import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';
import type { TriggerSummary } from '../types/triggers.js';
import type { FactValue, Outcome } from '../types/reasons.js';
import { HistoryBuffer, classify, parseSeed } from './history.js';
import type { HistoryConfig, HistoryEntry } from './history.js';
import { HISTORY_SCHEMA_ID, assertValidHistory } from './schemas.js';
import { readRetained } from './retained-reader.js';

type ObsEventBase = {
  schema: 'home.events.v2';
  correlation_id: string;
  // Constant across an entire causal tree (equal to correlation_id at the root) — filter on this
  // to find everything caused by a given trigger regardless of how many HA hops deep it goes.
  root_correlation_id: string;
  // Set when this run was itself triggered by a state_changed produced by another run's HA write.
  parent_correlation_id?: string;
  parent_automation_id?: string;
  automation_id: string;
  location: string;
  subsystem: string;
  timestamp: string;
  dry_run?: boolean;
};

// A discriminated union, not one bag of optionals: decision/abort are pipeline-run-level
// outcomes (one per run), action_started/action_result are per-action sub-events (one pair
// per action) — different granularities that don't share a shape. See #141.
export type ObsEvent = ObsEventBase & (
  | {
      event_type: 'decision';
      trigger: TriggerSummary;
      decision: string;
      reason?: string;
      conditions?: Record<string, unknown>;
      // Present only for automations that declare `reasons`; both come from the declaration
      // and are validated before they get here. Absent for everyone else, so an undeclared
      // automation's payload is unchanged.
      outcome?: Outcome;
      facts?: Record<string, FactValue>;
      actions: Action[];
      // Framework-computed (actions.length > 0) — structurally answers "did this decision
      // result in at least one action" without parsing free-text decision/reason strings.
      hasAction: boolean;
    }
  | {
      event_type: 'abort';
      trigger: TriggerSummary;
      // 'disabled'/'unhandled_error' are framework-owned sentinels; 'guard' covers every
      // author-triggered abort() call; 'unavailable_input' is a required entity being missing,
      // via requireState()/requireNumericState() (#142) — distinct from 'guard' since it's a
      // structurally detectable condition, not arbitrary author logic.
      abort_kind: 'disabled' | 'unhandled_error' | 'guard' | 'unavailable_input';
      reason?: string;
      // Set only when abort_kind is 'unavailable_input' — the entity that was missing/invalid.
      entity?: string;
    }
  | { event_type: 'action_started'; action: Action }
  | { event_type: 'action_result'; action: Action; status: 'ok' | 'error'; error?: string }
  | {
      // Fires when a dispatched ha.call_service's expected state/attribute change never
      // arrived within commandAck.timeoutMs — a real signal (device unreachable, Zigbee
      // mesh failure, HA accepted the call but nothing responded). See #55. Arrives well
      // after the triggering run's action_result: 'ok' (that only confirms HA accepted the
      // WS call, not that the device responded), so it can't be folded into that event.
      event_type: 'action_ack_timeout';
      action: Action;
      entity: string;
      expected: Record<string, unknown>;
    }
);

export type LifecycleEventType = 'server_started' | 'server_stopping' | 'rescan_complete' | 'ha_reconnected';

export interface LifecycleEvent {
  schema: 'home.lifecycle.v1';
  type: LifecycleEventType;
  automation_count: number;
  timestamp: string;
  dry_run?: boolean;
}

export class EventPublisher {
  private readonly listeners: Array<(event: ObsEvent) => void> = [];
  // Keyed by namespace then location, so a dry run can never touch the live buffers.
  private readonly locationHistory = new Map<string, Map<string, HistoryBuffer>>();
  private readonly houseHistory = new Map<string, HistoryBuffer>();

  // `enabled` gates MQTT publishing of decision/action ObsEvents only (mirrors metrics.enabled;
  // see #144) — publishLifecycle (status/online heartbeat) is unaffected, and listeners (the
  // /events SSE endpoint, any future persistent store) are always notified regardless, so
  // consumers that don't want the MQTT stream aren't forced to lose in-process observability too.
  constructor(
    private readonly mqtt: MqttClient,
    private readonly enabled: boolean = true,
    // Off unless configured: history adds retained topics other consumers did not ask for.
    // Independent of `enabled`, which gates only the ObsEvent stream.
    private readonly history?: HistoryConfig,
  ) {}

