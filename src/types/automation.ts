import type { HAState, HAContext } from '../framework/ha-client.js';
import type { Trigger } from './triggers.js';
import type { Action } from './actions.js';

export type { HAState, HAContext };

// ---------- Decision ----------

export interface Decision {
  decision: string;
  reason?: string;
  actions: Action[];
  inputs?: Record<string, unknown>;
}

// ---------- Abort ----------

export type Abort = { abort: true; reason: string };

export const abort = (reason: string): Abort => ({ abort: true, reason });

export function isAbort(value: unknown): value is Abort {
  return typeof value === 'object' && value !== null && (value as Abort).abort === true;
}

// ---------- Automation ----------

export interface Automation<C> {
  id: string;
  location: string;
  subsystem: string;
  triggers: Trigger[];
  context: (state: HAState, ha: HAContext) => C | Abort;
  reduce: (ctx: C) => Decision;
}

// Identity function — provides type inference on C so the reduce argument
// is typed correctly without the user annotating the context shape explicitly.
export function defineAutomation<C>(automation: Automation<C>): Automation<C> {
  return automation;
}
