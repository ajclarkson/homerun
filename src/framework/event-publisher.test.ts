import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventPublisher } from './event-publisher.js';
import type { ObsEvent } from './event-publisher.js';
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
    schema: 'home.events.v2',
    correlation_id: 'abc-123',
    root_correlation_id: 'abc-123',
    automation_id: 'parlour:lighting',
    location: 'parlour',
    subsystem: 'lighting',
    event_type: 'decision',
    trigger: { type: 'on_start' },
    decision: 'lights_on',
    conditions: { lux: 40 },
    actions: [],
    hasAction: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ObsEvent;
}

// ---------- Tests ----------

describe('EventPublisher — publishDecision', () => {
  let mqtt: MockMqtt;
  let publisher: EventPublisher;

  beforeEach(() => {
    mqtt = makeMqtt();
    publisher = new EventPublisher(mqtt as unknown as MqttClient);
  });

  it('publishes the event to homerun/events (not retained)', async () => {
    publisher.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/events')!;
    expect(call[0]).toBe('homerun/events');
    expect(call[2]).toMatchObject({ retain: false });
    expect(JSON.parse(call[1] as string)).toMatchObject({ schema: 'home.events.v2', location: 'parlour' });
  });

  it('publishes the event retained to homerun/{location}/{subsystem}/decision', async () => {
    publisher.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'homerun/parlour/lighting/decision');
    expect(call).toBeDefined();
    expect(call![2]).toMatchObject({ retain: true });
  });

  it('publishes the correct schema version on the retained topic', async () => {
    publisher.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'homerun/parlour/lighting/decision')!;
    expect(JSON.parse(call[1] as string).schema).toBe('home.events.v2');
  });

  it('routes dry_run events to homerun/dev/* topics', async () => {
    publisher.publishDecision(makeDecisionEvent({ dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    expect(callForTopic(mqtt, 'homerun/dev/events')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/dev/parlour/lighting/decision')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeUndefined();
    expect(callForTopic(mqtt, 'homerun/parlour/lighting/decision')).toBeUndefined();
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => publisher.publishDecision(makeDecisionEvent())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('EventPublisher — publishActionEvent', () => {
  let mqtt: MockMqtt;
  let publisher: EventPublisher;

  beforeEach(() => {
    mqtt = makeMqtt();
    publisher = new EventPublisher(mqtt as unknown as MqttClient);
  });

  it('publishes an action event to homerun/events', async () => {
    publisher.publishActionEvent(makeDecisionEvent({ event_type: 'action_started' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'homerun/events')).toBeDefined();
  });

  it('does not publish to the retained decision topic for action events', async () => {
    publisher.publishActionEvent(makeDecisionEvent({ event_type: 'action_started' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'homerun/parlour/lighting/decision')).toBeUndefined();
  });

  it('routes dry_run action events to homerun/dev/events', async () => {
    publisher.publishActionEvent(makeDecisionEvent({ event_type: 'action_started', dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    expect(callForTopic(mqtt, 'homerun/dev/events')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeUndefined();
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => publisher.publishActionEvent(makeDecisionEvent({ event_type: 'action_result' }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('EventPublisher — publishLifecycle', () => {
  let mqtt: MockMqtt;
  let publisher: EventPublisher;

  beforeEach(() => {
    mqtt = makeMqtt();
    publisher = new EventPublisher(mqtt as unknown as MqttClient);
  });

  it('publishes to homerun/lifecycle (not retained)', async () => {
    publisher.publishLifecycle('server_started', 5);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/lifecycle')!;
    expect(call).toBeDefined();
    expect(call[2]).toMatchObject({ retain: false });
    const payload = JSON.parse(call[1] as string);
    expect(payload).toMatchObject({ schema: 'home.lifecycle.v1', type: 'server_started', automation_count: 5 });
    expect(payload.dry_run).toBeUndefined();
  });

  it('publishes to homerun/status (retained) with online status', async () => {
    publisher.publishLifecycle('server_started', 5);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const call = callForTopic(mqtt, 'homerun/status')!;
    expect(call).toBeDefined();
    expect(call[2]).toMatchObject({ retain: true });
    expect(JSON.parse(call[1] as string)).toMatchObject({ status: 'online', automation_count: 5 });
  });

  it('routes dry_run lifecycle events to homerun/dev/* topics', async () => {
    publisher.publishLifecycle('rescan_complete', 3, true);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    expect(callForTopic(mqtt, 'homerun/dev/lifecycle')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/dev/status')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/lifecycle')).toBeUndefined();
    expect(callForTopic(mqtt, 'homerun/status')).toBeUndefined();
  });

  it('includes dry_run flag in the lifecycle payload when true', async () => {
    publisher.publishLifecycle('ha_reconnected', 2, true);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/dev/lifecycle')!;
    expect(JSON.parse(call[1] as string).dry_run).toBe(true);
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => publisher.publishLifecycle('server_started', 1)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('EventPublisher — subscribe', () => {
  let mqtt: MockMqtt;
  let publisher: EventPublisher;

  beforeEach(() => {
    mqtt = makeMqtt();
    publisher = new EventPublisher(mqtt as unknown as MqttClient);
  });

  it('listener receives events published via publishDecision', () => {
    const listener = vi.fn();
    publisher.subscribe(listener);
    const event = makeDecisionEvent();
    publisher.publishDecision(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('listener receives events published via publishActionEvent', () => {
    const listener = vi.fn();
    publisher.subscribe(listener);
    const event = makeDecisionEvent({ event_type: 'action_started' });
    publisher.publishActionEvent(event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('multiple listeners all receive the event', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    publisher.subscribe(l1);
    publisher.subscribe(l2);
    publisher.publishDecision(makeDecisionEvent());
    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes the listener', () => {
    const listener = vi.fn();
    const unsubscribe = publisher.subscribe(listener);
    unsubscribe();
    publisher.publishDecision(makeDecisionEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing one listener does not affect others', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const unsub1 = publisher.subscribe(l1);
    publisher.subscribe(l2);
    unsub1();
    publisher.publishDecision(makeDecisionEvent());
    expect(l1).not.toHaveBeenCalled();
    expect(l2).toHaveBeenCalledOnce();
  });
});
