import type { MqttClient } from 'mqtt';
import type { Action } from '../types/actions.js';
import type { HAClient } from './ha-client.js';
import type { TimerManager } from './timer-manager.js';
import type { EventPublisher, ObsEvent } from './event-publisher.js';
import type { MetricsBackend } from './metrics.js';

export interface ExecutionContext {
  correlationId: string;
  automationId: string;
  location: string;
  subsystem: string;
  rootCorrelationId?: string;
  parentCorrelationId?: string;
  parentAutomationId?: string;
}

interface Deps {
  haClient: HAClient;
  mqttClient: MqttClient;
  timerManager: TimerManager;
  eventPublisher: EventPublisher;
  dryRun: boolean;
  metrics?: MetricsBackend;
}

function safeStringify(err: object): string {
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class ActionRuntime {
  constructor(private readonly deps: Deps) {}

  async execute(actions: Action[], ctx: ExecutionContext): Promise<void> {
    for (const action of actions) {
      await this.runAction(action, ctx);
    }
  }

  private async runAction(action: Action, ctx: ExecutionContext): Promise<void> {
    const labels = { location: ctx.location, action_type: action.type };
    this.deps.eventPublisher.publishActionEvent(this.makeEvent(ctx, 'action_started', action));
    this.deps.metrics?.incrementCounter('homerun_actions_dispatched_total', labels);

    const start = performance.now();
    try {
      if (!this.deps.dryRun) {
        await this.dispatch(action, ctx);
      }
      const duration = (performance.now() - start) / 1000;
      this.deps.metrics?.observeHistogram('homerun_action_duration_seconds', duration, labels);
      this.deps.metrics?.incrementCounter('homerun_actions_succeeded_total', labels);
      this.deps.eventPublisher.publishActionEvent(
        this.makeEvent(ctx, 'action_result', action, { reason: 'ok' }),
      );
    } catch (err) {
      const duration = (performance.now() - start) / 1000;
      this.deps.metrics?.observeHistogram('homerun_action_duration_seconds', duration, labels);
      this.deps.metrics?.incrementCounter('homerun_actions_failed_total', labels);
      const reason =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null
            ? safeStringify(err)
            : String(err);
      this.deps.eventPublisher.publishActionEvent(
        this.makeEvent(ctx, 'action_result', action, { reason }),
      );
    }
  }

  private async dispatch(action: Action, ctx: ExecutionContext): Promise<void> {
    switch (action.type) {
      case 'ha.call_service':
        await this.deps.haClient.callService(action.domain, action.service, action.target, action.data, {
          correlationId: ctx.correlationId,
          rootCorrelationId: ctx.rootCorrelationId,
          automationId: ctx.automationId,
        });
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
      root_correlation_id: ctx.rootCorrelationId ?? ctx.correlationId,
      automation_id: ctx.automationId,
      location: ctx.location,
      subsystem: ctx.subsystem,
      event_type,
      actions: [action],
      timestamp: new Date().toISOString(),
      ...(this.deps.dryRun ? { dry_run: true } : {}),
      ...(ctx.parentCorrelationId && { parent_correlation_id: ctx.parentCorrelationId }),
      ...(ctx.parentAutomationId && { parent_automation_id: ctx.parentAutomationId }),
      ...extra,
    };
  }
}
