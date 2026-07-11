import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _reloadFile, _deleteFile, rescanAutomations } from './hot-reload.js';
import type { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

// ---------- Module mocks (must be at top level) ----------

const { mockBuild, mockWatch, mockReaddir } = vi.hoisted(() => ({
  mockBuild: vi.fn(),
  mockWatch: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock('esbuild', () => ({ build: mockBuild }));
vi.mock('chokidar', () => ({ watch: mockWatch }));
vi.mock('node:fs/promises', () => ({ readdir: mockReaddir }));

// ---------- Helpers ----------

function makeRegistry(): AutomationRegistry {
  const store = new Map<string, Automation<unknown>>();
  return {
    register: vi.fn((a: Automation<unknown>) => store.set(a.id, a)),
    unregister: vi.fn((id: string) => { store.delete(id); }),
    getAll: vi.fn(() => Array.from(store.values())),
    getById: vi.fn((id: string) => store.get(id)),
  } as unknown as AutomationRegistry;
}

function makeAutomation(id = 'parlour:lighting'): Automation<unknown> {
  return {
    id,
    location: 'parlour',
    subsystem: 'lighting',
    triggers: [],
    context: () => ({}),
    reduce: () => ({ decision: 'ok', actions: [] }),
  };
}

function makeImporter(mod: unknown) {
  return vi.fn().mockResolvedValue(mod);
}

function makeBuildResult(code = 'export default {}') {
  return { outputFiles: [{ text: code }] };
}

// ---------- Tests ----------

describe('_reloadFile — happy path', () => {
  beforeEach(() => {
    mockBuild.mockResolvedValue(makeBuildResult());
  });

  it('registers the default export in the registry', async () => {
    const reg = makeRegistry();
    const auto = makeAutomation();
    const importer = makeImporter({ default: auto });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(reg.register).toHaveBeenCalledWith(auto);
  });

  it('registers all automations when the default export is an array', async () => {
    const reg = makeRegistry();
    const a1 = makeAutomation('parlour:lighting');
    const a2 = makeAutomation('kitchen:lighting');
    const importer = makeImporter({ default: [a1, a2] });

    await _reloadFile('/automations/multi-room.ts', reg, importer);

    expect(reg.register).toHaveBeenCalledTimes(2);
    expect(reg.register).toHaveBeenCalledWith(a1);
    expect(reg.register).toHaveBeenCalledWith(a2);
  });

  it('deregisters previously loaded automations from the same file on reload', async () => {
    const reg = makeRegistry();
    const fileToIds = new Map<string, string[]>();
    const v1 = makeAutomation('parlour:lighting');
    const importer1 = makeImporter({ default: v1 });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer1, fileToIds);
    expect(reg.register).toHaveBeenCalledWith(v1);

    const v2 = makeAutomation('parlour:lighting');
    const importer2 = makeImporter({ default: v2 });
    await _reloadFile('/automations/parlour-lighting.ts', reg, importer2, fileToIds);

    expect(reg.unregister).toHaveBeenCalledWith('parlour:lighting');
    expect(reg.register).toHaveBeenCalledWith(v2);
  });

  it('deregisters all array automations from a file when it reloads', async () => {
    const reg = makeRegistry();
    const fileToIds = new Map<string, string[]>();
    const a1 = makeAutomation('parlour:lighting');
    const a2 = makeAutomation('kitchen:lighting');
    await _reloadFile('/automations/multi-room.ts', reg, makeImporter({ default: [a1, a2] }), fileToIds);

    vi.mocked(reg.register).mockClear();
    const a3 = makeAutomation('bedroom:lighting');
    await _reloadFile('/automations/multi-room.ts', reg, makeImporter({ default: a3 }), fileToIds);

    expect(reg.unregister).toHaveBeenCalledWith('parlour:lighting');
    expect(reg.unregister).toHaveBeenCalledWith('kitchen:lighting');
    expect(reg.register).toHaveBeenCalledWith(a3);
  });

  it('passes a data: URI to the importer', async () => {
    const reg = makeRegistry();
    const importer = makeImporter({ default: makeAutomation() });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(importer).toHaveBeenCalledOnce();
    expect(importer.mock.calls[0][0]).toMatch(/^data:text\/javascript;base64,/);
  });

  it('calls esbuild.build with bundle: true and platform: node', async () => {
    const reg = makeRegistry();
    const importer = makeImporter({ default: makeAutomation() });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({
      entryPoints: ['/automations/parlour-lighting.ts'],
      bundle: true,
      platform: 'node',
      write: false,
    }));
  });

  it('includes a separate alias for @ajclarkson/homerun/testing to avoid subpath resolving as a directory', async () => {
    const reg = makeRegistry();
    const importer = makeImporter({ default: makeAutomation() });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    const { alias } = mockBuild.mock.calls[0][0] as { alias: Record<string, string> };
    expect(alias['@ajclarkson/homerun/testing']).toBeDefined();
    expect(alias['@ajclarkson/homerun/testing']).not.toContain('lib.js');
    expect(alias['@ajclarkson/homerun']).toBeDefined();
  });
});

describe('_reloadFile — build error', () => {
  it('keeps the previous automation and does not unregister it', async () => {
    mockBuild.mockRejectedValueOnce(new Error('syntax error'));
    const reg = makeRegistry();
    const fileToIds = new Map<string, string[]>();
    const existing = makeAutomation();
    reg.register(existing);
    fileToIds.set('/automations/parlour-lighting.ts', ['parlour:lighting']);

    await _reloadFile('/automations/parlour-lighting.ts', reg, makeImporter({ default: makeAutomation() }), fileToIds);

    expect(reg.unregister).not.toHaveBeenCalled();
    expect(reg.getById('parlour:lighting')).toBe(existing);
  });
});

describe('_reloadFile — missing default export', () => {
  beforeEach(() => {
    mockBuild.mockResolvedValue(makeBuildResult('export const foo = 1'));
  });

  it('keeps the previous automation and does not throw', async () => {
    const reg = makeRegistry();
    const existing = makeAutomation();
    reg.register(existing);

    await _reloadFile('/automations/parlour-lighting.ts', reg, makeImporter({ default: undefined }));

    expect(reg.register).toHaveBeenCalledTimes(1);
    expect(reg.getById('parlour:lighting')).toBe(existing);
  });
});

describe('_reloadFile — importer error', () => {
  beforeEach(() => {
    mockBuild.mockResolvedValue(makeBuildResult());
  });

  it('keeps the previous automation and does not throw', async () => {
    const reg = makeRegistry();
    const existing = makeAutomation();
    reg.register(existing);

    await _reloadFile('/automations/parlour-lighting.ts', reg, vi.fn().mockRejectedValue(new Error('import failed')));

    expect(reg.register).toHaveBeenCalledTimes(1);
    expect(reg.getById('parlour:lighting')).toBe(existing);
  });
});

// ---------- _deleteFile ----------

describe('_deleteFile', () => {
  it('unregisters all automations from the deleted file', () => {
    const reg = makeRegistry();
    const fileToIds = new Map<string, string[]>();
    fileToIds.set('/automations/parlour-lighting.ts', ['parlour:lighting', 'parlour:heating']);

    _deleteFile('/automations/parlour-lighting.ts', reg, fileToIds);

    expect(reg.unregister).toHaveBeenCalledWith('parlour:lighting');
    expect(reg.unregister).toHaveBeenCalledWith('parlour:heating');
  });

  it('removes the file from the tracking map', () => {
    const reg = makeRegistry();
    const fileToIds = new Map<string, string[]>();
    fileToIds.set('/automations/parlour-lighting.ts', ['parlour:lighting']);

    _deleteFile('/automations/parlour-lighting.ts', reg, fileToIds);

    expect(fileToIds.has('/automations/parlour-lighting.ts')).toBe(false);
  });

  it('does nothing when the file was never tracked', () => {
    const reg = makeRegistry();
    _deleteFile('/automations/unknown.ts', reg, new Map());
    expect(reg.unregister).not.toHaveBeenCalled();
  });
});

// ---------- rescanAutomations ----------

describe('rescanAutomations', () => {
  beforeEach(() => {
    mockBuild.mockClear();
    mockBuild.mockResolvedValue(makeBuildResult());
  });

  it('registers automations from all current files', async () => {
    const reg = makeRegistry();
    const auto = makeAutomation('parlour:lighting');
    const importer = makeImporter({ default: auto });
    mockReaddir.mockResolvedValue(['parlour-lighting.ts']);

    const fileToIds = new Map<string, string[]>();
    await rescanAutomations('/automations', reg, fileToIds, importer);

    expect(reg.register).toHaveBeenCalledWith(auto);
  });

  it('unregisters automations from files that no longer exist', async () => {
    const reg = makeRegistry();
    mockReaddir.mockResolvedValue(['parlour-lighting.ts']);
    mockBuild.mockResolvedValue(makeBuildResult());

    const fileToIds = new Map<string, string[]>();
    fileToIds.set('/automations/deleted.ts', ['bedroom:lighting']);

    await rescanAutomations('/automations', reg, fileToIds, makeImporter({ default: makeAutomation() }));

    expect(reg.unregister).toHaveBeenCalledWith('bedroom:lighting');
    expect(fileToIds.has('/automations/deleted.ts')).toBe(false);
  });

  it('re-registers automations from files that still exist', async () => {
    const reg = makeRegistry();
    const auto = makeAutomation('parlour:lighting');
    mockReaddir.mockResolvedValue(['parlour-lighting.ts']);

    const fileToIds = new Map<string, string[]>();
    fileToIds.set('/automations/parlour-lighting.ts', ['parlour:lighting']);

    await rescanAutomations('/automations', reg, fileToIds, makeImporter({ default: auto }));

    expect(reg.register).toHaveBeenCalledWith(auto);
  });

  it('treats a missing AUTOMATIONS_DIR as an empty file list and purges all tracked automations', async () => {
    const reg = makeRegistry();
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const fileToIds = new Map<string, string[]>();
    fileToIds.set('/automations/parlour-lighting.ts', ['parlour:lighting']);

    await rescanAutomations('/automations', reg, fileToIds);

    expect(reg.unregister).toHaveBeenCalledWith('parlour:lighting');
  });

  it('skips .test.ts files', async () => {
    const reg = makeRegistry();
    mockReaddir.mockResolvedValue(['parlour-lighting.ts', 'parlour-lighting.test.ts']);

    const fileToIds = new Map<string, string[]>();
    await rescanAutomations('/automations', reg, fileToIds, makeImporter({ default: makeAutomation() }));

    expect(mockBuild).toHaveBeenCalledTimes(1);
    expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({
      entryPoints: ['/automations/parlour-lighting.ts'],
    }));
  });
});

// ---------- AUTOMATION env var scoping ----------

describe('startHotReload — AUTOMATION env var', () => {
  let mockWatcher: { on: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockWatcher = { on: vi.fn().mockReturnThis() };
    mockWatch.mockReturnValue(mockWatcher);
  });

  afterEach(() => {
    delete process.env.AUTOMATION;
    mockWatch.mockReset();
  });

  it('watches the full automations dir when AUTOMATION is not set', async () => {
    const { startHotReload } = await import('./hot-reload.js');
    const reg = makeRegistry();
    startHotReload('/automations', reg);
    expect(mockWatch).toHaveBeenCalledWith('/automations/**/*.ts', expect.anything());
  });

  it('registers automations when a new file is added', async () => {
    const { startHotReload } = await import('./hot-reload.js');
    startHotReload('/automations', makeRegistry());
    const handlers = mockWatcher.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(handlers).toContain('add');
  });

  it('ignores .test.ts files in the watcher', async () => {
    const { startHotReload } = await import('./hot-reload.js');
    startHotReload('/automations', makeRegistry());
    const [, options] = mockWatch.mock.calls[0] as [unknown, { ignored: unknown[] }];
    const ignored = options.ignored as Array<RegExp | unknown>;
    const testTsPattern = ignored.find((p) => p instanceof RegExp && p.test('foo.test.ts'));
    expect(testTsPattern).toBeDefined();
  });

  it('watches only the named file when AUTOMATION is set', async () => {
    process.env.AUTOMATION = 'heating/boiler-demand';
    const { startHotReload } = await import('./hot-reload.js');
    const reg = makeRegistry();
    startHotReload('/automations', reg);
    expect(mockWatch).toHaveBeenCalledWith('/automations/heating/boiler-demand.ts', expect.anything());
  });
});
