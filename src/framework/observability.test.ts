import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Observability } from './observability.js';
import type { ObsEvent } from './observability.js';
import type { MqttClient } from 'mqtt';

// ---------- Helpers ----------

type MockMqtt = { publishAsync: ReturnType<typeof vi.fn> };

function makeMqtt(): MockMqtt {
  return { publishAsync: vi.fn().mockResolvedValue(undefined) };
}

function callForTopic(mqtt: MockMqtt, topic: string): unknown[] | undefined {
  return mqtt.publishAsync.mock.calls.find((c: unknown[]) => c[0] === topic);
}

function makeDecisionEvent(overrides: Partial<ObsEvent> = {}): ObsEvent {
  return {
    schema: 'home.events.v1',
    correlation_id: 'abc-123',
    automation_id: 'parlour:lighting',
    location: 'parlour',
    subsystem: 'lighting',
    type: 'decision',
    decision: 'lights_on',
    inputs: { lux: 40 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------- Tests ----------

describe('Observability — publishDecision', () => {
  let mqtt: MockMqtt;
  let obs: Observability;

  beforeEach(() => {
    mqtt = makeMqtt();
    obs = new Observability(mqtt as unknown as MqttClient);
  });

  it('publishes the event to home/events (not retained)', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'home/events')!;
    expect(call[0]).toBe('home/events');
    expect(call[2]).toMatchObject({ retain: false });
    expect(JSON.parse(call[1] as string)).toMatchObject({ schema: 'home.events.v1', type: 'decision', location: 'parlour' });
  });

  it('publishes the event retained to {location}/{subsystem}/decision', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'parlour/lighting/decision');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ retain: true });
  });

  it('publishes the correct schema version on the retained topic', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'parlour/lighting/decision')!;
    expect(JSON.parse(call[1] as string).schema).toBe('home.events.v1');
  });

  it('includes dry_run: true when set on the event', async () => {
    obs.publishDecision(makeDecisionEvent({ dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'home/events')!;
    expect(JSON.parse(call[1] as string).dry_run).toBe(true);
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => obs.publishDecision(makeDecisionEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('Observability — publishActionEvent', () => {
  let mqtt: MockMqtt;
  let obs: Observability;

  beforeEach(() => {
    mqtt = makeMqtt();
    obs = new Observability(mqtt as unknown as MqttClient);
  });

  it('publishes an abort event to home/events with type: abort', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'abort', reason: 'guard_failed' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'home/events')!;
    const payload = JSON.parse(call[1] as string);
    expect(payload.type).toBe('abort');
    expect(payload.reason).toBe('guard_failed');
  });

  it('does not publish to the retained decision topic for action events', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'action_started' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'parlour/lighting/decision')).toBeUndefined();
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => obs.publishActionEvent(makeDecisionEvent({ type: 'action_result' }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
