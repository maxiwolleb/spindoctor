# Configuration

## Environment variables

All optional — the Docker image sets sensible defaults for a containerized
deployment.

| Variable                    | Default                                                                | Purpose                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SPINDOCTOR_DB`             | `/data/spindoctor.sqlite` (image) / `./data/spindoctor.sqlite` (dev)   | Path to the SQLite database file.                                                                                                             |
| `PORT`                      | `8080`                                                                 | HTTP port the backend listens on.                                                                                                             |
| `HOST`                      | `0.0.0.0`                                                              | Interface the backend binds to.                                                                                                               |
| `SPINDOCTOR_WEB_ROOT`       | built-in `apps/web/dist` path, resolved relative to the backend module | Directory of the built SPA served as static files (and its SPA fallback). Static serving is skipped entirely if this directory doesn't exist. |
| `SPINDOCTOR_MIGRATIONS_DIR` | resolved next to the backend source (`../../drizzle`)                  | Overrides where Drizzle looks for migration files — only needed if your deploy layout differs from the shipped image.                         |

These map directly onto `createServer()`'s overrides in
`apps/backend/src/main.ts`; each is read once at startup.

## Settings (web UI)

Everything else is configured at runtime through the **Settings** page,
persisted in the database (so it survives a restart):

- **Grading thresholds** — the three numeric thresholds the verdict
  evaluator uses (see [How it works](/guide/how-it-works)):
  - Reallocated sectors — warn above (default `10`)
  - SSD/NVMe wear % — warn at (default `80`)
  - SSD/NVMe wear % — fail at (default `100`)
- **Concurrency** — the number of simultaneous test slots (default `4`).
  Runs beyond this limit queue rather than starting immediately.
- **Protected drives** — a list of serial numbers that are never eligible
  for destructive testing, manual or auto-mode (see
  [Safety](/guide/safety)). Empty by default.
- **Auto-mode** — off by default; requires the acknowledgment checkbox
  before the toggle can be enabled (see
  [How it works](/guide/how-it-works#auto-mode)).

Settings are read and written via `GET`/`PUT /api/settings`; the same
validation the Settings form applies client-side (numeric thresholds,
whole-number concurrency ≥ 1, string-only protect-list entries) is
enforced again server-side.
