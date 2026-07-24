# Homerun — Framework Development Context

## What this is

Homerun is a TypeScript framework for Home Assistant automation. It enforces a typed, testable pattern: context builder + pure reducer + declarative actions. Designed to be published as `@ajclarkson/homerun`.

This repository contains the framework only — no automations, no household-specific configuration, no entity names. Those live in a separate `homerun-automations` repo, which is public — keep that in mind when writing anything there (issues, PRs, commits) too.

## What this is not

This repo should never contain:
- Automation logic for any specific home
- Real entity IDs, room names, or household configuration
- HA credentials or environment-specific URLs
- Migration notes or references to Node-RED flows

If you find yourself wanting to reference specific entities or rooms while working here, that's a signal to step back to the design docs first.

## Architecture

The framework has seven core components:

| Module | File | Responsibility |
|--------|------|----------------|
| HA Client | `src/framework/ha-client.ts` | WebSocket connection, state cache, entity registry |
| Trigger Engine | `src/framework/trigger-engine.ts` | Pure event router — matches events to automations, button gesture recognition |
| Scheduler | `src/framework/scheduler.ts` | Cron jobs (`schedule`) and `on_start` — event source that feeds `dispatch()` |
| Timer Manager | `src/framework/timer-manager.ts` | Named timers — event source that feeds `dispatch()` on expiry |
| Pipeline Runner | `src/framework/pipeline.ts` | 5-step pipeline: correlate → context → reduce → validate → fanout |
| Action Runtime | `src/framework/action-runtime.ts` | Declarative action execution with observability events |
| Observability | `src/framework/observability.ts` | MQTT event + snapshot publisher |
| Registry | `src/framework/registry.ts` | Automation registration, hot reload |

**Event source pattern:** Scheduler and TimerManager are independent event sources — they have no dependency on HAClient and generate events from time/timers. Both call `TriggerEngine.dispatch()`. TriggerEngine is a pure router with zero self-generated events.

Full design intent is documented externally. This CLAUDE.md covers what you need to work in this codebase.

## The automation API

An automation is a typed object. This is the public API surface — changes here are breaking changes.

```typescript
interface Automation<C> {
  id: string;
  location: string;
  subsystem: string;
  triggers: Trigger[];
  context: (state: HAState, ha: HAContext) => C | Abort;
  reduce: (ctx: C) => Decision;
}
```

`defineAutomation` is the user-facing entry point — it provides type inference on the context shape.

## Trigger types

```typescript
type Trigger =
  | { type: 'state_changed'; entity: string | RegExp }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity: string; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string };
```

`on_start` fires once when the system is ready and the state cache is populated. It has no `delayMs` — if startup work needs to be deferred, emit a `timer.start` action from the reducer and handle `timer_expired` instead.

## Action types

```typescript
type Action =
  | { type: 'ha.call_service'; domain: string; service: string;
      target?: { entity_id: string }; data?: Record<string, unknown> }
  | { type: 'mqtt.publish'; topic: string; payload: string; retain?: boolean; impliesEntity?: string }
  | { type: 'timer.start'; timerKey: string; delayMs: number }
  | { type: 'timer.cancel'; timerKey: string };
```

Unknown action types must log a warning and emit an error observability event — never silently dropped.

### `mqtt.publish` and `impliesEntity`

`sensor`/`binary_sensor` domains in HA have no service call to set their state — publishing to a manually-configured MQTT entity's `state_topic` is the correct (and only) way to drive them. Set `impliesEntity` to that entity's ID whenever `topic` is one of these `state_topic`s. This lets the HA Client link the `state_changed` HA emits in response back to this automation's run (`parent_correlation_id`/`parent_automation_id` on the resulting observability events), the same way `ha.call_service` gets that link automatically via `target.entity_id`.

There's no way for the framework to detect a missing `impliesEntity` — a topic string carries no information about which HA entity, if any, mirrors it, and that mapping lives entirely in HA's own (often manual) MQTT config. Leaving it unset doesn't break anything; it just means the resulting `state_changed`, and anything that reacts to it, won't be traceable back to this automation's run.

## Decision and observability events

