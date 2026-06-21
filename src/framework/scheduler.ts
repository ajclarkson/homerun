import cron from 'node-cron';
import type { Automation } from '../types/automation.js';
import type { TriggerEvent } from '../types/triggers.js';

export class Scheduler {
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly automations: Automation<unknown>[],
    private readonly dispatch: (event: TriggerEvent) => void,
    private readonly ready: Promise<void>,
  ) {}

  start(): void {
    for (const automation of this.automations) {
      for (const trigger of automation.triggers) {
        if (trigger.type === 'schedule') {
          const { cron: expression } = trigger;
          const task = cron.schedule(expression, () => {
            this.dispatch({ type: 'schedule', cron: expression });
          });
          this.cleanups.push(() => task.stop());
        }
      }
    }

    this.ready.then(() => {
      this.dispatch({ type: 'on_start' });
    }).catch((err) => {
      console.error('[scheduler] ready promise rejected:', err);
    });
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }
}
