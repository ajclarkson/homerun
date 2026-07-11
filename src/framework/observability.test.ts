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

  it('publishes the event to homerun/events (not retained)', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/events')!;
    expect(call[0]).toBe('homerun/events');
    expect(call[2]).toMatchObject({ retain: false });
    expect(JSON.parse(call[1] as string)).toMatchObject({ schema: 'home.events.v1', type: 'decision', location: 'parlour' });
  });

  it('publishes the event retained to homerun/{location}/{subsystem}/decision', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'homerun/parlour/lighting/decision');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ retain: true });
  });

  it('publishes the correct schema version on the retained topic', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'homerun/parlour/lighting/decision')!;
    expect(JSON.parse(call[1] as string).schema).toBe('home.events.v1');
  });

  it('routes dry_run events to homerun/dev/* topics', async () => {
    obs.publishDecision(makeDecisionEvent({ dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    expect(callForTopic(mqtt, 'homerun/dev/events')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/dev/parlour/lighting/decision')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeUndefined();
    expect(callForTopic(mqtt, 'homerun/parlour/lighting/decision')).toBeUndefined();
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

  it('publishes an abort event to homerun/events with type: abort', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'abort', reason: 'guard_failed' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/events')!;
    const payload = JSON.parse(call[1] as string);
    expect(payload.type).toBe('abort');
    expect(payload.reason).toBe('guard_failed');
  });

  it('does not publish to the retained decision topic for action events', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'action_started' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'homerun/parlour/lighting/decision')).toBeUndefined();
  });

  it('routes dry_run action events to homerun/dev/events', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'action_started', dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'homerun/dev/events')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeUndefined();
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => obs.publishActionEvent(makeDecisionEvent({ type: 'action_result' }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('Observability — subscribe', () => {
  let mqtt: MockMqtt;
  let obs: Observability;

  beforeEach(() => {
    mqtt = makeMqtt();
    obs = new Observability(mqtt as unknown as MqttClient);
  });

  it('listener receives events published via publishDecision', () => {
    const listener = vi.fn();
    obs.subscribe(listener);
    const event = makeDecisionEvent();
    obs.publishDecision(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('listener receives events published via publishActionEvent', () => {
    const listener = vi.fn();
    obs.subscribe(listener);
    const event = makeDecisionEvent({ type: 'action_started' });
    obs.publishActionEvent(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('multiple listeners all receive the event', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    obs.subscribe(l1);
    obs.subscribe(l2);
    obs.publishDecision(makeDecisionEvent());
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes the listener', () => {
    const listener = vi.fn();
    const unsubscribe = obs.subscribe(listener);
    unsubscribe();
    obs.publishDecision(makeDecisionEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing one listener does not affect others', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = obs.subscribe(l1);
    obs.subscribe(l2);
    unsub1();
    obs.publishDecision(makeDecisionEvent());
    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledOnce();
  });
});
