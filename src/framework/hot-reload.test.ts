import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _reloadFile } from './hot-reload.js';
import type { AutomationRegistry } from './registry.js';
import type { Automation } from '../types/automation.js';

// ---------- Module mocks (must be at top level) ----------

const { mockBuild, mockWatch } = vi.hoisted(() => ({
  mockBuild: vi.fn(),
  mockWatch: vi.fn(),
}));

vi.mock('esbuild', () => ({ build: mockBuild }));
vi.mock('chokidar', () => ({ watch: mockWatch }));

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
});

describe('_reloadFile — build error', () => {
  it('keeps the previous automation and does not throw', async () => {
    mockBuild.mockRejectedValueOnce(new Error('syntax error'));
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
