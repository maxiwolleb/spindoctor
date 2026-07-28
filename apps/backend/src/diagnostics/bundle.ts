import { createHash, randomBytes } from "node:crypto"
import { gzipSync } from "node:zlib"
import type { DriveType, Reason, Thresholds, Verdict } from "@spindoctor/shared"
import { resolveThresholds } from "@spindoctor/shared"
import type { Db } from "../db/client"
import {
  getConfig,
  getSnapshotRaws,
  listAudit,
  listDrives,
  listRuns,
  updateConfig,
} from "../db/repositories"
import { stageResults } from "../db/schema"
import { eq } from "drizzle-orm"
import { analyzeGaps, type GapInput, type GapReport } from "./gaps"
import type { RunEnvironment } from "./environment"

/** Bumped whenever the shape below changes, so a reader knows what it is holding. */
export const BUNDLE_SCHEMA_VERSION = 1

/**
 * Stage logs are the only unbounded input here — one badblocks log reached
 * 3.87 MB before issue #38, half of it backspace characters. Capped, and every
 * cut recorded in `truncations` so a reader knows what was withheld instead of
 * quietly receiving a partial log.
 */
const MAX_LOG_BYTES = 64 * 1024

export interface DiagnosticsBundle {
  schemaVersion: number
  generatedAt: string
  /** Per-instance pseudonym, so bundles from one instance can be recognized as
   * related without naming the machine. Derived from the same salt as the drive
   * refs, which is never itself exported. */
  instanceRef: string
  serialsPseudonymized: boolean
  environment: RunEnvironment & { spindoctorVersion: string | null }
  config: {
    thresholds: Thresholds
    concurrency: number
    autoModeEnabled: boolean
    skipCondemnedDrives: boolean
  }
  drives: BundleDrive[]
  runs: BundleRun[]
  smart: Record<string, { before: unknown; after: unknown | null }>
  audit: BundleAudit[]
  gaps: GapReport
  truncations: Truncation[]
}

export interface BundleDrive {
  driveRef: string
  model: string
  sizeBytes: number
  /** What the drive row records — corrected from SMART where they disagreed. */
  type: DriveType
  transport: string
  firstSeen: string | null
  lastSeen: string | null
}

export interface BundleRun {
  id: number
  driveRef: string
  mode: string
  status: string
  verdict: Verdict | null
  reasons: Reason[]
  restartCount: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  stages: BundleStage[]
}

export interface BundleStage {
  stage: string
  status: string
  progress: number
  startedAt: string | null
  finishedAt: string | null
  metrics: unknown
  log: string | null
}

export interface BundleAudit {
  ts: string
  action: string
  driveRef: string | null
  detail: string | null
}

export interface Truncation {
  what: string
  originalBytes: number
}

/**
 * Returns the instance's pseudonymization salt, generating and persisting one on
 * first use.
 *
 * The salt is deliberately never exported. Without it a `driveRef` cannot be
 * walked back to a serial even by someone holding the whole bundle and a list of
 * candidate serials, and two instances that test the same physical drive produce
 * unrelated refs — so bundles cannot be joined into a fleet-wide inventory by a
 * third party.
 */
export function ensureDiagnosticsSalt(db: Db): string {
  const existing = getConfig(db).diagnosticsSalt
  if (existing) return existing
  const salt = randomBytes(32).toString("hex")
  updateConfig(db, { diagnosticsSalt: salt })
  return salt
}

/** Stable within an instance, irreversible without the salt, and short enough to
 * read in a report. */
function pseudonym(salt: string, value: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 12)
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

function capLog(log: string | null, what: string, truncations: Truncation[]): string | null {
  if (log == null) return null
  const bytes = Buffer.byteLength(log, "utf8")
  if (bytes <= MAX_LOG_BYTES) return log
  truncations.push({ what, originalBytes: bytes })
  return `${log.slice(0, MAX_LOG_BYTES)}\n[truncated: ${bytes} bytes originally]`
}

