import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';

export interface ObsEvent {
  schema: 'home.events.v1';
  correlation_id: string;
  automation_id: string;
  location: string;
  subsystem: string;
  event_type: 'decision' | 'abort' | 'action_started' | 'action_result';
  decision?: string;
  reason?: string;
  inputs?: Record<string, unknown>;
  actions?: Action[];
  dry_run?: boolean;
  timestamp: string;
}

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
