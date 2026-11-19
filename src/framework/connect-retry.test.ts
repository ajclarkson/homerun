import { describe, it, expect, vi } from 'vitest';
import {
  connectWithRetry,
  describeConnectError,
  HAConnectError,
  type ConnectRetryOptions,
} from './connect-retry.js';

const ERR_CANNOT_CONNECT = 1;
const ERR_INVALID_AUTH = 2;

function opts(overrides: Partial<ConnectRetryOptions> = {}): ConnectRetryOptions & {
  sleep: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
} {
  return {
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 300,
    sleep: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  } as ReturnType<typeof opts>;
}

describe('connectWithRetry', () => {
  it('retries an unreachable HA, logging each failure, then succeeds', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(ERR_CANNOT_CONNECT)
      .mockRejectedValueOnce(ERR_CANNOT_CONNECT)
      .mockResolvedValueOnce('conn');
    const o = opts();

    await expect(connectWithRetry(attempt, o)).resolves.toBe('conn');

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(o.log).toHaveBeenCalledTimes(2);
    expect(o.log.mock.calls[0]![0]).toContain('ERR_CANNOT_CONNECT');
    expect(o.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const attempt = vi.fn().mockRejectedValue(ERR_CANNOT_CONNECT);
    const o = opts({ maxAttempts: 5 });

    await expect(connectWithRetry(attempt, o)).rejects.toBeInstanceOf(HAConnectError);

    expect(o.sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 300, 300]);
  });

  it('throws immediately on invalid auth without retrying', async () => {
    const attempt = vi.fn().mockRejectedValue(ERR_INVALID_AUTH);
    const o = opts();

    await expect(connectWithRetry(attempt, o)).rejects.toThrow(/ERR_INVALID_AUTH/);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(o.sleep).not.toHaveBeenCalled();
  });

  it('throws HAConnectError once retries are exhausted', async () => {
    const attempt = vi.fn().mockRejectedValue(ERR_CANNOT_CONNECT);
    const o = opts({ maxAttempts: 3 });

    const err = await connectWithRetry(attempt, o).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HAConnectError);
    expect((err as HAConnectError).attempts).toBe(3);
    expect((err as HAConnectError).code).toBe(ERR_CANNOT_CONNECT);
    expect((err as Error).message).toContain('after 3 attempts');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry unknown (non-library) errors', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(connectWithRetry(attempt, opts())).rejects.toThrow(/boom/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid maxAttempts', async () => {
    await expect(connectWithRetry(vi.fn(), opts({ maxAttempts: 0 }))).rejects.toThrow(/maxAttempts/);
  });
});

describe('describeConnectError', () => {
  it('maps library codes to names', () => {
    expect(describeConnectError(1)).toBe('ERR_CANNOT_CONNECT');
    expect(describeConnectError(2)).toBe('ERR_INVALID_AUTH');
    expect(describeConnectError(99)).toBe('unknown error code 99');
    expect(describeConnectError(new Error('x'))).toBe('x');
  });
});
