import { describe, it, expect } from 'vitest';
import { defineAutomation } from './automation.js';
import { resolveDeclaredReason, validateReasonDeclarations } from './reasons.js';
import type { ReasonDeclarations } from './reasons.js';

const base = { id: 'room:lighting', location: 'room', subsystem: 'lighting', triggers: [{ type: 'on_start' as const }] };
const loose = (reasons: unknown) => () =>
  defineAutomation({ ...base, reasons, context: () => ({}), reduce: () => ({ decision: 'x', actions: [] }) } as never);

describe('defineAutomation — load-time validation of reasons', () => {
  it('accepts a well-formed declaration', () => {
    expect(loose({ lux_high: { outcome: 'declined', facts: ['lux'] }, on: { outcome: 'acted' } })).not.toThrow();
  });

  it('does nothing for an automation that declares no reasons', () => {
    const automation = defineAutomation({ ...base, context: () => ({}), reduce: () => ({ decision: 'x', actions: [] }) });
    expect(automation.reasons).toBeUndefined();
  });

  it.each([
    ['an outcome outside the three values', { r: { outcome: 'maybe' } }, /outcome must be one of/],
    ['a missing outcome', { r: {} }, /outcome must be one of/],
    ['facts that are not an array', { r: { outcome: 'acted', facts: 'lux' } }, /array of keys/],
    ['a non-string fact key', { r: { outcome: 'acted', facts: [1] } }, /fact key/],
    ['a fact key with punctuation', { r: { outcome: 'acted', facts: ['lux level'] } }, /fact key/],
    ['a duplicated fact key', { r: { outcome: 'acted', facts: ['a', 'a'] } }, /declared twice/],
    ['more than 8 facts', { r: { outcome: 'acted', facts: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } }, /at most 8/],
    ['an unknown field in a declaration', { r: { outcome: 'acted', fact: ['lux'] } }, /unknown field/],
    ['a reason name that embeds a value', { 'calendar_theme_not_an_option:autumn': { outcome: 'declined' } }, /reason name/],
    ['an empty reasons object', {}, /at least one/],
    ['reasons that are not an object', ['a'], /keyed by reason name/],
    ['a declaration that is not an object', { r: 'acted' }, /must be an object/],
  ])('fails loading on %s', (_name, reasons, message) => {
    expect(loose(reasons)).toThrow(message);
  });

  it('names the automation in the error', () => {
    expect(loose({ r: { outcome: 'nope' } })).toThrow(/automation "room:lighting"/);
  });
});

describe('resolveDeclaredReason — run-time enforcement', () => {
  const reasons: ReasonDeclarations = {
    lux_high: { outcome: 'declined', facts: ['lux', 'threshold'] },
    lights_on: { outcome: 'acted' },
  };

  it('returns the declared outcome and the facts', () => {
    expect(resolveDeclaredReason(reasons, { reason: 'lux_high', facts: { lux: 85, threshold: 40 } }))
      .toEqual({ outcome: 'declined', facts: { lux: 85, threshold: 40 } });
  });

  it('returns no facts for a reason that declares none', () => {
    expect(resolveDeclaredReason(reasons, { reason: 'lights_on' })).toEqual({ outcome: 'acted' });
  });

  it('keeps null, boolean and string facts', () => {
    const r: ReasonDeclarations = { r: { outcome: 'acted', facts: ['a', 'b', 'c'] } };
    expect(resolveDeclaredReason(r, { reason: 'r', facts: { a: null, b: false, c: 'x' } }).facts)
      .toEqual({ a: null, b: false, c: 'x' });
  });

  it.each([
    ['an undeclared reason', { reason: 'lights_off' }, /not declared/],
    ['a missing reason', {}, /not declared/],
    ['an inherited property name as reason', { reason: 'toString' }, /not declared/],
    ['an undeclared fact', { reason: 'lux_high', facts: { lux: 1, threshold: 2, extra: 3 } }, /"extra" is not declared/],
    ['a missing fact', { reason: 'lux_high', facts: { lux: 1 } }, /"threshold" must be/],
    ['facts missing entirely', { reason: 'lux_high' }, /supplied none/],
    ['facts for a reason that declares none', { reason: 'lights_on', facts: { lux: 1 } }, /declares no facts/],
    ['a NaN fact', { reason: 'lux_high', facts: { lux: NaN, threshold: 2 } }, /finite number/],
    ['an Infinity fact', { reason: 'lux_high', facts: { lux: Infinity, threshold: 2 } }, /finite number/],
    ['an object fact', { reason: 'lux_high', facts: { lux: { a: 1 }, threshold: 2 } }, /"lux" must be/],
    ['an array fact', { reason: 'lux_high', facts: { lux: [1], threshold: 2 } }, /"lux" must be/],
    ['an undefined fact', { reason: 'lux_high', facts: { lux: undefined, threshold: 2 } }, /"lux" must be/],
  ])('throws on %s', (_name, decision, message) => {
    expect(() => resolveDeclaredReason(reasons, decision)).toThrow(message);
  });
});

describe('validateReasonDeclarations', () => {
  it('is exported for direct use and throws with the automation id', () => {
    expect(() => validateReasonDeclarations('a:b', null)).toThrow(/automation "a:b"/);
  });
});
