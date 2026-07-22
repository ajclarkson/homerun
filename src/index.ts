import path from 'node:path';
import { connect } from 'mqtt';
import { loadConfig } from './framework/config.js';
import { HAClient } from './framework/ha-client.js';
import { AutomationRegistry } from './framework/registry.js';
import { EventPublisher } from './framework/event-publisher.js';
import { TimerManager } from './framework/timer-manager.js';
import { ActionRuntime } from './framework/action-runtime.js';
import { TriggerEngine } from './framework/trigger-engine.js';
import { Scheduler } from './framework/scheduler.js';
import { rescanAutomations, startHotReload } from './framework/hot-reload.js';
import { runPipeline } from './framework/pipeline.js';
import { ApiServer } from './framework/api-server.js';
import { PromMetricsBackend } from './framework/metrics-prom.js';
import { NoopMetricsBackend } from './framework/metrics.js';

process.on('uncaughtException', (err) => {
  console.error('[homerun] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[homerun] unhandledRejection:', reason);
});

// 0. Load and validate configuration before anything else.
const config = await loadConfig();
const { dry_run: dryRun } = config.options;
const metricsBackend = config.metrics.enabled ? new PromMetricsBackend(true) : new NoopMetricsBackend();

const lwtTopic = dryRun ? 'homerun/dev/status' : 'homerun/status';
const lwtPayload = JSON.stringify({ status: 'offline', timestamp: new Date().toISOString() });

// 1. Connect MQTT before anything else (EventPublisher and ActionRuntime need it).
const mqtt = connect(config.mqtt.url, {
  will: { topic: lwtTopic, payload: lwtPayload, qos: 1, retain: true },
});
await new Promise<void>((resolve, reject) => {
  mqtt.once('connect', () => resolve());
  mqtt.once('error', reject);
});

// 2. Instantiate components in dependency order.
//    TimerManager holds a closure over `engine` — the late binding is intentional;
//    `engine` is assigned before any timer can fire.
const haClient = new HAClient();
const registry = new AutomationRegistry();
const eventPublisher = new EventPublisher(mqtt);
let engine!: TriggerEngine;
const timerManager = new TimerManager((e) => engine.dispatch(e));
const actionRuntime = new ActionRuntime({
  haClient,
  mqttClient: mqtt,
  timerManager,
  eventPublisher,
  dryRun,
  metrics: metricsBackend,
});

// 3. Initial automation load — must complete before the engine and scheduler start.
const automationsDir = path.resolve(config.automations.dir);

await rescanAutomations(automationsDir, registry);
const initialCount = registry.getAll().length;
metricsBackend.setGauge('homerun_automations_loaded', initialCount);
console.log(`[homerun] loaded ${initialCount} automation(s)`);

// 4. Wire up the engine and scheduler.
//    Track in-flight pipelines so graceful shutdown can drain before exit.
let shuttingDown = false;
let inFlight = 0;
let drainResolve: (() => void) | null = null;

function dispatchPipeline(automation: Parameters<typeof runPipeline>[0], event: Parameters<typeof runPipeline>[1]): void {
  if (shuttingDown) return;
  inFlight++;
  runPipeline(automation, event, haClient, { eventPublisher, actionRuntime, dryRun, metrics: metricsBackend })
    .catch((err: unknown) => { console.error('[homerun] pipeline error:', err); })
    .finally(() => {
      inFlight--;
      if (inFlight === 0 && drainResolve) { drainResolve(); drainResolve = null; }
    });
}

engine = new TriggerEngine(registry, haClient, dispatchPipeline, mqtt, metricsBackend);
const scheduler = new Scheduler(registry.getAll(), (e) => engine.dispatch(e), haClient.ready);

engine.start();
scheduler.start();

// 5. Start hot-reload watcher (dev) and SIGUSR1 rescan (git-sync sidecar in k8s).
startHotReload(automationsDir, registry);

async function reload(): Promise<void> {
  await rescanAutomations(automationsDir, registry);
  scheduler.sync(registry.getAll());
  const count = registry.getAll().length;
  metricsBackend.setGauge('homerun_automations_loaded', count);
  console.log(`[homerun] rescan complete — ${count} automation(s) registered`);
  eventPublisher.publishLifecycle('rescan_complete', count, dryRun);
}

process.on('SIGUSR1', () => {
  console.log('[homerun] SIGUSR1 received — rescanning automations');
  reload().catch((err: unknown) => {
    console.error('[homerun] rescan failed:', err);
  });
});

// 6. Start the HTTP API server.
let haReady = false;
const apiServer = new ApiServer({
  registry,
  onTrigger: dispatchPipeline,
  onReload: reload,
  isReady: () => haReady,
  entityCount: () => haClient.entityCount,
  eventPublisher,
  dryRun,
  metrics: config.metrics.enabled ? metricsBackend as PromMetricsBackend : undefined,
});
await apiServer.start(config.server.port);

// 7. Connect to HA last — state_changed events start flowing once ready resolves.
haClient.on('reconnected', () => {
  console.log(`[homerun] reconnected — ${haClient.entityCount} entities refreshed`);
  eventPublisher.publishLifecycle('ha_reconnected', registry.getAll().length, dryRun);
});

await haClient.connect(config.homeassistant.url, config.homeassistant.token);
await haClient.ready;
haReady = true;
console.log(`[homerun] ready — ${haClient.entityCount} entities cached`);
eventPublisher.publishLifecycle('server_started', registry.getAll().length, dryRun);

// 8. Graceful SIGTERM shutdown.
process.on('SIGTERM', () => {
  console.log('[homerun] SIGTERM received — starting graceful shutdown');
  const { shutdown_timeout_ms: timeoutMs } = config.server;
  shuttingDown = true;

  const automationCount = registry.getAll().length;
  eventPublisher.publishLifecycle('server_stopping', automationCount, dryRun);

  const drain = (): Promise<void> => {
    if (inFlight === 0) return Promise.resolve();
    console.log(`[homerun] draining ${inFlight} in-flight pipeline(s)...`);
    return new Promise<void>((resolve) => {
      drainResolve = resolve;
      setTimeout(() => {
        if (drainResolve) {
          console.warn(`[homerun] shutdown: drain timed out with ${inFlight} pipeline(s) still running`);
          drainResolve = null;
          resolve();
        }
      }, timeoutMs);
    });
  };

  Promise.resolve()
    .then(() => apiServer.stop())
    .then(() => { scheduler.stop(); timerManager.cancelAll(); })
    .then(drain)
    .then(() => { haClient.disconnect(); return mqtt.endAsync(); })
    .then(() => {
      console.log('[homerun] shutdown complete');
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[homerun] shutdown error:', err);
      process.exit(1);
    });
});
