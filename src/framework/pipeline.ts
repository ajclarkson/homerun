import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import { summarizeTrigger } from '../types/triggers.js';
import { isAbort, UnavailableInputError } from '../types/automation.js';
import { resolveDeclaredReason } from '../types/reasons.js';
import type { ResolvedReason } from '../types/reasons.js';
import type { HAClient } from './ha-client.js';
import type { EventPublisher, ObsEvent } from './event-publisher.js';
import type { ActionRuntime } from './action-runtime.js';
import type { MetricsBackend } from './metrics.js';

interface Deps {
  eventPublisher: EventPublisher;
  actionRuntime: ActionRuntime;
  dryRun?: boolean;
  metrics?: MetricsBackend;
}

export async function runPipeline(
  automation: Automation<unknown>,
  event: TriggerEvent,
  haClient: HAClient,
  deps: Deps,
): Promise<void> {
  deps.metrics?.incrementCounter('homerun_pipeline_runs_total', {
    location: automation.location,
    trigger_type: event.type,
  });

  const correlationId = event.correlation_id;
  const rootCorrelationId = event.root_correlation_id ?? correlationId;
  const timestamp = new Date().toISOString();
  const trigger = summarizeTrigger(event);

  const base = {
    schema: 'home.events.v2' as const,
    correlation_id: correlationId,
    root_correlation_id: rootCorrelationId,
    automation_id: automation.id,
    location: automation.location,
    subsystem: automation.subsystem,
    timestamp,
    ...(deps.dryRun ? { dry_run: true } : {}),
    ...(event.parent_correlation_id && { parent_correlation_id: event.parent_correlation_id }),
    ...(event.parent_automation_id && { parent_automation_id: event.parent_automation_id }),
  };

  // Step 1: Enabled check
  if (automation.enabled === false) {
    deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'disabled', trigger });
    return;
  }

  // Step 2: Context
  let ctx: unknown;
  try {
    ctx = automation.context(haClient.state, haClient.context, event);
  } catch (err) {
    if (err instanceof UnavailableInputError) {
      deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'unavailable_input', entity: err.entityId, trigger });
    } else {
      deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'unhandled_error', trigger });
    }
    return;
  }

  if (isAbort(ctx)) {
    deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'guard', reason: ctx.reason, trigger });
    return;
  }

  // Step 3: Reduce
  let result: ReturnType<Automation<unknown>['reduce']>;
  try {
    result = automation.reduce(ctx);
  } catch {
    deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'unhandled_error', trigger });
    return;
  }

  // Step 3b: Declared reasons. Only automations that opted in are checked; for the rest
  // `declared` stays undefined and the event below is built exactly as before.
  let declared: ResolvedReason | undefined;
  if (automation.reasons) {
    try {
      declared = resolveDeclaredReason(automation.reasons, result);
    } catch (err) {
      // An undeclared reason or fact is an authoring bug. Abort loudly rather than publish a
      // decision a consumer cannot explain; the message goes to the log because the abort
      // event itself carries no free text.
      console.error(`[pipeline] ${automation.id}: declared-reasons violation:`, (err as Error).message);
      deps.eventPublisher.publishDecision({ ...base, event_type: 'abort', abort_kind: 'unhandled_error', trigger });
      return;
    }
  }

  // Step 4: Validate — safe defaults
  const actions = result.actions ?? [];
  // Defaults to the full context object so authors get observability "for free" without
  // hand-duplicating context fields into conditions — reduce() can still override with its
  // own (e.g. trimmed) conditions when the full context isn't what should be published.
  const conditions = result.conditions ?? (ctx as Record<string, unknown>);
  const decision: ObsEvent = {
    ...base,
    event_type: 'decision',
    trigger,
    decision: result.decision,
    reason: result.reason,
    conditions,
    actions,
    hasAction: actions.length > 0,
    ...(declared && { outcome: declared.outcome }),
    ...(declared?.facts && { facts: declared.facts }),
  };

  // Step 5: Fanout
  await Promise.all([
    Promise.resolve(deps.eventPublisher.publishDecision(decision)),
    deps.actionRuntime.execute(actions, {
      correlationId,
      automationId: automation.id,
      location: automation.location,
      subsystem: automation.subsystem,
      rootCorrelationId,
      ...(event.parent_correlation_id && { parentCorrelationId: event.parent_correlation_id }),
      ...(event.parent_automation_id && { parentAutomationId: event.parent_automation_id }),
    }),
  ]);
}
