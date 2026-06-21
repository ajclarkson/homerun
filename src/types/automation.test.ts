import { describe, it, expect, expectTypeOf } from 'vitest';
import { defineAutomation, abort, isAbort, type Automation, type Decision, type Abort } from './automation.js';

describe('defineAutomation', () => {
  it('returns the automation unchanged', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'kitchen',
      subsystem: 'lighting',
      triggers: [{ type: 'on_start' }],
      context: () => ({ lightsOn: true }),
      reduce: ({ lightsOn }) => ({
        decision: lightsOn ? 'turn_off' : 'turn_on',
        actions: [],
      }),
    });

    expect(automation.id).toBe('test');
    expect(automation.location).toBe('kitchen');
    expect(automation.subsystem).toBe('lighting');
  });

  it('infers C so reduce receives the typed context shape', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'kitchen',
      subsystem: 'lighting',
      triggers: [],
      context: () => ({ count: 42, label: 'hello' }),
      reduce: (ctx) => {
        // If C is inferred correctly these property accesses compile without annotation.
        expectTypeOf(ctx.count).toEqualTypeOf<number>();
        expectTypeOf(ctx.label).toEqualTypeOf<string>();
        return { decision: 'ok', actions: [] };
      },
    });

    const ctx = (automation.context as () => { count: number; label: string })();
    expect(automation.reduce(ctx).decision).toBe('ok');
  });

  it('context may return Abort to short-circuit the pipeline', () => {
    // The compile-time proof is that this call type-checks at all.
    defineAutomation({
      id: 'test',
      location: 'kitchen',
      subsystem: 'lighting',
      triggers: [],
      context: (_state, _ha): { enabled: boolean } | Abort =>
        abort('not_ready'),
      reduce: (ctx) => ({ decision: ctx.enabled ? 'on' : 'off', actions: [] }),
    });
  });
});

describe('abort', () => {
  it('produces an Abort with the given reason', () => {
    const result = abort('some_reason');
    expect(result).toEqual({ abort: true, reason: 'some_reason' });
  });
});

describe('isAbort', () => {
  it('returns true for an Abort value', () => {
    expect(isAbort(abort('x'))).toBe(true);
  });

  it('returns false for a Decision', () => {
    const decision: Decision = { decision: 'ok', actions: [] };
    expect(isAbort(decision)).toBe(false);
  });

  it('returns false for null and primitives', () => {
    expect(isAbort(null)).toBe(false);
    expect(isAbort(undefined)).toBe(false);
    expect(isAbort('abort')).toBe(false);
  });
});
