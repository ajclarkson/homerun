import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import { isAbort } from '../types/automation.js';
import type { HAClient } from './ha-client.js';
import type { Observability, ObsEvent } from './observability.js';
import type { ActionRuntime } from './action-runtime.js';

interface Deps {
  observability: Observability;
  actionRuntime: ActionRuntime;
  dryRun?: boolean;
}

export async function runPipeline(
  automation: Automation<unknown>,
  event: TriggerEvent,
  haClient: HAClient,
  deps: Deps,
): Promise<void> {
  const correlationId = event.correlation_id;
  const timestamp = new Date().toISOString();

  const base: Omit<ObsEvent, 'type' | 'decision' | 'reason' | 'actions' | 'inputs'> = {
    schema: 'home.events.v1',
    correlation_id: correlationId,
    automation_id: automation.id,
    location: automation.location,
    subsystem: automation.subsystem,
    timestamp,
    ...(deps.dryRun ? { dry_run: true } : {}),
  };

  // Step 2: Context
  let ctx: unknown;
  try {
    ctx = automation.context(haClient.state, haClient.context, event);
  } catch {
    deps.observability.publishDecision({ ...base, type: 'abort', reason: 'unhandled_error' });
    return;
  }

  if (isAbort(ctx)) {
    deps.observability.publishDecision({ ...base, type: 'abort', reason: ctx.reason });
    return;
  }

  // Step 3: Reduce
  let result: ReturnType<Automation<unknown>['reduce']>;
  try {
    result = automation.reduce(ctx);
  } catch {
    deps.observability.publishDecision({ ...base, type: 'abort', reason: 'unhandled_error' });
    return;
  }

  // Step 4: Validate — safe defaults
  const actions = result.actions ?? [];
  const decision: ObsEvent = {
    ...base,
    type: 'decision',
    decision: result.decision,
    reason: result.reason,
    inputs: result.inputs,
    actions,
  };

  // Step 5: Fanout
  await Promise.all([
    Promise.resolve(deps.observability.publishDecision(decision)),
    deps.actionRuntime.execute(actions, {
      correlationId,
      automationId: automation.id,
      location: automation.location,
      subsystem: automation.subsystem,
    }),
  ]);
}
