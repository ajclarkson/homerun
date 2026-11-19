// Initial-connect retry policy for the HA WebSocket. Only the first connect needs this:
// once connected, home-assistant-js-websocket reconnects on its own.
//
// Why not the library's `setupRetry`: it retries a fixed 1s apart with no hook, so failed
// attempts would be invisible and the total wait unbounded in practice. We run one
// attempt per call (setupRetry 0) and own the backoff, so every failure is logged.

// Mirrors the numeric codes in home-assistant-js-websocket's errors.ts; the library
// rejects with these bare numbers rather than Error objects.
const ERR_CANNOT_CONNECT = 1;
const ERR_CONNECTION_LOST = 3;

const ERROR_NAMES: Readonly<Record<number, string>> = {
  1: 'ERR_CANNOT_CONNECT',
  2: 'ERR_INVALID_AUTH',
  3: 'ERR_CONNECTION_LOST',
  4: 'ERR_HASS_HOST_REQUIRED',
  5: 'ERR_INVALID_HTTPS_TO_HTTP',
  6: 'ERR_INVALID_AUTH_CALLBACK',
};

export interface ConnectRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

// ~8 minutes of waiting in total: long enough to ride out a Home Assistant restart,
// short enough that a genuinely wrong URL gets the process restarted and noticed.
export const DEFAULT_CONNECT_RETRY: ConnectRetryOptions = {
  maxAttempts: 20,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.warn(message),
};

export class HAConnectError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly attempts: number) {
    super(message);
    this.name = 'HAConnectError';
  }
}

export function describeConnectError(err: unknown): string {
  if (typeof err === 'number') return ERROR_NAMES[err] ?? `unknown error code ${err}`;
  return err instanceof Error ? err.message : String(err);
}

// Only "HA is not reachable" is transient. Invalid auth, a bad URL or an unknown
// error will not fix itself, so retrying would only delay the failure.
function isRetryable(err: unknown): boolean {
  return err === ERR_CANNOT_CONNECT || err === ERR_CONNECTION_LOST;
}

function backoffMs(attempt: number, opts: ConnectRetryOptions): number {
  const delay = opts.initialDelayMs * 2 ** (attempt - 1);
  return Math.min(Math.max(delay, 0), opts.maxDelayMs);
}

export async function connectWithRetry<T>(
  attemptConnect: () => Promise<T>,
  opts: ConnectRetryOptions = DEFAULT_CONNECT_RETRY,
): Promise<T> {
  if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
    throw new Error(`connectWithRetry: maxAttempts must be a positive integer, got ${opts.maxAttempts}`);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptConnect();
    } catch (err) {
      const reason = describeConnectError(err);
      const code = typeof err === 'number' ? err : undefined;
      if (!isRetryable(err)) {
        throw new HAConnectError(`Home Assistant connection failed, not retrying: ${reason}`, code, attempt);
      }
      if (attempt >= opts.maxAttempts) {
        throw new HAConnectError(
          `Home Assistant unreachable after ${attempt} attempts: ${reason}`, code, attempt,
        );
      }
      const delay = backoffMs(attempt, opts);
      opts.log(`[homerun] HA connect attempt ${attempt}/${opts.maxAttempts} failed: ${reason}; retrying in ${delay}ms`);
      await opts.sleep(delay);
    }
  }
}
