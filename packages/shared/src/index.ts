export type DriveType = "HDD" | "SSD" | "NVMe"
export type Transport = "SATA" | "SAS" | "USB" | "NVMe" | "UNKNOWN"
export type Verdict = "PASS" | "WARN" | "FAIL"
export type Severity = "info" | "warn" | "fail"

export type StageName = "SMART_BEFORE" | "SELFTEST_LONG" | "SURFACE" | "SMART_AFTER" | "VERDICT"

export const STAGE_NAMES: readonly StageName[] = [
  "SMART_BEFORE",
  "SELFTEST_LONG",
  "SURFACE",
  "SMART_AFTER",
  "VERDICT",
] as const

/** Key SMART/health metrics we grade on. `null` means "not reported". */
export interface SmartKeyMetrics {
  reallocatedSectors: number | null
  currentPending: number | null
  offlineUncorrectable: number | null
  reportedUncorrect: number | null
  crcErrors: number | null
  powerOnHours: number | null
  /**
   * ATA attribute 10 — times the platters needed a retry to reach speed. A
   * mechanical signal, and the rare SMART counter where the first non-zero value
   * is already decisive: in Backblaze's fleet data a drive with any spin retries
   * shows roughly ten times the annual failure rate of one with none. `null` on
   * SAS/NVMe, which have no equivalent.
   */
  spinRetryCount: number | null
  /**
   * ATA attribute 188 — commands the drive abandoned because they timed out.
   * Graded on a threshold rather than on any non-zero value: low historical
   * counts are common and are as often a cable as a drive (the same story as
   * `crcErrors`). `null` on SAS/NVMe.
   */
  commandTimeouts: number | null
  /** SSD/NVMe wear, 0–100+. */
  percentageUsed: number | null
  /** NVMe media/integrity errors. */
  mediaErrors: number | null
  temperatureC: number | null
  /**
   * SAS/SCSI grown defect list size — blocks the drive has retired since
   * format. The SAS analogue of ATA reallocated sectors, but deliberately kept
   * as its own metric because the scale is entirely different: healthy SAS
   * drives in service routinely carry counts in the thousands, so the ATA
   * `reallocatedWarnMax` threshold is meaningless here. `null` on ATA/NVMe.
   */
  grownDefects: number | null
  /**
   * SAS/SCSI link-layer errors — invalid DWORDs plus loss-of-sync, summed over
   * every phy of every port. A cable/backplane signal rather than a media one:
   * an audit of 18 SAS drives found counts in the hundreds that did not move
   * under load, i.e. the test rig's wiring, not a failing disk. Graded as a
   * warning only, never a failure. `null` on ATA/NVMe.
   */
  linkErrors: number | null
  /**
   * The drive's own overall health verdict (`smart_status.passed`).
   *
   * On SAS this is the authoritative failure signal — it carries explicit
   * conditions like "impending failure data error rate too high" — and is the
   * only field that separates a failing drive from a healthy one when defect
   * counts overlap. On ATA it is a vendor-threshold summary that often stays
   * `true` on visibly failing drives, so it is treated as a signal that can
   * condemn a drive but never as proof one is fine. `null` if not reported.
   */
  smartHealthPassed: boolean | null
}

/**
 * The `SmartKeyMetrics` keys holding a number — every metric the numeric
 * threshold/growth rules and the before/after diff table operate on. Keeps
 * those call sites from having to consider `smartHealthPassed`, which is a
 * boolean and graded on its own.
 */
export type NumericSmartMetricKey = {
  [K in keyof SmartKeyMetrics]-?: SmartKeyMetrics[K] extends number | null ? K : never
}[keyof SmartKeyMetrics]

/** Per-attribute flag for the full SMART attribute table (issue #14) — `ok`
 * unless the row itself already looks bad or borderline, independent of any
 * before/after comparison. */
export type SmartAttributeHealth = "ok" | "warn" | "fail"

/** One row of the full SMART attribute set for a single snapshot — the
 * complete table smartctl reported, not just the graded `SmartKeyMetrics`
 * subset. ATA rows come from `ata_smart_attributes.table[]` and populate
 * `id`/`value`/`worst`/`thresh`; NVMe has no such normalized-attribute
 * concept, so an NVMe row only sets `rawValue` (from
 * `nvme_smart_health_information_log`) and leaves the rest `null`. */
export interface SmartAttributeRow {
  /** ATA attribute id (1–255), or `null` for a field with no numeric id (NVMe). */
  id: number | null
  /** Attribute name as smartctl reports it (e.g. "Reallocated_Sector_Ct"), or
   * the NVMe log field name (e.g. "media_errors"). */
  name: string
  /** Normalized current value, ATA only. */
  value: number | null
  /** Worst historical normalized value, ATA only. */
  worst: number | null
  /** Failure threshold for the normalized value, ATA only. */
  thresh: number | null
  /** The underlying raw counter/measurement — what most attributes are actually graded on. */
  rawValue: number | null
  /** smartctl's raw string rendering, when it carries more than the bare number
   * (e.g. a duration like "21000h+02m+00.000s"). `null` when it adds nothing. */
  rawString: string | null
  health: SmartAttributeHealth
}

