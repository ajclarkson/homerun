import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerManager } from './timer-manager.js';
import type { TriggerEvent } from '../types/triggers.js';

describe('TimerManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('dispatches timer_expired after delayMs', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('parlour:lighting:off-delay', 5000);
    expect(dispatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'timer_expired', timerKey: 'parlour:lighting:off-delay' }));
  });

  it('mints a correlation_id on timer_expired dispatch', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('parlour:lighting:off-delay', 5000);
    vi.advanceTimersByTime(5000);

    const [event] = dispatch.mock.calls[0] as [TriggerEvent & { correlation_id: string }];
    expect(event.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('each timer expiry mints a fresh correlation_id', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:a', 1000);
    tm.start('room:b', 1000);
    vi.advanceTimersByTime(1000);

    const ids = dispatch.mock.calls.map(([e]) => (e as TriggerEvent & { correlation_id: string }).correlation_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('starting a second timer on the same key cancels the first — only one expiry fires', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:sub:purpose', 5000);
    vi.advanceTimersByTime(3000);

    tm.start('room:sub:purpose', 5000); // restart
    vi.advanceTimersByTime(5000);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'timer_expired', timerKey: 'room:sub:purpose' }));
  });

  it('cancel prevents dispatch from firing', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:sub:purpose', 5000);
    tm.cancel('room:sub:purpose');
    vi.advanceTimersByTime(5000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancel on an unknown key is a no-op and does not throw', () => {
    const tm = new TimerManager(vi.fn());
    expect(() => tm.cancel('does:not:exist')).not.toThrow();
  });

  it('independent keys are independent — cancelling one does not affect the other', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:lights:off', 5000);
    tm.start('room:heating:off', 5000);
    tm.cancel('room:lights:off');
    vi.advanceTimersByTime(5000);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'timer_expired', timerKey: 'room:heating:off' }));
  });

  it('cancelAll prevents all pending timers from firing', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:lights:off', 5000);
    tm.start('room:heating:off', 5000);
    tm.start('room:fan:off', 5000);
    tm.cancelAll();
    vi.advanceTimersByTime(5000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cancelAll on an empty manager is a no-op and does not throw', () => {
    const tm = new TimerManager(vi.fn());
    expect(() => tm.cancelAll()).not.toThrow();
  });

  it('cancelAll is safe to call twice', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:lights:off', 5000);
    tm.cancelAll();
    expect(() => tm.cancelAll()).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
