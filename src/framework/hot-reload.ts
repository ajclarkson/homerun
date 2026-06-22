import path from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { watch } from 'chokidar';
import { transform } from 'esbuild';
import type { AutomationRegistry } from './registry.js';

type Importer = (filePath: string) => Promise<{ default: unknown }>;

const defaultImporter: Importer = (filePath) => import(`${filePath}?t=${Date.now()}`);

export async function _reloadFile(
  filePath: string,
  registry: AutomationRegistry,
  importer: Importer = defaultImporter,
): Promise<void> {
  try {
    const source = await readFile(filePath, 'utf8');
    const { code } = await transform(source, { loader: 'ts', format: 'esm' });

    const tmpPath = `${filePath}.${Date.now()}.mjs`;
    await writeFile(tmpPath, code);

    let mod: { default: unknown };
    try {
      mod = await importer(tmpPath);
    } finally {
      await unlink(tmpPath).catch(() => undefined);
    }

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
