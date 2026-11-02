import type { HAState, HAContext } from '../framework/ha-client.js';
import type { Trigger, TriggerEvent } from './triggers.js';
import type { Action } from './actions.js';
import { validateReasonDeclarations } from './reasons.js';
import type { DeclaredDecision, FactValue, ReasonDeclarations } from './reasons.js';

export type { HAState, HAContext };

// ---------- Decision ----------

export interface Decision {
  decision: string;
  reason?: string;
  actions: Action[];
  // The conditions that determined this decision — free-form, author-curated. Distinct from
  // `trigger` on the published ObsEvent (what happened, framework-derived): this is why it was
  // allowed to happen this way (e.g. lux level, house mode, whether sleep mode blocked it).
  conditions?: Record<string, unknown>;
  // Typed values for the sentence a consumer renders from `reason`. Only meaningful when the
  // automation declares `reasons`; kept apart from `conditions` (a debug dump of everything)
  // so what a consumer may rely on is small, named and checked.
  facts?: Record<string, FactValue>;
}

// ---------- Abort ----------

export type Abort = { abort: true; reason: string };

export const abort = (reason: string): Abort => ({ abort: true, reason });

export function isAbort(value: unknown): value is Abort {
  return typeof value === 'object' && value !== null && (value as Abort).abort === true;
}

// ---------- Required state ----------
// Covers the dominant abort() pattern found across real automations (~70% of call sites,
// per #142's audit): a required entity's state is missing or invalid, so context() can't
// proceed. Thrown, not returned — pipeline.ts already wraps context() in try/catch, so this
// collapses `const x = state(id)?.state; if (x === undefined) return abort(...)` at every call
// site down to one line, with no per-call guard needed. Caught specially in pipeline.ts and
// classified as abort_kind: 'unavailable_input' with the entity name, distinct from a genuine
// bug (abort_kind: 'unhandled_error').

export class UnavailableInputError extends Error {
  constructor(public readonly entityId: string) {
    super(`required entity unavailable: ${entityId}`);
    this.name = 'UnavailableInputError';
  }
}

// HA's own sentinel values for "entity is registered but not producing readings" — an
// offline zigbee device, an integration that hasn't polled yet. Distinct from the entity
// key being absent from the state cache entirely, but the same "unavailable" in practice:
// every real audited call site treated these three cases identically.
const HA_UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

export function requireState(state: HAState, entityId: Parameters<HAState>[0]): string {
  const value = state(entityId)?.state;
  if (value === undefined || HA_UNAVAILABLE_STATES.has(value)) {
    throw new UnavailableInputError(String(entityId));
  }
  return value;
}

export function requireNumericState(state: HAState, entityId: Parameters<HAState>[0]): number {
  const raw = requireState(state, entityId);
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed)) throw new UnavailableInputError(String(entityId));
  return parsed;
}

// ---------- Automation ----------

export interface Automation<C> {
  id: string;
  location: string;
  subsystem: string;
  enabled?: boolean;
  triggers: Trigger[];
  // Opt-in. Once present, every decision's `reason` (and `facts`) is checked against it at
  // compile time, load time and run time. Absent: the automation behaves and emits as before.
  reasons?: ReasonDeclarations;
  context: (state: HAState, ha: HAContext, event: TriggerEvent) => C | Abort;
  reduce: (ctx: C) => Decision;
}

// With `reasons` declared, `reduce` must return one of the declared shapes, so a misspelt
// reason or a missing fact fails to compile. Overloads rather than a conditional return type:
// a conditional on the inferred R defeats literal inference for `reason` in the reducer body.
export type DeclaredAutomation<C, R extends ReasonDeclarations> =
  Omit<Automation<C>, 'reduce' | 'reasons'> & {
    reasons: R;
    reduce: (ctx: C) => DeclaredDecision<R>;
  };

// Identity function — provides type inference on C so the reduce argument
// is typed correctly without the user annotating the context shape explicitly. `const R`
// keeps the declared keys as literals so they can narrow `reason`.
export function defineAutomation<C, const R extends ReasonDeclarations>(
  automation: DeclaredAutomation<C, R>,
): Automation<C>;
export function defineAutomation<C>(automation: Omit<Automation<C>, 'reasons'>): Automation<C>;
export function defineAutomation<C>(automation: Automation<C>): Automation<C> {
  if (automation.reasons !== undefined) {
    validateReasonDeclarations(automation.id, automation.reasons);
  }
  return automation;
}
