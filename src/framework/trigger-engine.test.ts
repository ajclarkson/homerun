import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TriggerEngine, parseButtonAction } from './trigger-engine.js';
import { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import type { HAClient, EntityState, StateChangedEvent } from './ha-client.js';
import type { MqttClient } from 'mqtt';

// ---------- Helpers ----------

function makeEntityState(state: string, entity_id = 'light.test'): EntityState {
  return { entity_id, state, attributes: {}, last_changed: 'T', last_updated: 'T' };
}

function makeAutomation(
  id: string,
  triggers: Automation<unknown>['triggers'],
): Automation<unknown> {
  return {
    id,
    location: 'test',
    subsystem: 'test',
    triggers,
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
  };
}

function makeRegistry(...automations: Automation<unknown>[]): AutomationRegistry {
  const registry = new AutomationRegistry();
  for (const a of automations) registry.register(a);
  return registry;
}

// Minimal MQTT client mock: EventEmitter with subscribe/on stubs.
function makeMockMqttClient() {
  const emitter = new EventEmitter();
  const subscribed = new Set<string>();
  const client = {
    subscribe: vi.fn((topic: string) => { subscribed.add(topic); }),
    on: (event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb),
    publish: (topic: string, payload: string) => emitter.emit('message', topic, Buffer.from(payload)),
  } as unknown as MqttClient;
  return { client, publish: (topic: string, payload: string) => emitter.emit('message', topic, Buffer.from(payload)), subscribed };
}

// Minimal HAClient mock: real EventEmitter + manually resolvable ready promise.
// emitStateChanged also updates the internal state cache so haClient.state() reflects it.
function makeMockHAClient() {
  const emitter = new EventEmitter();
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
  const currentStates = new Map<string, EntityState>();

  const client = Object.assign(emitter, {
    ready,
    state: (entityId: string) => currentStates.get(entityId),
  }) as unknown as HAClient;

  const emitStateChanged = (event: StateChangedEvent) => {
    currentStates.set(event.entity_id, event.new_state);
    emitter.emit('state_changed', event);
  };

  return {
    client,
    resolveReady: () => readyResolve(),
    emitStateChanged,
    // Update state without emitting an event — simulates external state drift.
    setCurrentState: (entityId: string, state: string) => {
      currentStates.set(entityId, makeEntityState(state, entityId));
    },
  };
}

// ---------- parseButtonAction ----------

describe('parseButtonAction', () => {
  it.each([
    ['short_press', { button: undefined, pressType: 'short' }],
    ['button-short-press', { button: undefined, pressType: 'short' }],
    ['1_short_release', { button: '1', pressType: 'short' }],
    ['2_click', { button: '2', pressType: 'short' }],
    ['on', { button: undefined, pressType: 'short' }],
    ['toggle', { button: undefined, pressType: 'short' }],
    ['hold', { button: undefined, pressType: 'hold' }],
    ['long_press', { button: undefined, pressType: 'hold' }],
    ['button-long-press', { button: undefined, pressType: 'hold' }],
    ['1_long_release', { button: '1', pressType: 'hold' }],
  ] as const)('classifies "%s"', (state, expected) => {
    expect(parseButtonAction(state)).toEqual(expected);
  });

  it('returns null for unrecognised state', () => {
    expect(parseButtonAction('unavailable')).toBeNull();
    expect(parseButtonAction('')).toBeNull();
    expect(parseButtonAction('off')).toBeNull();
    // 'press' is raw button-down, not a confirmed action — confirmed action is 'on'/'off'/'toggle'
    expect(parseButtonAction('press')).toBeNull();
    expect(parseButtonAction('release')).toBeNull();
    expect(parseButtonAction('brightness_step_down')).toBeNull();
  });
});

// ---------- TriggerEngine ----------

describe('TriggerEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- state_changed ----------

  describe('state_changed', () => {
    it('routes to automation with matching string entity', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.kitchen' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: makeEntityState('off', 'light.kitchen'),
        new_state: makeEntityState('on', 'light.kitchen'),
        correlation_id: 'test-cid',
      });

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'state_changed', entity_id: 'light.kitchen' }));
    });

    it('routes to automation with matching RegExp entity', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: /^sensor\..*_temperature$/ }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'sensor.kitchen_temperature',
        old_state: undefined,
        new_state: makeEntityState('21', 'sensor.kitchen_temperature'),
        correlation_id: 'test-cid',
      });

      expect(onMatch).toHaveBeenCalledOnce();
    });

    it('does not route non-matching entity', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.kitchen' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.bedroom',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.bedroom'),
        correlation_id: 'test-cid',
      });

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('does not route before HAClient.ready resolves', async () => {
      const { client, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.kitchen' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      // Do NOT resolve ready — listener not wired yet.

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.kitchen'),
        correlation_id: 'test-cid',
      });

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('fires each matching automation exactly once per event', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      // Automation with two triggers for the same entity — should fire only once.
      const automation = makeAutomation('a', [
        { type: 'state_changed', entity: 'light.kitchen' },
        { type: 'state_changed', entity: /^light\./ },
      ]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.kitchen'),
        correlation_id: 'test-cid',
      });

      expect(onMatch).toHaveBeenCalledOnce();
    });
  });

  // ---------- on_start ----------

  describe('on_start', () => {
    it('routes when dispatched by Scheduler', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'on_start' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.dispatch({ type: 'on_start', correlation_id: 'test-cid' });

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'on_start' }));
    });
  });

  // ---------- timer_expired ----------

  describe('timer_expired', () => {
    it('routes to automation with matching timerKey', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.dispatch({ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay', correlation_id: 'test-cid' });

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' }));
    });

    it('does not route for a different timerKey', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.dispatch({ type: 'timer_expired', timerKey: 'parlour:lights:off-delay', correlation_id: 'test-cid' });

      expect(onMatch).not.toHaveBeenCalled();
    });
  });

  // ---------- button gestures ----------

  describe('button gestures', () => {
    async function setupButtonEngine(entity = 'sensor.button') {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [
        { type: 'button', entity, gesture: 'single_press' },
        { type: 'button', entity, gesture: 'double_press' },
        { type: 'button', entity, gesture: 'hold' },
      ]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      return { onMatch, emitStateChanged, client, automation };
    }

    function press(emitStateChanged: ReturnType<typeof makeMockHAClient>['emitStateChanged'], entity = 'sensor.button', state = 'short_press') {
      emitStateChanged({ entity_id: entity, old_state: undefined, new_state: makeEntityState(state, entity), correlation_id: 'test-cid' });
    }

    it('resolves single press after 400ms window', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged);
      expect(onMatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'single_press' }));
    });

    it('resolves double press when second short press arrives within 400ms', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged);
      vi.advanceTimersByTime(200);
      press(emitStateChanged);

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'double_press' }));
    });

    it('does not resolve as double press when second press arrives after 400ms', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged);
      vi.advanceTimersByTime(400); // single_press fires
      press(emitStateChanged);    // starts a new window
      vi.advanceTimersByTime(400); // second single_press fires

      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onMatch.mock.calls.every(([, e]) => (e as TriggerEvent & { gesture: string }).gesture === 'single_press')).toBe(true);
    });

    it('resolves hold immediately without waiting for 400ms window', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged, 'sensor.button', 'hold');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'hold' }));
    });

    it('fires hold only once when hold state repeats while button is held', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged, 'sensor.button', 'hold');
      press(emitStateChanged, 'sensor.button', 'hold');
      press(emitStateChanged, 'sensor.button', 'hold');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'hold' }));
    });

    it('fires hold again after release resets the dedup', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged, 'sensor.button', 'hold');
      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('', 'sensor.button'), correlation_id: 'reset' });
      press(emitStateChanged, 'sensor.button', 'hold');

      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onMatch.mock.calls.every(([, e]) => (e as { gesture: string }).gesture === 'hold')).toBe(true);
    });

    it('does not fire single_press for raw "press" state — only confirmed actions like "on"', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('press', 'sensor.button'), correlation_id: 'test-cid' });
      vi.advanceTimersByTime(400);

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('does not fire single_press on hold sequence (press → brightness_step_down → hold)', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('press', 'sensor.button'), correlation_id: 'cid-1' });
      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('brightness_step_down', 'sensor.button'), correlation_id: 'cid-2' });
      press(emitStateChanged, 'sensor.button', 'hold');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'hold' }));
    });

    it('hold during resolving state cancels single press and fires hold', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged);               // short → resolving
      vi.advanceTimersByTime(200);
      press(emitStateChanged, 'sensor.button', 'hold'); // hold → cancels window

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'hold' }));
      // Ensure single_press does not fire after
      vi.advanceTimersByTime(400);
      expect(onMatch).toHaveBeenCalledOnce();
    });

    it('two different entities do not interfere', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const a1 = makeAutomation('a1', [
        { type: 'button', entity: 'sensor.button_a', gesture: 'single_press' },
      ]);
      const a2 = makeAutomation('a2', [
        { type: 'button', entity: 'sensor.button_b', gesture: 'double_press' },
      ]);

      const engine = new TriggerEngine(makeRegistry(a1, a2), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      // Short press on button_a starts its 400ms window.
      press(emitStateChanged, 'sensor.button_a');
      // Short press on button_b starts its own window independently.
      press(emitStateChanged, 'sensor.button_b');
      press(emitStateChanged, 'sensor.button_b'); // double press on b

      // b resolves as double_press immediately.
      expect(onMatch).toHaveBeenCalledWith(a2, expect.objectContaining({ gesture: 'double_press' }));

      // a still waiting — advance its 400ms window.
      vi.advanceTimersByTime(400);
      expect(onMatch).toHaveBeenCalledWith(a1, expect.objectContaining({ gesture: 'single_press' }));
    });

    it('fires single_press immediately when no double_press trigger is declared', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [
        { type: 'button', entity: 'sensor.button', gesture: 'single_press' },
        { type: 'button', entity: 'sensor.button', gesture: 'hold' },
        // no double_press — single_press should fire without waiting
      ]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      press(emitStateChanged);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'single_press' }));
    });

    it('still waits 400ms when double_press is declared alongside single_press', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine(); // declares all three

      press(emitStateChanged);
      expect(onMatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'single_press' }));
    });

    it('passes numeric button identifier through to the trigger event', async () => {
      const { onMatch, emitStateChanged } = await setupButtonEngine();

      press(emitStateChanged, 'sensor.button', '2_short_release');
      vi.advanceTimersByTime(400);

      expect(onMatch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ gesture: 'single_press', button: '2' }),
      );
    });
  });

  // ---------- state_changed with duration ----------

  describe('state_changed with duration', () => {
    it('delays dispatch by duration ms and fires if state still matches', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 5000 }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: makeEntityState('on', 'binary_sensor.motion'), new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'test-cid' });

      expect(onMatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'state_changed', entity_id: 'binary_sensor.motion' }));
    });

    it('does not dispatch if state has changed by the time the timer fires', async () => {
      const { client, resolveReady, emitStateChanged, setCurrentState } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 5000 }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: makeEntityState('on', 'binary_sensor.motion'), new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'test-cid' });
      // State reverts without a new event (re-check will fail).
      setCurrentState('binary_sensor.motion', 'on');

      vi.advanceTimersByTime(5000);
      expect(onMatch).not.toHaveBeenCalled();
    });

    it('cancels the pending timer and restarts it when a new state_changed arrives', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 5000 }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      // First event: off, 5000ms timer starts.
      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: undefined, new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'cid-1' });
      // At 2000ms the entity changes back — timer resets.
      vi.advanceTimersByTime(2000);
      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: makeEntityState('off', 'binary_sensor.motion'), new_state: makeEntityState('on', 'binary_sensor.motion'), correlation_id: 'cid-2' });

      // Original 5000ms timer would fire here (3000ms after second event) — no dispatch.
      vi.advanceTimersByTime(3000);
      expect(onMatch).not.toHaveBeenCalled();

      // Second timer fires 5000ms after second event.
      vi.advanceTimersByTime(2000);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ correlation_id: 'cid-2' }));
    });

    it('tracks two automations with different durations on the same entity independently', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const fast = makeAutomation('fast', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 1000 }]);
      const slow = makeAutomation('slow', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 5000 }]);

      const engine = new TriggerEngine(makeRegistry(fast, slow), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: undefined, new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'test-cid' });

      vi.advanceTimersByTime(1000);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(fast, expect.anything());

      vi.advanceTimersByTime(4000);
      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onMatch).toHaveBeenCalledWith(slow, expect.anything());
    });

    it('duration: 0 dispatches immediately like no duration', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 0 }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: undefined, new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'test-cid' });
      expect(onMatch).toHaveBeenCalledOnce();
    });

    it('preserves the original correlation_id through the delay', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'binary_sensor.motion', duration: 1000 }]);

      const engine = new TriggerEngine(makeRegistry(automation), client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'binary_sensor.motion', old_state: undefined, new_state: makeEntityState('off', 'binary_sensor.motion'), correlation_id: 'original-cid' });
      vi.advanceTimersByTime(1000);
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ correlation_id: 'original-cid' }));
    });
  });

  // ---------- button regex entity ----------

  describe('button regex entity', () => {
    it('fires for any entity matching a regex pattern', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const registry = makeRegistry(
        makeAutomation('a', [{ type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' }]),
      );

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'sensor.bedroom_button_adam_action', old_state: undefined, new_state: makeEntityState('hold', 'sensor.bedroom_button_adam_action'), correlation_id: 'test-cid' });
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'button', gesture: 'hold', entity_id: 'sensor.bedroom_button_adam_action' }));
    });

    it('fires for multiple entities matching the same pattern', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const registry = makeRegistry(
        makeAutomation('a', [{ type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' }]),
      );

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'sensor.bedroom_button_adam_action', old_state: undefined, new_state: makeEntityState('hold', 'sensor.bedroom_button_adam_action'), correlation_id: 'cid-1' });
      emitStateChanged({ entity_id: 'sensor.bedroom_button_wall_action', old_state: undefined, new_state: makeEntityState('hold', 'sensor.bedroom_button_wall_action'), correlation_id: 'cid-2' });
      expect(onMatch).toHaveBeenCalledTimes(2);
    });

    it('does not route non-matching entities through the button handler', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const registry = makeRegistry(
        makeAutomation('a', [
          { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' },
          { type: 'state_changed', entity: 'sensor.other' },
        ]),
      );

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'sensor.other', old_state: undefined, new_state: makeEntityState('on', 'sensor.other'), correlation_id: 'test-cid' });
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'state_changed' }));
    });

    it('respects double_press window for regex-matched entities', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const registry = makeRegistry(
        makeAutomation('a', [
          { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'single_press' },
          { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'double_press' },
        ]),
      );

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({ entity_id: 'sensor.bedroom_button_adam_action', old_state: undefined, new_state: makeEntityState('short_press', 'sensor.bedroom_button_adam_action'), correlation_id: 'cid-1' });
      expect(onMatch).not.toHaveBeenCalled();
      emitStateChanged({ entity_id: 'sensor.bedroom_button_adam_action', old_state: undefined, new_state: makeEntityState('short_press', 'sensor.bedroom_button_adam_action'), correlation_id: 'cid-2' });
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'double_press' }));
    });
  });

  // ---------- button handler hot-reload ----------

  describe('button handler hot-reload', () => {
    it('picks up a new button automation after registry change', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const registry = makeRegistry();

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      // Register a button automation after the engine has started.
      registry.register(makeAutomation('a', [{ type: 'button', entity: 'sensor.button', gesture: 'single_press' }]));

      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('short_press', 'sensor.button'), correlation_id: 'test-cid' });
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'button', gesture: 'single_press' }));
    });

    it('respects updated double_press config after registry change', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      // Initially registered with only single_press — no double_press window.
      const registry = makeRegistry(
        makeAutomation('a', [{ type: 'button', entity: 'sensor.button', gesture: 'single_press' }]),
      );

      const engine = new TriggerEngine(registry, client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      // Re-register with double_press added — button handler should rebuild and now wait.
      registry.register(makeAutomation('a', [
        { type: 'button', entity: 'sensor.button', gesture: 'single_press' },
        { type: 'button', entity: 'sensor.button', gesture: 'double_press' },
      ]));

      emitStateChanged({ entity_id: 'sensor.button', old_state: undefined, new_state: makeEntityState('short_press', 'sensor.button'), correlation_id: 'test-cid' });
      // Should NOT fire immediately now that double_press is declared.
      expect(onMatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gesture: 'single_press' }));
    });
  });

  // ---------- manual trigger ----------

  describe('manual trigger via homerun/trigger/+', () => {
    it('fires the named automation when a message arrives on homerun/trigger/{id}', async () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('parlour:lighting', [{ type: 'on_start' }]);

      const engine = new TriggerEngine(makeRegistry(automation), haClient, onMatch, mqttClient);
      engine.start();

      publish('homerun/trigger/parlour:lighting', '{}');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'on_start' }));
    });

    it('logs a warning and does not call onMatch for an unknown automation id', () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const engine = new TriggerEngine(makeRegistry(), haClient, onMatch, mqttClient);
      engine.start();

      publish('homerun/trigger/unknown:automation', '{}');

      expect(onMatch).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown:automation'));
      warnSpy.mockRestore();
    });

    it('subscribes to homerun/trigger/+ on start', () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, subscribed } = makeMockMqttClient();
      const engine = new TriggerEngine(makeRegistry(), haClient, vi.fn(), mqttClient);
      engine.start();
      expect(subscribed.has('homerun/trigger/+')).toBe(true);
    });

    it('does not interfere with regular mqtt_in messages on other topics', async () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'mqtt_in', topic: 'home/foo' }]);

      const engine = new TriggerEngine(makeRegistry(automation), haClient, onMatch, mqttClient);
      engine.start();

      publish('home/foo', 'hello');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'mqtt_in', topic: 'home/foo' }));
    });
  });

  // ---------- mqtt_in ----------

  describe('mqtt_in', () => {
    it('dispatches to automation when a message arrives on its declared topic', () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'mqtt_in', topic: 'home/foo' }]);

      const engine = new TriggerEngine(makeRegistry(automation), haClient, onMatch, mqttClient);
      engine.start();

      publish('home/foo', 'hello');

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(
        automation,
        expect.objectContaining({ type: 'mqtt_in', topic: 'home/foo', payload: 'hello' }),
      );
    });

    it('does not dispatch when message arrives on a different topic', () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'mqtt_in', topic: 'home/foo' }]);

      const engine = new TriggerEngine(makeRegistry(automation), haClient, onMatch, mqttClient);
      engine.start();

      publish('home/bar', 'hello');

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('dispatches to multiple automations subscribed to the same topic', () => {
      const { client: haClient } = makeMockHAClient();
      const { client: mqttClient, publish } = makeMockMqttClient();
      const onMatch = vi.fn();
      const a1 = makeAutomation('a1', [{ type: 'mqtt_in', topic: 'home/foo' }]);
      const a2 = makeAutomation('a2', [{ type: 'mqtt_in', topic: 'home/foo' }]);

      const engine = new TriggerEngine(makeRegistry(a1, a2), haClient, onMatch, mqttClient);
      engine.start();

      publish('home/foo', 'ping');

      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onMatch).toHaveBeenCalledWith(a1, expect.objectContaining({ type: 'mqtt_in', topic: 'home/foo' }));
      expect(onMatch).toHaveBeenCalledWith(a2, expect.objectContaining({ type: 'mqtt_in', topic: 'home/foo' }));
    });

    it('starts cleanly without an mqttClient when no mqtt_in automations are registered', () => {
      const { client: haClient } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.test' }]);

      expect(() => {
        const engine = new TriggerEngine(makeRegistry(automation), haClient, onMatch);
        engine.start();
      }).not.toThrow();
    });
  });
});
