import path from 'node:path';
import { watch } from 'chokidar';
import { build } from 'esbuild';
import type { AutomationRegistry } from './registry.js';

type Importer = (dataUri: string) => Promise<{ default: unknown }>;

const defaultImporter: Importer = (dataUri) => import(dataUri);

export async function _reloadFile(
  filePath: string,
  registry: AutomationRegistry,
  importer: Importer = defaultImporter,
): Promise<void> {
  try {
    const result = await build({
      entryPoints: [filePath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      packages: 'external',
    });

    const code = result.outputFiles[0].text;
    const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    const mod = await importer(dataUri);

    if (!mod.default) {
      throw new Error(`${filePath} has no default export`);
    }

    registry.register(mod.default as never);
  } catch (err) {
    console.error(`[hot-reload] failed to reload ${filePath}:`, err);
  }
}

export function startHotReload(automationsDir: string, registry: AutomationRegistry): void {
  const target = process.env.AUTOMATION
    ? path.join(automationsDir, `${process.env.AUTOMATION}.ts`)
    : `${automationsDir}/**/*.ts`;

  watch(target, { ignoreInitial: true }).on('change', (filePath: string) => {
    _reloadFile(filePath, registry).catch((err: unknown) => {
      console.error('[hot-reload] unexpected error:', err);
    });
  });
}
