import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionRuntime } from './action-runtime.js';
import type { ExecutionContext } from './action-runtime.js';
import type { Action } from '../types/actions.js';

// ---------- Mocks ----------

function makeDeps(dryRun = false) {
  const haClient = {
    callService: vi.fn().mockResolvedValue(undefined),
    registerPendingWrite: vi.fn(),
    registerPendingAck: vi.fn(),
    state: vi.fn().mockReturnValue(undefined),
    on: vi.fn(),
  };
  const mqttClient = { publishAsync: vi.fn().mockResolvedValue(undefined) };
  const timerManager = { start: vi.fn(), cancel: vi.fn() };
  const eventPublisher = { publishActionEvent: vi.fn() };
  const metrics = { incrementCounter: vi.fn(), observeHistogram: vi.fn() };
  const commandAck = { enabled: false, timeoutMs: 8000 };
  return { haClient, mqttClient, timerManager, eventPublisher, dryRun, metrics, commandAck };
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
    expect(deps.haClient.callService).toHaveBeenCalledWith(
      'light', 'turn_on', { entity_id: 'light.parlour_light_ceiling' }, { brightness: 255 },
      { correlationId: 'test-corr-id', rootCorrelationId: undefined, automationId: 'parlour:lighting' },
    );
  });

  it('passes rootCorrelationId to haClient.callService as the write origin', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'climate', service: 'set_temperature', target: { entity_id: 'sensor.living_room_active_heating' } };
    await rt.execute([action], makeCtx({ rootCorrelationId: 'A' }));
    expect(deps.haClient.callService).toHaveBeenCalledWith(
      'climate', 'set_temperature', { entity_id: 'sensor.living_room_active_heating' }, undefined,
      { correlationId: 'test-corr-id', rootCorrelationId: 'A', automationId: 'parlour:lighting' },
    );
  });

  it('emits action_started before and action_result after', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_off' };
    await rt.execute([action], makeCtx());
    const calls = deps.eventPublisher.publishActionEvent.mock.calls.map((c: unknown[]) => (c[0] as { event_type: string }).event_type);
    expect(calls).toEqual(['action_started', 'action_result']);
  });

  it('action_result carries status: ok on success', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_off' }], makeCtx());
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { status: string; error?: string };
    expect(result.status).toBe('ok');
    expect(result.error).toBeUndefined();
  });

  it('action_result carries status: error and error detail on failure; subsequent actions still run', async () => {
    deps.haClient.callService.mockRejectedValueOnce(new Error('HA unavailable'));
    const rt = new ActionRuntime(deps as never);
    const actions: Action[] = [
      { type: 'ha.call_service', domain: 'light', service: 'turn_off' },
      { type: 'timer.cancel', timerKey: 'parlour:lighting:off-delay' },
    ];
    await rt.execute(actions, makeCtx());
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { event_type: string; status: string; error?: string };
    expect(result.event_type).toBe('action_result');
    expect(result.status).toBe('error');
    expect(result.error).toContain('HA unavailable');
    expect(deps.timerManager.cancel).toHaveBeenCalled();
  });

  it('action_started/action_result carry the singular action, not an array', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_off' };
    await rt.execute([action], makeCtx());
    const [started, result] = deps.eventPublisher.publishActionEvent.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    expect(started.action).toEqual(action);
    expect(result.action).toEqual(action);
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

  it('registers a pending write when impliesEntity is set', async () => {
    const rt = new ActionRuntime(deps as never);
    const ctx = makeCtx({ correlationId: 'cid-1', rootCorrelationId: 'A', automationId: 'bedroom:occupancy' });
    await rt.execute([{ type: 'mqtt.publish', topic: 'bedroom/occupied/state', payload: 'ON', retain: true, impliesEntity: 'binary_sensor.bedroom_occupied' }], ctx);
    expect(deps.haClient.registerPendingWrite).toHaveBeenCalledWith('binary_sensor.bedroom_occupied', {
      correlationId: 'cid-1',
      rootCorrelationId: 'A',
      automationId: 'bedroom:occupancy',
    });
  });

  it('does not register a pending write when impliesEntity is absent', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'mqtt.publish', topic: 'bedroom/occupied/state', payload: 'ON' }], makeCtx());
    expect(deps.haClient.registerPendingWrite).not.toHaveBeenCalled();
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
    const result = deps.eventPublisher.publishActionEvent.mock.calls[1][0] as { event_type: string; status: string; error?: string };
    expect(result.event_type).toBe('action_result');
    expect(result.status).toBe('error');
    expect(result.error).toContain('unknown.action');
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

  it('does not register a pending write for mqtt.publish with impliesEntity', async () => {
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'mqtt.publish', topic: 'home/test', payload: 'x', impliesEntity: 'binary_sensor.x' }], makeCtx());
    expect(deps.haClient.registerPendingWrite).not.toHaveBeenCalled();
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

