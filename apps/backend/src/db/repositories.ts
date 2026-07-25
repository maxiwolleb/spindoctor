import { eq, desc } from "drizzle-orm"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type {
  Thresholds,
  SmartKeyMetrics,
  Verdict,
  Reason,
  StageName,
  DiscoveredDrive,
} from "@spindoctor/shared"
import type { Db } from "./client"
import { config, drives, testRuns, stageResults, smartSnapshots, auditLog } from "./schema"

export type ConfigRow = typeof config.$inferSelect
export type DriveRow = typeof drives.$inferSelect
export type RunRow = typeof testRuns.$inferSelect
export type StageRow = typeof stageResults.$inferSelect
export type SnapshotRow = typeof smartSnapshots.$inferSelect
export type AuditRow = typeof auditLog.$inferSelect

export interface ConfigUpdate {
  thresholds: Thresholds
  concurrency: number
  autoModeEnabled: boolean
  protectList: string[]
}

// ---- config ----

export function ensureConfig(db: Db): void {
  const existing = db.select().from(config).where(eq(config.id, 1)).get()
  if (existing) return
  db.insert(config)
    .values({
      id: 1,
      thresholds: DEFAULT_THRESHOLDS,
      concurrency: 4,
      autoModeEnabled: false,
      protectList: [],
    })
    .run()
}

export function getConfig(db: Db): ConfigRow {
  const row = db.select().from(config).where(eq(config.id, 1)).get()
  if (!row) throw new Error("config not seeded — call ensureConfig(db) first")
  return row
}

export function updateConfig(db: Db, patch: Partial<ConfigUpdate>): ConfigRow {
  if (Object.keys(patch).length === 0) return getConfig(db)
  db.update(config).set(patch).where(eq(config.id, 1)).run()
  return getConfig(db)
}

// ---- drives ----

export function upsertDrive(db: Db, d: DiscoveredDrive): void {
  const now = new Date()
  db.insert(drives)
    .values({
      serial: d.serial,
      wwn: d.wwn,
      model: d.model,
      sizeBytes: d.sizeBytes,
      type: d.type,
      transport: d.transport,
      firstSeen: now,
      lastSeen: now,
      protectedFlag: false,
    })
    .onConflictDoUpdate({
      target: drives.serial,
      set: {
        model: d.model,
        sizeBytes: d.sizeBytes,
        type: d.type,
        transport: d.transport,
        wwn: d.wwn,
        lastSeen: now,
      },
    })
    .run()
}

export function getDrive(db: Db, serial: string): DriveRow | undefined {
  return db.select().from(drives).where(eq(drives.serial, serial)).get()
}

export function listDrives(db: Db): DriveRow[] {
  return db.select().from(drives).all()
}

export function setProtected(db: Db, serial: string, value: boolean): void {
  db.update(drives).set({ protectedFlag: value }).where(eq(drives.serial, serial)).run()
}

// ---- runs ----

export function createRun(db: Db, input: { driveSerial: string; regime: unknown }): number {
  const result = db
    .insert(testRuns)
    .values({
      driveSerial: input.driveSerial,
      regime: input.regime,
      status: "PENDING",
      createdAt: new Date(),
    })
    .run()
  return Number(result.lastInsertRowid)
}

export function getRun(db: Db, id: number): RunRow | undefined {
  return db.select().from(testRuns).where(eq(testRuns.id, id)).get()
}

/** Newest-first (by id) so `GET /api/runs` and any run-history list is stable
 * across calls instead of relying on unspecified SQLite row order. */
export function listRuns(db: Db, opts?: { driveSerial?: string }): RunRow[] {
  if (opts?.driveSerial !== undefined) {
    return db
      .select()
      .from(testRuns)
      .where(eq(testRuns.driveSerial, opts.driveSerial))
      .orderBy(desc(testRuns.id))
      .all()
  }
  return db.select().from(testRuns).orderBy(desc(testRuns.id)).all()
}

export interface RunUpdate {
  status: string
  verdict: Verdict
  reasons: Reason[]
  currentStage: string
  restartCount: number
  error: string
  startedAt: Date
  finishedAt: Date
}

export function updateRun(db: Db, id: number, patch: Partial<RunUpdate>): void {
  if (Object.keys(patch).length === 0) return
  db.update(testRuns).set(patch).where(eq(testRuns.id, id)).run()
}

// ---- stages ----

