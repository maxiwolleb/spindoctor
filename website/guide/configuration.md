# Configuration

## Environment variables

All optional — the Docker image sets sensible defaults for a containerized
deployment.

| Variable                         | Default                                                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPINDOCTOR_DB`                  | `/data/spindoctor.sqlite` (image) / `./data/spindoctor.sqlite` (dev)   | Path to the SQLite database file.                                                                                                                                                                                                                                                                                                                                                       |
| `PORT`                           | `8080`                                                                 | HTTP port the backend listens on.                                                                                                                                                                                                                                                                                                                                                       |
| `HOST`                           | `0.0.0.0`                                                              | Interface the backend binds to.                                                                                                                                                                                                                                                                                                                                                         |
| `SPINDOCTOR_WEB_ROOT`            | built-in `apps/web/dist` path, resolved relative to the backend module | Directory of the built SPA served as static files (and its SPA fallback). Static serving is skipped entirely if this directory doesn't exist.                                                                                                                                                                                                                                           |
| `SPINDOCTOR_MIGRATIONS_DIR`      | resolved next to the backend source (`../../drizzle`)                  | Overrides where Drizzle looks for migration files — only needed if your deploy layout differs from the shipped image.                                                                                                                                                                                                                                                                   |
| `SPINDOCTOR_SYSTEM_DISK_SERIALS` | unset                                                                  | Comma-separated drive serials spindoctor must always refuse, whatever any probe reports. Matched ignoring case and surrounding whitespace. Worth setting to the host's own system disk: in a container `lsblk` reports only the container's mount namespace, so spindoctor cannot work out which disk the host booted from — see [Safety](/guide/safety#what-the-container-cannot-see). |
| `LOG_LEVEL`                      | `info`                                                                 | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. An unrecognized value falls back to `info` rather than failing to start.                                                                                                                                                                                                                                           |
| `LOG_FORMAT`                     | `pretty`                                                               | `pretty` gives colored, one-line-per-event output in `docker logs`; `json` gives newline-delimited JSON for shipping to a log collector.                                                                                                                                                                                                                                                |

These map directly onto `createServer()`'s overrides in
`apps/backend/src/main.ts`; each is read once at startup.

## Settings (web UI)

Everything else is configured at runtime through the **Settings** page,
persisted in the database (so it survives a restart):

- **Grading thresholds** — the numeric thresholds the verdict evaluator
  uses. Each default is calibrated against observed failure rates rather
  than picked as a round number — see [Where the thresholds come
  from](/guide/how-it-works#where-the-thresholds-come-from):
  - Reallocated sectors — warn above (default `4`)
  - Command timeouts — warn above (default `100`)
  - SSD/NVMe wear % — warn at (default `80`)
  - SSD/NVMe wear % — fail at (default `100`)
- **Concurrency** — the number of simultaneous test slots (default `4`).
  Runs beyond this limit queue rather than starting immediately.
- **Protected drives** — a list of serial numbers that are never eligible
  for destructive testing, manual or auto-mode (see
  [Safety](/guide/safety)). Empty by default.
- **Already-failed drives** — on by default: a drive whose baseline SMART
  read already condemns it goes straight to a FAIL verdict instead of
  spending ~90 minutes on a self-test and hours overwriting a disk that has
  already failed (see
  [How it works](/guide/how-it-works#already-failed-drives-stop-early)). A
  single destructive run can opt out from the start dialog when the write is
  wanted as a wipe.
- **Diagnostics** — off by default. Enables a downloadable bundle containing
  what spindoctor could not explain about the drives it graded: the raw
  `smartctl` payloads it read, the verdicts it reached, the versions of the CLI
  tools in use, and a report of attributes it has no description for, drives it
  may have mis-typed, and runs where its verdict disagreed with the drive's own
  health claim. Intended for handing to someone improving the parsers and
  thresholds.

  **Nothing is transmitted anywhere.** spindoctor has no telemetry and makes no
  outbound requests; this only adds `GET /api/diagnostics/bundle`, a file you
  download and choose to share. With the flag off the route returns 404.

  Drive serials are replaced by per-instance pseudonyms by default — stable
  enough to tie findings to one drive and follow it across runs, without the
  bundle being a readable inventory. The salt that produces them is never
  exported, so the pseudonyms cannot be reversed, and two instances testing the
  same drive produce unrelated identifiers. A sub-toggle switches to verbatim
  serials. Model and firmware are always included: they are what parser fixes are
  keyed on, and they identify a product rather than your fleet. The protect list
  is excluded outright, being a list of serials.

- **Auto-mode** — off by default; requires the acknowledgment checkbox
  before the toggle can be enabled (see
  [How it works](/guide/how-it-works#auto-mode)).

Settings are read and written via `GET`/`PUT /api/settings`; the same
validation the Settings form applies client-side (numeric thresholds,
whole-number concurrency ≥ 1, string-only protect-list entries) is
enforced again server-side.

Thresholds are stored per install. An install created before a threshold
existed reads back with the current default filled in for it, and any value
already stored is left alone — a default that changes in a later release
never silently moves a number an operator may have tuned.