export interface BuildBundleOptions {
  db: Db
  environment: RunEnvironment
  spindoctorVersion?: string | null
  /** Overridden only by tests that need a fixed timestamp. */
  now?: Date
}

/**
 * Assembles everything an offline reader needs to audit spindoctor's own
 * judgement: the raw payloads it graded, the verdicts it reached, the environment
 * it ran in, and a report of what it could not explain.
 *
 * `config.protectList` is excluded outright — it is a list of drive serials, and
 * nothing in the analysis needs it.
 */
export function buildBundle(opts: BuildBundleOptions): DiagnosticsBundle {
  const { db, environment } = opts
  const cfg = getConfig(db)
  const pseudonymize = !cfg.diagnosticsIncludeSerials
  const salt = ensureDiagnosticsSalt(db)
  const ref = (serial: string): string => (pseudonymize ? pseudonym(salt, serial) : serial)

  const truncations: Truncation[] = []
  const driveRows = listDrives(db)
  const byModel = new Map(driveRows.map((d) => [d.serial, d]))

  const runs: BundleRun[] = []
  const smart: DiagnosticsBundle["smart"] = {}
  const gapInputs: GapInput[] = []

  for (const run of listRuns(db)) {
    const stages = db
      .select()
      .from(stageResults)
      .where(eq(stageResults.runId, run.id))
      .orderBy(stageResults.id)
      .all()

    runs.push({
      id: run.id,
      driveRef: ref(run.driveSerial),
      mode: (run.regime as { mode?: string }).mode ?? "unknown",
      status: run.status,
      verdict: run.verdict as Verdict | null,
      reasons: (run.reasons ?? []) as Reason[],
      restartCount: run.restartCount,
      error: run.error,
      startedAt: iso(run.startedAt),
      finishedAt: iso(run.finishedAt),
      stages: stages.map((s) => ({
        stage: s.stage,
        status: s.status,
        progress: s.progress,
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        metrics: s.metrics,
        log: capLog(s.log, `run ${run.id} stage ${s.stage} log`, truncations),
      })),
    })

    const raws = getSnapshotRaws(db, run.id)
    smart[String(run.id)] = { before: raws.before ?? null, after: raws.after ?? null }

    const drive = byModel.get(run.driveSerial)
    if (raws.before != null && drive) {
      gapInputs.push({
        runId: run.id,
        driveRef: ref(run.driveSerial),
        model: drive.model,
        transport: drive.transport,
        discoveredType: drive.type as DriveType,
        verdict: run.verdict as Verdict | null,
        reasons: (run.reasons ?? []) as Reason[],
        before: raws.before,
        after: raws.after ?? null,
      })
    }
  }

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    instanceRef: pseudonym(salt, "instance"),
    serialsPseudonymized: pseudonymize,
    environment: { ...environment, spindoctorVersion: opts.spindoctorVersion ?? null },
    config: {
      thresholds: resolveThresholds(cfg.thresholds),
      concurrency: cfg.concurrency,
      autoModeEnabled: cfg.autoModeEnabled,
      skipCondemnedDrives: cfg.skipCondemnedDrives,
    },
    drives: driveRows.map((d) => ({
      driveRef: ref(d.serial),
      model: d.model,
      sizeBytes: d.sizeBytes,
      type: d.type as DriveType,
      transport: d.transport,
      firstSeen: iso(d.firstSeen),
      lastSeen: iso(d.lastSeen),
    })),
    runs,
    smart,
    audit: listAudit(db).map((a) => ({
      ts: a.ts.toISOString(),
      action: a.action,
      driveRef: a.driveSerial ? ref(a.driveSerial) : null,
      detail: a.detail,
    })),
    gaps: analyzeGaps(gapInputs, resolveThresholds(cfg.thresholds)),
    truncations,
  }
}

/** The bundle as a gzipped JSON payload, which is what the route serves. */
export function serializeBundle(bundle: DiagnosticsBundle): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(bundle, null, 2), "utf8"))
}
