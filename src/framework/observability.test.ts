import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Observability } from './observability.js';
import type { ObsEvent } from './observability.js';
import type { MqttClient } from 'mqtt';

// ---------- Helpers ----------

function makeMqtt(): { publishAsync: ReturnType<typeof vi.fn> } & Pick<MqttClient, 'publishAsync'> {
  return { publishAsync: vi.fn().mockResolvedValue(undefined) };
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
  let mqtt: ReturnType<typeof makeMqtt>;
  let obs: Observability;

  beforeEach(() => {
    mqtt = makeMqtt();
    obs = new Observability(mqtt as unknown as MqttClient);
  });

  it('publishes the event to home/events (not retained)', async () => {
    const event = makeDecisionEvent();
    obs.publishDecision(event);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const [topic, , opts] = mqtt.publishAsync.mock.calls.find(
      ([t]: [string]) => t === 'home/events',
    )!;
    expect(topic).toBe('home/events');
    expect(opts).toMatchObject({ retain: false });
    const payload = JSON.parse(mqtt.publishAsync.mock.calls.find(([t]: [string]) => t === 'home/events')![1] as string);
    expect(payload).toMatchObject({ schema: 'home.events.v1', type: 'decision', location: 'parlour' });
  });

  it('publishes the event retained to {location}/{subsystem}/decision', async () => {
    const event = makeDecisionEvent();
    obs.publishDecision(event);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const retainedCall = mqtt.publishAsync.mock.calls.find(
      ([t]: [string]) => t === 'parlour/lighting/decision',
    );
    expect(retainedCall).toBeDefined();
    expect(retainedCall![2]).toMatchObject({ retain: true });
  });

  it('publishes the correct schema version on the retained topic', async () => {
    obs.publishDecision(makeDecisionEvent());
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalledTimes(2));

    const retainedCall = mqtt.publishAsync.mock.calls.find(
      ([t]: [string]) => t === 'parlour/lighting/decision',
    )!;
    const payload = JSON.parse(retainedCall[1] as string);
    expect(payload.schema).toBe('home.events.v1');
  });

  it('includes dry_run: true when set on the event', async () => {
    obs.publishDecision(makeDecisionEvent({ dry_run: true }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = mqtt.publishAsync.mock.calls.find(([t]: [string]) => t === 'home/events')!;
    const payload = JSON.parse(call[1] as string);
    expect(payload.dry_run).toBe(true);
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => obs.publishDecision(makeDecisionEvent())).not.toThrow();
    // give the promise time to reject
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('Observability — publishActionEvent', () => {
  let mqtt: ReturnType<typeof makeMqtt>;
  let obs: Observability;

  beforeEach(() => {
    mqtt = makeMqtt();
    obs = new Observability(mqtt as unknown as MqttClient);
  });

  it('publishes an abort event to home/events with type: abort', async () => {
    const event = makeDecisionEvent({ type: 'abort', reason: 'guard_failed' });
    obs.publishActionEvent(event);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = mqtt.publishAsync.mock.calls.find(([t]: [string]) => t === 'home/events')!;
    const payload = JSON.parse(call[1] as string);
    expect(payload.type).toBe('abort');
    expect(payload.reason).toBe('guard_failed');
  });

  it('does not publish to the retained decision topic for action events', async () => {
    obs.publishActionEvent(makeDecisionEvent({ type: 'action_started' }));
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const retainedCall = mqtt.publishAsync.mock.calls.find(
      ([t]: [string]) => t === 'parlour/lighting/decision',
    );
    expect(retainedCall).toBeUndefined();
  });

  it('swallows MQTT publish failure and does not throw', async () => {
    mqtt.publishAsync.mockRejectedValue(new Error('connection lost'));
    expect(() => obs.publishActionEvent(makeDecisionEvent({ type: 'action_result' }))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