  subscribe(listener: (event: ObsEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  publishDecision(event: ObsEvent): void {
    if (this.enabled) {
      const payload = this.safeSerialize(event);
      if (payload !== undefined) {
        const ns = event.dry_run ? 'homerun/dev' : 'homerun';
        this.publish(`${ns}/events`, payload, false);
        this.publish(`${ns}/${event.location}/${event.subsystem}/decision`, payload, true);
      }
    }
    this.recordHistory(event);
    this.notifyListeners(event);
  }

  publishActionEvent(event: ObsEvent): void {
    if (this.enabled) {
      const payload = this.safeSerialize(event);
      if (payload !== undefined) {
        const ns = event.dry_run ? 'homerun/dev' : 'homerun';
        this.publish(`${ns}/events`, payload, false);
      }
    }
    this.recordHistory(event);
    this.notifyListeners(event);
  }

  publishLifecycle(type: LifecycleEventType, automationCount: number, dryRun = false): void {
    const event: LifecycleEvent = {
      schema: 'home.lifecycle.v1',
      type,
      automation_count: automationCount,
      timestamp: new Date().toISOString(),
      ...(dryRun && { dry_run: true }),
    };
    const ns = dryRun ? 'homerun/dev' : 'homerun';
    const payload = JSON.stringify(event);
    this.publish(`${ns}/lifecycle`, payload, false);
    this.publish(`${ns}/status`, JSON.stringify({ status: 'online', automation_count: automationCount, timestamp: event.timestamp }), true);
  }

  // Rebuilds the buffers from the retained topics so history survives a restart. Call once,
  // before the engine starts, so no live entry can race the seed. A malformed or missing seed
  // means an empty buffer, never a failed startup. `dryRun` selects the namespace to read,
  // keeping a dry run on `homerun/dev/...` end to end.
  async seedHistory(dryRun: boolean, settleMs = 1000): Promise<void> {
    const config = this.history;
    if (!config) return;
    const ns = dryRun ? 'homerun/dev' : 'homerun';
    const houseTopic = `${ns}/history`;
    const locationTopic = new RegExp(`^${ns}/([^/]+)/history$`);
    // In the live namespace `homerun/+/history` also matches the dry-run house topic
    // (`homerun/dev/history`), so `dev` is reserved and never read as a location.
    const locationOf = (topic: string): string | undefined => {
      const location = locationTopic.exec(topic)?.[1];
      return location !== undefined && (dryRun || location !== 'dev') ? location : undefined;
    };
    try {
      const found = await readRetained(
        this.mqtt, [houseTopic, `${ns}/+/history`],
        (t) => t === houseTopic || locationOf(t) !== undefined, settleMs,
      );
      for (const [topic, raw] of found) this.applySeed(ns, topic, raw, config, locationOf(topic));
    } catch (err) {
      console.warn('[EventPublisher] could not read retained history, starting empty:', err);
    }
  }

  private applySeed(ns: string, topic: string, raw: string, config: HistoryConfig, location?: string): void {
    const seed = parseSeed(topic, raw, location);
    if (!seed) return;
    const buffer = location === undefined
      ? this.bufferFor(this.houseHistory, ns, config.houseSize)
      : this.bufferFor(this.locationMap(ns), location, config.size);
    buffer.load(seed.entries);
  }

  private locationMap(ns: string): Map<string, HistoryBuffer> {
    let map = this.locationHistory.get(ns);
    if (!map) { map = new Map(); this.locationHistory.set(ns, map); }
    return map;
  }

  private bufferFor(map: Map<string, HistoryBuffer>, key: string, size: number): HistoryBuffer {
    let buffer = map.get(key);
    if (!buffer) { buffer = new HistoryBuffer(size); map.set(key, buffer); }
    return buffer;
  }

  // History is a side channel: a classification, schema or publish failure is logged and the
  // pipeline carries on, exactly like serialization above.
  private recordHistory(event: ObsEvent): void {
    const config = this.history;
    if (!config) return;
    try {
      const entry = classify(event);
      if (!entry) return;
      // Check the entry before it can enter either buffer: a bad entry would otherwise sit in
      // memory and be retained until the next restart.
      assertValidHistory({ schema: HISTORY_SCHEMA_ID, entries: [entry] });
      const ns = event.dry_run ? 'homerun/dev' : 'homerun';
      const locationBuffer = this.bufferFor(this.locationMap(ns), entry.location, config.size);
      const houseBuffer = this.bufferFor(this.houseHistory, ns, config.houseSize);
      this.store(locationBuffer, `${ns}/${entry.location}/history`, entry);
      this.store(houseBuffer, `${ns}/history`, entry);
    } catch (err) {
      console.error(`[EventPublisher] history skipped for ${event.event_type} from ${event.automation_id}:`, err);
    }
  }

  private store(buffer: HistoryBuffer, topic: string, entry: HistoryEntry): void {
    buffer.push(entry);
    this.publish(topic, JSON.stringify(buffer.payload()), true);
  }

  private publish(topic: string, payload: string, retain: boolean): void {
    this.mqtt.publishAsync(topic, payload, { retain }).catch((err: unknown) => {
      console.error(`[EventPublisher] MQTT publish failed on ${topic}:`, err);
    });
  }

  // Observability must never affect automation behaviour — a decision/action event that fails
  // to serialize (e.g. conditions defaulting to a context object with a circular reference) must
  // not throw, since runPipeline awaits this alongside actionRuntime.execute() in the same
  // Promise.all; a synchronous throw here would silently prevent real actions from ever running.
  private safeSerialize(event: ObsEvent): string | undefined {
    try {
      return JSON.stringify(event);
    } catch (err) {
      console.error(`[EventPublisher] failed to serialize ${event.event_type} event for ${event.automation_id} — MQTT publish skipped:`, err);
      return undefined;
    }
  }

  // Isolates listeners from each other and from the publisher — the same reliability principle
  // applied to subscribers (e.g. the /events SSE endpoint) as to serialization above.
  private notifyListeners(event: ObsEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[EventPublisher] listener threw, continuing:', err);
      }
    }
  }
}