// ---------- Command ack tracking (#55) ----------

describe('ActionRuntime — command ack tracking', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => { deps = makeDeps(); });

  it('does not register a pending ack when commandAck.enabled is false', async () => {
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('registers a pending ack with state: on for turn_on when enabled', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };
    await rt.execute([action], makeCtx({ correlationId: 'cid-1', rootCorrelationId: 'A', automationId: 'kitchen:lighting', location: 'kitchen', subsystem: 'lighting' }));
    expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith('light.example', {
      correlationId: 'cid-1',
      rootCorrelationId: 'A',
      automationId: 'kitchen:lighting',
      location: 'kitchen',
      subsystem: 'lighting',
      action,
      expected: { state: 'on' },
    }, 8000);
  });

  it('registers a pending ack with state: off for turn_off when enabled', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_off', target: { entity_id: 'light.example' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith('light.example', expect.objectContaining({ expected: { state: 'off' } }), 8000);
  });

  it('infers expected attributes from data keys by HA convention', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'climate', service: 'set_temperature', target: { entity_id: 'climate.example' }, data: { temperature: 21 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith('climate.example', expect.objectContaining({ expected: { temperature: 21 } }), 8000);
  });

  it('excludes known non-attribute data keys like transition', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' }, data: { brightness: 200, transition: 2 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith('light.example', expect.objectContaining({ expected: { state: 'on', brightness: 200 } }), 8000);
  });

  it('maps set_value on number domain to expected state, not an attribute called value (#153)', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'number', service: 'set_value', target: { entity_id: 'number.example' }, data: { value: 21 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith('number.example', expect.objectContaining({ expected: { state: 21 } }), 8000);
  });

  it.each(['number', 'input_number', 'input_text', 'input_select', 'text'])(
    'maps set_value on %s domain to expected state (#153)',
    async (domain) => {
      deps.commandAck.enabled = true;
      const rt = new ActionRuntime(deps as never);
      const action: Action = { type: 'ha.call_service', domain, service: 'set_value', target: { entity_id: `${domain}.example` }, data: { value: 'x' } };
      await rt.execute([action], makeCtx());
      expect(deps.haClient.registerPendingAck).toHaveBeenCalledWith(`${domain}.example`, expect.objectContaining({ expected: { state: 'x' } }), 8000);
    },
  );

  it('skips set_value tracking when the entity state already matches (idempotent) (#153)', async () => {
    deps.commandAck.enabled = true;
    deps.haClient.state.mockReturnValue({ entity_id: 'number.example', state: '21', attributes: {}, last_changed: '', last_updated: '' });
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'number', service: 'set_value', target: { entity_id: 'number.example' }, data: { value: '21' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('skips set_value tracking when idempotent even when data.value is a number and state is HA\'s string form (#158)', async () => {
    deps.commandAck.enabled = true;
    deps.haClient.state.mockReturnValue({ entity_id: 'number.example', state: '21', attributes: {}, last_changed: '', last_updated: '' });
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'number', service: 'set_value', target: { entity_id: 'number.example' }, data: { value: 21 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('does not track media_player.join at all (#153)', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'media_player', service: 'join', target: { entity_id: 'media_player.parlour' }, data: { group_members: ['media_player.kitchen'] } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('does not track media_player.unjoin at all (#153)', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'media_player', service: 'unjoin', target: { entity_id: 'media_player.parlour' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('does not track scene.turn_on at all — a scene entity state is a last-activated timestamp, not on/off (#156)', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: 'scene.example_off' }, data: { transition: 0.5 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('skips tracking when the entity already matches every expected field (idempotent)', async () => {
    deps.commandAck.enabled = true;
    deps.haClient.state.mockReturnValue({ entity_id: 'light.example', state: 'on', attributes: {}, last_changed: '', last_updated: '' });
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('does not skip when only some expected fields already match', async () => {
    deps.commandAck.enabled = true;
    deps.haClient.state.mockReturnValue({ entity_id: 'light.example', state: 'on', attributes: { brightness: 100 }, last_changed: '', last_updated: '' });
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' }, data: { brightness: 200 } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).toHaveBeenCalled();
  });

  it('does not track when there is no target entity_id', async () => {
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on' };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('does not track in dry-run mode', async () => {
    deps = makeDeps(true);
    deps.commandAck.enabled = true;
    const rt = new ActionRuntime(deps as never);
    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };
    await rt.execute([action], makeCtx());
    expect(deps.haClient.registerPendingAck).not.toHaveBeenCalled();
  });

  it('subscribes to action_ack_timeout and publishes an ObsEvent + increments a metric on fire', () => {
    new ActionRuntime(deps as never);
    const handler = deps.haClient.on.mock.calls.find((c: unknown[]) => c[0] === 'action_ack_timeout')?.[1] as (e: unknown) => void;
    expect(handler).toBeInstanceOf(Function);

    const action: Action = { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } };
    handler({
      correlationId: 'cid-1',
      rootCorrelationId: 'A',
      automationId: 'kitchen:lighting',
      location: 'kitchen',
      subsystem: 'lighting',
      action,
      expected: { state: 'on' },
      entity_id: 'light.example',
    });

    expect(deps.eventPublisher.publishActionEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'action_ack_timeout',
      correlation_id: 'cid-1',
      root_correlation_id: 'A',
      automation_id: 'kitchen:lighting',
      location: 'kitchen',
      subsystem: 'lighting',
      action,
      entity: 'light.example',
      expected: { state: 'on' },
    }));
    expect(deps.metrics.incrementCounter).toHaveBeenCalledWith(
      'homerun_action_ack_timeout_total',
      { location: 'kitchen', action_type: 'ha.call_service' },
    );
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
      schema: 'home.events.v2',
      correlation_id: 'cid-99',
      automation_id: 'bedroom:heating',
      location: 'bedroom',
      subsystem: 'heating',
    });
  });

  it('defaults root_correlation_id to correlation_id when ctx has none', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    await rt.execute([{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }], makeCtx({ correlationId: 'cid-99' }));
    const started = deps.eventPublisher.publishActionEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(started.root_correlation_id).toBe('cid-99');
  });

  it('includes root_correlation_id, parent_correlation_id, and parent_automation_id when set on ctx', async () => {
    const deps = makeDeps();
    const rt = new ActionRuntime(deps as never);
    const ctx = makeCtx({ rootCorrelationId: 'A', parentCorrelationId: 'A', parentAutomationId: 'heat_living_room' });
    await rt.execute([{ type: 'ha.call_service', domain: 'climate', service: 'set_temperature' }], ctx);
    const started = deps.eventPublisher.publishActionEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(started).toMatchObject({
      root_correlation_id: 'A',
      parent_correlation_id: 'A',
      parent_automation_id: 'heat_living_room',
    });
  });
});