export function addStage(
  db: Db,
  input: { runId: number; stage: StageName; status: string },
): number {
  const result = db
    .insert(stageResults)
    .values({
      runId: input.runId,
      stage: input.stage,
      status: input.status,
      // A stage row is created exactly when the stage begins running, so its
      // creation time is its start time. The reconcile-resume path reuses the
      // existing row instead of calling addStage, so a resumed SELFTEST_LONG
      // keeps its original startedAt.
      startedAt: new Date(),
    })
    .run()
  return Number(result.lastInsertRowid)
}

export interface StageUpdate {
  status: string
  progress: number
  logPath: string
  /** Captured raw tool output for this stage (badblocks stdout/stderr +
   * bad-block logfile for SURFACE, the self-test poll trail for
   * SELFTEST_LONG). Left unset for stage kinds that don't capture one. */
  log: string
  metrics: unknown
  startedAt: Date
  finishedAt: Date
}

export function updateStage(db: Db, id: number, patch: Partial<StageUpdate>): void {
  if (Object.keys(patch).length === 0) return
  db.update(stageResults).set(patch).where(eq(stageResults.id, id)).run()
}

// ---- smart snapshots ----

export function saveSnapshot(
  db: Db,
  input: { runId: number; phase: "before" | "after"; raw: unknown; keyMetrics: SmartKeyMetrics },
): void {
  db.insert(smartSnapshots)
    .values({
      runId: input.runId,
      phase: input.phase,
      raw: input.raw,
      keyMetrics: input.keyMetrics,
      capturedAt: new Date(),
    })
    .run()
}

/** All snapshot rows for a run, newest-first (mirrors
 * `TestEngine#loadSnapshot`'s `.orderBy(desc(smartSnapshots.id))`) — shared by
 * `getSnapshots` and `getSnapshotRaws` so both pick the same latest row per
 * phase off a single query. */
function snapshotRowsForRun(db: Db, runId: number): SnapshotRow[] {
  return db
    .select()
    .from(smartSnapshots)
    .where(eq(smartSnapshots.runId, runId))
    .orderBy(desc(smartSnapshots.id))
    .all()
}

/** The before/after key-metrics pair for a run, keyed by `phase` — `null` for
 * whichever phase hasn't been captured yet (e.g. a run still on
 * `SMART_BEFORE`, or a read-only regime that skips one side). Drive detail's
 * SMART diff view is the only current consumer.
 *
 * A run can accumulate more than one snapshot per phase (no unique(run_id,
 * phase) constraint) — e.g. a crash + `reconcile()` re-runs SMART_BEFORE/
 * SMART_AFTER and `saveSnapshot` is called again. `.find()` on the
 * newest-first rows picks the latest row per phase instead of a stale
 * pre-crash one. */
export function getSnapshots(
  db: Db,
  runId: number,
): { before: SmartKeyMetrics | null; after: SmartKeyMetrics | null } {
  const rows = snapshotRowsForRun(db, runId)
  const before = rows.find((r) => r.phase === "before")
  const after = rows.find((r) => r.phase === "after")
  return {
    before: (before?.keyMetrics as SmartKeyMetrics | undefined) ?? null,
    after: (after?.keyMetrics as SmartKeyMetrics | undefined) ?? null,
  }
}

/** The before/after *raw* smartctl JSON for a run, keyed by `phase` — same
 * latest-row-per-phase selection as `getSnapshots`, but for consumers that
 * need the unparsed payload: the full-attribute-table view and the raw-SMART
 * download route (issue #14). */
export function getSnapshotRaws(
  db: Db,
  runId: number,
): { before: unknown | null; after: unknown | null } {
  const rows = snapshotRowsForRun(db, runId)
  const before = rows.find((r) => r.phase === "before")
  const after = rows.find((r) => r.phase === "after")
  return { before: before?.raw ?? null, after: after?.raw ?? null }
}

// ---- audit ----

export function appendAudit(
  db: Db,
  input: { action: string; driveSerial?: string; detail?: string },
): void {
  db.insert(auditLog)
    .values({
      ts: new Date(),
      action: input.action,
      driveSerial: input.driveSerial,
      detail: input.detail,
    })
    .run()
}

export function listAudit(db: Db): AuditRow[] {
  return db.select().from(auditLog).orderBy(desc(auditLog.ts), desc(auditLog.id)).all()
}
