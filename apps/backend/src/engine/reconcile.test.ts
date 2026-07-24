import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import type { DiscoveredDrive, RunUpdateEvent, SelfTestResult } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import { stageResults } from "../db/schema"
import * as repo from "../db/repositories"
import { FakeDeviceApi } from "../device/fakeDeviceApi"
import { parseSmartMetrics } from "../device/smartParser"
import { regimeStages } from "./regime"
import { TestEngine } from "./engine"

const drive = (over: Partial<DiscoveredDrive> = {}): DiscoveredDrive => ({
  devicePath: "/dev/sda",
  serial: "SER1",
  wwn: null,
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
  ...over,
})

const smartRaw = (over: Record<string, unknown> = {}): unknown => ({
  ata_smart_attributes: { table: [] },
  temperature: {},
  ...over,
})

const PASSED_SELFTEST_RESULT: SelfTestResult = { status: "PASSED" }

function isTerminal(status: string): boolean {
  return status === "DONE" || status === "FAILED" || status === "ABORTED"
}

/** Resolves with the first terminal run:update event for the given runId. */
function waitForSettled(engine: TestEngine, runId: number): Promise<RunUpdateEvent> {
  return new Promise((resolve) => {
    const handler = (evt: RunUpdateEvent) => {
      if (evt.runId === runId && isTerminal(evt.status)) {
        engine.off("run:update", handler)
        resolve(evt)
      }
    }
    engine.on("run:update", handler)
  })
}

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

/** Seeds a run with driveSerial/regime and marks it non-terminal (RUNNING). */
function seedRunningRun(mode: "destructive" | "read-only", driveSerial: string): number {
  const runId = repo.createRun(db, {
    driveSerial,
    regime: { mode, stages: regimeStages(mode).map((s) => s.stage) },
  })
  repo.updateRun(db, runId, { status: "RUNNING" })
  return runId
}

/** Seeds a DONE SMART_BEFORE stage + its snapshot. */
function seedSmartBefore(runId: number): void {
  repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
  repo.saveSnapshot(db, { runId, phase: "before", raw: smartRaw(), keyMetrics: parseSmartMetrics(smartRaw()) })
}

/** Seeds a DONE SELFTEST_LONG stage row, with its result persisted to `metrics`. */
function seedSelfTestDone(runId: number): void {
  const id = repo.addStage(db, { runId, stage: "SELFTEST_LONG", status: "DONE" })
  repo.updateStage(db, id, { metrics: PASSED_SELFTEST_RESULT })
}

describe("TestEngine.reconcile", () => {
  it("restarts an interrupted SURFACE stage from scratch, marks the old row INTERRUPTED, increments restartCount, and the run completes", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = seedRunningRun("destructive", d.serial)
    seedSmartBefore(runId)
    seedSelfTestDone(runId)
    const staleSurfaceId = repo.addStage(db, { runId, stage: "SURFACE", status: "RUNNING" })

    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const settled = waitForSettled(engine, runId)
    await engine.reconcile()
    const terminal = await settled

    expect(terminal.status).toBe("DONE")
    expect(api.surfaceCalls).toEqual([{ devicePath: d.devicePath, mode: "destructive" }])

    const run = repo.getRun(db, runId)!
    expect(run.restartCount).toBe(1)
    expect(run.status).toBe("DONE")

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    const staleRow = stages.find((s) => s.id === staleSurfaceId)
    expect(staleRow?.status).toBe("INTERRUPTED")

    const surfaceRows = stages.filter((s) => s.stage === "SURFACE")
    expect(surfaceRows).toHaveLength(2)
    expect(surfaceRows.find((s) => s.id !== staleSurfaceId)?.status).toBe("DONE")
  })

  it("resumes an interrupted SELFTEST_LONG by polling only, without calling startLongSelfTest again", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = seedRunningRun("destructive", d.serial)
    seedSmartBefore(runId)
    const staleSelfTestId = repo.addStage(db, { runId, stage: "SELFTEST_LONG", status: "RUNNING" })

    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: { running: false, percentRemaining: 0, result: PASSED_SELFTEST_RESULT } },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    expect(api.started).toEqual([])

    const settled = waitForSettled(engine, runId)
    await engine.reconcile()
    const terminal = await settled

    expect(terminal.status).toBe("DONE")
    // The firmware self-test kept running across the restart — reconcile
    // must not have called startLongSelfTest a second time.
    expect(api.started).toEqual([])
    expect(api.surfaceCalls).toEqual([{ devicePath: d.devicePath, mode: "destructive" }])

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    const selfTestRows = stages.filter((s) => s.stage === "SELFTEST_LONG")
    // Resumed by polling reuses the existing row rather than inserting a new one.
    expect(selfTestRows).toHaveLength(1)
    expect(selfTestRows[0]?.id).toBe(staleSelfTestId)
    expect(selfTestRows[0]?.status).toBe("DONE")
  })

  it("fails a run with TOO_MANY_RESTARTS instead of restarting SURFACE again once restartCount hits the cap", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = seedRunningRun("destructive", d.serial)
    seedSmartBefore(runId)
    seedSelfTestDone(runId)
    const staleSurfaceId = repo.addStage(db, { runId, stage: "SURFACE", status: "RUNNING" })
    repo.updateRun(db, runId, { restartCount: 3 })

    const api = new FakeDeviceApi({ drives: [d] })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const settled = waitForSettled(engine, runId)
    await engine.reconcile()
    const terminal = await settled

    expect(terminal.status).toBe("FAILED")
    expect(api.surfaceCalls).toEqual([])

    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("FAILED")
    expect(run.error).toBe("TOO_MANY_RESTARTS")
    expect(run.restartCount).toBe(3)

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages.find((s) => s.id === staleSurfaceId)?.status).toBe("RUNNING")
  })

  it("fails a run with DRIVE_GONE when the drive can no longer be found by serial", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = seedRunningRun("destructive", d.serial)

    const api = new FakeDeviceApi({ drives: [] })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const settled = waitForSettled(engine, runId)
    await engine.reconcile()
    const terminal = await settled

    expect(terminal.status).toBe("FAILED")
    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("FAILED")
    expect(run.error).toBe("DRIVE_GONE")
    expect(api.surfaceCalls).toEqual([])
    expect(api.started).toEqual([])
  })

  it("leaves an already-terminal (DONE) run untouched", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = repo.createRun(db, {
      driveSerial: d.serial,
      regime: { mode: "destructive", stages: regimeStages("destructive").map((s) => s.stage) },
    })
    repo.updateRun(db, runId, { status: "DONE", verdict: "PASS", reasons: [], finishedAt: new Date() })
    const before = repo.getRun(db, runId)!

    const api = new FakeDeviceApi({ drives: [d] })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const events: RunUpdateEvent[] = []
    engine.on("run:update", (evt: RunUpdateEvent) => events.push(evt))

    await engine.reconcile()
    // Give any (incorrect) fire-and-forget re-execution a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toHaveLength(0)
    expect(api.surfaceCalls).toEqual([])
    expect(api.started).toEqual([])

    const after = repo.getRun(db, runId)!
    expect(after).toEqual(before)
  })
})
