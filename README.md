# Homerun

**Typed, testable Home Assistant automations in TypeScript.**

> **Status: early development.** The framework is not yet published to npm and the API is not stable. This README documents the intended design; some parts are still being built.

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

**`context()`** reads from the HA state cache and returns a typed snapshot — or aborts early if the guard condition isn't met. It is the only place that touches external state.

**`reduce()`** is a pure function. It receives the context and returns a decision with a list of declarative actions. No async, no side effects, no HA calls.

**The pipeline** handles everything else: correlation IDs, observability snapshots, error isolation, and action execution.

---

## Example

```typescript
import { defineAutomation, abort } from './src/types/automation.js';

export const kitchenLights = defineAutomation({
  id: 'kitchen:lighting',
  location: 'kitchen',
  subsystem: 'lighting',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.kitchen_motion' },
    { type: 'state_changed', entity: 'binary_sensor.kitchen_door' },
    { type: 'on_start' },
  ],

  context(state, ha) {
    const enabled = state('input_boolean.kitchen_automation_lights_enabled');
    if (enabled?.state !== 'on') return abort('automation_disabled');

    return {
      motion: state('binary_sensor.kitchen_motion')?.state === 'on',
      lux: Number(state('sensor.kitchen_sensor_lux')?.state ?? 0),
      luxThreshold: Number(state('input_number.kitchen_automation_lux_threshold_dark')?.state ?? 40),
    };
  },

  reduce(ctx) {
    const shouldLight = ctx.motion && ctx.lux < ctx.luxThreshold;

    return {
      decision: shouldLight ? 'lights_on' : 'lights_off',
      inputs: ctx,
      actions: [
        {
          type: 'ha.call_service',
          domain: 'light',
          service: shouldLight ? 'turn_on' : 'turn_off',
          target: { entity_id: 'light.kitchen_light_ceiling' },
        },
      ],
    };
  },
});
```

---

## Testing

Because `reduce()` is a pure function, tests are just function calls:

```typescript
import { describe, it, expect } from 'vitest';
import { kitchenLights } from './kitchen-lights';

describe('kitchenLights reducer', () => {
  it('turns lights on when motion is detected below lux threshold', () => {
    const result = kitchenLights.reduce({ motion: true, lux: 20, luxThreshold: 40 });
    expect(result.decision).toBe('lights_on');
    expect(result.actions[0]).toMatchObject({ service: 'turn_on' });
  });

  it('turns lights off when lux is already high', () => {
    const result = kitchenLights.reduce({ motion: true, lux: 80, luxThreshold: 40 });
    expect(result.decision).toBe('lights_off');
  });

  it('turns lights off when motion clears', () => {
    const result = kitchenLights.reduce({ motion: false, lux: 10, luxThreshold: 40 });
    expect(result.decision).toBe('lights_off');
  });
});
```

No mocking, no HA connection, no async. The context builder can be tested separately with a plain function as the state accessor:

```typescript
const mockState = (entity: string) => ({
  'input_boolean.kitchen_automation_lights_enabled': { state: 'on' },
  'binary_sensor.kitchen_motion': { state: 'on' },
  'sensor.kitchen_sensor_lux': { state: '20' },
  'input_number.kitchen_automation_lux_threshold_dark': { state: '40' },
})[entity] as any;

const ctx = kitchenLights.context(mockState, mockHAContext);
```

---

## Trigger types

| Trigger | Fires when |
|---------|-----------|
| `state_changed` | An entity's state or attributes change. Accepts a string or `RegExp` for the entity ID. |
| `schedule` | A cron expression fires. |
| `on_start` | The system is ready and the state cache is fully populated. |
| `timer_expired` | A named timer set by a previous `timer.start` action expires. |
| `button` | A Zigbee button entity emits a `single_press`, `double_press`, or `hold` gesture. |

```typescript
triggers: [
  { type: 'state_changed', entity: 'binary_sensor.parlour_motion' },
  { type: 'state_changed', entity: /^binary_sensor\..+_motion$/ },
  { type: 'schedule', cron: '0 22 * * *' },
  { type: 'on_start' },
  { type: 'timer_expired', timerKey: 'kitchen:lights:off-delay' },
  { type: 'button', entity: 'sensor.hallway_button', gesture: 'double_press' },
]
```

---

## Action types

Actions are returned from `reduce()` as a plain array. The runtime executes them after the observability snapshot is published.

| Action | Effect |
|--------|--------|
| `ha.call_service` | Calls a Home Assistant service |
| `mqtt.publish` | Publishes to an MQTT topic |
| `timer.start` | Starts (or restarts) a named timer |
| `timer.cancel` | Cancels a named timer |

```typescript
actions: [
  {
    type: 'ha.call_service',
    domain: 'climate',
    service: 'set_temperature',
    target: { entity_id: 'climate.bedroom_trv' },
    data: { temperature: 20 },
  },
  {
    type: 'timer.start',
    timerKey: 'kitchen:lights:off-delay',
    delayMs: 120_000,
  },
  {
    type: 'mqtt.publish',
    topic: 'homerun/decisions/kitchen',
    payload: JSON.stringify({ decision: 'lights_on' }),
    retain: false,
  },
]
```

---

## Observability

Every pipeline run publishes a decision snapshot to MQTT — whether it completed, aborted, or threw. Each snapshot carries a `correlation_id` minted at the event source, so you can trace a HA state change through to the TRV setpoint that resulted from it.

```json
{
  "schema": "home.events.v1",
  "correlation_id": "b3d2f1a0-...",
  "automation_id": "kitchen:lighting",
  "location": "kitchen",
  "subsystem": "lighting",
  "type": "decision",
  "decision": "lights_on",
  "inputs": { "motion": true, "lux": 20, "luxThreshold": 40 },
  "actions": [{ "type": "ha.call_service", "domain": "light", "service": "turn_on" }],
  "timestamp": "2026-06-23T18:00:00.000Z"
}
```

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `HA_URL` | Home Assistant base URL (e.g. `http://homeassistant.local:8123`) |
| `HA_TOKEN` | Long-lived access token |
| `MQTT_URL` | MQTT broker URL (e.g. `mqtt://localhost:1883`) |
| `AUTOMATIONS_DIR` | Directory of automation files (hot-reloaded on change) |
| `DRY_RUN` | Set to `true` to log actions without executing them |

---

## Running

> Homerun is not yet published to npm. Clone the repository and run directly from source.

```bash
# Development — hot-reloads automations on file change
npm run dev

# Run tests
npm test
```

Set `DRY_RUN=true` to run the full pipeline — context, reduce, observability — without making any HA service calls. This is the default for local development.

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
                 (MQTT snapshot)         (HA calls / timers / MQTT)
```

---

## License

MIT