```typescript
interface Decision {
  decision: string;
  reason?: string;
  actions: Action[];
  // The conditions that determined this decision (e.g. lux level, house mode). Distinct from
  // `trigger` on the published event (what happened) — this is why it was allowed to happen
  // this way. Optional: defaults to the full context object returned by `context()` if omitted,
  // so this is "for free" for most automations — only set it explicitly to trim or reshape what
  // gets published (e.g. a context object holding something not worth publishing wholesale).
  conditions?: Record<string, unknown>;
}
```

Every pipeline run publishes an `ObsEvent` (`schema: 'home.events.v2'`) to `homerun/events`, and — for `decision`/`abort` only — a retained snapshot to `homerun/{location}/{subsystem}/decision`. It's a discriminated union on `event_type`, not one flat shape:

- `decision` — carries `trigger` (a trimmed summary of the real trigger — `{ type, entity_id?, to?, from?, cron?, ... }` depending on trigger type), `decision`/`reason`/`conditions` from the reducer, `actions`, and `hasAction: boolean` (framework-computed from `actions.length > 0` — filter on this, not on parsing `decision` strings, to find every decision that resulted in at least one action).
- `abort` — carries `trigger` and `abort_kind: 'disabled' | 'unhandled_error' | 'guard'` (`'guard'` covers every author-triggered `abort()` call; `reason` on top of that is whatever string `abort()` was given).
- `action_started` / `action_result` — one pair per action in the plan, each carrying the single `action` it's about (not an array — always exactly one). `action_result` carries `status: 'ok' | 'error'` and, on failure, `error` with the detail. Emitted as two separate wire events deliberately: a `action_started` with no matching `action_result` is itself a signal (a hung HA call, a crash mid-action).

## HAContext

Passed as the second argument to every context builder. Provides synchronous access to entity registry data loaded at startup.

```typescript
interface HAContext {
  entitiesByLabel: (label: string) => string[];
  labelsFor: (entity: string) => string[];
  entitiesByArea: (area: string) => string[];
}
```

## Reliability requirements

These are non-negotiable — the framework runs unattended and controls physical devices:

- **Never crash the process.** `uncaughtException` and `unhandledRejection` must be caught at the top level, logged, and recovered from.
- **Isolate pipeline errors.** An exception in any automation's context builder or reducer must produce an `abort` decision with `reason: 'unhandled_error'` and flow through observability. It must never affect other automations or future events.
- **Gate on state cache readiness.** The Trigger Engine must not dispatch events until the initial state cache sync is complete after (re)connect.
- **Hot reload must not unload on error.** A failed module load during hot reload keeps the previous version of that automation registered. A bad file push must never silently remove a running automation.
- **Reconnect safely.** On HA WebSocket reconnect, re-sync the full state cache before resuming event delivery.

## Coding style

