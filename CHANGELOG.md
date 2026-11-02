# Changelog

## 0.1.0

Additive and opt-in: an automation that declares nothing behaves and publishes exactly as before.

- `defineAutomation({ reasons })`: declare each reason with an `outcome` (`acted`, `declined`, `ignored`) and typed `facts`. Enforced at compile time (`reason` narrowed to the declared keys), at load time and at run time (an undeclared reason or fact aborts with `unhandled_error`).
- Decision events gain optional `outcome` and `facts` for declaring automations.
- Catalogue of declared reasons, retained on `homerun/catalog` (`home.catalog.v1`) and added to `GET /automations`.
- Optional history ring buffers (`history: { size, houseSize }`), retained on `homerun/{location}/history` and `homerun/history` (`home.history.v1`), seeded from the retained topics at startup.
- JSON Schemas for both payloads in `schemas/`; published payloads are validated against them.
- Type tests (`*.test-d.ts`) run with the suite; `npm run build` now uses `tsconfig.build.json`.
