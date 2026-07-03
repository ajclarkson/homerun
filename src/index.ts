import 'dotenv/config';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'mqtt';
import { HAClient } from './framework/ha-client.js';
import { AutomationRegistry } from './framework/registry.js';
import { Observability } from './framework/observability.js';
import { TimerManager } from './framework/timer-manager.js';
import { ActionRuntime } from './framework/action-runtime.js';
import { TriggerEngine } from './framework/trigger-engine.js';
import { Scheduler } from './framework/scheduler.js';
import { _reloadFile, startHotReload } from './framework/hot-reload.js';
import { runPipeline } from './framework/pipeline.js';

process.on('uncaughtException', (err) => {
  console.error('[homerun] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[homerun] unhandledRejection:', reason);
});

// Write PID so the git-sync exechook can signal us after each sync.
await writeFile('/tmp/homerun.pid', String(process.pid)).catch(() => {
  console.warn('[homerun] could not write PID file — SIGUSR1 rescan will not be available');
});

// 1. Connect MQTT before anything else (Observability and ActionRuntime need it).
const mqtt = connect(process.env.MQTT_URL!);
await new Promise<void>((resolve, reject) => {
  mqtt.once('connect', () => resolve());
  mqtt.once('error', reject);
});

// 2. Instantiate components in dependency order.
//    TimerManager holds a closure over `engine` — the late binding is intentional;
//    `engine` is assigned before any timer can fire.
const haClient = new HAClient();
const registry = new AutomationRegistry();
const observability = new Observability(mqtt);
let engine!: TriggerEngine;
const timerManager = new TimerManager((e) => engine.dispatch(e));
const actionRuntime = new ActionRuntime({
  haClient,
  mqttClient: mqtt,
  timerManager,
  observability,
  dryRun: process.env.DRY_RUN === 'true',
});

// 3. Initial automation load — must complete before the engine and scheduler start.
const automationsDir = path.resolve(process.env.AUTOMATIONS_DIR!);

const isAutomation = (f: string) =>
  f.endsWith('.ts') &&
  !f.includes('node_modules') &&
  !f.includes('.d.ts') &&
  !f.split(path.sep).includes('types');

async function loadAutomations(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await readdir(automationsDir, { recursive: true })) as string[];
  } catch {
    console.warn(`[homerun] AUTOMATIONS_DIR not found: ${automationsDir} — starting with no automations`);
  }
  for (const file of files.filter(isAutomation)) {
    await _reloadFile(path.join(automationsDir, file), registry);
  }
}

await loadAutomations();
console.log(`[homerun] loaded ${registry.getAll().length} automation(s)`);

// 4. Wire up the engine and scheduler.
engine = new TriggerEngine(registry, haClient, (automation, event) => {
  runPipeline(automation, event, haClient, { observability, actionRuntime }).catch((err: unknown) => {
    console.error('[homerun] pipeline error:', err);
  });
}, mqtt);
const scheduler = new Scheduler(registry.getAll(), (e) => engine.dispatch(e), haClient.ready);

engine.start();
scheduler.start();

// 5. Start hot-reload watcher (dev) and SIGUSR1 rescan (git-sync sidecar in K8s).
startHotReload(automationsDir, registry);
process.on('SIGUSR1', () => {
  console.log('[homerun] SIGUSR1 received — rescanning automations');
  loadAutomations().then(() => {
    console.log(`[homerun] rescan complete — ${registry.getAll().length} automation(s) registered`);
  }).catch((err: unknown) => {
    console.error('[homerun] rescan failed:', err);
  });
});

// 6. Connect to HA last — state_changed events start flowing once ready resolves.
haClient.on('reconnected', () => {
  console.log(`[homerun] reconnected — ${haClient.entityCount} entities refreshed`);
});

await haClient.connect(process.env.HA_URL!, process.env.HA_TOKEN!);
await haClient.ready;
console.log(`[homerun] ready — ${haClient.entityCount} entities cached`);
