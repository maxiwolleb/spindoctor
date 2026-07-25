# spindoctor

Qualify used and refurbished drives before you trust them: SMART → long
self-test → destructive surface scan (`badblocks -w`) → SMART again →
**PASS / WARN / FAIL** — driven from a live web console.

[![CI](https://img.shields.io/github/actions/workflow/status/maxiwolleb/spindoctor/ci.yml?branch=main&label=CI)](https://github.com/maxiwolleb/spindoctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/maxiwolleb/spindoctor)](LICENSE)
[![Image](https://img.shields.io/badge/ghcr.io-maxiwolleb%2Fspindoctor-blue)](https://github.com/maxiwolleb/spindoctor/pkgs/container/spindoctor)

## ⚠️ Safety warning

**The destructive test IRRECOVERABLY WIPES the drive under test.** The
surface stage runs `badblocks -w`, a destructive write-pattern scan — it
erases all data on the drive, with no way to get it back. Only point
spindoctor at drives whose data you do not need.

There are guards, and they are always on:

- a drive that is currently **mounted** is never eligible for a destructive
  run;
- the host's own **system disk** is never eligible;
- any drive you add to the **protected-serial list** (Settings) is never
  eligible, including in auto-mode;
- starting a destructive run — manually or via auto-mode — requires
  **typing the drive's serial number** to confirm, in the UI and enforced
  again by the API.

These guards reduce risk, they do not eliminate it. You are the one who
decides which drives get passed into the container in the first place
(see the device-passthrough note below) — spindoctor cannot warn you about
a drive it was never told to protect. Double-check `lsblk` before you pass
any device through.

## Screenshots

| Dashboard                                                                               | Drive detail                                                                               | Settings                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| ![Dashboard: drive inventory with health and verdict](assets/screenshots/dashboard.png) | ![Drive detail: SMART before/after diff and stage timeline](assets/screenshots/detail.png) | ![Settings: thresholds, concurrency, protected drives, auto-mode](assets/screenshots/settings.png) |

- **Dashboard** — every discovered drive with its model, serial, size,
  type, mount/system state, and latest verdict; start a test per drive.
- **Drive detail** — the SMART before/after diff for the latest run, the
  per-stage timeline, and run history.
- **Settings** — grading thresholds, test concurrency, the protected-serial
  list, and the auto-mode acknowledgment + toggle.

## Quickstart

```yaml
# docker-compose.yml
services:
  spindoctor:
    image: ghcr.io/maxiwolleb/spindoctor:latest
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    restart: unless-stopped

    # Device passthrough — REQUIRED for real SMART/badblocks/hdparm access,
    # OFF by default so a plain `docker compose up` never touches host disks.
    # ⚠️ DESTRUCTIVE: any drive passed through here can be WIPED. Uncomment
    # one of the two blocks below, and list the exact drives via `devices:`
    # (check with `lsblk` first) before enabling this.
    #
    # privileged: true
    # # — or, narrower —
    # cap_add:
    #   - SYS_RAWIO
    #   - SYS_ADMIN
    # devices:
    #   - "/dev/sdX:/dev/sdX"
```

```
docker compose up -d
```

Open `http://localhost:8080`. Without the device-passthrough block
uncommented, the UI comes up and the dashboard works, but drive discovery
will not see any real disks — that's intentional, so a plain
`docker compose up` never touches host block devices by accident.

A full example is in [`docker-compose.yml`](docker-compose.yml).

## How it works

### The regime

Each test run walks a fixed, ordered set of stages:

```
SMART_BEFORE → SELFTEST_LONG → SURFACE → SMART_AFTER → VERDICT
```

- **SMART_BEFORE / SMART_AFTER** — `smartctl` snapshots, before and after.
- **SELFTEST_LONG** — the drive's own firmware long self-test.
- **SURFACE** — `badblocks`, in destructive (`-w`) or read-only mode
  depending on how the run was started.
- **VERDICT** — the before/after SMART diff, self-test result, and surface
  result are evaluated against thresholds to produce PASS/WARN/FAIL with
  structured reasons.

Runs are durable: an interrupted self-test resumes by polling the drive's
own firmware state, and a killed surface stage restarts, both on backend
startup.

### Verdict thresholds

- **Reallocated sectors:** `0` → PASS; `1`–`10` and stable → WARN; above
  `10`, or grown during the test window, → FAIL. (`10` is the default
  `reallocatedWarnMax` threshold — configurable in Settings.)
- **Current pending / offline uncorrectable / reported uncorrectable
  sectors:** any value `> 0` after the test → FAIL.
- **SSD/NVMe wear** (`percentageUsed`): `≥ 80%` → WARN, `≥ 100%` → FAIL
  (defaults, configurable).
- **Surface scan:** any bad block found → FAIL.
- A failed long self-test → FAIL; an aborted/incomplete self-test or
  surface scan → WARN.
- Interface CRC errors → WARN (check cabling).
- NVMe media errors → FAIL.

### Auto-mode

Auto-mode continuously polls attached drives and automatically starts a
**destructive** run on every newly-discovered, eligible drive — no manual
click required. It is:

- **off by default**;
- **opt-in**, and gated behind an explicit checkbox acknowledgment in
  Settings ("I understand auto-mode will destructively wipe any newly
  attached, eligible drive") before the toggle can even be enabled;
- still subject to the same safety guards as a manual start — a mounted,
  system, or protected-list drive is never enqueued, auto-mode or not.

### Safety model

See the safety warning above — the guards
(mounted/system/protected-list exclusion, typed-serial confirmation) are
enforced both in the UI and again server-side on `POST /api/runs`, so they
hold even if a client bypasses the UI.

## Configuration

Environment variables (all optional — defaults shown are what the Docker
image sets):

| Variable                    | Default                                                              | Purpose                                                                                                               |
| --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SPINDOCTOR_DB`             | `/data/spindoctor.sqlite` (image) / `./data/spindoctor.sqlite` (dev) | Path to the SQLite database file.                                                                                     |
| `PORT`                      | `8080`                                                               | HTTP port the backend listens on.                                                                                     |
| `HOST`                      | `0.0.0.0`                                                            | Interface the backend binds to.                                                                                       |
| `SPINDOCTOR_WEB_ROOT`       | built-in `apps/web/dist` path                                        | Directory of the built SPA served as static files.                                                                    |
| `SPINDOCTOR_MIGRATIONS_DIR` | resolved next to the backend source                                  | Overrides where Drizzle looks for migration files — only needed if your deploy layout differs from the shipped image. |

Everything else is configured at runtime through the **Settings** page in
the web UI: grading thresholds (reallocated-sector warn limit, SSD/NVMe
wear warn/fail limits), test concurrency, the protected-serial list, and
the auto-mode toggle.

## Development

spindoctor is a pnpm workspace monorepo:

- `apps/backend` — Fastify + TypeScript (REST + SSE), SQLite via Drizzle.
- `apps/web` — Vue 3 + Vuetify, built with Vite.
- `packages/shared` — wire types shared by both sides (source-only, no
  build step).

Requires Node ≥ 22 and pnpm ≥ 9.

```
pnpm install
pnpm dev                              # backend + web, both in watch mode
pnpm test                             # vitest, whole workspace
pnpm -r typecheck                     # typecheck every package
pnpm --filter @spindoctor/web build   # production SPA build
```

The backend runs under `tsx` (not a bundler) in both development and
production, so `packages/shared`'s source-only exports resolve the same
way everywhere.

## Testing

Tests are written before (or alongside) the code they cover, and are built to
run anywhere without touching real hardware:

- **Pure, deterministic core.** The verdict evaluator
  (`apps/backend/src/verdict`) and the device-output parsers (`smartParser`,
  `lsblkParser`, `badblocksParser`, `scanParser` under `apps/backend/src/device`)
  are plain functions with no I/O — they're exercised against captured
  `smartctl`/`lsblk`/`badblocks`-shaped fixtures with a scenario per
  threshold/edge case (clean, warn, fail, boundary values, missing metrics).
- **Nothing real runs.** All disk access goes through a `DeviceApi`
  interface; tests use `FakeDeviceApi` (in-memory, scripted responses)
  instead of the real implementation. No test in this repo runs `smartctl`,
  `badblocks`, or `lsblk` against an actual disk, and none ever will —
  destructive commands are never exercised against real hardware in
  tests or CI.
- **No wall-clock waits.** The engine's poll loops (self-test polling,
  auto-mode discovery) take an injectable `sleep` function instead of calling
  `setTimeout` directly, so tests drive them deterministically without real
  delays or flaky timing.
- **The one real-I/O path is emulated, not mocked away.** The surface-scan
  runner does spawn a real child process, so it's tested against a small
  Node script (`__testhelpers__/fake-badblocks.mjs`) that stands in for the
  `badblocks` binary — same stdout/stderr/log-file shape, so the runner's
  process handling (progress parsing, abort/kill, spawn failures) is
  exercised for real without needing `badblocks` or a disk to be present.

Run the suite:

```
pnpm test             # vitest, whole workspace
pnpm test:coverage     # same, plus a v8 coverage report (text + html + lcov)
```

## No auth in v1

The web UI and API have **no authentication** in this version. It is
built for a trusted LAN — do not expose it directly to the internet.

## Documentation

Full docs, including install/run, how-it-works, safety, configuration, and
architecture guides, are at
**[maxiwolleb.gitlab.io/spindoctor](https://maxiwolleb.gitlab.io/spindoctor/)**.

The docs site (`website/`, VitePress) deploys to GitLab Pages. This
repository lives on GitHub and is mirrored to GitLab so that GitLab CI can
run the `pages` job — see [CONTRIBUTING.md](CONTRIBUTING.md#documentation)
for details.

## License

[MIT](LICENSE)
