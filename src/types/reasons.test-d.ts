import { describe, it, expectTypeOf } from 'vitest';
import { defineAutomation } from './automation.js';
import type { Decision } from './automation.js';

const base = { id: 'a', location: 'room', subsystem: 'lighting', triggers: [{ type: 'on_start' as const }] };

describe('declared reasons: compile-time narrowing', () => {
  it('narrows reason to the declared keys and facts to that reason\'s list', () => {
    defineAutomation({
      ...base,
      reasons: {
        lux_high: { outcome: 'declined', facts: ['lux', 'threshold'] },
        lights_on: { outcome: 'acted' },
      },
      context: () => ({ lux: 85 }),
      reduce: ({ lux }) => {
        if (lux > 40) return { decision: 'no_action', reason: 'lux_high', facts: { lux, threshold: 40 }, actions: [] };
        return { decision: 'turn_on', reason: 'lights_on', actions: [] };
      },
    });
  });

  it('rejects an undeclared reason', () => {
    defineAutomation({
      ...base,
      // @ts-expect-error 'lights_off' is not a declared reason
      reasons: { lights_on: { outcome: 'acted' } },
      context: () => ({}),
      reduce: () => ({ decision: 'turn_off', reason: 'lights_off', actions: [] }),
    });
  });

  it('rejects a missing declared fact', () => {
    defineAutomation({
      ...base,
      reasons: { lux_high: { outcome: 'declined', facts: ['lux', 'threshold'] } },
      context: () => ({}),
      // @ts-expect-error 'threshold' is declared but missing from facts
      reduce: () => ({ decision: 'no_action', reason: 'lux_high', facts: { lux: 1 }, actions: [] }),
    });
  });

  it('rejects a non-primitive fact value', () => {
    defineAutomation({
      ...base,
      reasons: { lux_high: { outcome: 'declined', facts: ['lux'] } },
      context: () => ({}),
      // @ts-expect-error facts are string, number, boolean or null
      reduce: () => ({ decision: 'no_action', reason: 'lux_high', facts: { lux: [1] }, actions: [] }),
    });
  });

  it('rejects an outcome outside the three values', () => {
    defineAutomation({
      ...base,
      // @ts-expect-error 'maybe' is not an outcome
      reasons: { lux_high: { outcome: 'maybe' } },
      context: () => ({}),
      reduce: () => ({ decision: 'no_action', reason: 'lux_high', actions: [] }),
    });
  });

  it('rejects facts for a reason that declares none', () => {
    defineAutomation({
      ...base,
      reasons: { lights_on: { outcome: 'acted' } },
      context: () => ({}),
      // @ts-expect-error facts are not allowed for a reason that declares none
      reduce: () => ({ decision: 'turn_on', reason: 'lights_on', facts: { lux: 1 }, actions: [] }),
    });
  });
});

describe('automations that declare nothing', () => {
  it('keep a free-form reason and infer the context type as before', () => {
    defineAutomation({
      ...base,
      context: () => ({ lux: 1 }),
      reduce: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<{ lux: number }>();
        return { decision: 'no_action', reason: 'anything_goes', actions: [] } satisfies Decision;
      },
    });
  });
});

describe('automations that declare nothing cannot return facts', () => {
  it('rejects facts without a declaration', () => {
    defineAutomation({
      ...base,
      context: () => ({}),
      // @ts-expect-error facts need a reasons declaration to be checked against
      reduce: () => ({ decision: 'x', facts: { lux: 1 }, actions: [] }),
    });
  });
});
