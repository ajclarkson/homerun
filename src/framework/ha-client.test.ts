import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HAClient, type StateChangedEvent } from './ha-client.js';

// ---------- Mock home-assistant-js-websocket ----------

let capturedSubscribeCallback: ((entities: Record<string, unknown>) => void) | null = null;
let capturedDisconnectListener: (() => void) | null = null;

const mockConnection = {
  addEventListener: vi.fn((event: string, cb: () => void) => {
    if (event === 'disconnected') capturedDisconnectListener = cb;
  }),
  sendMessagePromise: vi.fn(async () => []),
};

vi.mock('home-assistant-js-websocket', () => ({
  createLongLivedTokenAuth: vi.fn(() => ({})),
  createConnection: vi.fn(async () => mockConnection),
  subscribeEntities: vi.fn((_conn: unknown, cb: (entities: Record<string, unknown>) => void) => {
    capturedSubscribeCallback = cb;
  }),
}));

// ---------- Helpers ----------

function makeEntity(
  state: string,
  lastUpdated = '2024-01-01T00:00:00Z',
  attributes: Record<string, unknown> = {},
) {
  return {
    state,
    attributes,
    last_changed: lastUpdated,
    last_updated: lastUpdated,
    context: { id: '', parent_id: null, user_id: null },
  };
}

function snapshot(entities: Record<string, ReturnType<typeof makeEntity>>) {
  return entities;
}

async function connectClient() {
  const client = new HAClient();
  const connectPromise = client.connect('http://ha.local', 'token');
  // connect() chains createConnection → loadEntityRegistry → subscribeEntities, so we
  // need to drain the full microtask queue (not just one tick) before the subscribe
  // callback is captured. setImmediate fires after all pending microtasks complete.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { client, connectPromise };
}

async function connectAndInitialise(
  entities: Record<string, ReturnType<typeof makeEntity>> = {},
  registryEntries: Array<{ entity_id: string; labels?: string[] }> = [],
) {
  (mockConnection.sendMessagePromise as Mock).mockResolvedValueOnce(registryEntries);
  const { client, connectPromise } = await connectClient();
  capturedSubscribeCallback!(snapshot(entities));
  await client.ready;
  return { client, connectPromise };
}

// ---------- Tests ----------

