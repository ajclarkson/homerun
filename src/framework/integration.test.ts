/**
 * End-to-end integration tests.
 *
 * These wire real pipeline + real ActionRuntime + real EventPublisher together,
 * with only the network boundaries mocked (HAClient.callService, MqttClient).
 * They catch field-name mismatches and wiring bugs that unit tests can't see.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { runPipeline } from './pipeline.js';
import { ActionRuntime } from './action-runtime.js';
import { EventPublisher } from './event-publisher.js';
import { TimerManager } from './timer-manager.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';
import type { HAClient } from './ha-client.js';
import type { MqttClient } from 'mqtt';
import { abort } from '../types/automation.js';

// ---------- Harness ----------

function makeHarness(dryRun = false) {
  const mqttPublish = vi.fn().mockResolvedValue(undefined);
  const mqtt = { publishAsync: mqttPublish } as unknown as MqttClient;

  const haCallService = vi.fn().mockResolvedValue(undefined);
  const haClient = {
    state: vi.fn().mockReturnValue(undefined),
    context: { entitiesByLabel: vi.fn().mockReturnValue([]), labelsFor: vi.fn().mockReturnValue([]) },
    callService: haCallService,
  } as unknown as HAClient;

  const timerDispatch = vi.fn<(e: TriggerEvent) => void>();
  const timerManager = new TimerManager(timerDispatch);

  const eventPublisher = new EventPublisher(mqtt);
  const publishedDecisions: unknown[] = [];
  const publishedActions: unknown[] = [];
  eventPublisher.subscribe((event) => {
    if (event.event_type === 'decision' || event.event_type === 'abort') {
      publishedDecisions.push(event);
    } else {
      publishedActions.push(event);
    }
  });

  const actionRuntime = new ActionRuntime({ haClient, mqttClient: mqtt, timerManager, eventPublisher, dryRun });

  async function run(automation: Automation<unknown>, event: TriggerEvent) {
    await runPipeline(automation, event, haClient, { eventPublisher, actionRuntime, dryRun });
  }

  return { run, haCallService, mqttPublish, timerDispatch, publishedDecisions, publishedActions, timerManager };
}

const onStart: TriggerEvent = { type: 'on_start', correlation_id: 'integ-001' };

// ---------- Happy path ----------

describe('Integration — trigger → decision → HA action', () => {
  it('calls HA callService for a lights_on decision', async () => {
    const { run, haCallService, publishedDecisions, publishedActions } = makeHarness();

    const automation: Automation<unknown> = {
      id: 'parlour:lighting',
      location: 'parlour',
      subsystem: 'lighting',
      triggers: [{ type: 'on_start' }],
      context: () => ({ lux: 30 }),
      reduce: () => ({
        decision: 'lights_on',
        actions: [{ type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.parlour_light_ceiling' }, data: { brightness: 200 } }],
      }),
    };

    await run(automation, onStart);

    expect(haCallService).toHaveBeenCalledWith('light', 'turn_on', { entity_id: 'light.parlour_light_ceiling' }, { brightness: 200 });
    expect(publishedDecisions).toHaveLength(1);
    expect(publishedDecisions[0]).toMatchObject({ event_type: 'decision', decision: 'lights_on', automation_id: 'parlour:lighting' });
    expect(publishedActions).toHaveLength(2); // action_started + action_result
    expect((publishedActions[0] as Record<string, unknown>).event_type).toBe('action_started');
    expect((publishedActions[1] as Record<string, unknown>).event_type).toBe('action_result');
    expect((publishedActions[1] as Record<string, unknown>).reason).toBe('ok');
  });

  it('propagates correlation_id from trigger through decision and action events', async () => {
    const { run, publishedDecisions, publishedActions } = makeHarness();

    const automation: Automation<unknown> = {
      id: 'kitchen:heating',
      location: 'kitchen',
      subsystem: 'heating',
      triggers: [{ type: 'on_start' }],
      context: () => ({}),
      reduce: () => ({
        decision: 'set_comfort',
        actions: [{ type: 'ha.call_service', domain: 'climate', service: 'set_temperature' }],
      }),
    };

    const event: TriggerEvent = { type: 'on_start', correlation_id: 'trace-xyz' };
    await run(automation, event);

    const decisionCorr = (publishedDecisions[0] as Record<string, unknown>).correlation_id;
    const actionCorr = (publishedActions[0] as Record<string, unknown>).correlation_id;
    expect(decisionCorr).toBe('trace-xyz');
    expect(actionCorr).toBe('trace-xyz');
  });

  it('publishes an abort event and skips actions when context returns abort()', async () => {
    const { run, haCallService, publishedDecisions, publishedActions } = makeHarness();

    const automation: Automation<unknown> = {
      id: 'parlour:lighting',
      location: 'parlour',
      subsystem: 'lighting',
      triggers: [{ type: 'on_start' }],
      context: () => abort('presence_override'),
      reduce: vi.fn(),
    };

    await run(automation, onStart);

    expect(haCallService).not.toHaveBeenCalled();
    expect(publishedActions).toHaveLength(0);
    expect(publishedDecisions).toHaveLength(1);
    expect(publishedDecisions[0]).toMatchObject({ event_type: 'abort', reason: 'presence_override' });
  });

  it('publishes abort and skips actions when HA action fails, but subsequent actions still run', async () => {
    const { run, haCallService, publishedActions } = makeHarness();
    haCallService.mockRejectedValueOnce(new Error('HA unavailable'));

    const automation: Automation<unknown> = {
      id: 'kitchen:heating',
      location: 'kitchen',
      subsystem: 'heating',
      triggers: [{ type: 'on_start' }],
      context: () => ({}),
      reduce: () => ({
        decision: 'set_temp',
        actions: [
          { type: 'ha.call_service', domain: 'climate', service: 'set_temperature' },
          { type: 'ha.call_service', domain: 'climate', service: 'set_hvac_mode' },
        ],
      }),
    };

    await run(automation, onStart);

    // Both actions ran — second one succeeds
    expect(haCallService).toHaveBeenCalledTimes(2);
    const results = publishedActions.filter((e) => (e as Record<string, unknown>).event_type === 'action_result') as Array<Record<string, unknown>>;
    expect(results[0].reason).toContain('HA unavailable');
    expect(results[1].reason).toBe('ok');
  });
});

// ---------- Dry-run mode ----------

describe('Integration — dry-run mode', () => {
  it('does not call HA and marks decision + action events with dry_run: true', async () => {
    const { run, haCallService, publishedDecisions, publishedActions } = makeHarness(true);

    const automation: Automation<unknown> = {
      id: 'parlour:lighting',
      location: 'parlour',
      subsystem: 'lighting',
      triggers: [{ type: 'on_start' }],
      context: () => ({}),
      reduce: () => ({
        decision: 'lights_on',
        actions: [{ type: 'ha.call_service', domain: 'light', service: 'turn_on' }],
      }),
    };

    await run(automation, onStart);

    expect(haCallService).not.toHaveBeenCalled();
    expect((publishedDecisions[0] as Record<string, unknown>).dry_run).toBe(true);
    expect(publishedActions.every((e) => (e as Record<string, unknown>).dry_run === true)).toBe(true);
  });
});

// ---------- Timer integration ----------

describe('Integration — timer action', () => {
  beforeEach(() => vi.useFakeTimers());

  it('timer.start schedules a dispatch via TimerManager', async () => {
    const { run, timerDispatch, timerManager } = makeHarness();

    const automation: Automation<unknown> = {
      id: 'parlour:lighting',
      location: 'parlour',
      subsystem: 'lighting',
      triggers: [{ type: 'on_start' }],
      context: () => ({}),
      reduce: () => ({
        decision: 'start_timer',
        actions: [{ type: 'timer.start', timerKey: 'parlour:lighting:off-delay', delayMs: 5000 }],
      }),
    };

    await run(automation, onStart);

    expect(timerDispatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(timerDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'timer_expired', timerKey: 'parlour:lighting:off-delay' }),
    );

    vi.useRealTimers();
  });
});

// ---------- MQTT action ----------

describe('Integration — mqtt.publish action', () => {
  it('publishes to MQTT with correct topic, payload, and retain', async () => {
    const { run, mqttPublish } = makeHarness();

    const automation: Automation<unknown> = {
      id: 'kitchen:status',
      location: 'kitchen',
      subsystem: 'status',
      triggers: [{ type: 'on_start' }],
      context: () => ({}),
      reduce: () => ({
        decision: 'publish_status',
        actions: [{ type: 'mqtt.publish', topic: 'home/kitchen/status', payload: '{"on":true}', retain: true }],
      }),
    };

    await run(automation, onStart);

    expect(mqttPublish).toHaveBeenCalledWith('home/kitchen/status', '{"on":true}', { retain: true });
  });
});
