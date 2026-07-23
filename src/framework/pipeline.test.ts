import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPipeline } from './pipeline.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import { abort } from '../types/automation.js';

// ---------- Mocks ----------

function makeDeps() {
  return {
    eventPublisher: { publishDecision: vi.fn(), publishActionEvent: vi.fn() },
    actionRuntime: { execute: vi.fn().mockResolvedValue(undefined) },
    metrics: { incrementCounter: vi.fn(), observeHistogram: vi.fn() },
  };
}

function makeHAClient() {
  return {
    state: vi.fn(),
    context: { entitiesByLabel: vi.fn(), labelsFor: vi.fn() },
  };
}

function makeAutomation(overrides: Partial<Automation<unknown>> = {}): Automation<unknown> {
  return {
    id: 'parlour:lighting',
    location: 'parlour',
    subsystem: 'lighting',
    triggers: [{ type: 'state_changed', entity: 'binary_sensor.parlour_sensor_motion' }],
    context: vi.fn().mockReturnValue({ lux: 40 }),
    reduce: vi.fn().mockReturnValue({ decision: 'lights_on', actions: [], inputs: { lux: 40 } }),
    ...overrides,
  };
}

const onStartEvent: TriggerEvent = { type: 'on_start', correlation_id: 'test-cid-pipeline' };

// ---------- Happy path ----------

describe('runPipeline — happy path', () => {
  let deps: ReturnType<typeof makeDeps>;
  let ha: ReturnType<typeof makeHAClient>;
  let auto: Automation<unknown>;

  beforeEach(() => {
    deps = makeDeps();
    ha = makeHAClient();
    auto = makeAutomation();
  });

  it('calls context with haClient.state, haClient.context, and the trigger event', async () => {
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.context).toHaveBeenCalledWith(ha.state, ha.context, onStartEvent);
  });

  it('passes old_state from state_changed event through to context', async () => {
    const stateChangedEvent: TriggerEvent = {
      type: 'state_changed',
      entity_id: 'light.test',
      old_state: { entity_id: 'light.test', state: 'off', attributes: {}, last_changed: 'T', last_updated: 'T' },
      new_state: { entity_id: 'light.test', state: 'on', attributes: {}, last_changed: 'T', last_updated: 'T' },
      correlation_id: 'test-cid',
    };
    let capturedEvent: TriggerEvent | undefined;
    const a = makeAutomation({ context: vi.fn().mockImplementation((_state: unknown, _ha: unknown, event: TriggerEvent) => { capturedEvent = event; return {}; }) });
    await runPipeline(a, stateChangedEvent, ha as never, deps as never);
    expect(capturedEvent?.type).toBe('state_changed');
    if (capturedEvent?.type === 'state_changed') {
      expect(capturedEvent.old_state?.state).toBe('off');
      expect(capturedEvent.new_state.state).toBe('on');
    }
  });

  it('calls reduce with the context result', async () => {
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.reduce).toHaveBeenCalledWith({ lux: 40 });
  });

  it('publishes a decision ObsEvent with correct fields', async () => {
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event).toMatchObject({
      schema: 'home.events.v1',
      automation_id: 'parlour:lighting',
      location: 'parlour',
      subsystem: 'lighting',
      event_type: 'decision',
      decision: 'lights_on',
    });
  });

  it('passes actions to actionRuntime.execute', async () => {
    const actions = [{ type: 'timer.cancel' as const, timerKey: 'k' }];
    auto = makeAutomation({ reduce: vi.fn().mockReturnValue({ decision: 'ok', actions }) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(deps.actionRuntime.execute).toHaveBeenCalledWith(actions, expect.objectContaining({ correlationId: expect.any(String) }));
  });

  it('uses the correlation_id from the event, not a generated one', async () => {
    const event: TriggerEvent = { type: 'on_start', correlation_id: 'fixed-id-abc' };
    await runPipeline(auto, event, ha as never, deps as never);
    const [obsEvent] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(obsEvent.correlation_id).toBe('fixed-id-abc');
  });

  it('correlation_id on ObsEvent matches the one passed to actionRuntime', async () => {
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [obsEvent] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    const [, ctx] = deps.actionRuntime.execute.mock.calls[0] as [unknown, { correlationId: string }];
    expect(obsEvent.correlation_id).toBe(ctx.correlationId);
  });

  it('defaults missing actions array to []', async () => {
    auto = makeAutomation({ reduce: vi.fn().mockReturnValue({ decision: 'ok' }) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [, ctx] = deps.actionRuntime.execute.mock.calls[0] as [unknown[], unknown];
    expect(ctx).toBeDefined();
    expect(deps.actionRuntime.execute).toHaveBeenCalledWith([], expect.anything());
  });
});

// ---------- Disabled automation ----------

describe('runPipeline — disabled automation', () => {
  it('publishes abort with reason disabled and skips context and reduce', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ enabled: false });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.context).not.toHaveBeenCalled();
    expect(auto.reduce).not.toHaveBeenCalled();
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.event_type).toBe('abort');
    expect(event.reason).toBe('disabled');
  });

  it('runs normally when enabled is true', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ enabled: true });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.context).toHaveBeenCalled();
    expect(auto.reduce).toHaveBeenCalled();
  });

  it('runs normally when enabled is omitted', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation();
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.context).toHaveBeenCalled();
    expect(auto.reduce).toHaveBeenCalled();
  });
});

// ---------- Abort from context ----------

