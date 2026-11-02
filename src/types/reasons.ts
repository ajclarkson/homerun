import type { Action } from './actions.js';

// ---------- Declared reasons ----------
// Opt-in vocabulary an automation can publish about its own decisions. Everything here is
// structured on purpose: the framework emits reason keys, outcomes and typed facts, and the
// consumer owns the wording. A sentence in the framework would drift from the rule it describes.

export const OUTCOMES = ['acted', 'declined', 'ignored'] as const;

// `acted`: the rule changed something. `declined`: a rule chose not to act and a person would
// want to know why. `ignored`: noise (startup, already in the right state). Declared, never
// inferred from `actions`: a no_action decision can still carry a timer-cancel action.
export type Outcome = (typeof OUTCOMES)[number];

export type FactValue = string | number | boolean | null;

// At most this many keys per reason, so a retained history entry stays small and a fact list
// cannot grow into a second `conditions` dump.
export const MAX_FACTS = 8;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ReasonDeclaration {
  readonly outcome: Outcome;
  readonly facts?: readonly string[];
}

export type ReasonDeclarations = Readonly<Record<string, ReasonDeclaration>>;

// ---------- Compile-time narrowing ----------

type FactsFor<D extends ReasonDeclaration> =
  D extends { readonly facts: readonly (infer K extends string)[] }
    ? [K] extends [never] ? Record<never, never> : { readonly [P in K]: FactValue }
    : Record<never, never>;

type DecisionFor<R extends ReasonDeclarations, K extends keyof R & string> = {
  decision: string;
  reason: K;
  actions: Action[];
  conditions?: Record<string, unknown>;
} & (keyof FactsFor<R[K]> extends never
  ? { facts?: undefined }
  : { facts: FactsFor<R[K]> });

// What `reduce` may return once reasons are declared: one member per declared reason, so
// `reason` is the union of declared keys and `facts` is keyed by that reason's declared list.
export type DeclaredDecision<R extends ReasonDeclarations> = {
  [K in keyof R & string]: DecisionFor<R, K>;
}[keyof R & string];

// ---------- Load-time validation ----------

function assertIdentifier(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`${what} must match ${IDENTIFIER} (got ${JSON.stringify(value)}); reasons carry no free text`);
  }
}

function validateFactKeys(reason: string, facts: unknown): void {
  if (facts === undefined) return;
  if (!Array.isArray(facts)) throw new Error(`reason "${reason}": facts must be an array of keys`);
  if (facts.length > MAX_FACTS) {
    throw new Error(`reason "${reason}": ${facts.length} facts declared, at most ${MAX_FACTS} allowed`);
  }
  const seen = new Set<string>();
  for (const key of facts) {
    assertIdentifier(key, `reason "${reason}": fact key`);
    if (seen.has(key)) throw new Error(`reason "${reason}": fact "${key}" declared twice`);
    seen.add(key);
  }
}

function validateDeclaration(reason: string, spec: unknown): void {
  assertIdentifier(reason, 'reason name');
  if (typeof spec !== 'object' || spec === null) {
    throw new Error(`reason "${reason}": declaration must be an object`);
  }
  const { outcome, facts, ...rest } = spec as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new Error(`reason "${reason}": unknown field(s) ${extra.join(', ')}`);
  if (!OUTCOMES.includes(outcome as Outcome)) {
    throw new Error(`reason "${reason}": outcome must be one of ${OUTCOMES.join(', ')} (got ${JSON.stringify(outcome)})`);
  }
  validateFactKeys(reason, facts);
}

// Called from defineAutomation so a bad declaration fails when the automation file loads,
// not on the first decision at 2am.
export function validateReasonDeclarations(automationId: string, reasons: unknown): void {
  try {
    if (typeof reasons !== 'object' || reasons === null || Array.isArray(reasons)) {
      throw new Error('reasons must be an object keyed by reason name');
    }
    const entries = Object.entries(reasons);
    if (entries.length === 0) throw new Error('reasons must declare at least one reason');
    for (const [reason, spec] of entries) validateDeclaration(reason, spec);
  } catch (err) {
    throw new Error(`automation "${automationId}": invalid reasons: ${(err as Error).message}`, { cause: err });
  }
}

// ---------- Run-time enforcement ----------

export interface ResolvedReason {
  outcome: Outcome;
  facts?: Record<string, FactValue>;
}

function isFactValue(value: unknown): value is FactValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function resolveFacts(reason: string, declared: readonly string[], given: unknown): Record<string, FactValue> | undefined {
  if (declared.length === 0) {
    if (given !== undefined) throw new Error(`reason "${reason}" declares no facts but the decision supplied some`);
    return undefined;
  }
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new Error(`reason "${reason}" declares facts [${declared.join(', ')}] but the decision supplied none`);
  }
  const record = given as Record<string, unknown>;
  const out: Record<string, FactValue> = {};
  for (const key of Object.keys(record)) {
    if (!declared.includes(key)) throw new Error(`reason "${reason}": fact "${key}" is not declared`);
  }
  for (const key of declared) {
    const value = record[key];
    if (!isFactValue(value)) {
      throw new Error(`reason "${reason}": fact "${key}" must be a string, finite number, boolean or null (got ${typeof value})`);
    }
    out[key] = value;
  }
  return out;
}

// Called by the pipeline on every decision from a declaring automation. Throws on an
// undeclared reason or fact: the pipeline turns that into an `unhandled_error` abort so the
// gap is visible, never a decision with a silently dropped explanation.
export function resolveDeclaredReason(
  reasons: ReasonDeclarations,
  decision: { reason?: unknown; facts?: unknown },
): ResolvedReason {
  const { reason } = decision;
  if (typeof reason !== 'string' || !Object.hasOwn(reasons, reason)) {
    throw new Error(`reason ${JSON.stringify(reason)} is not declared`);
  }
  const spec = reasons[reason];
  const facts = resolveFacts(reason, spec.facts ?? [], decision.facts);
  return { outcome: spec.outcome, ...(facts && { facts }) };
}
