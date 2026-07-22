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
    this.registerCronTriggers(this.automations);

    this.ready.then(() => {
      this.dispatch({ type: 'on_start', correlation_id: crypto.randomUUID() });
    }).catch((err) => {
      console.error('[scheduler] ready promise rejected:', err);
    });
  }

  sync(automations: Automation<unknown>[]): void {
    this.stop();
    this.registerCronTriggers(automations);
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
  }

  private registerCronTriggers(automations: Automation<unknown>[]): void {
    const automationIdsByExpression = new Map<string, string[]>();
    for (const automation of automations) {
      for (const trigger of automation.triggers) {
        if (trigger.type === 'schedule') {
          const ids = automationIdsByExpression.get(trigger.cron) ?? [];
          ids.push(automation.id);
          automationIdsByExpression.set(trigger.cron, ids);
        }
      }
    }

    for (const [expression, automationIds] of automationIdsByExpression) {
      try {
        const task = cron.schedule(expression, () => {
          this.dispatch({ type: 'schedule', cron: expression, correlation_id: crypto.randomUUID() });
        });
        this.cleanups.push(() => task.stop());
        console.log(`[scheduler] registered cron "${expression}" for ${automationIds.join(', ')}`);
      } catch (err) {
        console.error(`[scheduler] failed to register cron "${expression}" for ${automationIds.join(', ')}:`, err);
      }
    }
  }
}
