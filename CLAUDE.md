# Homerun — Framework Development Context

## What this is

Homerun is a TypeScript framework for Home Assistant automation. It enforces a typed, testable pattern: context builder + pure reducer + declarative actions. Designed to be published as `@ajclarkson/homerun`.

This repository contains the framework only — no automations, no household-specific configuration, no entity names. Those live in a separate private `homerun-automations` repo.

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
  | { type: 'mqtt.publish'; topic: string; payload: string; retain?: boolean }
  | { type: 'timer.start'; timerKey: string; delayMs: number }
  | { type: 'timer.cancel'; timerKey: string };
```

Unknown action types must log a warning and emit an error observability event — never silently dropped.

## HAContext

Passed as the second argument to every context builder. Provides synchronous access to entity registry data loaded at startup.

```typescript
interface HAContext {
  entitiesByLabel: (label: string) => string[];
  labelsFor: (entity: string) => string[];
}
```

## Reliability requirements

These are non-negotiable — the framework runs unattended and controls physical devices:

- **Never crash the process.** `uncaughtException` and `unhandledRejection` must be caught at the top level, logged, and recovered from.
- **Isolate pipeline errors.** An exception in any automation's context builder or reducer must produce an `abort` decision with `reason: 'unhandled_error'` and flow through observability. It must never affect other automations or future events.
- **Gate on state cache readiness.** The Trigger Engine must not dispatch events until the initial state cache sync is complete after (re)connect.
- **Hot reload must not unload on error.** A failed module load during hot reload keeps the previous version of that automation registered. A bad file push must never silently remove a running automation.
- **Reconnect safely.** On HA WebSocket reconnect, re-sync the full state cache before resuming event delivery.

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

## Current state

`HAClient` is complete — see `src/framework/ha-client.ts`. Remaining work is tracked as [GitHub issues](https://github.com/ajclarkson/homerun/issues).
