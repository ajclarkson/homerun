import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  defineAutomation, abort, isAbort, requireState, requireNumericState, UnavailableInputError,
  type Automation, type Decision, type Abort,
} from './automation.js';
import type { HAState, EntityState } from '../framework/ha-client.js';

function makeState(values: Record<string, Partial<EntityState> & { state: string }>): HAState {
  return ((entity: string) => {
    const v = values[entity];
    if (!v) return undefined;
    return { entity_id: entity, attributes: {}, last_changed: '', last_updated: '', ...v };
  }) as HAState;
}

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

describe('requireState', () => {
  it('returns the entity state string when present', () => {
    const state = makeState({ 'sensor.house_active_mode': { state: 'normal' } });
    expect(requireState(state, 'sensor.house_active_mode')).toBe('normal');
  });

  it('throws UnavailableInputError with the entity id when missing', () => {
    const state = makeState({});
    expect(() => requireState(state, 'sensor.house_active_mode')).toThrow(UnavailableInputError);
    try {
      requireState(state, 'sensor.house_active_mode');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnavailableInputError);
      expect((err as UnavailableInputError).entityId).toBe('sensor.house_active_mode');
    }
  });
});

describe('requireNumericState', () => {
  it('returns the parsed number when the state is a valid number', () => {
    const state = makeState({ 'input_number.lux_threshold': { state: '15.5' } });
    expect(requireNumericState(state, 'input_number.lux_threshold')).toBe(15.5);
  });

  it('throws UnavailableInputError when the entity is missing', () => {
    const state = makeState({});
    expect(() => requireNumericState(state, 'input_number.lux_threshold')).toThrow(UnavailableInputError);
  });

  it('throws UnavailableInputError when the state is not a finite number', () => {
    const state = makeState({ 'input_number.lux_threshold': { state: 'unavailable' } });
    expect(() => requireNumericState(state, 'input_number.lux_threshold')).toThrow(UnavailableInputError);
  });
});