Inspired by [TigerBeetle's TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md), adapted for a TypeScript automation framework — not a line-by-line port. The parts that assume a fixed-memory embedded database (no dynamic allocation after startup, no recursion, static loop bounds) don't apply here and are deliberately skipped. What does carry over:

- **A side effect must never be able to break core control flow.** Observability, logging, and metrics are secondary to an automation actually running — a serialization failure or a bad listener must never prevent a real `ha.call_service`/`mqtt.publish` action from executing. See `EventPublisher.safeSerialize`/`notifyListeners` for the concrete pattern: catch at the boundary, log, keep going — never let the side channel take down the primary one.
- **Fail loudly and close to the mistake, not silently deep in unrelated code.** Prefer an explicit `throw`/abort at the point something is actually wrong over a fallback that papers over it and surfaces a confusing symptom three layers away.
- **Explicit, narrow error handling at trust boundaries — not broad try/catch as a reflex.** Wrap exactly where untrusted or fallible input crosses in (a reducer's return value, a network call, `JSON.stringify` on author-supplied data), not around large blocks "just in case."
- **Keep functions and files small enough to review in one sitting.** If a function is doing two distinct jobs, split it — this codebase already tends to favor many small, named private methods over long ones (see `ActionRuntime`, `HAClient`) and that's deliberate, not incidental.
- **Comments explain *why*, not *what*.** Well-named code already says what it does; a comment earns its place by capturing a non-obvious constraint, a rejected alternative, or the reason a workaround exists — not by restating the next line.
- **Tests are not optional.** TDD for new framework behavior — see Development workflow below.

## Dry-run mode

`DRY_RUN=true` causes the action runtime to log actions rather than execute them. The full pipeline runs — context, reduce, observability — but `ha.call_service` and `mqtt.publish` are no-ops. This is the default for local development and must be built in from the start.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `HA_URL` | Home Assistant base URL |
| `HA_TOKEN` | Long-lived access token |
| `MQTT_URL` | MQTT broker URL |
| `AUTOMATIONS_DIR` | Path to automation files (watched by hot reload) |
| `DRY_RUN` | Set to `true` to disable action execution |
| `AUTOMATION` | Scope hot reload to a single file (optional, dev only) |

## Development workflow

Work is tracked as GitHub issues. When picking up an issue:

1. Pull latest `main`, then create a branch: `git checkout -b feat/issue-{N}-short-description`
2. Write failing tests first (TDD) — add the new `it()` blocks, run the suite, confirm they fail for the right reason
3. Implement until all tests pass
4. Open a PR referencing the issue — the PR title should follow the existing `feat(#N): ...` convention

Never commit directly to `main`.

## Testing

Vitest. Reducers and context builders are plain functions — import and call them directly with mock state. No HA connection required for unit tests.

```typescript
import { reduceExample } from './example';

it('returns no_action when disabled', () => {
  const result = reduceExample({ enabled: false });
  expect(result.decision).toBe('no_action');
});
```

`HAState` in tests is a plain function: `(entity: string) => mockValues[entity]`.

## MQTT topics

All observability events are published under the `homerun/` namespace:

| Topic | Retained | Purpose |
|-------|----------|---------|
| `homerun/events` | No | Event bus — every decision, abort, and action event |
| `homerun/{location}/{subsystem}/decision` | Yes | Latest decision snapshot per automation |
| `homerun/dev/events` | No | Same as above but when `DRY_RUN=true` |
| `homerun/dev/{location}/{subsystem}/decision` | Yes | Same as above but when `DRY_RUN=true` |

Dry-run events are routed to `homerun/dev/*` so they cannot overwrite retained live decision state.

## Observability: Prometheus vs ObsEvent

The framework has two independent observability outputs, each the source of truth for a different question. Neither is a subset of the other — don't use one to reconstruct what the other already answers.

**Prometheus (`MetricsBackend`, `homerun_*` metrics)** is for aggregates: rates, counts, durations, trends over time. `homerun_actions_dispatched_total`/`_succeeded_total`/`_failed_total`, `homerun_action_duration_seconds`, `homerun_pipeline_runs_total`, `homerun_automations_loaded`. The right tool for "how often is X happening" or "what's the failure rate for this action type" — it's already structured for `rate()`/`sum by (...)` queries. Opt-in via `metrics.enabled` in config; a no-op backend (`NoopMetricsBackend`) is used when disabled, so metrics calls are always safe to make regardless of whether anything is actually collecting them.

**`ObsEvent` (`homerun/events`, `homerun/{location}/{subsystem}/decision`, and the `/events` SSE endpoint)** is for point-in-time audit and causal tracing: one specific pipeline run, correlated via `correlation_id`/`root_correlation_id`/`parent_correlation_id`, with the full decision reasoning attached (`trigger`, `conditions`, `reason`, `abort_kind`). The right tool for "what exactly happened on this run and why," not for aggregate questions — parsing the event stream to compute a success rate is the wrong layer; that's what the Prometheus counters already do.

The `/events` SSE endpoint (`ApiServer`) is fed by `EventPublisher.subscribe()`, an in-process listener list — separate from the MQTT `publish()` calls. Anything hooking into `ObsEvent`s in-process (SSE today; a future persistent store for a UI) should use `subscribe()`, not consume the MQTT stream — this keeps it working independently of whether MQTT publishing for `ObsEvent` is enabled at all.

## Consumer repo

Automations live in a separate consumer repo (`homerun-automations`, public). It depends on this package via a local file link (`"homerun": "file:../homerun"`). The `homerun-generate-ha-types` bin is invoked from there as `npm run codegen`.

## Current state

The full bootstrap is running. The framework is in active development — remaining work is tracked as [GitHub issues](https://github.com/ajclarkson/homerun/issues).
