import type { Automation, Decision, Abort } from './types/automation.js';
import type { TriggerEvent } from './types/triggers.js';
import type { HAContext } from './framework/ha-client.js';
import { isAbort } from './types/automation.js';

type TestStateEntry = { state: string; attributes?: Record<string, unknown>; last_changed?: string; last_updated?: string };

interface TestOptions {
  event: TriggerEvent;
  state?: Record<string, TestStateEntry>;
  ha?: Partial<HAContext>;
}

export function testAutomation<C>(
  automation: Automation<C>,
  options: TestOptions,
): Decision | Abort {
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

  const ctx = automation.context(stateFunc, haContext, event);
  if (isAbort(ctx)) return ctx;
  return automation.reduce(ctx);
}
