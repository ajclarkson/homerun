import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MqttClient } from 'mqtt';
import { ApiServer } from './api-server.js';
import { AutomationRegistry } from './registry.js';
import { EventPublisher } from './event-publisher.js';
import type { Automation } from '../types/automation.js';

// ---------- Helpers ----------

function makeAutomation(id: string, overrides: Partial<Automation<unknown>> = {}): Automation<unknown> {
  return {
    id,
    location: 'parlour',
    subsystem: 'lighting',
    triggers: [{ type: 'on_start' }, { type: 'schedule', cron: '0 * * * *' }],
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
    ...overrides,
  };
}

function makeMqtt(): { publishAsync: ReturnType<typeof vi.fn> } {
  return { publishAsync: vi.fn().mockResolvedValue(undefined) };
}

async function get(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`);
}

async function post(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
}

// ---------- Tests ----------

describe('ApiServer', () => {
  let registry: AutomationRegistry;
  let obs: EventPublisher;
  let onTrigger: ReturnType<typeof vi.fn>;
  let onReload: ReturnType<typeof vi.fn>;
  let isReady: ReturnType<typeof vi.fn>;
  let entityCount: ReturnType<typeof vi.fn>;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    registry = new AutomationRegistry();
    obs = new EventPublisher(makeMqtt() as unknown as MqttClient);
    onTrigger = vi.fn();
    onReload = vi.fn().mockResolvedValue(undefined);
    isReady = vi.fn().mockReturnValue(true);
    entityCount = vi.fn().mockReturnValue(42);

    server = new ApiServer({ registry, onTrigger, onReload, isReady, entityCount, eventPublisher: obs });
    await server.start(0);
    port = server.port!;
  });

  afterEach(async () => {
    await server.stop();
  });

  // ---------- GET /automations ----------

  describe('GET /automations', () => {
    it('returns 200 with JSON content-type', async () => {
      const res = await get(port, '/automations');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
    });

    it('returns empty array when no automations are registered', async () => {
      const res = await get(port, '/automations');
      expect(await res.json()).toEqual([]);
    });

    it('returns registered automations with id, location, subsystem, and full triggers', async () => {
      registry.register(makeAutomation('parlour:lighting'));
      const res = await get(port, '/automations');
      const body = await res.json() as unknown[];
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: 'parlour:lighting',
        location: 'parlour',
        subsystem: 'lighting',
        enabled: true,
        triggers: [
          { type: 'on_start' },
          { type: 'schedule', cron: '0 * * * *' },
        ],
      });
    });

    it('serialises RegExp entity as a string in state_changed triggers', async () => {
      registry.register(makeAutomation('kitchen:heating', {
        location: 'kitchen',
        subsystem: 'heating',
        triggers: [{ type: 'state_changed', entity: /^sensor\.kitchen_/ }],
      }));
      const res = await get(port, '/automations');
      const body = await res.json() as Array<{ triggers: unknown[] }>;
      expect(body[0].triggers[0]).toEqual({ type: 'state_changed', entity: '/^sensor\\.kitchen_/' });
    });

    it('returns all registered automations', async () => {
      registry.register(makeAutomation('parlour:lighting'));
      registry.register(makeAutomation('kitchen:heating', { location: 'kitchen', subsystem: 'heating' }));
      const res = await get(port, '/automations');
      const body = await res.json() as unknown[];
      expect(body).toHaveLength(2);
    });
  });

  // ---------- POST /automations/:id/trigger ----------

  describe('POST /automations/:id/trigger', () => {
    it('returns 404 when automation does not exist', async () => {
      const res = await post(port, '/automations/unknown:thing/trigger');
      expect(res.status).toBe(404);
    });

    it('returns 200 when automation exists', async () => {
      registry.register(makeAutomation('parlour:lighting'));
      const res = await post(port, '/automations/parlour:lighting/trigger');
      expect(res.status).toBe(200);
    });

    it('calls onTrigger with the automation and a manual trigger event', async () => {
      const automation = makeAutomation('parlour:lighting');
      registry.register(automation);
      await post(port, '/automations/parlour:lighting/trigger');
      expect(onTrigger).toHaveBeenCalledOnce();
      const [calledAutomation, calledEvent] = onTrigger.mock.calls[0] as [unknown, { type: string; correlation_id: string }];
      expect(calledAutomation).toBe(automation);
      expect(calledEvent.type).toBe('on_start');
      expect(typeof calledEvent.correlation_id).toBe('string');
    });
  });

  // ---------- POST /reload ----------

  describe('POST /reload', () => {
    it('returns 200 and calls onReload', async () => {
      const res = await post(port, '/reload');
      expect(res.status).toBe(200);
      expect(onReload).toHaveBeenCalledOnce();
    });

    it('returns 500 when onReload rejects', async () => {
      onReload.mockRejectedValue(new Error('reload failed'));
      const res = await post(port, '/reload');
      expect(res.status).toBe(500);
    });
  });

  // ---------- GET /health/live ----------

  describe('GET /health/live', () => {
    it('returns 200 when process is running', async () => {
      const res = await get(port, '/health/live');
      expect(res.status).toBe(200);
    });

    it('returns 200 even when isReady returns false', async () => {
      isReady.mockReturnValue(false);
      const res = await get(port, '/health/live');
      expect(res.status).toBe(200);
    });
  });

  // ---------- GET /health/ready ----------

  describe('GET /health/ready', () => {
    it('returns 200 with entity and automation count when ready', async () => {
      registry.register(makeAutomation('parlour:lighting'));
      registry.register(makeAutomation('kitchen:heating'));
      const res = await get(port, '/health/ready');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).toMatchObject({ status: 'ready', entities: 42, automations: 2 });
    });

    it('returns 503 when not ready', async () => {
      isReady.mockReturnValue(false);
      const res = await get(port, '/health/ready');
      expect(res.status).toBe(503);
    });

    it('returns 503 with status: starting in the body', async () => {
      isReady.mockReturnValue(false);
      const res = await get(port, '/health/ready');
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('starting');
    });

    it('omits dry_run from the response when not in dry-run mode', async () => {
      const res = await get(port, '/health/ready');
      const body = await res.json() as Record<string, unknown>;
      expect(body.dry_run).toBeUndefined();
    });

    it('includes dry_run: true in the response when in dry-run mode', async () => {
      const dryServer = new ApiServer({ registry, onTrigger, onReload, isReady, entityCount, eventPublisher: obs, dryRun: true });
      await dryServer.start(0);
      try {
        const res = await get(dryServer.port!, '/health/ready');
        const body = await res.json() as Record<string, unknown>;
        expect(body.dry_run).toBe(true);
      } finally {
        await dryServer.stop();
      }
    });
  });

  // ---------- GET /events ----------

  describe('GET /events', () => {
    it('returns text/event-stream content-type', async () => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    });

    it('streams events published via event publisher', async () => {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      const event: Parameters<typeof obs.publishDecision>[0] = {
        schema: 'home.events.v1',
        correlation_id: 'test-123',
        automation_id: 'parlour:lighting',
        location: 'parlour',
        subsystem: 'lighting',
        event_type: 'decision',
        decision: 'lights_on',
        timestamp: new Date().toISOString(),
      };

      obs.publishDecision(event);

      const { value } = await reader.read();
      const text = decoder.decode(value);
      controller.abort();

      expect(text).toContain('data:');
      const jsonStr = text.replace(/^data:\s*/m, '').trim();
      expect(JSON.parse(jsonStr)).toMatchObject({ automation_id: 'parlour:lighting', event_type: 'decision' });
    });

    it('unsubscribes the SSE listener when the client disconnects', async () => {
      const controller = new AbortController();
      await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
      controller.abort();

      // Brief wait for cleanup to propagate
      await new Promise((r) => setTimeout(r, 20));

      // Publishing should not throw even after client disconnected
      expect(() =>
        obs.publishDecision({
          schema: 'home.events.v1',
          correlation_id: 'x',
          automation_id: 'a',
          location: 'l',
          subsystem: 's',
          type: 'decision',
          timestamp: new Date().toISOString(),
        }),
      ).not.toThrow();
    });
  });

  // ---------- Unknown routes ----------

  describe('unknown routes', () => {
    it('returns 404 for an unknown GET path', async () => {
      const res = await get(port, '/unknown');
      expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown POST path', async () => {
      const res = await post(port, '/unknown');
      expect(res.status).toBe(404);
    });
  });
});
