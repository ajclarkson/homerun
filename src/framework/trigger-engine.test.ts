import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TriggerEngine, parseButtonAction } from './trigger-engine.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import type { HAClient, EntityState, StateChangedEvent } from './ha-client.js';

// ---------- Mock node-cron ----------

// vi.mock is hoisted — use vi.hoisted so the variable is available in the factory.
const { mockCronSchedule } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockCronSchedule: vi.fn((_expr: string, _cb: () => void): any => ({ stop: vi.fn() })),
}));
vi.mock('node-cron', () => ({ default: { schedule: mockCronSchedule } }));

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

// Minimal HAClient mock: real EventEmitter + manually resolvable ready promise.
function makeMockHAClient() {
  const emitter = new EventEmitter();
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });

  const client = Object.assign(emitter, { ready }) as unknown as HAClient;

  return {
    client,
    resolveReady: () => readyResolve(),
    emitStateChanged: (event: StateChangedEvent) => emitter.emit('state_changed', event),
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
  });
});

// ---------- TriggerEngine ----------

describe('TriggerEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCronSchedule.mockClear();
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

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: makeEntityState('off', 'light.kitchen'),
        new_state: makeEntityState('on', 'light.kitchen'),
      });

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, expect.objectContaining({ type: 'state_changed', entity_id: 'light.kitchen' }));
    });

    it('routes to automation with matching RegExp entity', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: /^sensor\..*_temperature$/ }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'sensor.kitchen_temperature',
        old_state: undefined,
        new_state: makeEntityState('21', 'sensor.kitchen_temperature'),
      });

      expect(onMatch).toHaveBeenCalledOnce();
    });

    it('does not route non-matching entity', async () => {
      const { client, resolveReady, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.kitchen' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.bedroom',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.bedroom'),
      });

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('does not route before HAClient.ready resolves', async () => {
      const { client, emitStateChanged } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'state_changed', entity: 'light.kitchen' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      // Do NOT resolve ready — listener not wired yet.

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.kitchen'),
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

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      emitStateChanged({
        entity_id: 'light.kitchen',
        old_state: undefined,
        new_state: makeEntityState('on', 'light.kitchen'),
      });

      expect(onMatch).toHaveBeenCalledOnce();
    });
  });

  // ---------- on_start ----------

  describe('on_start', () => {
    it('fires after ready with no delay', async () => {
      const { client, resolveReady } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'on_start' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, { type: 'on_start' });
    });

    it('fires after ready with delayMs', async () => {
      const { client, resolveReady } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'on_start', delayMs: 5000 }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await Promise.resolve(); // flush ready.then()

      vi.advanceTimersByTime(4999);
      expect(onMatch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onMatch).toHaveBeenCalledOnce();
    });

    it('does not fire before ready', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'on_start' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      vi.runAllTimers();

      expect(onMatch).not.toHaveBeenCalled();
    });

    it('fires each automation with on_start independently', async () => {
      const { client, resolveReady } = makeMockHAClient();
      const onMatch = vi.fn();
      const a1 = makeAutomation('a1', [{ type: 'on_start' }]);
      const a2 = makeAutomation('a2', [{ type: 'on_start', delayMs: 2000 }]);

      const engine = new TriggerEngine([a1, a2], client, onMatch);
      engine.start();
      resolveReady();
      await Promise.resolve();

      vi.advanceTimersByTime(0);
      expect(onMatch).toHaveBeenCalledWith(a1, { type: 'on_start' });
      expect(onMatch).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(2000);
      expect(onMatch).toHaveBeenCalledTimes(2);
      expect(onMatch).toHaveBeenCalledWith(a2, { type: 'on_start' });
    });
  });

  // ---------- timer_expired ----------

  describe('timer_expired', () => {
    it('routes to automation with matching timerKey', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.dispatch({ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' });

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, { type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' });
    });

    it('does not route for a different timerKey', () => {
      const { client } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.dispatch({ type: 'timer_expired', timerKey: 'parlour:lights:off-delay' });

      expect(onMatch).not.toHaveBeenCalled();
    });
  });

  // ---------- schedule ----------

  describe('schedule', () => {
    it('registers a cron job for schedule triggers', async () => {
      const { client, resolveReady } = makeMockHAClient();
      const automation = makeAutomation('a', [{ type: 'schedule', cron: '0 8 * * *' }]);

      const engine = new TriggerEngine([automation], client, vi.fn());
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      expect(mockCronSchedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
    });

    it('fires onMatch when cron job fires', async () => {
      const { client, resolveReady } = makeMockHAClient();
      const onMatch = vi.fn();
      const automation = makeAutomation('a', [{ type: 'schedule', cron: '0 8 * * *' }]);

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      // Invoke the registered cron callback directly.
      const [, cronCallback] = mockCronSchedule.mock.calls[0] as [string, () => void];
      cronCallback();

      expect(onMatch).toHaveBeenCalledOnce();
      expect(onMatch).toHaveBeenCalledWith(automation, { type: 'schedule', cron: '0 8 * * *' });
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

      const engine = new TriggerEngine([automation], client, onMatch);
      engine.start();
      resolveReady();
      await vi.runAllTimersAsync();

      return { onMatch, emitStateChanged, automation };
    }

    function press(emitStateChanged: ReturnType<typeof makeMockHAClient>['emitStateChanged'], entity = 'sensor.button', state = 'short_press') {
      emitStateChanged({ entity_id: entity, old_state: undefined, new_state: makeEntityState(state, entity) });
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

      const engine = new TriggerEngine([a1, a2], client, onMatch);
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
});