describe('runPipeline — abort from context', () => {
  it('skips reduce and publishes an abort ObsEvent', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({
      context: vi.fn().mockReturnValue(abort('guard_failed')),
    });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(auto.reduce).not.toHaveBeenCalled();
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.event_type).toBe('abort');
    expect(event.reason).toBe('guard_failed');
  });

  it('does not call actionRuntime.execute on abort', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ context: vi.fn().mockReturnValue(abort('no_presence')) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(deps.actionRuntime.execute).not.toHaveBeenCalled();
  });
});

// ---------- Exception in context ----------

describe('runPipeline — exception in context', () => {
  it('produces abort with reason unhandled_error', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ context: vi.fn().mockImplementation(() => { throw new Error('boom'); }) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.event_type).toBe('abort');
    expect(event.reason).toBe('unhandled_error');
  });

  it('does not affect other pipeline invocations', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const throwing = makeAutomation({ context: vi.fn().mockImplementation(() => { throw new Error('boom'); }) });
    const healthy = makeAutomation({ id: 'bedroom:lighting' });

    await Promise.all([
      runPipeline(throwing, onStartEvent, ha as never, deps as never),
      runPipeline(healthy, onStartEvent, ha as never, deps as never),
    ]);

    expect(deps.eventPublisher.publishDecision).toHaveBeenCalledTimes(2);
    expect(healthy.reduce).toHaveBeenCalled();
  });
});

// ---------- Exception in reduce ----------

describe('runPipeline — exception in reduce', () => {
  it('produces abort with reason unhandled_error', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ reduce: vi.fn().mockImplementation(() => { throw new Error('reduce failed'); }) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.event_type).toBe('abort');
    expect(event.reason).toBe('unhandled_error');
  });
});

// ---------- Dry-run mode ----------

describe('runPipeline — dry-run mode', () => {
  it('sets dry_run: true on decision events when dryRun dep is true', async () => {
    const deps = { ...makeDeps(), dryRun: true };
    const ha = makeHAClient();
    const auto = makeAutomation();
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.dry_run).toBe(true);
  });

  it('does not set dry_run on decision events when dryRun dep is false', async () => {
    const deps = { ...makeDeps(), dryRun: false };
    const ha = makeHAClient();
    const auto = makeAutomation();
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.dry_run).toBeUndefined();
  });

  it('sets dry_run: true on abort events when dryRun dep is true', async () => {
    const deps = { ...makeDeps(), dryRun: true };
    const ha = makeHAClient();
    const auto = makeAutomation({ context: vi.fn().mockReturnValue(abort('guard_failed')) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.dry_run).toBe(true);
  });
});

// ---------- Correlation propagation ----------

describe('runPipeline — correlation propagation', () => {
  it('defaults root_correlation_id to correlation_id when the event has none (root event)', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation();
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.root_correlation_id).toBe('test-cid-pipeline');
  });

  it('carries root_correlation_id through unchanged when the event is a downstream hop', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation();
    const hopEvent: TriggerEvent = {
      type: 'on_start',
      correlation_id: 'D',
      root_correlation_id: 'A',
      parent_correlation_id: 'A',
      parent_automation_id: 'heat_living_room',
    };
    await runPipeline(auto, hopEvent, ha as never, deps as never);
    const [event] = deps.eventPublisher.publishDecision.mock.calls[0] as [Record<string, unknown>];
    expect(event.correlation_id).toBe('D');
    expect(event.root_correlation_id).toBe('A');
    expect(event.parent_correlation_id).toBe('A');
    expect(event.parent_automation_id).toBe('heat_living_room');
  });

  it('two automations reacting to the same root event publish the same root_correlation_id', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const light = makeAutomation({ id: 'living_room:lighting' });
    const heat = makeAutomation({ id: 'living_room:heating' });
    await Promise.all([
      runPipeline(light, onStartEvent, ha as never, deps as never),
      runPipeline(heat, onStartEvent, ha as never, deps as never),
    ]);
    const roots = deps.eventPublisher.publishDecision.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).root_correlation_id,
    );
    expect(roots).toEqual(['test-cid-pipeline', 'test-cid-pipeline']);
  });

  it('passes rootCorrelationId, parentCorrelationId, and parentAutomationId to actionRuntime.execute', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation();
    const hopEvent: TriggerEvent = {
      type: 'on_start',
      correlation_id: 'D',
      root_correlation_id: 'A',
      parent_correlation_id: 'A',
      parent_automation_id: 'heat_living_room',
    };
    await runPipeline(auto, hopEvent, ha as never, deps as never);
    const [, ctx] = deps.actionRuntime.execute.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(ctx.rootCorrelationId).toBe('A');
    expect(ctx.parentCorrelationId).toBe('A');
    expect(ctx.parentAutomationId).toBe('heat_living_room');
  });
});

// ---------- Metrics ----------

describe('runPipeline — metrics', () => {
  it('increments homerun_pipeline_runs_total with location and trigger_type', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation();
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_pipeline_runs_total',
      { location: 'parlour', trigger_type: 'on_start' },
    );
  });

  it('increments pipeline counter even when context aborts', async () => {
    const deps = makeDeps();
    const ha = makeHAClient();
    const auto = makeAutomation({ context: vi.fn().mockReturnValue(abort('guard_failed')) });
    await runPipeline(auto, onStartEvent, ha as never, deps as never);
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_pipeline_runs_total',
      expect.objectContaining({ location: 'parlour' }),
    );
  });

  it('does not throw when metrics dep is absent', async () => {
    const deps = { eventPublisher: { publishDecision: vi.fn(), publishActionEvent: vi.fn() }, actionRuntime: { execute: vi.fn().mockResolvedValue(undefined) } };
    const ha = makeHAClient();
    const auto = makeAutomation();
    await expect(runPipeline(auto, onStartEvent, ha as never, deps as never)).resolves.toBeUndefined();
  });
});
