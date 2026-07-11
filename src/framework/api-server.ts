import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AutomationRegistry } from './registry.js';
import type { Observability, ObsEvent } from './observability.js';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';

export interface ApiServerDeps {
  registry: AutomationRegistry;
  onTrigger: (automation: Automation<unknown>, event: TriggerEvent) => void;
  onReload: () => Promise<void>;
  isReady: () => boolean;
  entityCount: () => number;
  observability: Observability;
  dryRun?: boolean;
}

export class ApiServer {
  private server: Server | null = null;
  private _port: number | null = null;

  constructor(private readonly deps: ApiServerDeps) {}

  get port(): number | null {
    return this._port;
  }

  start(port = 7070): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.listen(port, '0.0.0.0', () => {
        const addr = this.server!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : port;
        console.log(`[homerun] API server listening on port ${this._port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url === '/automations') return this.getAutomations(res);
    if (method === 'POST' && url === '/reload') return this.postReload(res);
    if (method === 'GET' && url === '/health/live') return this.getHealthLive(res);
    if (method === 'GET' && url === '/health/ready') return this.getHealthReady(res);
    if (method === 'GET' && url === '/events') return this.getEvents(req, res);

    const triggerMatch = method === 'POST' && url.match(/^\/automations\/(.+)\/trigger$/);
    if (triggerMatch) return this.postTrigger(triggerMatch[1], res);

    json(res, 404, { error: 'not found' });
  }

  private getAutomations(res: ServerResponse): void {
    const automations = this.deps.registry.getAll().map((a) => ({
      id: a.id,
      location: a.location,
      subsystem: a.subsystem,
      triggerTypes: a.triggers.map((t) => t.type),
    }));
    json(res, 200, automations);
  }

  private postTrigger(id: string, res: ServerResponse): void {
    const automation = this.deps.registry.getById(id);
    if (!automation) {
      json(res, 404, { error: `no automation with id "${id}"` });
      return;
    }
    this.deps.onTrigger(automation, { type: 'on_start', correlation_id: crypto.randomUUID() });
    json(res, 200, { ok: true });
  }

  private postReload(res: ServerResponse): void {
    this.deps.onReload()
      .then(() => json(res, 200, { ok: true }))
      .catch((err: unknown) => {
        console.error('[ApiServer] reload failed:', err);
        json(res, 500, { error: 'reload failed' });
      });
  }

  private getHealthLive(res: ServerResponse): void {
    json(res, 200, { status: 'live' });
  }

  private getHealthReady(res: ServerResponse): void {
    if (!this.deps.isReady()) {
      json(res, 503, { status: 'starting' });
      return;
    }
    json(res, 200, {
      status: 'ready',
      entities: this.deps.entityCount(),
      automations: this.deps.registry.getAll().length,
      ...(this.deps.dryRun && { dry_run: true }),
    });
  }

  private getEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const unsubscribe = this.deps.observability.subscribe((event: ObsEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on('close', unsubscribe);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}
