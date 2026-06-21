import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';

export interface ObsEvent {
  schema: 'home.events.v1';
  correlation_id: string;
  automation_id: string;
  location: string;
  subsystem: string;
  type: 'decision' | 'abort' | 'action_started' | 'action_result';
  decision?: string;
  reason?: string;
  inputs?: Record<string, unknown>;
  actions?: Action[];
  dry_run?: boolean;
  timestamp: string;
}

export class Observability {
  constructor(private readonly mqtt: MqttClient) {}

  publishDecision(event: ObsEvent): void {
    const payload = JSON.stringify(event);
    this.publish('home/events', payload, false);
    this.publish(`${event.location}/${event.subsystem}/decision`, payload, true);
  }

  publishActionEvent(event: ObsEvent): void {
    this.publish('home/events', JSON.stringify(event), false);
  }

  private publish(topic: string, payload: string, retain: boolean): void {
    this.mqtt.publishAsync(topic, payload, { retain }).catch((err: unknown) => {
      console.error(`[Observability] MQTT publish failed on ${topic}:`, err);
    });
  }
}
