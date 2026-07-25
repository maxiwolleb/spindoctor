# How it works

## The regime

Every test run — manual or auto-mode — walks the same fixed, ordered set
of stages:

```
SMART_BEFORE → SELFTEST_LONG → SURFACE → SMART_AFTER → VERDICT
```

- **SMART_BEFORE** — a `smartctl -x --json=c` snapshot of the drive,
  parsed into a small set of key metrics (reallocated sectors, pending
  sectors, uncorrectable counts, CRC errors, SSD/NVMe wear, …) and stored
  alongside the raw output.
- **SELFTEST_LONG** — starts the drive's own firmware long self-test
  (`smartctl -t long`) and polls it to completion.
- **SURFACE** — a full-surface `badblocks` pass: `-w` (destructive,
  writes and verifies every sector) for a destructive run, `-n`
  (non-destructive, read-only-safe) for a read-only scan.
- **SMART_AFTER** — a second SMART snapshot, taken after the self-test and
  surface stages.
- **VERDICT** — the before/after SMART diff, the self-test result, and
  the surface result are evaluated against the configured thresholds into
  a **PASS / WARN / FAIL**, with structured, per-reason detail.

![Drive detail: SMART before/after diff and stage timeline](/screenshots/detail.png)

## Verdict thresholds

The verdict evaluator is a pure function of the before/after SMART
metrics, the self-test result, the surface result, and the configured
thresholds. The rules, in order:

- **Long self-test:**
  - `FAILED` → **FAIL**.
  - `ABORTED` or `UNKNOWN` (didn't complete) → **WARN**.
- **Surface scan:**
  - any bad block found (`badBlocks > 0`) → **FAIL**.
  - didn't complete → **WARN**.
- **Hard uncorrectable indicators** (after the test) — any of these
  `> 0` → **FAIL**:
  - current pending sectors
  - offline uncorrectable sectors
  - reported uncorrectable errors
- **Growth during the test window** — reallocated sectors or current
  pending sectors higher _after_ than _before_ → **FAIL**, even if the
  absolute after-value would otherwise only warrant a WARN.
- **Reallocated sectors (absolute, after the test):**
  - `0` → no reason raised (contributes to PASS).
  - `1`–`10` (the default `reallocatedWarnMax`) and stable (no growth
    above) → **WARN**.
  - `> 10` → **FAIL**.
- **Interface CRC errors** — any `> 0` → **WARN** (check cabling).
- **SSD/NVMe wear** (`percentageUsed`, SSD/NVMe drives only):
  - `≥ 80%` (default `ssdPercentageUsedWarn`) → **WARN**.
  - `≥ 100%` (default `ssdPercentageUsedFail`) → **FAIL**.
- **NVMe media errors** — any `> 0` → **FAIL**.

The three numeric thresholds above (`reallocatedWarnMax`,
`ssdPercentageUsedWarn`, `ssdPercentageUsedFail`) are configurable in
Settings — see [Configuration](/guide/configuration). The overall verdict
is the worst severity across every reason raised: any FAIL reason makes
the run FAIL; otherwise any WARN reason makes it WARN; otherwise PASS.

## Durable runs

Runs survive a backend restart. On startup, the engine reconciles every
run that was left `RUNNING` or `PENDING` by a previous process:

- A `SELFTEST_LONG` stage that was still running resumes by **polling**
  the drive's own firmware state — the self-test itself kept running on
  the drive across the restart, only this process's tracking of it was
  interrupted, so it isn't started over.
- A `SURFACE` stage that was interrupted mid-write/scan is **restarted
  from scratch** — `badblocks` doesn't checkpoint, so there's no partial
  state to resume. A destructive surface restart re-runs the safety
  guards before writing again (see [Safety](/guide/safety)).
- Surface restarts are capped: a run that's been restarted too many times
  is given up on and marked `FAILED` rather than retried forever.

## Auto-mode

Auto-mode polls attached drives on an interval and automatically starts a
**destructive** run on every newly-discovered, eligible drive — no manual
click required. It is:

- **off by default**;
- **opt-in**, gated behind an explicit checkbox acknowledgment in Settings
  before the toggle can even be enabled;
- still subject to the exact same safety guards as a manual destructive
  start — a mounted, system, or protected-list drive is never enqueued,
  auto-mode or not (see [Safety](/guide/safety)).

A drive that's denied by the safety guard is not remembered as
permanently ineligible — if it later becomes eligible (unmounted, removed
from the protect list), a later poll picks it up.
