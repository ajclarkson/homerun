# Homerun

**Typed, testable Home Assistant automations in TypeScript.**

> **Status: pre-1.0.** The API may change. Builds are published to npm as `@ajclarkson/homerun` (`edge` tag, on every push to `main`) and as a Docker image, `ghcr.io/ajclarkson/homerun:edge`.

Homerun is a framework that replaces HA automations and Node-RED flows with pure functions. Every automation is a context builder and a reducer — no side effects, no hidden state, no YAML. The pipeline handles observability, error isolation, and action execution.

---

## The problem

Home Assistant automations are YAML. Node-RED flows are JSON blobs. Both are hard to test, hard to review, and impossible to type-check. A bad deploy silently breaks your lights at 2am.

Homerun brings the same discipline you'd apply to application code: pure functions, typed inputs, and a test suite that runs in milliseconds.

---

## How it works

Every automation follows the same pipeline:

```
Event → context() → reduce() → actions[]
```

**`context()`** reads from the HA state cache and returns a typed snapshot — or aborts early if a required input is missing. It is the only place that touches external state.

**`reduce()`** is a pure function. It receives the context and returns a decision with a list of declarative actions. No async, no side effects, no HA calls.

**The pipeline** handles everything else: correlation IDs, observability events, error isolation, and action execution.

---

## Example

```typescript
import { defineAutomation, abort, requireState, requireNumericState } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'kitchen:lighting',
  location: 'kitchen',
  subsystem: 'lighting',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.kitchen_motion' },
    { type: 'on_start' },
  ],

  context(state) {
    if (requireState(state, 'input_boolean.kitchen_lights_enabled') !== 'on') {
      return abort('automation_disabled');
    }
    return {
      motion: requireState(state, 'binary_sensor.kitchen_motion') === 'on',
      lux: requireNumericState(state, 'sensor.kitchen_lux'),
      luxThreshold: requireNumericState(state, 'input_number.kitchen_lux_threshold'),
    };
  },

  reduce(ctx) {
    const shouldLight = ctx.motion && ctx.lux < ctx.luxThreshold;
    return {
      decision: shouldLight ? 'lights_on' : 'lights_off',
      actions: [
        {
          type: 'ha.call_service',
          domain: 'light',
          service: shouldLight ? 'turn_on' : 'turn_off',
          target: { entity_id: 'light.kitchen_ceiling' },
        },
      ],
    };
  },
});
```

`requireState` and `requireNumericState` abort the run, with the missing entity recorded, if an entity is unavailable or non-numeric, so a dead sensor never silently becomes a wrong decision. The decision's `conditions` default to the full context, so the published event explains itself.

Files like this go in your automations directory; see [Consumer setup](docs/consumers.md).

---

## Testing

Because `reduce()` is a pure function, tests are just function calls. To test the whole automation without a Home Assistant connection, use the test helpers:

```typescript
import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import kitchenLights from './kitchen-lights';

describe('kitchen lighting', () => {
  it('turns lights on when motion is detected below the lux threshold', () => {
    const result = testAutomation(kitchenLights, {
      event: { type: 'state_changed', entity_id: 'binary_sensor.kitchen_motion', new_state: { state: 'on' } },
      state: {
        'input_boolean.kitchen_lights_enabled': { state: 'on' },
        'binary_sensor.kitchen_motion': { state: 'on' },
        'sensor.kitchen_lux': { state: '20' },
        'input_number.kitchen_lux_threshold': { state: '40' },
      },
    });
    expect(result.decision).toBe('lights_on');
    expect(result.actions[0]).toMatchObject({ service: 'turn_on' });
  });
});
```

No mocking, no HA connection, no async. `testAbort` and `testUnavailable` cover the abort paths. See [Automation API](docs/api.md).

---

## Triggers and actions

