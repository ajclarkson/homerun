import { describe, it, expect, vi } from 'vitest';
import { waitForHaReady, type StartupReadyDeps } from './startup-ready.js';

function deps(overrides: Partial<StartupReadyDeps> = {}): StartupReadyDeps & {
  exit: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    connect: async () => {},
    ready: Promise.resolve(),
    timeoutMs: 60_000,
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  } as ReturnType<typeof deps>;
}

describe('waitForHaReady', () => {
  it('returns true without exiting when connect and ready finish in time', async () => {
    const d = deps();
    await expect(waitForHaReady(d)).resolves.toBe(true);
    expect(d.exit).not.toHaveBeenCalled();
    expect(d.log).not.toHaveBeenCalled();
  });

  it('logs and exits 1 when ready never resolves', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ ready: new Promise<void>(() => {}), timeoutMs: 5_000 });
      const p = waitForHaReady(d);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toBe(false);
      expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('not ready within 5000ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs and exits 1 when connect never resolves', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ connect: () => new Promise<void>(() => {}), timeoutMs: 5_000 });
      const p = waitForHaReady(d);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toBe(false);
      expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('not ready within 5000ms'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not exit when ready arrives just before the deadline', async () => {
    vi.useFakeTimers();
    try {
      let resolveReady!: () => void;
      const d = deps({ ready: new Promise<void>((r) => { resolveReady = r; }), timeoutMs: 5_000 });
      const p = waitForHaReady(d);
      await vi.advanceTimersByTimeAsync(4_999);
      resolveReady();
      await expect(p).resolves.toBe(true);
      expect(d.exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs the reason and exits 1 when connect rejects', async () => {
    const d = deps({ connect: () => Promise.reject(new Error('Home Assistant unreachable after 20 attempts')) });
    await expect(waitForHaReady(d)).resolves.toBe(false);
    expect(d.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('unreachable after 20 attempts'));
  });

  it('clears the timer on success', async () => {
    const clearTimer = vi.fn();
    await waitForHaReady(deps({ setTimer: () => 'h', clearTimer }));
    expect(clearTimer).toHaveBeenCalledWith('h');
  });

  it.each([0, 999, 600_001, NaN])('rejects an out-of-range timeout (%s)', async (timeoutMs) => {
    await expect(waitForHaReady(deps({ timeoutMs }))).rejects.toThrow('timeoutMs must be');
  });
});
