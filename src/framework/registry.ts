import type { Automation } from '../types/automation.js';

export class AutomationRegistry {
  private readonly automations = new Map<string, Automation<unknown>>();

  register(automation: Automation<unknown>): void {
    this.automations.set(automation.id, automation);
  }

  unregister(id: string): void {
    this.automations.delete(id);
  }

  getAll(): Automation<unknown>[] {
    return Array.from(this.automations.values());
  }

  getById(id: string): Automation<unknown> | undefined {
    return this.automations.get(id);
  }
}
