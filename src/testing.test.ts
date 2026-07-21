import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from './testing.js';
import { defineAutomation, abort } from './types/automation.js';
import type { TriggerEvent } from './types/triggers.js';

const onStartEvent: TriggerEvent = { type: 'on_start', correlation_id: 'test-cid' };

const stateChangedEvent: TriggerEvent = {
  type: 'state_changed',
  entity_id: 'binary_sensor.motion',
  old_state: { entity_id: 'binary_sensor.motion', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.motion', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};

// ---------- testAutomation ----------

describe('testAutomation', () => {
  it('returns the Decision from reduce on the happy path', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: () => ({ enabled: true }),
      reduce: ({ enabled }) => ({ decision: enabled ? 'on' : 'off', actions: [] }),
    });

    const result = testAutomation(automation, { event: onStartEvent });
    expect(result.decision).toBe('on');
  });

  it('throws when context aborts', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: () => abort('not_ready'),
      reduce: () => ({ decision: 'ok', actions: [] }),
    });

    expect(() => testAutomation(automation, { event: onStartEvent })).toThrow('automation aborted: not_ready');
  });

  it('passes injected state to context', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: (state) => ({ mode: state('sensor.mode')?.state }),
      reduce: ({ mode }) => ({ decision: mode ?? 'unknown', actions: [] }),
    });

    const result = testAutomation(automation, {
      event: onStartEvent,
      state: { 'sensor.mode': { state: 'home' } },
    });

    expect(result.decision).toBe('home');
  });

  it('returns undefined for entities not in the state map', () => {
    let captured: string | undefined;
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: (state) => { captured = state('sensor.unknown')?.state; return {}; },
      reduce: () => ({ decision: 'ok', actions: [] }),
    });

    testAutomation(automation, { event: onStartEvent });
    expect(captured).toBeUndefined();
  });

  it('passes the trigger event as the third context argument', () => {
    let capturedEvent: TriggerEvent | undefined;
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'state_changed', entity: 'binary_sensor.motion' }],
      context: (_state, _ha, event) => { capturedEvent = event; return {}; },
      reduce: () => ({ decision: 'ok', actions: [] }),
    });

    testAutomation(automation, { event: stateChangedEvent });
    expect(capturedEvent).toBe(stateChangedEvent);
  });

  it('exposes old_state from a state_changed event via the event argument', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'state_changed', entity: 'binary_sensor.motion' }],
      context: (_state, _ha, event) => ({
        justTurnedOn: event.type === 'state_changed' &&
          event.old_state?.state === 'off' &&
          event.new_state.state === 'on',
      }),
      reduce: ({ justTurnedOn }) => ({ decision: justTurnedOn ? 'act' : 'skip', actions: [] }),
    });

    const result = testAutomation(automation, { event: stateChangedEvent });
    expect(result.decision).toBe('act');
  });

  it('ha context defaults to returning empty arrays', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: (_state, ha) => ({
        lights: ha.entitiesByLabel('lights'),
        labels: ha.labelsFor('light.x'),
        areaEntities: ha.entitiesByArea('kitchen'),
      }),
      reduce: ({ lights, labels, areaEntities }) => ({
        decision: 'ok',
        actions: [],
        inputs: { lights, labels, areaEntities },
      }),
    });

    const result = testAutomation(automation, { event: onStartEvent });
    expect(result.inputs?.lights).toEqual([]);
    expect(result.inputs?.labels).toEqual([]);
    expect(result.inputs?.areaEntities).toEqual([]);
  });

  it('accepts custom ha context overrides', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: (_state, ha) => ({ lights: ha.entitiesByLabel('lights') }),
      reduce: ({ lights }) => ({ decision: 'ok', actions: [], inputs: { lights } }),
    });

    const result = testAutomation(automation, {
      event: onStartEvent,
      ha: { entitiesByLabel: () => ['light.kitchen', 'light.parlour'] },
    });

    expect(result.inputs?.lights).toEqual(['light.kitchen', 'light.parlour']);
  });

  it('fills in default EntityState fields for injected state entries', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: (state) => ({ entity: state('light.kitchen') }),
      reduce: ({ entity }) => ({ decision: 'ok', actions: [], inputs: { entity } }),
    });

    const result = testAutomation(automation, {
      event: onStartEvent,
      state: { 'light.kitchen': { state: 'on', attributes: { brightness: 200 } } },
    });

    const entity = result.inputs?.entity as { entity_id: string; state: string; attributes: Record<string, unknown> };
    expect(entity.entity_id).toBe('light.kitchen');
    expect(entity.state).toBe('on');
    expect(entity.attributes).toEqual({ brightness: 200 });
  });
});

// ---------- testAbort ----------

describe('testAbort', () => {
  it('returns Abort when context aborts', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: () => abort('not_ready'),
      reduce: () => ({ decision: 'ok', actions: [] }),
    });

    const result = testAbort(automation, { event: onStartEvent });
    expect(result.reason).toBe('not_ready');
  });

  it('throws when automation produces a Decision instead of aborting', () => {
    const automation = defineAutomation({
      id: 'test',
      location: 'test',
      subsystem: 'test',
      triggers: [{ type: 'on_start' }],
      context: () => ({ enabled: true }),
      reduce: () => ({ decision: 'on', actions: [] }),
    });

    expect(() => testAbort(automation, { event: onStartEvent })).toThrow('expected abort but got decision: on');
  });
});
