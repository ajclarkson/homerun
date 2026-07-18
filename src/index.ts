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

process.on('uncaughtException', (err) => {
  console.error('[homerun] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[homerun] unhandledRejection:', reason);
});

// 0. Load and validate configuration before anything else.
const config = await loadConfig();
const { dry_run: dryRun } = config.options;

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
});

// 3. Initial automation load — must complete before the engine and scheduler start.
const automationsDir = path.resolve(config.automations.dir);

await rescanAutomations(automationsDir, registry);
console.log(`[homerun] loaded ${registry.getAll().length} automation(s)`);

// 4. Wire up the engine and scheduler.
engine = new TriggerEngine(registry, haClient, (automation, event) => {
  runPipeline(automation, event, haClient, { eventPublisher, actionRuntime, dryRun }).catch((err: unknown) => {
    console.error('[homerun] pipeline error:', err);
  });
}, mqtt);
const scheduler = new Scheduler(registry.getAll(), (e) => engine.dispatch(e), haClient.ready);

engine.start();
scheduler.start();

// 5. Start hot-reload watcher (dev) and SIGUSR1 rescan (git-sync sidecar in k8s).
startHotReload(automationsDir, registry);

async function reload(): Promise<void> {
  await rescanAutomations(automationsDir, registry);
  const count = registry.getAll().length;
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
  onTrigger: (automation, event) => {
    runPipeline(automation, event, haClient, { eventPublisher, actionRuntime, dryRun }).catch((err: unknown) => {
      console.error('[homerun] pipeline error (http trigger):', err);
    });
  },
  onReload: reload,
  isReady: () => haReady,
  entityCount: () => haClient.entityCount,
  eventPublisher,
  dryRun,
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
