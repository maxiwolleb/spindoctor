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

## Reading the SMART data

Both SMART snapshots are shown two ways in the run detail. The **diff table**
covers the handful of metrics the verdict actually grades, before against after.
The **attribute table** shows everything the drive reported, one row per field,
each with a plain-language description of what it measures and a per-row
ok / warn / fail flag. Row flags follow the same rules the verdict does, so a
red row never sits next to a PASS.

What that table contains depends on how the drive reports health:

- **ATA/SATA** — the standard SMART attribute table, with each attribute's
  normalized value, worst-ever value and vendor threshold alongside the raw
  counter.
- **NVMe** — the health-information log: critical warning, percentage used,
  available spare, media errors, and so on.
- **SAS/SCSI** — SCSI log pages instead of an attribute table: the drive's own
  self-assessment, the grown defect list, the error counter log split by
  read/write/verify (uncorrected, recovered-by-retry, and corrected totals), and
  the SAS phy link counters summed across every phy.

Some of those counters are routinely enormous on a perfectly healthy drive —
millions of ECC-corrected reads, thousands of grown defects, hundreds of invalid
DWORDs from ordinary cabling — which is the whole reason each row carries an
explanation rather than just a number. The raw `smartctl --json` output for
either snapshot is downloadable from the same page.

## Already-failed drives stop early

A drive whose very first SMART read already condemns it does not get the
rest of the regime. Nothing a later stage could find would clear it — FAIL
is FAIL — and the two stages in between are expensive: roughly 90 minutes
of firmware self-test, then hours of writing every sector. On a 12 TB SAS
disk that is most of a day spent confirming a verdict the first three
seconds already gave you.

So after `SMART_BEFORE`, the baseline snapshot is graded on its own. If it
already yields a **fail**-severity reason — the drive reporting its own
health as failing, pending or uncorrectable sectors, reallocated sectors
past the limit, exhausted SSD wear, NVMe media errors — the run skips
straight to `VERDICT`:

```
SMART_BEFORE → SELFTEST_LONG → SURFACE → SMART_AFTER → VERDICT
                  skipped      skipped    skipped
```

The skipped stages are recorded as **Skipped** in the run timeline, not as
passed, and the verdict carries the reasons that condemned the drive plus a
note that the self-test was skipped.

Warnings never trigger this. A drive with stable reallocated sectors, a
high-but-stable SAS grown-defect count, link or CRC errors is exactly the
drive that most needs the full regime, so it gets it.

Two ways to run everything anyway:

- **Settings → Already-failed drives** turns the early exit off globally
  (it is on by default).
- **Wipe even if SMART already condemns the drive**, in the start dialog,
  overrides it for a single destructive run — because the destructive pass
  is also a _wipe_, and wiping a dying drive before disposal is a perfectly
  good reason to want every sector written.

Neither affects the [safety guards](/guide/safety): a mounted, system, or
protected drive is never writable, whatever these are set to.

## Verdict thresholds

The verdict evaluator is a pure function of the before/after SMART
metrics, the self-test result, the surface result, and the configured
thresholds. The rules, in order:

- **Long self-test:**
  - `FAILED` → **FAIL**.
  - `ABORTED` or `UNKNOWN` (didn't complete) → **WARN**.
  - `SKIPPED` (never started, because the baseline already condemned the
    drive — see above) → an informational note only; it cannot move the
    verdict, since the reasons that condemned the drive are in the same
    list.
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