/**
 * `UNSUPPORTED` is for a drive that cannot run the routine at all — plenty of
 * cheap NVMe controllers don't implement the device self-test command. Kept
 * distinct from `SKIPPED` (we chose not to run it) and from
 * `UNKNOWN`/`ABORTED` (it should have run and didn't), because only those last
 * two leave the drive's health less certain. A drive that never had the feature
 * isn't suspicious for lacking it.
 *
 * `SKIPPED` is not something a drive ever reports — it is the engine's record
 * that it deliberately never started the routine, because the baseline SMART
 * read had already condemned the drive (issue #49). Deliberately distinct from
 * `UNKNOWN`/`ABORTED`, which mean a test that was meant to run didn't finish and
 * therefore leave the drive's health less certain, not more.
 */
export type SelfTestStatus = "PASSED" | "FAILED" | "ABORTED" | "UNKNOWN" | "SKIPPED" | "UNSUPPORTED"

export interface SelfTestResult {
  status: SelfTestStatus
  message?: string
}

export interface SurfaceResult {
  mode: "write" | "read-only"
  badBlocks: number
  completed: boolean
}

export interface Thresholds {
  /** Reallocated sectors up to and including this (and > 0) → WARN; above → FAIL. */
  reallocatedWarnMax: number
  /** Command timeouts up to and including this → no reason raised; above → WARN. */
  commandTimeoutWarnMax: number
  /** SSD/NVMe percentage-used ≥ this → WARN. */
  ssdPercentageUsedWarn: number
  /** SSD/NVMe percentage-used ≥ this → FAIL. */
  ssdPercentageUsedFail: number
}

/**
 * Defaults chosen from Backblaze's published per-attribute failure rates (by way
 * of Scrutiny's dataset) rather than from round numbers, so each one can be
 * justified against an observed failure rate instead of taste:
 *
 * - `reallocatedWarnMax: 4` — a drive with 1–4 reallocated sectors fails at
 *   2.74%/year against a 2.52% baseline for a pristine drive, i.e. it is
 *   statistically indistinguishable from zero. The next band up (4–16) fails at
 *   7.50%, three times baseline. 4 is where the data stops being ambiguous;
 *   anything above it is a real elevation, which for a drive about to be sold on
 *   is disqualifying.
 * - `commandTimeoutWarnMax: 100` — ≤100 timeouts fails at 2.49% (baseline);
 *   above that, 10.0%. The cutoff is deliberately generous because a handful of
 *   timeouts is as often a cable as a drive.
 * - `ssdPercentageUsedWarn/Fail: 80/100` — kept as-is. There is no comparable
 *   fleet data for SSD wear (Backblaze's SSD population is too small, and
 *   Scrutiny marks every wear attribute non-critical with no observed
 *   thresholds), so these stay a manufacturer-endurance reading: 100% means the
 *   drive has reached its own rated write endurance.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  reallocatedWarnMax: 4,
  commandTimeoutWarnMax: 100,
  ssdPercentageUsedWarn: 80,
  ssdPercentageUsedFail: 100,
}

/**
 * Fills in any threshold a persisted config predates. Settings are stored as a
 * JSON blob, so an install created before a threshold existed has an object
 * missing that key — and reading it raw would compare a counter against
 * `undefined`, which is silently false for every drive. Values already stored
 * win: a threshold someone may have tuned is never overwritten by a later change
 * to the default.
 */
export function resolveThresholds(stored: unknown): Thresholds {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_THRESHOLDS }
  }
  const raw = stored as Record<string, unknown>
  const merged = { ...DEFAULT_THRESHOLDS }
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof Thresholds>) {
    const value = raw[key]
    if (typeof value === "number" && Number.isFinite(value)) merged[key] = value
  }
  return merged
}

export interface Reason {
  code: string
  severity: Severity
  message: string
  metric?: string
  before?: number | null
  after?: number | null
}

export interface VerdictInput {
  before: SmartKeyMetrics
  after: SmartKeyMetrics
  deviceType: DriveType
  selfTest: SelfTestResult
  /** `null` when the regime had no surface stage (e.g. read-only skipped). */
  surface: SurfaceResult | null
  thresholds: Thresholds
}

export interface VerdictResult {
  verdict: Verdict
  reasons: Reason[]
}

export interface DiscoveredDrive {
  devicePath: string
  serial: string
  wwn: string | null
  model: string
  sizeBytes: number
  type: DriveType
  transport: Transport
  mounted: boolean
  isSystemDisk: boolean
}

export interface SelfTestProgress {
  running: boolean
  percentRemaining: number | null
  result: SelfTestResult | null
}

export type RegimeMode = "destructive" | "read-only"

