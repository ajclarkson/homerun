import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';
import type { HAClient } from './ha-client.js';
import type { TimerManager } from './timer-manager.js';
import type { EventPublisher, ObsEvent } from './event-publisher.js';

export interface ExecutionContext {
  correlationId: string;
  automationId: string;
  location: string;
  subsystem: string;
}

interface Deps {
  haClient: HAClient;
  mqttClient: MqttClient;
  timerManager: TimerManager;
  eventPublisher: EventPublisher;
  dryRun: boolean;
}

export class ActionRuntime {
  constructor(private readonly deps: Deps) {}

  async execute(actions: Action[], ctx: ExecutionContext): Promise<void> {
    for (const action of actions) {
      await this.runAction(action, ctx);
    }
  }

  private async runAction(action: Action, ctx: ExecutionContext): Promise<void> {
    this.deps.eventPublisher.publishActionEvent(this.makeEvent(ctx, 'action_started', action));

    try {
      if (!this.deps.dryRun) {
        await this.dispatch(action);
      }
      this.deps.eventPublisher.publishActionEvent(
        this.makeEvent(ctx, 'action_result', action, { reason: 'ok' }),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.eventPublisher.publishActionEvent(
        this.makeEvent(ctx, 'action_result', action, { reason }),
      );
    }
  }

  private async dispatch(action: Action): Promise<void> {
    switch (action.type) {
      case 'ha.call_service':
        await this.deps.haClient.callService(action.domain, action.service, action.target, action.data);
        break;
      case 'mqtt.publish':
        await this.deps.mqttClient.publishAsync(action.topic, action.payload, { retain: action.retain ?? false });
        break;
      case 'timer.start':
        this.deps.timerManager.start(action.timerKey, action.delayMs);
        break;
      case 'timer.cancel':
        this.deps.timerManager.cancel(action.timerKey);
        break;
      default: {
        const unknown = (action as { type: string }).type;
        throw new Error(`unknown action type: ${unknown}`);
      }
    }
  }

  private makeEvent(
    ctx: ExecutionContext,
    event_type: ObsEvent['event_type'],
    action: Action,
    extra: Partial<ObsEvent> = {},
  ): ObsEvent {
    return {
      schema: 'home.events.v1',
      correlation_id: ctx.correlationId,
      automation_id: ctx.automationId,
      location: ctx.location,
      subsystem: ctx.subsystem,
      event_type,
      actions: [action],
      timestamp: new Date().toISOString(),
      ...(this.deps.dryRun ? { dry_run: true } : {}),
      ...extra,
    };
  }
}
