import { describe, it, expect, beforeEach } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { createDb, type Db } from "./client"
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
    repo.saveSnapshot(db, { runId, phase: "before", raw: { ok: true }, keyMetrics: { reallocatedSectors: 0 } as any })
    repo.updateRun(db, runId, { status: "DONE", verdict: "PASS" })
    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("DONE")
    expect(run.verdict).toBe("PASS")
    expect(repo.listRuns(db, { driveSerial: "SER123" })).toHaveLength(1)
  })

  it("appends and lists audit entries", () => {
    repo.appendAudit(db, { action: "DESTRUCTIVE_START", driveSerial: "SER123", detail: "manual" })
    const rows = repo.listAudit(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "DESTRUCTIVE_START", driveSerial: "SER123", detail: "manual" })
  })
})
