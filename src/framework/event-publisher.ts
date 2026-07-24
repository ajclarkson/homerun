import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';
import type { TriggerSummary } from '../types/triggers.js';

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
      actions: Action[];
      // Framework-computed (actions.length > 0) — structurally answers "did this decision
      // result in at least one action" without parsing free-text decision/reason strings.
      hasAction: boolean;
    }
  | {
      event_type: 'abort';
      trigger: TriggerSummary;
      // 'disabled'/'unhandled_error' are framework-owned sentinels; 'guard' covers every
      // author-triggered abort() call. See #142 for a possible future finer-grained split.
      abort_kind: 'disabled' | 'unhandled_error' | 'guard';
      reason?: string;
    }
  | { event_type: 'action_started'; action: Action }
  | { event_type: 'action_result'; action: Action; status: 'ok' | 'error'; error?: string }
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

  constructor(private readonly mqtt: MqttClient) {}

  subscribe(listener: (event: ObsEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  publishDecision(event: ObsEvent): void {
    const payload = JSON.stringify(event);
    const ns = event.dry_run ? 'homerun/dev' : 'homerun';
    this.publish(`${ns}/events`, payload, false);
    this.publish(`${ns}/${event.location}/${event.subsystem}/decision`, payload, true);
    for (const l of this.listeners) l(event);
  }

  publishActionEvent(event: ObsEvent): void {
    const ns = event.dry_run ? 'homerun/dev' : 'homerun';
    this.publish(`${ns}/events`, JSON.stringify(event), false);
    for (const l of this.listeners) l(event);
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

  private publish(topic: string, payload: string, retain: boolean): void {
    this.mqtt.publishAsync(topic, payload, { retain }).catch((err: unknown) => {
      console.error(`[EventPublisher] MQTT publish failed on ${topic}:`, err);
    });
  }
}
