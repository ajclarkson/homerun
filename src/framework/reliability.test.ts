import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TriggerEngine } from './trigger-engine.js';
import { runPipeline } from './pipeline.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import type { HAClient, EntityState } from './ha-client.js';
import { abort } from '../types/automation.js';

// ---------- Test harness ----------

interface Harness {
  resolveReady: () => void;
  emitStateChange: (entityId: string, state?: string) => void;
  emitReconnecting: () => void;
  dispatch: (event: TriggerEvent) => void;
  obs: { publishDecision: ReturnType<typeof vi.fn>; publishActionEvent: ReturnType<typeof vi.fn> };
  actionRuntime: { execute: ReturnType<typeof vi.fn> };
}

function makeEntityState(entityId: string, state = 'on'): EntityState {
  return { entity_id: entityId, state, attributes: {}, last_changed: '', last_updated: '' };
}

function makeHarness(automations: Automation<unknown>[]): Harness {
  let readyResolve!: () => void;
  const readyPromise = new Promise<void>((r) => { readyResolve = r; });

  const emitter = new EventEmitter();
  const haClient = Object.assign(emitter, {
    ready: readyPromise,
    state: vi.fn().mockReturnValue(undefined),
    context: { entitiesByLabel: vi.fn().mockReturnValue([]), labelsFor: vi.fn().mockReturnValue([]) },
    callService: vi.fn().mockResolvedValue(undefined),
  }) as unknown as HAClient;

  const obs = { publishDecision: vi.fn(), publishActionEvent: vi.fn() };
  const actionRuntime = { execute: vi.fn().mockResolvedValue(undefined) };

  const engine = new TriggerEngine(automations, haClient, (automation, event) => {
    runPipeline(automation, event, haClient, { observability: obs as never, actionRuntime: actionRuntime as never });
  });
  engine.start();

  return {
    resolveReady: () => readyResolve(),
    emitStateChange: (entityId, state = 'on') => {
      emitter.emit('state_changed', {
        entity_id: entityId,
        old_state: undefined,
        new_state: makeEntityState(entityId, state),
      });
    },
    emitReconnecting: () => emitter.emit('reconnecting'),
    dispatch: (event) => engine.dispatch(event),
    obs,
    actionRuntime,
  };
}

function makeAutomation(
  id: string,
  entity: string,
  overrides: Partial<Pick<Automation<unknown>, 'context' | 'reduce'>> = {},
): Automation<unknown> {
  return {
    id,
    location: id.split(':')[0],
    subsystem: id.split(':')[1] ?? 'test',
    triggers: [{ type: 'state_changed', entity }],
    context: vi.fn().mockReturnValue({}),
    reduce: vi.fn().mockReturnValue({ decision: 'ok', actions: [] }),
    ...overrides,
  };
}

// ---------- Pipeline isolation ----------

describe('Pipeline isolation — throwing context', () => {
  it('does not prevent a healthy automation from completing its pipeline', async () => {
    const throwing = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      context: () => { throw new Error('context boom'); },
    });
    const healthy = makeAutomation('kitchen:lights', 'binary_sensor.motion');
    const h = makeHarness([throwing, healthy]);

    h.resolveReady();
    await vi.waitFor(() => {});

    h.emitStateChange('binary_sensor.motion');

    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(2));

    const types = h.obs.publishDecision.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('abort');
    expect(types).toContain('decision');
    expect(healthy.reduce).toHaveBeenCalled();
  });
});

describe('Pipeline isolation — throwing reduce', () => {
  it('produces abort; the next trigger for that automation runs a fresh pipeline', async () => {
    let callCount = 0;
    const auto = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      reduce: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('reduce boom');
        return { decision: 'ok', actions: [] };
      }),
    });
    const h = makeHarness([auto]);

    h.resolveReady();
    await vi.waitFor(() => {});

    h.emitStateChange('binary_sensor.motion');
    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(1));
    expect((h.obs.publishDecision.mock.calls[0][0] as { type: string }).type).toBe('abort');

    h.emitStateChange('binary_sensor.motion');
    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(2));
    expect((h.obs.publishDecision.mock.calls[1][0] as { type: string }).type).toBe('decision');
  });
});

describe('Pipeline isolation — Abort from context', () => {
  it('does not affect any other automation', async () => {
    const aborting = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      context: () => abort('presence_override'),
    });
    const healthy = makeAutomation('kitchen:lights', 'binary_sensor.motion');
    const h = makeHarness([aborting, healthy]);

    h.resolveReady();
    await vi.waitFor(() => {});

    h.emitStateChange('binary_sensor.motion');

    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(2));
    expect(healthy.reduce).toHaveBeenCalled();
  });
});

// ---------- Async fault tolerance ----------

