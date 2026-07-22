import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { HAClient, type StateChangedEvent } from './ha-client.js';

// ---------- Mock home-assistant-js-websocket ----------

let capturedSubscribeCallback: ((entities: Record<string, unknown>) => void) | null = null;
let capturedDisconnectListener: (() => void) | null = null;
let capturedRegistryUpdatedCallback: (() => void) | null = null;

const mockConnection = {
  addEventListener: vi.fn((event: string, cb: () => void) => {
    if (event === 'disconnected') capturedDisconnectListener = cb;
  }),
  sendMessagePromise: vi.fn(async () => []),
  close: vi.fn(),
};

vi.mock('home-assistant-js-websocket', () => ({
  createLongLivedTokenAuth: vi.fn(() => ({})),
  createConnection: vi.fn(async () => mockConnection),
  subscribeEntities: vi.fn((_conn: unknown, cb: (entities: Record<string, unknown>) => void) => {
    capturedSubscribeCallback = cb;
  }),
  subscribeEvents: vi.fn((_conn: unknown, cb: () => void, eventType: string) => {
    if (eventType === 'entity_registry_updated') capturedRegistryUpdatedCallback = cb;
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
  registryEntries: Array<{ entity_id: string; labels?: string[]; area_id?: string }> = [],
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
    capturedRegistryUpdatedCallback = null;
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

    it('mints a correlation_id on each state_changed event', async () => {
      const { client } = await connectAndInitialise({
        'light.kitchen': makeEntity('on', '2024-01-01T00:00:00Z'),
      });

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({
        'light.kitchen': makeEntity('off', '2024-01-01T00:01:00Z'),
      }));

      expect((changes[0] as StateChangedEvent & { correlation_id: string }).correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('mints a different correlation_id for each state_changed event', async () => {
      const { client } = await connectAndInitialise({
        'light.a': makeEntity('on', 'T1'),
        'light.b': makeEntity('on', 'T1'),
      });

      const changes: StateChangedEvent[] = [];
      client.on('state_changed', (e) => changes.push(e));

      capturedSubscribeCallback!(snapshot({
        'light.a': makeEntity('off', 'T2'),
        'light.b': makeEntity('off', 'T2'),
      }));

      const ids = changes.map((e) => (e as StateChangedEvent & { correlation_id: string }).correlation_id);
      expect(ids[0]).not.toBe(ids[1]);
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

  describe('entity registry / areas', () => {
    it('returns entities for an area', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'light.parlour_ceiling', area_id: 'parlour' },
        { entity_id: 'light.parlour_floor_lamp', area_id: 'parlour' },
        { entity_id: 'light.kitchen_ceiling', area_id: 'kitchen' },
      ]);

      expect(client.context.entitiesByArea('parlour').sort()).toEqual([
        'light.parlour_ceiling',
        'light.parlour_floor_lamp',
      ]);
    });

    it('returns empty array for unknown area', async () => {
      const { client } = await connectAndInitialise({}, []);
      expect(client.context.entitiesByArea('no_such_area')).toEqual([]);
    });

    it('ignores entities with no area_id', async () => {
      const { client } = await connectAndInitialise({}, [
        { entity_id: 'light.no_area' },
        { entity_id: 'light.parlour_ceiling', area_id: 'parlour' },
      ]);

      expect(client.context.entitiesByArea('parlour')).toEqual(['light.parlour_ceiling']);
    });

    it('reloads area map on reconnect', async () => {
      (mockConnection.sendMessagePromise as Mock)
        .mockResolvedValueOnce([
          { entity_id: 'light.a', area_id: 'old_room' },
        ])
        .mockResolvedValueOnce([
          { entity_id: 'light.a', area_id: 'new_room' },
        ]);

      const { client } = await connectClient();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T1') }));
      await client.ready;

      capturedDisconnectListener!();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T2') }));

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.context.entitiesByArea('old_room')).toEqual([]);
      expect(client.context.entitiesByArea('new_room')).toEqual(['light.a']);
    });
  });

  describe('entity_registry_updated live refresh', () => {
    it('reloads labels when entity_registry_updated fires', async () => {
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

      expect(client.context.labelsFor('light.a')).toEqual(['old_label']);

      capturedRegistryUpdatedCallback!();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.context.labelsFor('light.a')).toEqual(['new_label']);
      expect(client.context.entitiesByLabel('old_label')).toEqual([]);
      expect(client.context.entitiesByLabel('new_label')).toEqual(['light.a']);
    });

    it('reloads area map when entity_registry_updated fires', async () => {
      (mockConnection.sendMessagePromise as Mock)
        .mockResolvedValueOnce([
          { entity_id: 'light.a', area_id: 'old_room' },
        ])
        .mockResolvedValueOnce([
          { entity_id: 'light.a', area_id: 'new_room' },
        ]);

      const { client } = await connectClient();
      capturedSubscribeCallback!(snapshot({ 'light.a': makeEntity('on', 'T1') }));
      await client.ready;

      expect(client.context.entitiesByArea('old_room')).toEqual(['light.a']);

      capturedRegistryUpdatedCallback!();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(client.context.entitiesByArea('old_room')).toEqual([]);
      expect(client.context.entitiesByArea('new_room')).toEqual(['light.a']);
    });

    it('subscribes to entity_registry_updated on connect', async () => {
      const { subscribeEvents } = await import('home-assistant-js-websocket');
      const { client } = await connectClient();
      capturedSubscribeCallback!(snapshot({}));
      await client.ready;
      expect(subscribeEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        'entity_registry_updated',
      );
    });
  });

  describe('disconnect', () => {
    it('calls close() on the underlying connection', async () => {
      const { client } = await connectAndInitialise();
      mockConnection.close.mockClear();
      client.disconnect();
      expect(mockConnection.close).toHaveBeenCalledOnce();
    });

    it('is safe to call when not yet connected', () => {
      const client = new HAClient();
      expect(() => client.disconnect()).not.toThrow();
    });

    it('is safe to call twice', async () => {
      const { client } = await connectAndInitialise();
      mockConnection.close.mockClear();
      client.disconnect();
      expect(() => client.disconnect()).not.toThrow();
      expect(mockConnection.close).toHaveBeenCalledOnce();
    });
  });
});
