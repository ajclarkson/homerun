# Changelog

## Unreleased

- An exception in an automation's `context()` or `reduce()` is now logged (`console.error`, with automation id, stage, message and stack). The `unhandled_error` abort gains optional structured `stage` (`context` | `reduce`) and `error_type` (the `Error` name, only when identifier-shaped). Neither the message nor the stack is on the event. History `detail` carries both fields too; the history schema is unchanged.

## Unreleased

- **Behaviour change:** the loader no longer skips `lib/` and `types/` directories automatically. Consumers that relied on that must set `automations.ignore: [lib, types]` in `configuration.yaml`, otherwise helper files there are loaded as automations and logged as errors (no default export).
- New `automations.ignore`: list of directory names, matched as path segments, skipped by the loader and the file watcher. Default `[]`.
- Docker image runs as the non-root `node` user; the unused `AUTOMATIONS_DIR` env var is removed (the path comes from `automations.dir`).

## 0.1.0

Additive and opt-in: an automation that declares nothing behaves and publishes exactly as before.

- `defineAutomation({ reasons })`: declare each reason with an `outcome` (`acted`, `declined`, `ignored`) and typed `facts`. Enforced at compile time (`reason` narrowed to the declared keys), at load time and at run time. A run-time violation never stops the actions: the decision publishes without `outcome`/`facts` and a structured `declaration_error` event (`problem`: `undeclared_reason` | `missing_fact` | `undeclared_fact` | `invalid_fact_value`, optional `reason`/`fact`) is published and logged. Automations without `reasons` cannot return `facts` (compile error). The registry rejects bad declarations and the reserved location `dev` at load.
- Decision events gain optional `outcome` and `facts` for declaring automations.
- Catalogue of declared reasons, retained on `homerun/catalog` (`home.catalog.v1`, published on every startup, empty if nothing declares) and added to `GET /automations`.
- Optional history ring buffers (`history: { size, houseSize }`), retained on `homerun/{location}/history` and `homerun/history` (`home.history.v1`), seeded from the retained topics at startup, republishes coalesced and flushed on shutdown. The catalogue and history are both gated by `events.enabled`.
- JSON Schemas for both payloads in `schemas/`; published payloads are validated against them.
- Type tests (`*.test-d.ts`) run with the suite; `npm run build` now uses `tsconfig.build.json`.
