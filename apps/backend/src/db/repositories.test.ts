import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { createDb, type Db } from "./client"
import { auditLog, stageResults } from "./schema"
import * as repo from "./repositories"

const drive = (over: Partial<DiscoveredDrive> = {}): DiscoveredDrive => ({
  devicePath: "/dev/sda",
  serial: "SER123",
  wwn: "0xabc",
  model: "WDC WD40EFRX",
  sizeBytes: 4000787030016,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
  ...over,
})

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
})

describe("config", () => {
  it("seeds defaults once and is idempotent", () => {
    repo.ensureConfig(db)
    repo.ensureConfig(db)
    const c = repo.getConfig(db)
    expect(c.id).toBe(1)
    expect(c.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(c.concurrency).toBe(4)
    expect(c.autoModeEnabled).toBe(false)
    expect(c.protectList).toEqual([])
  })
  it("updates a subset of fields", () => {
    repo.ensureConfig(db)
    const c = repo.updateConfig(db, { concurrency: 2, autoModeEnabled: true, protectList: ["X"] })
    expect(c.concurrency).toBe(2)
    expect(c.autoModeEnabled).toBe(true)
    expect(c.protectList).toEqual(["X"])
    expect(c.thresholds).toEqual(DEFAULT_THRESHOLDS)
  })
  it("no-ops on an empty patch instead of throwing", () => {
    repo.ensureConfig(db)
    const before = repo.getConfig(db)
    expect(() => repo.updateConfig(db, {})).not.toThrow()
    const after = repo.updateConfig(db, {})
    expect(after).toEqual(before)
  })
})

describe("drives", () => {
  it("inserts then upserts preserving firstSeen and protected flag", () => {
    repo.upsertDrive(db, drive())
    repo.setProtected(db, "SER123", true)
    const first = repo.getDrive(db, "SER123")!
    repo.upsertDrive(db, drive({ model: "WDC WD40EFRX (renamed)", sizeBytes: 123 }))
    const second = repo.getDrive(db, "SER123")!
    expect(second.model).toBe("WDC WD40EFRX (renamed)")
    expect(second.sizeBytes).toBe(123)
    expect(second.protectedFlag).toBe(true)
    expect(second.firstSeen.getTime()).toBe(first.firstSeen.getTime())
    expect(second.lastSeen.getTime()).toBeGreaterThanOrEqual(first.lastSeen.getTime())
    expect(repo.listDrives(db)).toHaveLength(1)
  })
})

describe("runs / stages / snapshots / audit", () => {
  beforeEach(() => repo.upsertDrive(db, drive()))

  it("round-trips a run with stages and snapshots", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    expect(repo.getRun(db, runId)!.status).toBe("PENDING")
    const stageId = repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "RUNNING" })
    repo.updateStage(db, stageId, { status: "DONE", progress: 100 })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { ok: true },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })
    repo.updateRun(db, runId, { status: "DONE", verdict: "PASS" })
    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("DONE")
    expect(run.verdict).toBe("PASS")
    expect(repo.listRuns(db, { driveSerial: "SER123" })).toHaveLength(1)
  })

  it("getSnapshots returns before/after key metrics keyed by phase, null for a phase not yet captured", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    expect(repo.getSnapshots(db, runId)).toEqual({ before: null, after: null })

    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { ok: true },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })
    expect(repo.getSnapshots(db, runId)).toEqual({ before: { reallocatedSectors: 0 }, after: null })

    repo.saveSnapshot(db, {
      runId,
      phase: "after",
      raw: { ok: true },
      keyMetrics: { reallocatedSectors: 5 } as any,
    })
    expect(repo.getSnapshots(db, runId)).toEqual({
      before: { reallocatedSectors: 0 },
      after: { reallocatedSectors: 5 },
    })
  })

  it("getSnapshots returns the latest row per phase when a crash + reconcile() re-captured it (no unique(run_id, phase) constraint)", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })

    // Pre-crash capture.
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { ok: true, pass: 1 },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })
    // reconcile() re-runs SMART_BEFORE after the crash and saves a second
    // "before" snapshot for the same run with different metrics.
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { ok: true, pass: 2 },
      keyMetrics: { reallocatedSectors: 3 } as any,
    })

    expect(repo.getSnapshots(db, runId)).toEqual({
      before: { reallocatedSectors: 3 },
      after: null,
    })
  })

  it("getSnapshotRaws returns before/after raw JSON keyed by phase, null for a phase not yet captured", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    expect(repo.getSnapshotRaws(db, runId)).toEqual({ before: null, after: null })

    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { ata_smart_attributes: { table: [] } },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })
    expect(repo.getSnapshotRaws(db, runId)).toEqual({
      before: { ata_smart_attributes: { table: [] } },
      after: null,
    })
  })

  it("getSnapshotRaws returns the latest row per phase, mirroring getSnapshots", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { pass: 1 },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { pass: 2 },
      keyMetrics: { reallocatedSectors: 3 } as any,
    })

    expect(repo.getSnapshotRaws(db, runId)).toEqual({ before: { pass: 2 }, after: null })
  })

  it("appends and lists audit entries", () => {
    repo.appendAudit(db, { action: "DESTRUCTIVE_START", driveSerial: "SER123", detail: "manual" })
    const rows = repo.listAudit(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: "DESTRUCTIVE_START",
      driveSerial: "SER123",
      detail: "manual",
    })
  })

  it("round-trips a stage's captured log via updateStage (#13)", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    const stageId = repo.addStage(db, { runId, stage: "SURFACE", status: "RUNNING" })
    expect(repo.getRun(db, runId)).toBeDefined()

    let stage = db.select().from(stageResults).where(eq(stageResults.id, stageId)).get()
    expect(stage?.log).toBeNull()

    repo.updateStage(db, stageId, {
      status: "DONE",
      log: "=== badblocks stdout ===\n(empty)\n\n=== bad-block logfile ===\n12345",
    })

    stage = db.select().from(stageResults).where(eq(stageResults.id, stageId)).get()
    expect(stage?.log).toContain("=== badblocks stdout ===")
    expect(stage?.log).toContain("12345")
  })

  it("no-ops on empty patches for updateRun and updateStage instead of throwing", () => {
    const runId = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    const stageId = repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "RUNNING" })
    expect(() => repo.updateRun(db, runId, {})).not.toThrow()
    expect(() => repo.updateStage(db, stageId, {})).not.toThrow()
    expect(repo.getRun(db, runId)!.status).toBe("PENDING")
  })

  it("lists runs newest-first by id regardless of insertion/filter path (Fix 4)", () => {
    const a = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    const b = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })
    const c = repo.createRun(db, { driveSerial: "SER123", regime: ["SMART_BEFORE", "VERDICT"] })

    expect(repo.listRuns(db).map((r) => r.id)).toEqual([c, b, a])
    expect(repo.listRuns(db, { driveSerial: "SER123" }).map((r) => r.id)).toEqual([c, b, a])
  })
})