export type RunStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "ABORTED"

/** Emitted by TestEngine on every run status transition. */
export interface RunUpdateEvent {
  runId: number
  /** The drive this run belongs to — lets a listener map any event frame to
   * a drive without a round-trip to `GET /api/runs/:id`. */
  driveSerial: string
  status: RunStatus
  currentStage?: StageName
  verdict?: Verdict
}

/** Emitted by TestEngine for in-progress stages (SELFTEST_LONG, SURFACE). */
export interface StageProgressEvent {
  runId: number
  /** The drive this stage belongs to — see `RunUpdateEvent.driveSerial`. */
  driveSerial: string
  stage: StageName
  percent: number
  /** The stage's start time, ISO-8601 — same value as `StageView.startedAt`
   * for the stage row this progress belongs to. Lets a listener (issue #15's
   * ETA estimate) extrapolate a completion time from elapsed time + percent
   * without a separate `GET /api/runs/:id` round-trip. `null` only in the
   * pathological case where the stage row's start time couldn't be resolved. */
  startedAt: string | null
  /** How long the device itself says this stage takes, start to finish, in
   * minutes — same figure as `StageView.declaredTotalMinutes`, carried on the
   * live frame because the dashboard's activity cell has no stage rows to read.
   * `null` for every stage but SELFTEST_LONG, and for a drive that declares
   * nothing. */
  declaredTotalMinutes: number | null
}

/** API-facing view of a drive: DB-known fields plus live discovery state. */
export interface DriveView {
  serial: string
  model: string
  sizeBytes: number
  type: DriveType
  transport: Transport
  present: boolean
  mounted: boolean
  isSystemDisk: boolean
  protected: boolean
  latestRun: {
    id: number
    status: string
    verdict: Verdict | null
    currentStage: string | null
  } | null
}

/** Body for `POST /api/runs`. `confirm` must equal `serial` for a destructive start. */
export interface CreateRunRequest {
  serial: string
  mode: RegimeMode
  confirm?: string
  /**
   * Run every stage even if the baseline SMART read already condemns the drive,
   * overriding the `skipCondemnedDrives` setting for this run only (issue #49).
   * For the operator who wants the destructive pass as a *wipe* on a drive
   * headed for disposal, not as a test.
   *
   * Named for exactly what it forces: it has no bearing on the safety guards
   * (`NO_SERIAL`/`SYSTEM_DISK`/`MOUNTED`/`PROTECTED`), which nothing in the API
   * can override.
   */
  forceFullRegime?: boolean
}

/** API-facing view of persisted settings (`GET`/`PUT /api/settings`). */
export interface SettingsView {
  thresholds: Thresholds
  concurrency: number
  autoModeEnabled: boolean
  protectList: string[]
  /** Stop a run at the verdict when the baseline SMART read already condemns the
   * drive, rather than spending hours to reach the same FAIL (issue #49). */
  skipCondemnedDrives: boolean
}

/** API-facing view of a test run — mirrors the `test_runs` row shape the UI needs.
 * Timestamps are ISO-8601 strings (not `Date`): they cross the wire as JSON, and
 * `JSON.stringify` already turns a `Date` into a string, so declaring `Date` here
 * would lie about what a client actually receives. */
export interface RunView {
  id: number
  driveSerial: string
  mode: RegimeMode
  status: RunStatus
  verdict: Verdict | null
  reasons: Reason[]
  currentStage: StageName | null
  restartCount: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

/** API-facing view of a persisted stage-result row, nested under `GET /api/runs/:id`.
 * Timestamps are ISO-8601 strings for the same wire-honesty reason as `RunView`. */
export interface StageView {
  id: number
  runId: number
  stage: StageName
  status: string
  progress: number
  logPath: string | null
  /** Captured raw tool output for this stage (e.g. badblocks' stdout/stderr
   * and bad-block logfile for SURFACE, the self-test poll trail for
   * SELFTEST_LONG). `null` for a stage that has no captured log — either
   * one wasn't recorded for that stage kind, or it hasn't finished yet. */
  log: string | null
  metrics: unknown
  /**
   * How long the device itself says this stage takes, start to finish, in
   * minutes — for SELFTEST_LONG, the drive's recommended polling time for the
   * extended routine (`ata_smart_data.self_test.polling_minutes.extended`),
   * taken from the run's baseline SMART capture. `null` for every other stage,
   * and for a drive that doesn't report one (SAS/SCSI and NVMe declare
   * self-test duration differently, if at all).
   *
   * Exists because a remaining-time estimate cannot be extrapolated from this
   * stage's progress (issue #61): ATA drives report their remaining percentage
   * in 10% steps and jump to "90% remaining" within seconds of starting, so
   * elapsed-over-percent claimed "~6m left" for a 97-minute routine. Where the
   * device declares a duration, the UI subtracts progress from it instead.
   */
  declaredTotalMinutes: number | null
  startedAt: string | null
  finishedAt: string | null
}
