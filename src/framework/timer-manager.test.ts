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
    expect(dispatch).toHaveBeenCalledWith({ type: 'timer_expired', timerKey: 'parlour:lighting:off-delay' });
  });

  it('starting a second timer on the same key cancels the first — only one expiry fires', () => {
    const dispatch = vi.fn<(e: TriggerEvent) => void>();
    const tm = new TimerManager(dispatch);

    tm.start('room:sub:purpose', 5000);
    vi.advanceTimersByTime(3000);

    tm.start('room:sub:purpose', 5000); // restart
    vi.advanceTimersByTime(5000);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'timer_expired', timerKey: 'room:sub:purpose' });
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
    expect(dispatch).toHaveBeenCalledWith({ type: 'timer_expired', timerKey: 'room:heating:off' });
  });
});
