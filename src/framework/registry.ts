import type { Automation } from '../types/automation.js';
import { validateReasonDeclarations } from '../types/reasons.js';

// `homerun/dev/*` is the dry-run namespace; a location called `dev` would collide with its
// topics (`homerun/dev/history`), so it is refused up front.
export const RESERVED_LOCATION = 'dev';

// Checked where automations enter the registry, not only in defineAutomation: an automation
// built by hand, or by another copy of the package, gets the same scrutiny, and one bad entry
// is rejected loudly instead of poisoning the catalogue and history for the rest.
export function assertRegistrable(automation: Automation<unknown>): void {
  if (automation.location === RESERVED_LOCATION) {
    throw new Error(`automation "${automation.id}": location "${RESERVED_LOCATION}" is reserved for the dry-run namespace`);
  }
  if (automation.reasons !== undefined) validateReasonDeclarations(automation.id, automation.reasons);
}

export class AutomationRegistry {
  private readonly automations = new Map<string, Automation<unknown>>();
  private readonly changeCallbacks: Array<() => void> = [];

  onChange(cb: () => void): void {
    this.changeCallbacks.push(cb);
  }

  register(automation: Automation<unknown>): void {
    assertRegistrable(automation);
    this.automations.set(automation.id, automation);
    for (const cb of this.changeCallbacks) cb();
  }

  unregister(id: string): void {
    if (!this.automations.delete(id)) return;
    for (const cb of this.changeCallbacks) cb();
  }

  getAll(): Automation<unknown>[] {
    return Array.from(this.automations.values());
  }

  getById(id: string): Automation<unknown> | undefined {
    return this.automations.get(id);
  }
}
