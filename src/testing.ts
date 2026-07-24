import type { Automation, Decision, Abort } from './types/automation.js';
import type { TriggerEvent } from './types/triggers.js';
import type { HAContext, HAState } from './framework/ha-client.js';
import { isAbort } from './types/automation.js';

type TestStateEntry = { state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string };

interface TestOptions {
  event: TriggerEvent;
  state?: Record<string, TestStateEntry>;
  ha?: Partial<HAContext>;
}

function run<C>(automation: Automation<C>, options: TestOptions): Decision | Abort {
  const { event, state = {}, ha = {} } = options;

  const stateFunc = (entityId: string) => {
    const entry = state[entityId];
    if (!entry) return undefined;
    return {
      entity_id: entityId,
      state: entry.state,
      attributes: entry.attributes ?? {},
      last_changed: entry.last_changed ?? '',
      last_updated: entry.last_updated ?? '',
    };
  };

  const haContext: HAContext = {
    entitiesByLabel: ha.entitiesByLabel ?? (() => []),
    labelsFor: ha.labelsFor ?? (() => []),
    entitiesByArea: ha.entitiesByArea ?? (() => []),
  };

  const ctx = automation.context(stateFunc as HAState, haContext, event);
  if (isAbort(ctx)) return ctx;

  const result = automation.reduce(ctx);
  // Mirrors runPipeline's default in src/framework/pipeline.ts, so tests observe the same
  // `conditions` a real run would publish.
  return { ...result, conditions: result.conditions ?? (ctx as Record<string, unknown>) };
}

export function testAutomation<C>(automation: Automation<C>, options: TestOptions): Decision {
  const result = run(automation, options);
  if (isAbort(result)) throw new Error(`automation aborted: ${result.reason}`);
  return result;
}

export function testAbort<C>(automation: Automation<C>, options: TestOptions): Abort {
  const result = run(automation, options);
  if (!isAbort(result)) throw new Error(`expected abort but got decision: ${result.decision}`);
  return result;
}
