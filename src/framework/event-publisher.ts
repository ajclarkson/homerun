import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';
import type { TriggerSummary } from '../types/triggers.js';
import type { DeclarationProblem, FactValue, Outcome } from '../types/reasons.js';
import { HistoryBuffer, classify, parseSeed } from './history.js';
import type { HistoryConfig } from './history.js';
import { HISTORY_SCHEMA_ID, assertValidHistory } from './schemas.js';
import { readRetained } from './retained-reader.js';
import { namespace } from './namespace.js';

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
      // Set only on 'unhandled_error'. `error_type` is the thrown Error's name, included only
      // when identifier-shaped (no free text); the message and stack go to the log.
      stage?: 'context' | 'reduce';
      error_type?: string;
    }
  | {
      // A declaring automation returned something its declaration does not allow. The decision
      // and its actions still go ahead (observability must never stop a real action); this
      // event is how the mistake stays loud. No free text: `reason` and `fact` are included
      // only when they are identifier-shaped, and the full detail goes to the log.
      event_type: 'declaration_error';
      problem: DeclarationProblem;
      reason?: string;
      fact?: string;
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
  private readonly locationHistory = new Map<string, HistoryBuffer>();
  private houseHistory: HistoryBuffer | undefined;
  // Latest payload per history topic awaiting a retained publish. A busy room would otherwise
  // republish the whole buffer on every event; only the newest state per topic matters.
  private readonly pendingHistory = new Map<string, HistoryBuffer>();
  private historyTimer: NodeJS.Timeout | undefined;
  private readonly ns: string;
  private readonly enabled: boolean;
  private readonly history: HistoryConfig | undefined;
  private readonly dryRun: boolean;
  private readonly historyDebounceMs: number;

  // `enabled` gates MQTT publishing of decision/action ObsEvents (mirrors metrics.enabled; see
  // #144), and also the catalogue and history, which are further MQTT output of the same kind.
  // Listeners (the /events SSE endpoint, any future persistent store) are always notified, so
  // consumers that don't want the MQTT stream aren't forced to lose in-process observability.
  // `history` is off unless configured. `dryRun` is per process, so it is fixed here and moves
  // every topic under homerun/dev. `historyDebounceMs` of 0 publishes immediately.
  constructor(
    private readonly mqtt: MqttClient,
    options: { enabled?: boolean; history?: HistoryConfig; dryRun?: boolean; historyDebounceMs?: number } = {},
  ) {
    this.enabled = options.enabled ?? true;
    this.history = options.history;
    this.dryRun = options.dryRun ?? false;
    this.historyDebounceMs = options.historyDebounceMs ?? 250;
    this.ns = namespace(this.dryRun);
  }

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
        this.publish(`${this.ns}/events`, payload, false);
        this.publish(`${this.ns}/${event.location}/${event.subsystem}/decision`, payload, true);
      }
    }
    this.recordHistory(event);
    this.notifyListeners(event);
  }

  publishActionEvent(event: ObsEvent): void {
    if (this.enabled) {
      const payload = this.safeSerialize(event);
      if (payload !== undefined) {
        this.publish(`${this.ns}/events`, payload, false);
      }
    }
    this.recordHistory(event);
    this.notifyListeners(event);
  }

  publishLifecycle(type: LifecycleEventType, automationCount: number): void {
    const dryRun = this.dryRun;
    const event: LifecycleEvent = {
      schema: 'home.lifecycle.v1',
      type,
      automation_count: automationCount,
      timestamp: new Date().toISOString(),
      ...(dryRun && { dry_run: true }),
    };
    const ns = this.ns;
    const payload = JSON.stringify(event);
    this.publish(`${ns}/lifecycle`, payload, false);
    this.publish(`${ns}/status`, JSON.stringify({ status: 'online', automation_count: automationCount, timestamp: event.timestamp }), true);
  }

  // Rebuilds the buffers from the retained topics so history survives a restart. Call once,
  // before the engine starts, so no live entry can race the seed. A malformed or missing seed
  // means an empty buffer, never a failed startup.
  async seedHistory(settleMs = 1000): Promise<void> {
    const config = this.history;
    if (!config || !this.enabled) return;
    const ns = this.ns;
    const houseTopic = `${ns}/history`;
    const locationTopic = new RegExp(`^${ns}/([^/]+)/history$`);
    // In the live namespace `homerun/+/history` also matches the dry-run house topic
    // (`homerun/dev/history`), so `dev` is reserved and never read as a location.
    const locationOf = (topic: string): string | undefined => {
      const location = locationTopic.exec(topic)?.[1];
      return location !== undefined && (this.dryRun || location !== 'dev') ? location : undefined;
    };
    try {
      const found = await readRetained(
        this.mqtt, [houseTopic, `${ns}/+/history`],
        (t) => t === houseTopic || locationOf(t) !== undefined, settleMs,
      );
      for (const [topic, raw] of found) this.applySeed(topic, raw, config, locationOf(topic));
    } catch (err) {
      console.warn('[EventPublisher] could not read retained history, starting empty:', err);
    }
  }

  private applySeed(topic: string, raw: string, config: HistoryConfig, location?: string): void {
    const seed = parseSeed(topic, raw, location);
    if (!seed) return;
    const buffer = location === undefined ? this.house(config) : this.locationBuffer(location, config);
    buffer.load(seed.entries);
  }

  private house(config: HistoryConfig): HistoryBuffer {
    this.houseHistory ??= new HistoryBuffer(config.houseSize);
    return this.houseHistory;
  }

  private locationBuffer(location: string, config: HistoryConfig): HistoryBuffer {
    let buffer = this.locationHistory.get(location);
    if (!buffer) { buffer = new HistoryBuffer(config.size); this.locationHistory.set(location, buffer); }
    return buffer;
  }

  // History is a side channel: a classification, schema or publish failure is logged and the
  // pipeline carries on, exactly like serialization above.
  private recordHistory(event: ObsEvent): void {
    const config = this.history;
    if (!config || !this.enabled) return;
    try {
      const entry = classify(event);
      if (!entry) return;
      // Check the entry before it can enter either buffer: a bad entry would otherwise sit in
      // memory and be retained until the next restart.
      assertValidHistory({ schema: HISTORY_SCHEMA_ID, entries: [entry] });
      const locationBuffer = this.locationBuffer(entry.location, config);
      const houseBuffer = this.house(config);
      locationBuffer.push(entry);
      houseBuffer.push(entry);
      this.queueHistory(`${this.ns}/${entry.location}/history`, locationBuffer);
      this.queueHistory(`${this.ns}/history`, houseBuffer);
    } catch (err) {
      console.error(`[EventPublisher] history skipped for ${event.event_type} from ${event.automation_id}:`, err);
    }
  }

  private queueHistory(topic: string, buffer: HistoryBuffer): void {
    this.pendingHistory.set(topic, buffer);
    if (this.historyDebounceMs === 0) { this.flushHistory(); return; }
    if (this.historyTimer) return;
    this.historyTimer = setTimeout(() => this.flushHistory(), this.historyDebounceMs);
    this.historyTimer.unref();
  }

  // Publishes the latest state of every pending topic now. The debounce only delays, so the
  // retained copy always converges on the newest buffer; call this on shutdown.
  flushHistory(): void {
    clearTimeout(this.historyTimer);
    this.historyTimer = undefined;
    for (const [topic, buffer] of this.pendingHistory) {
      this.publish(topic, JSON.stringify(buffer.payload()), true);
    }
    this.pendingHistory.clear();
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