| Trigger | Fires when |
|---------|-----------|
| `state_changed` | An entity's state or attributes change. Filter with `to`; delay with `duration`. |
| `schedule` | A cron expression fires. |
| `on_start` | The system is ready and the state cache is fully populated. |
| `timer_expired` | A named timer set by a previous `timer.start` action expires. |
| `button` | A button entity emits a `single_press`, `double_press`, or `hold` gesture. |
| `mqtt_in` | A message arrives on a subscribed MQTT topic. |

| Action | Effect |
|--------|--------|
| `ha.call_service` | Calls a Home Assistant service |
| `mqtt.publish` | Publishes to an MQTT topic |
| `timer.start` | Starts (or restarts) a named timer |
| `timer.cancel` | Cancels a named timer |

Actions are returned from `reduce()` as a plain array; the runtime executes them after the decision event is published. Full types and semantics: [Automation API](docs/api.md).

---

## Observability

Every pipeline run publishes an event to MQTT — whether it decided, aborted, or threw — and every action publishes its own start and result events. A `correlation_id` minted at the event source lets you trace a HA state change through to the service call that resulted from it.

```json
{
  "schema": "home.events.v2",
  "correlation_id": "b3d2f1a0-...",
  "root_correlation_id": "b3d2f1a0-...",
  "automation_id": "kitchen:lighting",
  "location": "kitchen",
  "subsystem": "lighting",
  "event_type": "decision",
  "trigger": { "type": "state_changed", "entity_id": "binary_sensor.kitchen_motion", "to": "on" },
  "decision": "lights_on",
  "conditions": { "motion": true, "lux": 20, "luxThreshold": 40 },
  "actions": [{ "type": "ha.call_service", "domain": "light", "service": "turn_on" }],
  "hasAction": true,
  "timestamp": "2026-06-23T18:00:00.000Z"
}
```

Schema, topics, command-ack tracking and Prometheus metrics: [Observability](docs/observability.md).

---

## Running

```bash
npm install @ajclarkson/homerun
```

Homerun reads a `configuration.yaml` (path from `HOMERUN_CONFIG`) with your Home Assistant URL and token, MQTT broker and automations directory. Secrets can live in a `secrets.yaml` beside it and be referenced with `!secret`. [`configuration.yaml.example`](configuration.yaml.example) shows every option.

Set `options.dry_run: true` to run the full pipeline — context, reduce, observability — without executing any actions.

Setting up your own automations repo, generating entity types from your Home Assistant, and running the runtime are covered in [Consumer setup](docs/consumers.md).

To work on the framework itself, clone this repo and use `npm run dev` (run from source, hot-reloads) and `npm test`.

---

## HTTP API

The server exposes an HTTP API on port `7070` by default (`server.port` in the config).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health/live` | Always returns `200 { status: "live" }` — used for liveness probes. |
| `GET` | `/health/ready` | Returns `200` when the HA state cache is populated and automations are loaded, `503` while starting. Response includes `entities`, `automations` counts, and `dry_run: true` if running in dry-run mode. |
| `GET` | `/automations` | Lists all registered automations with their `id`, `location`, `subsystem`, and trigger types. |
| `POST` | `/automations/:id/trigger` | Manually fires an `on_start` event for the given automation. |
| `POST` | `/reload` | Rescans the automations directory and hot-reloads changed files. |
| `GET` | `/events` | Server-sent event stream of all pipeline decisions and action events in real time. |

---

## Architecture

```
HAClient ──────────────────────────────────────┐
  └─ state_changed (per entity, with corr. ID) │
                                               ▼
Scheduler (cron / on_start) ──────► TriggerEngine.dispatch()
TimerManager (setTimeout)  ──────►        │
                                          ▼
                                   matchAndFire()
                                          │
                              ┌───────────▼──────────┐
                              │    Pipeline Runner    │
                              │  context → reduce     │
                              │  → validate → fanout  │
                              └──────────┬────────────┘
                                         │
                          ┌──────────────┴──────────────┐
                          ▼                             ▼
                   Observability                  ActionRuntime
                 (MQTT events)           (HA calls / timers / MQTT)
```

---

## License

MIT
