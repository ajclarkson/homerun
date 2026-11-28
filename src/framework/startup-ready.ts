// Bounds the initial wait for Home Assistant to deliver its first snapshot.
//
// Why: connect() can succeed against a Home Assistant that is itself mid-restart and then
// never deliver the first entity snapshot. The process stays alive, /health/ready stays 503
// and the orchestrator sees no failure to act on. Connect already has its own bounded
// retry (connect-retry.ts); this bounds only the wait that follows a successful connect.

export const MIN_READY_TIMEOUT_MS = 1_000;
export const MAX_READY_TIMEOUT_MS = 600_000;
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

export interface StartupReadyDeps {
  connect: () => Promise<void>;
  ready: Promise<void>;
  timeoutMs: number;
  // Injected so tests can run without real timers or killing the process.
  exit: (code: number) => void;
  log: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// Resolves true when ready; on timeout or connect failure logs, calls exit(1) and
// resolves false. Never rejects, so the caller cannot forget to handle failure.
export async function waitForHaReady(deps: StartupReadyDeps): Promise<boolean> {
  const { timeoutMs } = deps;
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_READY_TIMEOUT_MS || timeoutMs > MAX_READY_TIMEOUT_MS) {
    throw new Error(
      `waitForHaReady: timeoutMs must be ${MIN_READY_TIMEOUT_MS}-${MAX_READY_TIMEOUT_MS}, got ${timeoutMs}`,
    );
  }
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => { clearTimeout(h as NodeJS.Timeout); });

  let handle: unknown;
  const timeout = new Promise<'timeout'>((resolve) => {
    handle = setTimer(() => { resolve('timeout'); }, timeoutMs);
  });
  const connected = deps
    .connect()
    .then(() => deps.ready)
    .then(() => 'ready' as const);

  try {
    const outcome = await Promise.race([connected, timeout]);
    if (outcome === 'ready') return true;
    deps.log(
      `[homerun] Home Assistant connected but not ready after ${timeoutMs}ms ` +
      '(no initial state snapshot) — exiting so the supervisor can restart',
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log(`[homerun] Home Assistant startup failed: ${reason} — exiting`);
  } finally {
    clearTimer(handle);
    // The losing branch may reject later; swallow so it cannot become an unhandled rejection.
    connected.catch(() => {});
  }
  deps.exit(1);
  return false;
}
