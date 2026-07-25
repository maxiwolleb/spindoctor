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
