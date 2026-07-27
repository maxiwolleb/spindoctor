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

export type SelfTestStatus = "PASSED" | "FAILED" | "ABORTED" | "UNKNOWN"

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
  /** SSD/NVMe percentage-used ≥ this → WARN. */
  ssdPercentageUsedWarn: number
  /** SSD/NVMe percentage-used ≥ this → FAIL. */
  ssdPercentageUsedFail: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  reallocatedWarnMax: 10,
  ssdPercentageUsedWarn: 80,
  ssdPercentageUsedFail: 100,
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
}

/** API-facing view of persisted settings (`GET`/`PUT /api/settings`). */
export interface SettingsView {
  thresholds: Thresholds
  concurrency: number
  autoModeEnabled: boolean
  protectList: string[]
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
  startedAt: string | null
  finishedAt: string | null
}
