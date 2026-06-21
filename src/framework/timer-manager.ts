import type { TriggerEvent } from '../types/triggers.js';

export class TimerManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly dispatch: (event: TriggerEvent) => void) {}

  start(timerKey: string, delayMs: number): void {
    this.cancel(timerKey);
    const handle = setTimeout(() => {
      this.timers.delete(timerKey);
      this.dispatch({ type: 'timer_expired', timerKey });
    }, delayMs);
    this.timers.set(timerKey, handle);
  }

  cancel(timerKey: string): void {
    const handle = this.timers.get(timerKey);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(timerKey);
    }
  }
}
