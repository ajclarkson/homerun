import path from 'node:path';
import { watch } from 'chokidar';
import { build } from 'esbuild';
import type { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

type Importer = (dataUri: string) => Promise<{ default: unknown }>;

const defaultImporter: Importer = (dataUri) => import(dataUri);

// Module-level file→IDs map used in production. Tests pass their own instance.
const moduleFileToIds = new Map<string, string[]>();

export async function _reloadFile(
  filePath: string,
  registry: AutomationRegistry,
  importer: Importer = defaultImporter,
  fileToIds: Map<string, string[]> = moduleFileToIds,
): Promise<void> {
  try {
    const result = await build({
      entryPoints: [filePath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      alias: {
        '@ajclarkson/homerun/testing': path.resolve(import.meta.dirname, '../testing.js'),
        '@ajclarkson/homerun': path.resolve(import.meta.dirname, '../lib.js'),
      },
    });

    const code = result.outputFiles[0].text;
    const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const mod = await importer(dataUri);

    if (!mod.default) {
      throw new Error(`${filePath} has no default export`);
    }

    const automations: Automation<unknown>[] = Array.isArray(mod.default)
      ? (mod.default as Automation<unknown>[])
      : [mod.default as Automation<unknown>];

    // Deregister previous automations from this file only after successful load.
    for (const id of fileToIds.get(filePath) ?? []) {
      registry.unregister(id);
    }

    for (const auto of automations) {
      registry.register(auto);
    }

    fileToIds.set(filePath, automations.map((a) => a.id));
  } catch (err) {
    console.error(`[hot-reload] failed to reload ${filePath}:`, err);
  }
}

export function _deleteFile(
  filePath: string,
  registry: AutomationRegistry,
  fileToIds: Map<string, string[]> = moduleFileToIds,
): void {
  for (const id of fileToIds.get(filePath) ?? []) {
    registry.unregister(id);
  }
  fileToIds.delete(filePath);
}

const isAutomationFile = (f: string): boolean =>
  f.endsWith('.ts') &&
  !f.endsWith('.test.ts') &&
  !f.includes('node_modules') &&
  !f.includes('.d.ts') &&
  !f.split(path.sep).includes('types');

export async function rescanAutomations(
  automationsDir: string,
  registry: AutomationRegistry,
  fileToIds: Map<string, string[]> = moduleFileToIds,
  importer: Importer = defaultImporter,
): Promise<void> {
  let files: string[] = [];
  try {
    const { readdir } = await import('node:fs/promises');
    files = (await readdir(automationsDir, { recursive: true })) as string[];
  } catch {
    console.warn(`[homerun] AUTOMATIONS_DIR not found: ${automationsDir} — starting with no automations`);
  }

  const currentPaths = new Set(
    files.filter(isAutomationFile).map((f) => path.join(automationsDir, f)),
  );

  for (const trackedPath of [...fileToIds.keys()]) {
    if (!currentPaths.has(trackedPath)) {
      _deleteFile(trackedPath, registry, fileToIds);
    }
  }

  for (const filePath of currentPaths) {
    await _reloadFile(filePath, registry, importer, fileToIds);
  }
}

export function startHotReload(automationsDir: string, registry: AutomationRegistry): void {
  const target = process.env.AUTOMATION
    ? path.join(automationsDir, `${process.env.AUTOMATION}.ts`)
    : `${automationsDir}/**/*.ts`;

  const watcher = watch(target, { ignoreInitial: true, ignored: [/node_modules/, /\.test\.ts$/] });

  watcher.on('change', (filePath: string) => {
    _reloadFile(filePath, registry).catch((err: unknown) => {
      console.error('[hot-reload] unexpected error:', err);
    });
  });

  watcher.on('unlink', (filePath: string) => {
    _deleteFile(filePath, registry);
  });
}
