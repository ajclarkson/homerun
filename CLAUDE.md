# Homerun — Framework Development Context

## What this is

Homerun is a TypeScript framework for Home Assistant automation. It enforces a typed, testable pattern: context builder + pure reducer + declarative actions. Designed to be published as `@ajclarkson/homerun`.

This repository contains the framework only — no automations, no household-specific configuration, no entity names. Consumers keep their automations in their own repo and depend on this package. Everything written here (code, docs, issues, PRs, commits) is public.

## What this is not

This repo should never contain:
- Automation logic for any specific home
- Real entity IDs, room names, or household configuration
- HA credentials or environment-specific URLs

If you find yourself wanting to reference specific entities or rooms while working here, use a generic placeholder (`sensor.example`) instead.

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

Per-component detail is in the code; the public API and event schema are in `docs/`.

## Docs (read on demand)

- `docs/api.md`: automation API, trigger and action types, `requireState()`, `HAContext`, testing helpers. Read before changing anything public.
- `docs/observability.md`: `ObsEvent` schema (`home.events.v2`), `commandAck`, MQTT topics, Prometheus vs `ObsEvent`. Read before changing events or metrics.
- `docs/consumers.md`: how a consumer repo is set up: install, layout, type generation, config, running. Read when changing the loader, config, bins or packaging.
- `README.md`: overview, quick start, and the HTTP API (health, automations, reload, `/events` stream).

## Commands

```bash
npm run dev            # run from source, hot-reloads automations (DRY_RUN is the safe default)
npm run build          # tsc
npm test               # vitest, watch mode
npm run test:run       # vitest, single run (use before committing)
npm run generate:ha-types      # generate entity types from a live HA instance
npm run generate:ha-services   # generate typed service helpers
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

`options.dry_run: true` in the config causes the action runtime to log actions rather than execute them. The full pipeline runs — context, reduce, observability — but `ha.call_service` and `mqtt.publish` are no-ops. Dry-run events go to `homerun/dev/*` topics. Use it for local development.

## Configuration

The runtime reads `configuration.yaml` (path from `HOMERUN_CONFIG`, default `./configuration.yaml`), with `!secret` values from a `secrets.yaml` beside it. Schema and defaults: `src/framework/config.ts`; annotated example: `configuration.yaml.example`.

Environment variables are few: `HOMERUN_CONFIG` (config path), `AUTOMATION` (dev only: scope hot reload to one file), and `HA_URL`/`HA_TOKEN` (used only by the type and service generators).

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

## Consumers

A consumer is a repo that depends on this package, holds its automations, and runs the runtime (see `docs/consumers.md`). Anything exported from `src/lib.ts` or `src/testing.ts` is public API.

## Roadmap

Remaining work is tracked as [GitHub issues](https://github.com/ajclarkson/homerun/issues).
