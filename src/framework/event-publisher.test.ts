import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventPublisher } from './event-publisher.js';
import type { ObsEvent } from './event-publisher.js';
import type { MqttClient } from 'mqtt';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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

  it('does not throw when the event contains a value JSON.stringify cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = makeDecisionEvent({ conditions: circular });
    expect(() => publisher.publishDecision(event)).not.toThrow();
    expect(mqtt.publishAsync).not.toHaveBeenCalled();
  });

  it('still notifies listeners when the event fails to serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = makeDecisionEvent({ conditions: circular });
    const listener = vi.fn();
    publisher.subscribe(listener);
    publisher.publishDecision(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('does not let one throwing listener prevent another listener or the MQTT publish', () => {
    const throwingListener = vi.fn(() => { throw new Error('listener bug'); });
    const healthyListener = vi.fn();
    publisher.subscribe(throwingListener);
    publisher.subscribe(healthyListener);
    expect(() => publisher.publishDecision(makeDecisionEvent())).not.toThrow();
    expect(healthyListener).toHaveBeenCalledOnce();
    expect(mqtt.publishAsync).toHaveBeenCalled();
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

  it('publishes an action_ack_timeout event to homerun/events with entity and expected', async () => {
    const event = makeDecisionEvent({
      event_type: 'action_ack_timeout',
      action: { type: 'ha.call_service', domain: 'light', service: 'turn_on', target: { entity_id: 'light.example' } },
      entity: 'light.example',
      expected: { state: 'on' },
    });
    publisher.publishActionEvent(event);
    await vi.waitFor(() => expect(mqtt.publishAsync).toHaveBeenCalled());

    const call = callForTopic(mqtt, 'homerun/events')!;
    expect(JSON.parse(call[1] as string)).toMatchObject({
      event_type: 'action_ack_timeout',
      entity: 'light.example',
      expected: { state: 'on' },
    });
  });
});

describe('EventPublisher — enabled: false', () => {
  let mqtt: MockMqtt;
  let publisher: EventPublisher;

  beforeEach(() => {
    mqtt = makeMqtt();
    publisher = new EventPublisher(mqtt as unknown as MqttClient, false);
  });

  it('does not publish decision events to MQTT', () => {
    publisher.publishDecision(makeDecisionEvent());
    expect(mqtt.publishAsync).not.toHaveBeenCalled();
  });

  it('does not publish action events to MQTT', () => {
    publisher.publishActionEvent(makeDecisionEvent({ event_type: 'action_started' }));
    expect(mqtt.publishAsync).not.toHaveBeenCalled();
  });

  it('still notifies subscribed listeners for decision events', () => {
    const listener = vi.fn();
    publisher.subscribe(listener);
    const event = makeDecisionEvent();
    publisher.publishDecision(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('still notifies subscribed listeners for action events', () => {
    const listener = vi.fn();
    publisher.subscribe(listener);
    const event = makeDecisionEvent({ event_type: 'action_started' });
    publisher.publishActionEvent(event);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('still publishes lifecycle events to MQTT (unaffected by the events flag)', () => {
    publisher.publishLifecycle('server_started', 1);
    expect(mqtt.publishAsync).toHaveBeenCalled();
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

// ---------- History ----------

describe('EventPublisher — history', () => {
  const schemaFile = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../schemas/home.history.v1.json'), 'utf8'));
  const validator = z.fromJSONSchema(schemaFile);

  function publishedTo(mqtt: MockMqtt, topic: string): unknown[] {
    return mqtt.publishAsync.mock.calls.filter((c: unknown[]) => c[0] === topic).map((c) => JSON.parse(c[1] as string));
  }

  const acted = (overrides: Partial<ObsEvent> = {}) =>
    makeDecisionEvent({ outcome: 'acted', reason: 'lights_on', hasAction: true, ...overrides } as Partial<ObsEvent>);

  it('is off by default: no history topics are published', () => {
    const mqtt = makeMqtt();
    new EventPublisher(mqtt as unknown as MqttClient).publishDecision(acted());
    expect(mqtt.publishAsync.mock.calls.map((c: unknown[]) => c[0])).not.toContain('homerun/parlour/history');
    expect(mqtt.publishAsync.mock.calls.map((c: unknown[]) => c[0])).not.toContain('homerun/history');
  });

  it('publishes retained location and house history, each validating against the schema file', () => {
    const mqtt = makeMqtt();
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 });
    publisher.publishDecision(acted());
    for (const topic of ['homerun/parlour/history', 'homerun/history']) {
      const call = callForTopic(mqtt, topic);
      expect(call?.[2]).toEqual({ retain: true });
      expect(validator.safeParse(JSON.parse(call?.[1] as string)).success).toBe(true);
    }
  });

  it('publishes history when the ObsEvent stream is disabled', () => {
    const mqtt = makeMqtt();
    new EventPublisher(mqtt as unknown as MqttClient, false, { size: 20, houseSize: 30 }).publishDecision(acted());
    expect(callForTopic(mqtt, 'homerun/parlour/history')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeUndefined();
  });

  it('keeps separate locations apart and mixes them in the house history', () => {
    const mqtt = makeMqtt();
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 });
    publisher.publishDecision(acted({ location: 'parlour' }));
    publisher.publishDecision(acted({ location: 'hall', automation_id: 'hall:lighting' }));
    expect(publishedTo(mqtt, 'homerun/hall/history').at(-1)).toMatchObject({ entries: [{ location: 'hall' }] });
    expect((publishedTo(mqtt, 'homerun/history').at(-1) as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('caps each buffer at its size, newest first', () => {
    const mqtt = makeMqtt();
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 2, houseSize: 3 });
    for (const n of [1, 2, 3, 4]) publisher.publishDecision(acted({ decision: `d${n}` } as Partial<ObsEvent>));
    const entries = (publishedTo(mqtt, 'homerun/parlour/history').at(-1) as { entries: Array<{ decision: string }> }).entries;
    expect(entries.map((e) => e.decision)).toEqual(['d4', 'd3']);
    expect((publishedTo(mqtt, 'homerun/history').at(-1) as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('stores failed actions from publishActionEvent', () => {
    const mqtt = makeMqtt();
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 });
    publisher.publishActionEvent({
      schema: 'home.events.v2', correlation_id: 'c', root_correlation_id: 'c', automation_id: 'parlour:lighting',
      location: 'parlour', subsystem: 'lighting', timestamp: new Date().toISOString(), event_type: 'action_result',
      action: { type: 'timer.cancel', timerKey: 'k' }, status: 'error', error: 'x',
    });
    expect(publishedTo(mqtt, 'homerun/parlour/history').at(-1)).toMatchObject({ entries: [{ kind: 'action_failed' }] });
  });

  it('does not publish for events that are not remembered', () => {
    const mqtt = makeMqtt();
    new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 })
      .publishDecision(makeDecisionEvent({ outcome: 'ignored', reason: 'startup' } as Partial<ObsEvent>));
    expect(callForTopic(mqtt, 'homerun/parlour/history')).toBeUndefined();
  });

  it('keeps dry runs in homerun/dev and separate from live buffers', () => {
    const mqtt = makeMqtt();
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 });
    publisher.publishDecision(acted({ dry_run: true } as Partial<ObsEvent>));
    expect(callForTopic(mqtt, 'homerun/dev/parlour/history')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/dev/history')).toBeDefined();
    expect(callForTopic(mqtt, 'homerun/parlour/history')).toBeUndefined();
    expect(callForTopic(mqtt, 'homerun/history')).toBeUndefined();
    publisher.publishDecision(acted());
    expect((publishedTo(mqtt, 'homerun/parlour/history').at(-1) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('an invalid entry is logged and skipped without breaking the event or other listeners', () => {
    const mqtt = makeMqtt();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, { size: 20, houseSize: 30 });
    const listener = vi.fn();
    publisher.subscribe(listener);
    publisher.publishDecision(acted({ facts: { nested: { a: 1 } } } as unknown as Partial<ObsEvent>));
    expect(callForTopic(mqtt, 'homerun/parlour/history')).toBeUndefined();
    expect(callForTopic(mqtt, 'homerun/events')).toBeDefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('EventPublisher — seeding history from retained topics', () => {
  type Retained = Record<string, string>;

  // Delivers retained messages right after the subscribe resolves, as a broker does.
  function makeSeedMqtt(retained: Retained) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      publishAsync: vi.fn().mockResolvedValue(undefined),
      subscribeAsync: vi.fn(async (filters: string[]) => {
        queueMicrotask(() => {
          for (const [topic, payload] of Object.entries(retained)) {
            if (filters.some((f) => topicMatches(f, topic))) emitter.emit('message', topic, Buffer.from(payload), { retain: true });
          }
          // A live (non-retained) message on a matching topic must not be taken as a seed.
          emitter.emit('message', 'homerun/live/history', Buffer.from('{}'), { retain: false });
        });
        return [];
      }),
      unsubscribeAsync: vi.fn().mockResolvedValue(undefined),
    });
  }

  function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/'); const t = topic.split('/');
    return f.length === t.length && f.every((seg, i) => seg === '+' || seg === t[i]);
  }

  const entry = (location: string, decision: string) => ({
    ts: '2026-11-02T09:00:00.000Z', location, automation_id: `${location}:lighting`, subsystem: 'lighting',
    kind: 'decision', decision, outcome: 'acted',
  });
  const payload = (entries: unknown[]) => JSON.stringify({ schema: 'home.history.v1', entries });
  const config = { size: 3, houseSize: 5 };

  function lastPublished(mqtt: { publishAsync: ReturnType<typeof vi.fn> }, topic: string): { entries: Array<{ decision: string }> } {
    const calls = mqtt.publishAsync.mock.calls.filter((c: unknown[]) => c[0] === topic);
    return JSON.parse(calls.at(-1)?.[1] as string);
  }

  it('continues from the retained history, new entry on top', async () => {
    const mqtt = makeSeedMqtt({
      'homerun/parlour/history': payload([entry('parlour', 'old2'), entry('parlour', 'old1')]),
      'homerun/history': payload([entry('parlour', 'old2'), entry('parlour', 'old1')]),
    });
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, config);
    await publisher.seedHistory(false, 0);
    publisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true, decision: 'new' } as Partial<ObsEvent>));
    expect(lastPublished(mqtt, 'homerun/parlour/history').entries.map((e) => e.decision)).toEqual(['new', 'old2', 'old1']);
    expect(lastPublished(mqtt, 'homerun/history').entries.map((e) => e.decision)).toEqual(['new', 'old2', 'old1']);
  });

  it('trims a seed to the configured size', async () => {
    const mqtt = makeSeedMqtt({ 'homerun/parlour/history': payload([1, 2, 3, 4].map((n) => entry('parlour', `d${n}`))) });
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, config);
    await publisher.seedHistory(false, 0);
    publisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true, decision: 'new' } as Partial<ObsEvent>));
    expect(lastPublished(mqtt, 'homerun/parlour/history').entries).toHaveLength(3);
  });

  it('starts empty, with a warning, when a seed is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mqtt = makeSeedMqtt({ 'homerun/parlour/history': '{not json' });
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, config);
    await publisher.seedHistory(false, 0);
    publisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true } as Partial<ObsEvent>));
    expect(lastPublished(mqtt, 'homerun/parlour/history').entries).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('starts empty when nothing is retained', async () => {
    const mqtt = makeSeedMqtt({});
    const publisher = new EventPublisher(mqtt as unknown as MqttClient, true, config);
    await publisher.seedHistory(false, 0);
    publisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true } as Partial<ObsEvent>));
    expect(lastPublished(mqtt, 'homerun/parlour/history').entries).toHaveLength(1);
  });

  it('reads only the dev namespace in a dry run, and never reads dev topics as a live location', async () => {
    const retained = {
      'homerun/parlour/history': payload([entry('parlour', 'live')]),
      'homerun/dev/history': payload([entry('parlour', 'dev_house')]),
      'homerun/dev/parlour/history': payload([entry('parlour', 'dev')]),
    };
    const live = makeSeedMqtt(retained);
    const livePublisher = new EventPublisher(live as unknown as MqttClient, true, config);
    await livePublisher.seedHistory(false, 0);
    livePublisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true, decision: 'new' } as Partial<ObsEvent>));
    expect(lastPublished(live, 'homerun/parlour/history').entries.map((e) => e.decision)).toEqual(['new', 'live']);
    expect(live.publishAsync.mock.calls.map((c: unknown[]) => c[0])).not.toContain('homerun/dev/history');

    const dry = makeSeedMqtt(retained);
    const dryPublisher = new EventPublisher(dry as unknown as MqttClient, true, config);
    await dryPublisher.seedHistory(true, 0);
    dryPublisher.publishDecision(makeDecisionEvent({ outcome: 'acted', hasAction: true, decision: 'new', dry_run: true } as Partial<ObsEvent>));
    expect(lastPublished(dry, 'homerun/dev/parlour/history').entries.map((e) => e.decision)).toEqual(['new', 'dev']);
    expect(lastPublished(dry, 'homerun/dev/history').entries.map((e) => e.decision)).toEqual(['new', 'dev_house']);
  });

  it('unsubscribes and removes its listener when done', async () => {
    const mqtt = makeSeedMqtt({});
    await new EventPublisher(mqtt as unknown as MqttClient, true, config).seedHistory(false, 0);
    expect(mqtt.unsubscribeAsync).toHaveBeenCalled();
    expect(mqtt.listenerCount('message')).toBe(0);
  });

  it('does nothing when history is off', async () => {
    const mqtt = makeSeedMqtt({});
    await new EventPublisher(mqtt as unknown as MqttClient).seedHistory(false, 0);
    expect(mqtt.subscribeAsync).not.toHaveBeenCalled();
  });

  it('starts empty, with a warning, when the subscribe fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mqtt = makeSeedMqtt({});
    mqtt.subscribeAsync.mockRejectedValue(new Error('denied'));
    await expect(new EventPublisher(mqtt as unknown as MqttClient, true, config).seedHistory(false, 0)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
