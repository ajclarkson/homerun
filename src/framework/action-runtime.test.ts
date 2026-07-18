import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionRuntime } from './action-runtime.js';
import type { ExecutionContext } from './action-runtime.js';
import type { Action } from '../types/actions.js';

// ---------- Mocks ----------

function makeDeps(dryRun = false) {
  const haClient = { callService: vi.fn().mockResolvedValue(undefined) };
  const mqttClient = { publishAsync: vi.fn().mockResolvedValue(undefined) };
  const timerManager = { start: vi.fn(), cancel: vi.fn() };
  const eventPublisher = { publishActionEvent: vi.fn() };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  return { haClient, mqttClient, timerManager, eventPublisher, dryRun, metrics };
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    correlationId: 'test-corr-id',
    automationId: 'parlour:lighting',
    location: 'parlour',
    subsystem: 'lighting',
    ...overrides,
  };
}

// ---------- ha.call_service ----------

describe('ActionRuntime — ha.call_service', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => { deps = makeDeps(); });

  it('calls haClient.callService with correct arguments', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.parlour_light_ceiling' }, data: { brightness: 255 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.callService).toHaveBeenCalledWith('light', 'turn_on', { entity_id: 'light.parlour_light_ceiling' }, { brightness: 255 });
  });

  it('emits action_started before and action_result after', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_off' };
    await rt.execute([action], makeCtx());
    const calls = deps.eventPublisher.publishActionEvent.mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
    expect(calls).toEqual(['action_started', 'action_result']);
  });

  it('action_result carries reason: ok on success', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_off' }], makeCtx());
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { reason: string };
    expect(result.reason).toBe('ok');
  });

  it('action_result carries error detail on failure; subsequent actions still run', async () => {
    deps.haClient.callService.mockRejectedValueOnce(new Error('HA unavailable'));
    const rt = new ActionRuntime(deps as never);
    const actions: Action[] = [
      { type: 'ha.call_service', domain: 'light', service: 'turn_off' },
      { type: 'timer.cancel', timerKey: 'parlour:lighting:off-delay' },
    ];
    await rt.execute(actions, makeCtx());
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { event_type: string; reason: string };
    expect(result.event_type).toBe('action_result');
    expect(result.reason).toContain('HA unavailable');
    expect(deps.timerManager.cancel).toHaveBeenCalled();
  });
});

// ---------- mqtt.publish ----------

describe('ActionRuntime — mqtt.publish', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => { deps = makeDeps(); });

  it('calls mqttClient.publishAsync with topic, payload, and retain flag', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'mqtt.publish', topic: 'home/test', payload: '{"on":true}', retain: true }], makeCtx());
    expect(deps.mqttClient.publishAsync).toHaveBeenCalledWith('home/test', '{"on":true}', { retain: true });
  });

  it('defaults retain to false when not specified', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'mqtt.publish', topic: 'home/test', payload: 'hello' }], makeCtx());
    expect(deps.mqttClient.publishAsync).toHaveBeenCalledWith('home/test', 'hello', { retain: false });
  });
});

// ---------- timer.start / timer.cancel ----------

describe('ActionRuntime — timer actions', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => { deps = makeDeps(); });

  it('delegates timer.start to timerManager', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'timer.start', timerKey: 'parlour:lighting:off-delay', delayMs: 5000 }], makeCtx());
    expect(deps.timerManager.start).toHaveBeenCalledWith('parlour:lighting:off-delay', 5000);
  });

  it('delegates timer.cancel to timerManager', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'timer.cancel', timerKey: 'parlour:lighting:off-delay' }], makeCtx());
    expect(deps.timerManager.cancel).toHaveBeenCalledWith('parlour:lighting:off-delay');
  });
});

// ---------- Unknown action ----------

describe('ActionRuntime — unknown action type', () => {
  it('emits action_result with error detail and does not throw', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'unknown.action' } as never], makeCtx());
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { event_type: string; reason: string };
    expect(result.event_type).toBe('action_result');
    expect(result.reason).toContain('unknown.action');
  });
});

// ---------- Dry-run mode ----------

describe('ActionRuntime — dry-run mode', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => { deps = makeDeps(true); });

  it('does not call haClient.callService', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx());
    expect(deps.haClient.callService).not.toHaveBeenCalled();
  });

  it('does not call mqttClient.publishAsync', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'mqtt.publish', topic: 'home/test', payload: 'x' }], makeCtx());
    expect(deps.mqttClient.publishAsync).not.toHaveBeenCalled();
  });

  it('does not call timerManager.start or cancel', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([
      { type: 'timer.start', timerKey: 'k', delayMs: 1000 },
      { type: 'timer.cancel', timerKey: 'k' },
    ], makeCtx());
    expect(deps.timerManager.start).not.toHaveBeenCalled();
    expect(deps.timerManager.cancel).not.toHaveBeenCalled();
  });

  it('still emits action_started and action_result with dry_run: true', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx());
    const events = deps.eventPublisher.publishActionEvent.mock.calls.map((c: unknown[]) => c[0] as { event_type: string; dry_run: boolean });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.dry_run === true)).toBe(true);
  });
});

// ---------- Metrics ----------

describe('ActionRuntime — metrics', () => {
  it('increments dispatched counter with location and action_type on success', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx());
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_actions_dispatched_total',
      { location: 'parlour', action_type: 'ha.call_service' },
    );
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_actions_succeeded_total',
      { location: 'parlour', action_type: 'ha.call_service' },
    );
  });

  it('increments failed counter on HA error', async () => {
    const deps = makeDeps();
    deps.haClient.callService.mockRejectedValueOnce(new Error('timeout'));
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx());
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_actions_failed_total',
      { location: 'parlour', action_type: 'ha.call_service' },
    );
    expect(deps.metrics.incrementCounter).not.toHaveBeenCalledWith(
      'homerun_actions_succeeded_total',
      expect.anything(),
    );
  });

  it('observes action duration histogram on success', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx());
    expect(deps.metrics.observeHistogram).toHaveBeenCalledWith(
      'homerun_action_duration_seconds',
      expect.any(Number),
      { location: 'parlour', action_type: 'ha.call_service' },
    );
  });

  it('observes action duration histogram on failure', async () => {
    const deps = makeDeps();
    deps.haClient.callService.mockRejectedValueOnce(new Error('oops'));
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_off' }], makeCtx());
    expect(deps.metrics.observeHistogram).toHaveBeenCalledWith(
      'homerun_action_duration_seconds',
      expect.any(Number),
      { location: 'parlour', action_type: 'ha.call_service' },
    );
  });
});

// ---------- ObsEvent fields ----------

describe('ActionRuntime — event publisher fields', () => {
  it('includes correlation_id, automation_id, location, subsystem on events', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    const ctx = makeCtx({ correlationId: 'cid-99', automationId: 'bedroom:heating', location: 'bedroom', subsystem: 'heating' });
    await rt.execute([{ type: 'ha.call_service', domain: 'climate', service: 'set_temperature' }], ctx);
    const started = deps.eventPublisher.publishActionEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(started).toMatchObject({
      schema: 'home.events.v1',
      correlation_id: 'cid-99',
      automation_id: 'bedroom:heating',
      location: 'bedroom',
      subsystem: 'heating',
    });
  });
});