describe("audit ordering", () => {
  let auditDb: Db
  beforeEach(() => {
    auditDb = createDb(":memory:").db
  })

  it("breaks same-timestamp ties by id descending (newest insert first)", () => {
    const t = new Date(1_000_000)
    auditDb.insert(auditLog).values({ ts: t, action: "A", driveSerial: null, detail: null }).run()
    auditDb.insert(auditLog).values({ ts: t, action: "B", driveSerial: null, detail: null }).run()
    const rows = repo.listAudit(auditDb)
    expect(rows.map((r) => r.action)).toEqual(["B", "A"])
  })
})

// #14 follow-up: the SMART-derived type correction was being undone by the very
// next discovery. `GET /api/drives` upserts every device it sees, so a bridged
// NVMe reverted to lsblk's "HDD" within seconds of a run correcting it.
describe("upsertDrive vs setDriveType", () => {
  const bridged: DiscoveredDrive = {
    devicePath: "/dev/sdb",
    serial: "MLK136D003912",
    wwn: null,
    model: "E2M2 64GB",
    sizeBytes: 61_900_000_000,
    // What lsblk reports for a USB-NVMe bridge: rotational, hence HDD.
    type: "HDD",
    transport: "USB",
    mounted: false,
    isSystemDisk: false,
  }

  it("keeps a SMART-corrected type across later discoveries", () => {
    repo.upsertDrive(db, bridged)
    expect(repo.getDrive(db, bridged.serial)?.type).toBe("HDD")

    repo.setDriveType(db, bridged.serial, "NVMe")
    expect(repo.getDrive(db, bridged.serial)?.type).toBe("NVMe")

    // The dashboard re-discovers constantly; this must not undo the correction.
    repo.upsertDrive(db, bridged)
    repo.upsertDrive(db, bridged)
    expect(repo.getDrive(db, bridged.serial)?.type).toBe("NVMe")
  })

  it("still refreshes the fields discovery is authoritative for", () => {
    repo.upsertDrive(db, bridged)
    repo.setDriveType(db, bridged.serial, "NVMe")

    repo.upsertDrive(db, { ...bridged, model: "E2M2 64GB v2", sizeBytes: 62_000_000_000 })
    const row = repo.getDrive(db, bridged.serial)
    expect(row?.model).toBe("E2M2 64GB v2")
    expect(row?.sizeBytes).toBe(62_000_000_000)
    expect(row?.type).toBe("NVMe")
  })

  it("records the discovery-time type for a drive seen for the first time", () => {
    repo.upsertDrive(db, { ...bridged, serial: "NEW1" })
    expect(repo.getDrive(db, "NEW1")?.type).toBe("HDD")
  })
})
