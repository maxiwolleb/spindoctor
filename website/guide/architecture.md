# Architecture

## Monorepo layout

spindoctor is a pnpm-workspace monorepo with three packages:

- **`apps/backend`** — Fastify + TypeScript. REST API, Server-Sent Events
  for live progress, and (in production) static serving of the built SPA.
- **`apps/web`** — Vue 3 + Vite + TypeScript, using **Vuetify** for
  components and **Pinia** for state, fed by the backend's SSE stream.
- **`packages/shared`** — wire types (drive/run/stage views, verdict
  types, thresholds, events) imported by both sides. It's **source-only**:
  its `package.json` `exports` point straight at `./src/index.ts` with no
  build step, which resolves under Vite and Vitest but not bare Node —
  see [the `tsx` runtime](#the-tsx-runtime) below for why that matters.

## Backend layers

Under `apps/backend/src/`:

- **`device/`** — a mockable `DeviceApi` wrapping the CLI tools the
  container ships (`smartctl --json`, `badblocks`, `lsblk`). The real
  implementation (`RealDeviceApi`) shells out via `node:child_process`;
  nothing real ever runs in unit tests, which inject a fake `DeviceApi`
  instead.
- **`engine/`** — the durable state machine (`TestEngine`) that drives a
  `TestRun` through the ordered regime stages (see
  [How it works](/guide/how-it-works)), persists every transition, and
  emits `run:update`/`stage:progress` events. Reconciles interrupted runs
  on startup — a self-test resumes by polling, a killed surface stage
  restarts. `AutoModePoller` sits alongside it, polling drive discovery on
  an interval and enqueuing destructive runs when auto-mode is on.
- **`safety/`** — `checkDestructiveAllowed`, the single guard function
  consulted by every destructive-start path (manual API route, the
  pre-write re-check, and the auto-mode poller) — see
  [Safety](/guide/safety).
- **`verdict/`** — `evaluateVerdict`, a **pure** function: before/after
  SMART metrics + self-test result + surface result + thresholds →
  PASS/WARN/FAIL with structured reasons. No I/O, heavily table-tested.
- **`api/`** — Fastify route registration (`drives`, `runs`, `settings`,
  `audit`, `events`/SSE) plus a uniform JSON error shape.
- **`db/`** — SQLite via **Drizzle ORM** + `better-sqlite3`; repositories
  for drives, runs, stage results, SMART snapshots, config, and audit log.

Everything is keyed on the drive's **serial number** — device paths
(`/dev/sdX`) are treated as transient and re-resolved by serial after any
long-running stage, since a device node can be reassigned or reused
across a multi-hour regime.

## Live progress: SSE

The web UI doesn't poll. `apps/backend/src/api/routes/events.ts` exposes
an SSE endpoint that bridges `TestEngine`'s `run:update` and
`stage:progress` events straight onto the wire; the Pinia store in
`apps/web` subscribes once and updates reactively as stages progress,
self-tests tick forward, and verdicts land.

## The `tsx` runtime

The backend runs under **`tsx`** (not a bundler) in both development and
production — `tsx src/main.ts` is the literal start command in the
Docker image, not just a dev convenience. This is a deliberate,
non-default choice: bundling the backend would break
`@spindoctor/shared`'s source-only `.ts` exports (which resolve fine
under `tsx`'s on-the-fly transpilation, but not through a bundler that
expects `.js`) and the Drizzle migrations path the DB client resolves
relative to its own module. Running from source under `tsx` in production
too keeps dev and prod resolving both of those identically, at the cost
of not having a compiled build artifact.

## The Docker image

Multi-stage, Debian-slim based (`node:22-bookworm-slim` for both the
build and runtime stages):

1. **Build stage** — installs the full workspace, builds the `apps/web`
   SPA, then produces a self-contained backend deploy directory via
   `pnpm --filter @spindoctor/backend deploy --prod --legacy` (source +
   Drizzle migrations + a production `node_modules` with
   `@spindoctor/shared`, `tsx`, and `better-sqlite3` resolved into it).
2. **Runtime stage** — the same slim base, with the CLI tools the device
   layer shells out to installed via `apt`: `smartmontools`,
   `e2fsprogs`, `nvme-cli`, `hdparm`, and `util-linux` (for `lsblk`).
   `smartmontools` specifically comes from `bookworm-backports`: Debian
   bookworm ships 7.3, which predates NVMe self-test support, so
   `smartctl -t long` against an NVMe drive there does nothing at all while
   still exiting 0 — leaving every NVMe run stuck at "self-test did not
   complete". The
   deploy output and the built SPA are copied in, and the container runs
   `node_modules/.bin/tsx src/main.ts` as its entrypoint.

The container runs as root: `smartctl`/`badblocks`/`hdparm` need raw
block-device access, which already requires the operator to grant
`--device`/`--cap-add`/`--privileged` for the specific disks under test —
see [Install & run](/guide/install#device-passthrough) — so there's no
meaningful non-root story without also granting those same capabilities.
