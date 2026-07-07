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
      alias: { homerun: path.resolve(import.meta.dirname, '../lib.js') },
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

export function startHotReload(automationsDir: string, registry: AutomationRegistry): void {
  const target = process.env.AUTOMATION
    ? path.join(automationsDir, `${process.env.AUTOMATION}.ts`)
    : `${automationsDir}/**/*.ts`;

  watch(target, { ignoreInitial: true, ignored: /node_modules/ }).on('change', (filePath: string) => {
    _reloadFile(filePath, registry).catch((err: unknown) => {
      console.error('[hot-reload] unexpected error:', err);
    });
  });
}
