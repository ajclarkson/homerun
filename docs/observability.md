# Observability

Event schema, command-ack tracking, MQTT topics, and Prometheus vs `ObsEvent`.

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
- `abort` — carries `trigger` and `abort_kind: 'disabled' | 'unhandled_error' | 'guard' | 'unavailable_input'` (`'guard'` covers every author-triggered `abort()` call; `'unavailable_input'` is `requireState()`/`requireNumericState()` detecting a missing entity, with `entity` set to which one; `reason` on top of that is whatever string `abort()` was given, when applicable).
- `action_started` / `action_result` — one pair per action in the plan, each carrying the single `action` it's about (not an array — always exactly one). `action_result` carries `status: 'ok' | 'error'` and, on failure, `error` with the detail. Emitted as two separate wire events deliberately: a `action_started` with no matching `action_result` is itself a signal (a hung HA call, a crash mid-action).
- `action_ack_timeout` — opt-in (`commandAck.enabled`, see below), fires when a dispatched `ha.call_service`'s expected state/attribute change never arrives within `commandAck.timeoutMs`. Carries `action`, `entity`, and `expected` (the field/attribute → value map that was never satisfied). Arrives well after that run's own `action_result: 'ok'` — that only confirms HA accepted the WebSocket call, not that the device responded — so it can't be folded into that event; it's a separate, later-arriving signal correlated back via the same `correlation_id`.

### `commandAck` — command acknowledgment tracking

Opt-in (`commandAck.enabled`, default `false`) detection of a dispatched `ha.call_service` whose target entity never reaches the expected state — device unreachable, Zigbee mesh failure, or HA accepting the call but the device not responding. Deliberately convention-based rather than a per-service mapping table (which couldn't scale to arbitrary third-party integrations): a service's `data` keys are treated as the resulting attribute names it sets (`temperature`, `brightness`, `position`, ...) — true as a platform-wide HA naming convention, not domain-specific knowledge homerun has to hand-maintain — with `turn_on`/`turn_off` special-cased to `state: 'on'`/`'off'`, and a small denylist (`transition`, `entity_id`) excluding known non-attribute call parameters. Before tracking, the target entity's current state is checked against every expected field; if already satisfied (an idempotent call), nothing is tracked — no `state_changed` would fire anyway, so tracking it would produce a false-positive timeout. Only single-entity `target.entity_id` calls are tracked; multi-entity/scene dispatches are out of scope.

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

**Prometheus (`MetricsBackend`, `homerun_*` metrics)** is for aggregates: rates, counts, durations, trends over time. `homerun_actions_dispatched_total`/`_succeeded_total`/`_failed_total`, `homerun_action_duration_seconds`, `homerun_pipeline_runs_total`, `homerun_automations_loaded`, `homerun_action_ack_timeout_total`. The right tool for "how often is X happening" or "what's the failure rate for this action type" — it's already structured for `rate()`/`sum by (...)` queries. Opt-in via `metrics.enabled` in config; a no-op backend (`NoopMetricsBackend`) is used when disabled, so metrics calls are always safe to make regardless of whether anything is actually collecting them.

**`ObsEvent` (`homerun/events`, `homerun/{location}/{subsystem}/decision`, and the `/events` SSE endpoint)** is for point-in-time audit and causal tracing: one specific pipeline run, correlated via `correlation_id`/`root_correlation_id`/`parent_correlation_id`, with the full decision reasoning attached (`trigger`, `conditions`, `reason`, `abort_kind`). The right tool for "what exactly happened on this run and why," not for aggregate questions — parsing the event stream to compute a success rate is the wrong layer; that's what the Prometheus counters already do.

The `/events` SSE endpoint (`ApiServer`) is fed by `EventPublisher.subscribe()`, an in-process listener list — separate from the MQTT `publish()` calls. Anything hooking into `ObsEvent`s in-process (SSE today; a future persistent store for a UI) should use `subscribe()`, not consume the MQTT stream — this keeps it working independently of whether MQTT publishing for `ObsEvent` is enabled at all.

`events.enabled` (default `true`, mirrors `metrics.enabled`) gates the MQTT publishing side of `ObsEvent` only — `homerun/events` and the retained decision snapshot. `subscribe()` listeners (the `/events` SSE endpoint, any future UI store) are always notified regardless, and `publishLifecycle` (the online/offline status heartbeat) is unaffected — it's a process-liveness signal, not part of `ObsEvent`.