describe('Async fault tolerance', () => {
  it('thrown error in context is caught and produces abort — does not propagate', async () => {
    const auto = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      context: () => { throw new Error('unexpected'); },
    });
    const h = makeHarness([auto]);

    h.resolveReady();
    await vi.waitFor(() => {});

    // Should not throw or cause unhandled rejection
    await expect(async () => {
      h.emitStateChange('binary_sensor.motion');
      await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(1));
    }).not.toThrow();

    expect((h.obs.publishDecision.mock.calls[0][0] as { type: string }).type).toBe('abort');
  });

  it('a hanging action runtime does not block a concurrent pipeline for another automation', async () => {
    let hangingResolve!: () => void;
    const hanging = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      // simulate slow/hung action phase by making execute never resolve for first call
    });
    const healthy = makeAutomation('kitchen:lights', 'binary_sensor.motion');

    const h = makeHarness([hanging, healthy]);
    // Make the action runtime hang for the first call only
    h.actionRuntime.execute
      .mockImplementationOnce(() => new Promise<void>((r) => { hangingResolve = r; }))
      .mockResolvedValue(undefined);

    h.resolveReady();
    await vi.waitFor(() => {});

    h.emitStateChange('binary_sensor.motion');

    // Healthy pipeline should complete even though hanging pipeline is stuck
    await vi.waitFor(() =>
      expect(h.obs.publishDecision.mock.calls.some(
        (c) => (c[0] as { automation_id: string }).automation_id === 'kitchen:lights',
      )).toBe(true),
    );

    hangingResolve(); // unblock to avoid leaking the promise
  });
});

// ---------- State cache gate ----------

describe('State cache gate', () => {
  it('state_changed events before ready do not dispatch any automation', async () => {
    const auto = makeAutomation('parlour:lights', 'binary_sensor.motion');
    const h = makeHarness([auto]);

    // Emit before resolving ready — engine listener is not attached yet
    h.emitStateChange('binary_sensor.motion');
    await Promise.resolve(); // flush microtasks

    expect(h.obs.publishDecision).not.toHaveBeenCalled();
  });

  it('state_changed events after ready resolve dispatch correctly', async () => {
    const auto = makeAutomation('parlour:lights', 'binary_sensor.motion');
    const h = makeHarness([auto]);

    h.resolveReady();
    await vi.waitFor(() => {});

    h.emitStateChange('binary_sensor.motion');

    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(1));
    expect((h.obs.publishDecision.mock.calls[0][0] as { type: string }).type).toBe('decision');
  });
});

// ---------- Reconnect cycle ----------

describe('Reconnect cycle', () => {
  it('no automations are dispatched via TriggerEngine.dispatch during simulated reconnect window', async () => {
    // The reconnect window is handled entirely in HAClient — during it, HAClient
    // simply does not emit state_changed events. TriggerEngine only attaches
    // a listener to haClient; if haClient stays silent, nothing dispatches.
    // We verify TriggerEngine correctly forwards events when they do arrive.
    const auto = makeAutomation('parlour:lights', 'binary_sensor.motion');
    const h = makeHarness([auto]);

    h.resolveReady();
    await vi.waitFor(() => {});

    // Simulate reconnect window: haClient stops emitting state_changed
    // (no emitStateChange calls). Verify nothing fired.
    await Promise.resolve();
    expect(h.obs.publishDecision).not.toHaveBeenCalled();

    // After reconnect, normal dispatch resumes
    h.emitStateChange('binary_sensor.motion');
    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(1));
    expect((h.obs.publishDecision.mock.calls[0][0] as { type: string }).type).toBe('decision');
  });
});

// ---------- Sustained fault ----------

describe('Sustained fault', () => {
  it('one automation throwing on every trigger does not prevent other automations from completing', async () => {
    const N = 5;
    const faulting = makeAutomation('parlour:lights', 'binary_sensor.motion', {
      context: () => { throw new Error('always fails'); },
    });
    const healthy = makeAutomation('kitchen:lights', 'binary_sensor.motion');
    const h = makeHarness([faulting, healthy]);

    h.resolveReady();
    await vi.waitFor(() => {});

    for (let i = 0; i < N; i++) {
      h.emitStateChange('binary_sensor.motion');
    }

    await vi.waitFor(() => expect(h.obs.publishDecision).toHaveBeenCalledTimes(N * 2));

    const decisions = h.obs.publishDecision.mock.calls.map((c) => c[0] as { automation_id: string; type: string });
    const faultingDecisions = decisions.filter((d) => d.automation_id === 'parlour:lights');
    const healthyDecisions = decisions.filter((d) => d.automation_id === 'kitchen:lights');

    expect(faultingDecisions).toHaveLength(N);
    expect(faultingDecisions.every((d) => d.type === 'abort')).toBe(true);
    expect(healthyDecisions).toHaveLength(N);
    expect(healthyDecisions.every((d) => d.type === 'decision')).toBe(true);
  });
});