describe('HAClient', () => {
  beforeEach(() => {
    capturedSubscribeCallback = null;
    capturedDisconnectListener = null;
    vi.clearAllMocks();
    mockConnection.sendMessagePromise.mockResolvedValue([]);
  });

  describe('initial connection', () => {
    it('resolves ready after first subscribeEntities snapshot', async () => {
      const { client } = await connectAndInitialise({
        'light.test': makeEntity('on'),
      });

      let resolved = false;
      client.ready.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(true);
    });

    it('emits ready event after first snapshot', async () => {
      mockConnection.sendMessagePromise.mockResolvedValueOnce([]);
      const { client } = await connectClient();

      const readyFired = vi.fn();
      client.on('ready', readyFired);

      capturedSubscribeCallback!(snapshot({ 'light.test': makeEntity('on') }));
      await client.ready;

      expect(readyFired).toHaveBeenCalledOnce();
    });

    it('populates state cache from initial snapshot', async () => {
      const { client } = await connectAndInitialise({
        'light.kitchen': makeEntity('on'),
        'sensor.temp': makeEntity('21.5'),
      });

      expect(client.state('light.kitchen')?.state).toBe('on');
      expect(client.state('sensor.temp')?.state).toBe('21.5');
      expect(client.entityCount).toBe(2);
    });

    it('returns undefined for unknown entity', async () => {
      const { client } = await connectAndInitialise({});
      expect(client.state('light.does_not_exist')).toBeUndefined();
    });

    it('does not emit state_changed events during initial snapshot', async () => {
      mockConnection.sendMessagePromise.mockResolvedValueOnce([]);
      const { client } = await connectClient();

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({ 'light.test': makeEntity('on') }));
      await client.ready;

      expect(changes).toHaveLength(0);
    });
  });

  describe('state_changed events', () => {
    it('emits state_changed when last_updated changes', async () => {
      const { client } = await connectAndInitialise({
        'light.kitchen': makeEntity('on', '2024-01-01T00:00:00Z'),
      });

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({
        'light.kitchen': makeEntity('off', '2024-01-01T00:01:00Z'),
      }));

      expect(changes).toHaveLength(1);
      expect(changes[0].entity_id).toBe('light.kitchen');
      expect(changes[0].old_state?.state).toBe('on');
      expect(changes[0].new_state.state).toBe('off');
    });

    it('does not emit state_changed when last_updated is unchanged', async () => {
      const { client } = await connectAndInitialise({
        'light.kitchen': makeEntity('on', '2024-01-01T00:00:00Z'),
      });

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      // Same last_updated — HA batched an unrelated entity in the same snapshot.
      capturedSubscribeCallback!(snapshot({
        'light.kitchen': makeEntity('on', '2024-01-01T00:00:00Z'),
      }));

      expect(changes).toHaveLength(0);
    });

    it('emits state_changed with undefined old_state for a new entity', async () => {
      const { client } = await connectAndInitialise({});

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({
        'light.new': makeEntity('on', '2024-01-01T00:01:00Z'),
      }));

      expect(changes[0].old_state).toBeUndefined();
      expect(changes[0].new_state.state).toBe('on');
    });

    it('emits state_changed for only the entity that changed', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
        'light.b': makeEntity('off', 'T1'),
      });

      const changed: string[] = [];
      client.on('state_changed', (e) => changed.push(e.entity_id));

      capturedSubscribeCallback!(snapshot({
        'light.a': makeEntity('on', 'T1'),      // unchanged
        'light.b': makeEntity('on', 'T2'),      // changed
      }));

      expect(changed).toEqual(['light.b']);
    });

    it('prunes entities that disappear from the snapshot', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
        'light.b': makeEntity('on', 'T1'),
      });

      capturedSubscribeCallback!(snapshot({
        'light.a': makeEntity('on', 'T1'),
        // light.b removed
      }));

      expect(client.state('light.b')).toBeUndefined();
      expect(client.entityCount).toBe(1);
    });

    it('updates the cache with the new state', async () => {
      const { client } = await connectAndInitialise({
        'sensor.temp': makeEntity('20', 'T1'),
      });

      capturedSubscribeCallback!(snapshot({
        'sensor.temp': makeEntity('21', 'T2'),
      }));

      expect(client.state('sensor.temp')?.state).toBe('21');
    });
  });

  describe('reconnect', () => {
    it('does not emit state_changed events during reconnect repopulate', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
      });

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedDisconnectListener!();

      // Reconnect snapshot — light.a changed state while disconnected.
      capturedSubscribeCallback!(snapshot({
        'light.a': makeEntity('off', 'T2'),
      }));

      expect(changes).toHaveLength(0);
    });

    it('emits reconnected after reconnect snapshot', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
      });

      const reconnectedFired = vi.fn();
      client.on('reconnected', reconnectedFired);

      capturedDisconnectListener!();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('off', 'T2') }));

      expect(reconnectedFired).toHaveBeenCalledOnce();
    });

    it('repopulates cache with post-reconnect state', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
      });

      capturedDisconnectListener!();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('off', 'T2') }));

      expect(client.state('light.a')?.state).toBe('off');
    });

    it('resumes emitting state_changed after reconnect', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
      });

      capturedDisconnectListener!();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('off', 'T2') }));

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T3') }));

      expect(changes).toHaveLength(1);
      expect(changes[0].new_state.state).toBe('on');
    });
  });

  describe('entity registry / labels', () => {
    it('returns entities for a label', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'input_boolean.presence_a', labels: ['presence_hold_strong'] },
        { entity_id: 'input_boolean.presence_b', labels: ['presence_hold_strong'] },
        { entity_id: 'input_boolean.door_a', labels: ['presence_hold_door'] },
      ]);

      expect(client.context.entitiesByLabel('presence_hold_strong').sort()).toEqual([
        'input_boolean.presence_a',
        'input_boolean.presence_b',
      ]);
    });

    it('returns empty array for unknown label', async () => {
      const { client } = await connectAndInitialise({}, []);
      expect(client.context.entitiesByLabel('no_such_label')).toEqual([]);
    });

    it('returns labels for an entity', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'light.kitchen', labels: ['mood_light', 'kitchen_main'] },
      ]);

      expect(client.context.labelsFor('light.kitchen').sort()).toEqual([
        'kitchen_main',
        'mood_light',
      ]);
    });

    it('returns empty array for entity with no labels', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'light.kitchen' },
      ]);

      expect(client.context.labelsFor('light.kitchen')).toEqual([]);
    });

    it('handles entities with no labels field', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'light.unlabelled' },
      ]);

      expect(client.context.labelsFor('light.unlabelled')).toEqual([]);
      expect(client.context.entitiesByLabel('anything')).toEqual([]);
    });

    it('reloads registry on reconnect', async () => {
      (mockConnection.sendMessagePromise as Mock)
        .mockResolvedValueOnce([
          { entity_id: 'light.a', labels: ['old_label'] },
        ])
        .mockResolvedValueOnce([
          { entity_id: 'light.a', labels: ['new_label'] },
        ]);

      const { client } = await connectClient();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T1') }));
      await client.ready;

      capturedDisconnectListener!();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T2') }));

      // Give the background registry reload a tick to complete.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.context.labelsFor('light.a')).toEqual(['new_label']);
      expect(client.context.entitiesByLabel('old_label')).toEqual([]);
      expect(client.context.entitiesByLabel('new_label')).toEqual(['light.a']);
    });
  });
});
