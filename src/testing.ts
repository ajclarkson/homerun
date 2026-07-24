import type { Automation, Decision, Abort } from './types/automation.js';
import type { TriggerEvent } from './types/triggers.js';
import type { HAContext, HAState } from './framework/ha-client.js';
import { isAbort, UnavailableInputError } from './types/automation.js';

type TestStateEntry = { state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string };

interface TestOptions {
  event: TriggerEvent;
  state?: Record<string, TestStateEntry>;
  ha?: Partial<HAContext>;
}

function buildStateAndHa(options: TestOptions) {
  const { state = {}, ha = {} } = options;

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

  return { stateFunc, haContext };
}

function run<C>(automation: Automation<C>, options: TestOptions): Decision | Abort {
  const { stateFunc, haContext } = buildStateAndHa(options);

  const ctx = automation.context(stateFunc as HAState, haContext, options.event);
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

// For automations using requireState()/requireNumericState(), which throw
// UnavailableInputError rather than returning Abort — testAbort() can't observe these since
// run() never catches an exception thrown out of context(). Returns the entity id the
// automation required, so tests can assert on which input was missing.
export function testUnavailable<C>(automation: Automation<C>, options: TestOptions): string {
  const { stateFunc, haContext } = buildStateAndHa(options);

  try {
    automation.context(stateFunc as HAState, haContext, options.event);
  } catch (err) {
    if (err instanceof UnavailableInputError) return err.entityId;
    throw err;
  }
  throw new Error('expected UnavailableInputError but context() completed normally');
}
