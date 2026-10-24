# Setting up a consumer repo

A consumer is a repository that holds your automations and depends on `@ajclarkson/homerun`. The homerun runtime loads the automation files, wires them to Home Assistant and MQTT, and runs them.

## Install

```bash
npm install @ajclarkson/homerun
```

Every push to `main` publishes an `edge` build to npm (version `<base>-edge.<sha>`, dist-tag `edge`) and a `ghcr.io/ajclarkson/homerun:edge` Docker image. Tagged releases (`v*`) publish release images.

## Layout

Put automations anywhere under one directory (you choose it, see Configuration). Every `.ts` file under it, recursively, is loaded, except `*.test.ts` and `*.d.ts`.

- Each file must `export default` an `Automation`, or an array of them. Every automation needs a unique `id`.
- Files are bundled individually with esbuild. Imports of `@ajclarkson/homerun` and `@ajclarkson/homerun/testing` resolve to the running framework; other imports (shared helpers, factories) are bundled in.
- A failed reload keeps the previous version of that automation registered.
- Keep tests next to the code (`*.test.ts`); the loader ignores them.

## Generate types from your Home Assistant

```bash
HA_URL=http://homeassistant.local:8123 HA_TOKEN=... npx homerun-generate-ha-types
```

Writes `types/ha-entities.ts` in the current directory from `GET /api/states`, so entity IDs in triggers are type-checked. Re-run it when entities change. `homerun-generate-ha-services` does the same for typed service helpers. Never commit the token.

## Write and test

See `docs/api.md`. Tests use `vitest` with `@ajclarkson/homerun/testing`; no Home Assistant connection is needed.

## Configure and run

The runtime reads a YAML file, `./configuration.yaml` by default or the path in `HOMERUN_CONFIG`. A `secrets.yaml` next to it supplies `!secret key` values. Required keys: `homeassistant.url`, `homeassistant.token`, `mqtt.url`, `automations.dir`. See `configuration.yaml.example` in this repo for every option and its default.

```bash
HOMERUN_CONFIG=./configuration.yaml node node_modules/@ajclarkson/homerun/dist/src/index.js
```

The package also exposes this entry point as the `homerun` bin. With Docker, mount the config file and the automations directory into the container. Set `options.dry_run: true` to run the full pipeline without executing actions. `AUTOMATION=<file>` (relative to the automations directory, without `.ts`) scopes hot reload to a single file during development.
