# Automation API

The public API surface. Changes here are breaking changes. Types live in `src/types/` (`automation.ts`, `triggers.ts`, `actions.ts`).

## Automation

```typescript
interface Automation<C> {
  id: string;
  location: string;
  subsystem: string;
  enabled?: boolean;
  triggers: Trigger[];
  context: (state: HAState, ha: HAContext, event: TriggerEvent) => C | Abort;
  reduce: (ctx: C) => Decision;
}
```

`defineAutomation` is the user-facing entry point; it provides type inference on the context shape. `Decision` is described in `docs/observability.md`.

## Trigger types

```typescript
type Trigger =
  | { type: 'state_changed'; entity: string | RegExp; to?: string | string[]; duration?: number }
  | { type: 'schedule'; cron: string }
  | { type: 'on_start' }
  | { type: 'timer_expired'; timerKey: string }
  | { type: 'button'; entity: string | RegExp; gesture: 'single_press' | 'double_press' | 'hold'; button?: string }
  | { type: 'mqtt_in'; topic: string };
```

- `state_changed` fires on every HA state_changed event, including attribute-only updates. Use `to` to filter to specific state values, e.g. `{ type: 'state_changed', entity: 'sun.sun', to: 'below_horizon' }` fires only at sunset.
- `duration` (ms) delays the firing: it fires only if the entity still holds the new state when the delay elapses. Each new matching event restarts the delay.
- `on_start` fires once when the system is ready and the state cache is populated. It has no `delayMs`; if startup work needs deferring, emit a `timer.start` action from the reducer and handle `timer_expired`.

## Context builder

```typescript
context: (state, ha, event) => { ... }
```

- `state(entityId)` returns `{ entity_id, state, attributes, last_changed, last_updated } | undefined` from the live HA state cache.
- `ha` is the `HAContext` below. `event` is the raw `TriggerEvent`; inspect `event.type`. For `state_changed`: `event.entity_id`, `event.new_state`, `event.old_state` (may be `undefined` for new entities).
- All are synchronous. `ha.*` reads the registry snapshot loaded at startup, not live HA.
- Return `abort('reason')` to short-circuit: the abort is recorded in observability and `reduce` is never called.

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

### `requireState()` and `requireNumericState()`

The dominant `abort()` pattern across real automations (~70% of call sites, per an audit) is a required entity's state being missing or invalid — `const x = state(id)?.state; if (x === undefined) return abort(...)`, repeated at every such check. `requireState(state, entityId)`/`requireNumericState(state, entityId)` collapse that to one line each:

```typescript
context: (state) => {
  const houseMode = requireState(state, 'sensor.mode');
  const luxThreshold = requireNumericState(state, `input_number.${location}_threshold`);
  // ... no per-call guard needed — throws UnavailableInputError on failure
}
```

They throw `UnavailableInputError` rather than returning `Abort` — `pipeline.ts` already wraps `context()` in try/catch, and this lets call sites skip the `if (isAbort(...)) return ...` boilerplate entirely. Caught specially and classified as `abort_kind: 'unavailable_input'` with `entity` set to the entity ID, distinct from a genuine bug (`'unhandled_error'`). `requireNumericState` additionally checks `Number.isFinite` after `parseFloat`, matching the other half of the audited pattern (numeric threshold/sensor checks).

Fails fast on the first missing entity, matching how every existing `abort()` call site already behaves — it does not collect every missing entity in one context() call before aborting.

## HAContext

Passed as the second argument to every context builder. Provides synchronous access to entity registry data loaded at startup.

```typescript
interface HAContext {
  entitiesByLabel: (label: string) => string[];
  labelsFor: (entity: string) => string[];
  entitiesByArea: (area: string) => string[];
}
```

`entitiesByArea` resolves an entity's effective area: its own area if set, otherwise the area of its device. Labels are not inherited from devices. The registries reload (debounced) on `entity_registry_updated` and `device_registry_updated`.

## Testing

```typescript
import { testAutomation, testAbort, testUnavailable } from '@ajclarkson/homerun/testing';

const result = testAutomation(automation, {
  event: { type: 'state_changed', entity_id: 'binary_sensor.foo', new_state: { state: 'on' } },
  state: {
    'binary_sensor.foo': { state: 'on' },
    'input_boolean.bar': { state: 'off', last_changed: new Date(Date.now() - 5000).toISOString() },
  },
  ha: { entitiesByLabel: (l) => (l === 'some_label' ? ['input_boolean.bar'] : []) },
});

expect(result).toMatchObject({ decision: 'no_action', reason: 'some_reason' });
```

- `testAutomation` returns the `Decision` (throws if the automation aborted). `testAbort` returns the `Abort`. `testUnavailable` returns the entity ID that `requireState()`/`requireNumericState()` found missing.
- `state` entries only need the fields the automation reads. `last_changed`/`last_updated` default to `''`; only set them when the automation reads timestamps. `ha` members default to empty results.
- The returned `conditions` default to the full context object, as in a real pipeline run.
