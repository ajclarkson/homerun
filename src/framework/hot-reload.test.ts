import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _reloadFile } from './hot-reload.js';
import type { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

// ---------- Module mocks (must be at top level) ----------

const { mockTransform, mockWatch } = vi.hoisted(() => ({
  mockTransform: vi.fn(),
  mockWatch: vi.fn(),
}));

vi.mock('esbuild', () => ({ transform: mockTransform }));
vi.mock('chokidar', () => ({ watch: mockWatch }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('export default {}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

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

// ---------- Tests ----------

describe('_reloadFile — happy path', () => {
  beforeEach(() => {
    mockTransform.mockResolvedValue({ code: 'export default {}' });
  });

  it('registers the default export in the registry', async () => {
    const reg = makeRegistry();
    const auto = makeAutomation();
    const importer = makeImporter({ default: auto });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(reg.register).toHaveBeenCalledWith(auto);
  });

  it('passes the transpiled JS path to the importer', async () => {
    const reg = makeRegistry();
    const importer = makeImporter({ default: makeAutomation() });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(importer).toHaveBeenCalledOnce();
    expect(importer.mock.calls[0][0]).toContain('parlour-lighting');
  });

  it('calls esbuild.transform with loader: ts', async () => {
    const reg = makeRegistry();
    const importer = makeImporter({ default: makeAutomation() });

    await _reloadFile('/automations/parlour-lighting.ts', reg, importer);

    expect(mockTransform).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ loader: 'ts' }));
  });
});

describe('_reloadFile — transpile error', () => {
  it('keeps the previous automation and does not throw', async () => {
    mockTransform.mockRejectedValueOnce(new Error('syntax error'));
    const reg = makeRegistry();
    const existing = makeAutomation();
    reg.register(existing);

    await _reloadFile('/automations/parlour-lighting.ts', reg, makeImporter({ default: makeAutomation() }));

    expect(reg.register).toHaveBeenCalledTimes(1);
    expect(reg.getById('parlour:lighting')).toBe(existing);
  });
});

describe('_reloadFile — missing default export', () => {
  beforeEach(() => {
    mockTransform.mockResolvedValue({ code: 'export const foo = 1' });
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
    mockTransform.mockResolvedValue({ code: 'export default {}' });
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

  it('watches only the named file when AUTOMATION is set', async () => {
    process.env.AUTOMATION = 'heating/boiler-demand';
    const { startHotReload } = await import('./hot-reload.js');
    const reg = makeRegistry();
    startHotReload('/automations', reg);
    expect(mockWatch).toHaveBeenCalledWith('/automations/heating/boiler-demand.ts', expect.anything());
  });
});
