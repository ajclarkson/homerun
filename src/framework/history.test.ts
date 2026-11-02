import { describe, it, expect, vi, afterEach } from 'vitest';
import { HistoryBuffer, classify, parseSeed } from './history.js';
import type { HistoryEntry } from './history.js';
import type { ObsEvent } from './event-publisher.js';

const base = {
  schema: 'home.events.v2' as const,
  correlation_id: 'c1',
  root_correlation_id: 'c1',
  automation_id: 'room:lighting',
  location: 'room',
  subsystem: 'lighting',
  timestamp: '2026-11-02T10:00:00.000Z',
};
const trigger = { type: 'on_start' as const };
const call = { type: 'ha.call_service' as const, domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };

const decision = (extra: Record<string, unknown>): ObsEvent =>
  ({ ...base, event_type: 'decision', trigger, decision: 'no_action', actions: [], hasAction: false, ...extra }) as ObsEvent;

describe('classify — decisions', () => {
  it('stores a declared acted decision with its reason, outcome and facts', () => {
    const entry = classify(decision({ outcome: 'acted', reason: 'lights_on', facts: { lux: 3 }, hasAction: true }));
    expect(entry).toEqual({
      ts: base.timestamp, location: 'room', automation_id: 'room:lighting', subsystem: 'lighting',
      kind: 'decision', decision: 'no_action', reason: 'lights_on', outcome: 'acted', facts: { lux: 3 }, trigger,
    });
  });

  it('stores a declined decision even though it carries no action', () => {
    expect(classify(decision({ outcome: 'declined', reason: 'lux_high' }))?.outcome).toBe('declined');
  });

  it('drops an ignored decision, even one that carries an action', () => {
    expect(classify(decision({ outcome: 'ignored', reason: 'startup', hasAction: true }))).toBeUndefined();
  });

  it('stores an undeclared decision only when it has an action, without an outcome', () => {
    expect(classify(decision({ hasAction: true, reason: 'free_text' }))).toMatchObject({ kind: 'decision', reason: 'free_text' });
    expect(classify(decision({ hasAction: true }))).not.toHaveProperty('outcome');
    expect(classify(decision({ hasAction: false }))).toBeUndefined();
  });
});

describe('classify — aborts', () => {
  const abortEvent = (extra: Record<string, unknown>): ObsEvent =>
    ({ ...base, event_type: 'abort', trigger, ...extra }) as ObsEvent;

  it('stores unavailable_input with the entity as structured detail', () => {
    expect(classify(abortEvent({ abort_kind: 'unavailable_input', entity: 'sensor.example' }))).toMatchObject({
      kind: 'abort', trigger, detail: { abort_kind: 'unavailable_input', entity: 'sensor.example' },
    });
  });

  it('stores a guard abort with its reason', () => {
    expect(classify(abortEvent({ abort_kind: 'guard', reason: 'no_sensor' }))).toMatchObject({
      kind: 'abort', reason: 'no_sensor', detail: { abort_kind: 'guard' },
    });
  });

  it('stores unhandled_error', () => {
    expect(classify(abortEvent({ abort_kind: 'unhandled_error' }))?.detail).toEqual({ abort_kind: 'unhandled_error' });
  });

  it('drops a disabled abort', () => {
    expect(classify(abortEvent({ abort_kind: 'disabled' }))).toBeUndefined();
  });
});

describe('classify — action events', () => {
  const event = (extra: Record<string, unknown>): ObsEvent => ({ ...base, ...extra }) as ObsEvent;

  it('stores a failed action_result as action_failed with service and entity', () => {
    expect(classify(event({ event_type: 'action_result', action: call, status: 'error', error: 'boom' }))).toEqual({
      ts: base.timestamp, location: 'room', automation_id: 'room:lighting', subsystem: 'lighting',
      kind: 'action_failed', detail: { failure: 'error', action: 'light.turn_on', entity: 'light.example' },
    });
  });

  it('never carries the error text', () => {
    expect(JSON.stringify(classify(event({ event_type: 'action_result', action: call, status: 'error', error: 'secret boom' }))))
      .not.toContain('boom');
  });

  it('stores an ack timeout with the unresponsive entity', () => {
    expect(classify(event({ event_type: 'action_ack_timeout', action: call, entity: 'light.example', expected: { state: 'on' } })))
      .toMatchObject({ kind: 'action_failed', detail: { failure: 'ack_timeout', action: 'light.turn_on', entity: 'light.example' } });
  });

  it('labels a non-service action by its type and omits the entity', () => {
    const publish = { type: 'mqtt.publish' as const, topic: 't', payload: 'p' };
    expect(classify(event({ event_type: 'action_result', action: publish, status: 'error' })))
      .toMatchObject({ detail: { failure: 'error', action: 'mqtt.publish' } });
  });

  it('drops started and successful results', () => {
    expect(classify(event({ event_type: 'action_started', action: call }))).toBeUndefined();
    expect(classify(event({ event_type: 'action_result', action: call, status: 'ok' }))).toBeUndefined();
  });
});

describe('HistoryBuffer', () => {
  const entry = (n: number): HistoryEntry => ({
    ts: `2026-11-02T10:00:0${n}.000Z`, location: 'room', automation_id: 'a', subsystem: 's', kind: 'decision',
  });

  it('keeps newest first', () => {
    const buffer = new HistoryBuffer(5);
    buffer.push(entry(1)); buffer.push(entry(2));
    expect(buffer.payload().entries.map((e) => e.ts.slice(18, 19))).toEqual(['2', '1']);
  });

  it('drops the oldest beyond its size', () => {
    const buffer = new HistoryBuffer(2);
    for (const n of [1, 2, 3]) buffer.push(entry(n));
    expect(buffer.payload().entries.map((e) => e.ts.slice(18, 19))).toEqual(['3', '2']);
  });

  it('trims a larger seed to its size', () => {
    const buffer = new HistoryBuffer(2);
    buffer.load([entry(3), entry(2), entry(1)]);
    expect(buffer.payload().entries).toHaveLength(2);
  });

  it('does not let a caller mutate it through the payload', () => {
    const buffer = new HistoryBuffer(2);
    buffer.push(entry(1));
    buffer.payload().entries.length = 0;
    expect(buffer.payload().entries).toHaveLength(1);
  });

  it.each([0, -1, 1.5, 201, NaN])('rejects size %s', (size) => {
    expect(() => new HistoryBuffer(size)).toThrow(/history size/);
  });
});

describe('parseSeed', () => {
  afterEach(() => vi.restoreAllMocks());
  const entry = { ts: base.timestamp, location: 'room', automation_id: 'a', subsystem: 's', kind: 'abort' };
  const raw = (entries: unknown[]) => JSON.stringify({ schema: 'home.history.v1', entries });

  it('returns a valid seed', () => {
    expect(parseSeed('homerun/room/history', raw([entry]), 'room')?.entries).toHaveLength(1);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['a wrong schema', JSON.stringify({ schema: 'other', entries: [] })],
    ['an entry that breaks the schema', raw([{ ...entry, kind: 'bogus' }])],
  ])('warns and returns undefined for %s', (_name, payload) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSeed('homerun/room/history', payload, 'room')).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects a location topic holding another location\'s entries', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseSeed('homerun/other/history', raw([entry]), 'other')).toBeUndefined();
  });

  it('accepts mixed locations on the house topic', () => {
    expect(parseSeed('homerun/history', raw([entry, { ...entry, location: 'hall' }]))?.entries).toHaveLength(2);
  });
});
