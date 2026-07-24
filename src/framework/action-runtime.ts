import type { MqttClient } from 'mqtt';
import type { Action, HaCallServiceAction } from '../types/actions.js';
import type { AckTimeoutEvent, EntityState, HAClient } from './ha-client.js';
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
  commandAck?: { enabled: boolean; timeoutMs: number };
}

function safeStringify(err: object): string {
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// HA `data` keys are conventionally the same name as the attribute they end up setting
// (temperature, brightness, position, ...) — true across core and third-party integrations
// as a platform-wide naming convention, not something homerun needs to hand-map per service.
// These are the known exceptions: call parameters that don't name a resulting attribute.
const NON_ATTRIBUTE_DATA_KEYS = new Set(['transition', 'entity_id']);

// Computes the field/attribute -> value map a dispatched call is expected to produce, or
// undefined if there's nothing to track (no inferable fields, or the entity already matches
// every one of them — an idempotent call that legitimately produces no state_changed at all).
// See #55's design discussion for why this is convention-based rather than a per-service table.
function computeExpectedAck(
  action: HaCallServiceAction,
  current: EntityState | undefined,
): Record<string, unknown> | undefined {
  const expected: Record<string, unknown> = {};

  if (action.service === 'turn_on') expected.state = 'on';
  else if (action.service === 'turn_off') expected.state = 'off';

  for (const [key, value] of Object.entries(action.data ?? {})) {
    if (NON_ATTRIBUTE_DATA_KEYS.has(key)) continue;
    expected[key] = value;
  }

  if (Object.keys(expected).length === 0) return undefined;

  const alreadySatisfied = Object.entries(expected).every(([key, value]) =>
    key === 'state' ? current?.state === value : current?.attributes[key] === value,
  );
  if (alreadySatisfied) return undefined;

  return expected;
}

export class ActionRuntime {
  constructor(private readonly deps: Deps) {
    this.deps.haClient.on('action_ack_timeout', (e) => this.handleAckTimeout(e));
  }

  private handleAckTimeout(e: AckTimeoutEvent): void {
    this.deps.metrics?.incrementCounter('homerun_action_ack_timeout_total', {
      location: e.location,
      action_type: e.action.type,
    });
    this.deps.eventPublisher.publishActionEvent({
      schema: 'home.events.v2',
      correlation_id: e.correlationId,
      root_correlation_id: e.rootCorrelationId ?? e.correlationId,
      automation_id: e.automationId,
      location: e.location,
      subsystem: e.subsystem,
      timestamp: new Date().toISOString(),
      ...(this.deps.dryRun ? { dry_run: true } : {}),
      event_type: 'action_ack_timeout',
      action: e.action,
      entity: e.entity_id,
      expected: e.expected,
    });
  }

  async execute(actions: Action[], ctx: ExecutionContext): Promise<void> {
    for (const action of actions) {
      await this.runAction(action, ctx);
    }
  }

  private async runAction(action: Action, ctx: ExecutionContext): Promise<void> {
    const labels = { location: ctx.location, action_type: action.type };
    this.deps.eventPublisher.publishActionEvent(this.makeStartedEvent(ctx, action));
    this.deps.metrics?.incrementCounter('homerun_actions_dispatched_total', labels);

    const start = performance.now();
    try {
      if (!this.deps.dryRun) {
        await this.dispatch(action, ctx);
      }
      const duration = (performance.now() - start) / 1000;
      this.deps.metrics?.observeHistogram('homerun_action_duration_seconds', duration, labels);
      this.deps.metrics?.incrementCounter('homerun_actions_succeeded_total', labels);
      this.deps.eventPublisher.publishActionEvent(this.makeResultEvent(ctx, action, 'ok'));
    } catch (err) {
      const duration = (performance.now() - start) / 1000;
      this.deps.metrics?.observeHistogram('homerun_action_duration_seconds', duration, labels);
      this.deps.metrics?.incrementCounter('homerun_actions_failed_total', labels);
      const error =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null
            ? safeStringify(err)
            : String(err);
      this.deps.eventPublisher.publishActionEvent(this.makeResultEvent(ctx, action, 'error', error));
    }
  }

  private async dispatch(action: Action, ctx: ExecutionContext): Promise<void> {
    switch (action.type) {
      case 'ha.call_service': {
        const entityId = action.target?.entity_id;
        if (this.deps.commandAck?.enabled && entityId) {
          const expected = computeExpectedAck(action, this.deps.haClient.state(entityId as never));
          if (expected) {
            this.deps.haClient.registerPendingAck(entityId, {
              correlationId: ctx.correlationId,
              rootCorrelationId: ctx.rootCorrelationId,
              automationId: ctx.automationId,
              location: ctx.location,
              subsystem: ctx.subsystem,
              action,
              expected,
            }, this.deps.commandAck.timeoutMs);
          }
        }
        await this.deps.haClient.callService(action.domain, action.service, action.target, action.data, {
          correlationId: ctx.correlationId,
          rootCorrelationId: ctx.rootCorrelationId,
          automationId: ctx.automationId,
        });
        break;
      }
      case 'mqtt.publish':
        if (action.impliesEntity) {
          this.deps.haClient.registerPendingWrite(action.impliesEntity, {
            correlationId: ctx.correlationId,
            rootCorrelationId: ctx.rootCorrelationId,
            automationId: ctx.automationId,
          });
        }
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

  private baseFields(ctx: ExecutionContext) {
    return {
      schema: 'home.events.v2' as const,
      correlation_id: ctx.correlationId,
      root_correlation_id: ctx.rootCorrelationId ?? ctx.correlationId,
      automation_id: ctx.automationId,
      location: ctx.location,
      subsystem: ctx.subsystem,
      timestamp: new Date().toISOString(),
      ...(this.deps.dryRun ? { dry_run: true } : {}),
      ...(ctx.parentCorrelationId && { parent_correlation_id: ctx.parentCorrelationId }),
      ...(ctx.parentAutomationId && { parent_automation_id: ctx.parentAutomationId }),
    };
  }

  private makeStartedEvent(ctx: ExecutionContext, action: Action): ObsEvent {
    return { ...this.baseFields(ctx), event_type: 'action_started', action };
  }

  private makeResultEvent(ctx: ExecutionContext, action: Action, status: 'ok' | 'error', error?: string): ObsEvent {
    return {
      ...this.baseFields(ctx),
      event_type: 'action_result',
      action,
      status,
      ...(error !== undefined && { error }),
    };
  }
}
