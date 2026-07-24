import { describe, it, expect, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import type { DiscoveredDrive, RunUpdateEvent, SelfTestProgress } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import { stageResults, smartSnapshots } from "../db/schema"
import * as repo from "../db/repositories"
import { FakeDeviceApi, type FakeDeviceApiState } from "../device/fakeDeviceApi"
import { TestEngine, SafetyError, DriveNotFoundError } from "./engine"

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

const PASSED_SELFTEST: SelfTestProgress = { running: false, percentRemaining: 0, result: { status: "PASSED" } }

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

/** FakeDeviceApi variant whose pollSelfTest returns a scripted sequence across calls. */
class SequencedSelfTestApi extends FakeDeviceApi {
  private calls = 0
  constructor(
    state: FakeDeviceApiState,
    private readonly sequence: SelfTestProgress[],
  ) {
    super(state)
  }

  override async pollSelfTest(_devicePath: string): Promise<SelfTestProgress> {
    const idx = Math.min(this.calls, this.sequence.length - 1)
    this.calls++
    const step = this.sequence[idx]
    if (!step) throw new Error("no scripted self-test step")
    return step
  }
}

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

describe("TestEngine.startRun", () => {
  it("throws DriveNotFoundError when the serial matches no discovered drive", async () => {
    const engine = new TestEngine({ db, deviceApi: new FakeDeviceApi({ drives: [] }) })
    await expect(engine.startRun({ serial: "NOPE", mode: "read-only" })).rejects.toThrow(DriveNotFoundError)
  })

  it("denies a destructive start on a mounted drive, creating no run but an audit row", async () => {
    const d = drive({ mounted: true })
    const engine = new TestEngine({ db, deviceApi: new FakeDeviceApi({ drives: [d] }) })

    let caught: unknown
    try {
      await engine.startRun({ serial: d.serial, mode: "destructive" })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(SafetyError)
    expect((caught as SafetyError).code).toBe("MOUNTED")
    expect(repo.listRuns(db)).toHaveLength(0)
    const audit = repo.listAudit(db)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: "DESTRUCTIVE_DENIED", driveSerial: d.serial, detail: "MOUNTED" })
  })
})

describe("TestEngine full-run behavior", () => {
  it("runs a clean destructive regime to completion with a PASS verdict", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const events: RunUpdateEvent[] = []
    engine.on("run:update", (evt: RunUpdateEvent) => events.push(evt))

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(terminal.verdict).toBe("PASS")

    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("DONE")
    expect(run.verdict).toBe("PASS")

    const snapshots = db.select().from(smartSnapshots).where(eq(smartSnapshots.runId, runId)).all()
    expect(snapshots.map((s) => s.phase).sort()).toEqual(["after", "before"])

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages).toHaveLength(5)
    expect(stages.every((s) => s.status === "DONE")).toBe(true)

    expect(events.some((e) => e.status === "DONE")).toBe(true)
  })

  it("produces a FAIL verdict with a BADBLOCKS reason when the surface test finds bad blocks", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 2, completed: true } },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(terminal.verdict).toBe("FAIL")

    const run = repo.getRun(db, runId)!
    expect(run.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "BADBLOCKS" })]))
  })

  it("polls the self-test until finished, emitting stage:progress each time", async () => {
    const d = drive()
    const api = new SequencedSelfTestApi(
      {
        drives: [d],
        smartByPath: { [d.devicePath]: smartRaw() },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      [
        { running: true, percentRemaining: 60, result: null },
        { running: true, percentRemaining: 30, result: null },
        { running: false, percentRemaining: 0, result: { status: "PASSED" } },
      ],
    )
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const selfTestPercents: number[] = []
    engine.on("stage:progress", (evt: { stage: string; percent: number }) => {
      if (evt.stage === "SELFTEST_LONG") selfTestPercents.push(evt.percent)
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(selfTestPercents).toEqual([40, 70, 100])
  })

  it("runs SURFACE in read-only mode for a read-only regime", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const runId = await engine.startRun({ serial: d.serial, mode: "read-only" })
    await waitForSettled(engine, runId)

    expect(api.surfaceCalls).toEqual([{ devicePath: d.devicePath, mode: "read-only" }])
  })

  it("aborts a run when abortRun is called mid-surface-test", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
    })
    const engine = new TestEngine({ db, deviceApi: api, sleep: async () => {}, selfTestPollIntervalMs: 0 })

    const ctx: { runId?: number } = {}
    engine.on("stage:progress", (evt: { stage: string }) => {
      if (evt.stage === "SURFACE" && ctx.runId !== undefined) engine.abortRun(ctx.runId)
    })

    ctx.runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, ctx.runId)

    expect(terminal.status).toBe("ABORTED")
    expect(repo.getRun(db, ctx.runId)!.status).toBe("ABORTED")
  })
})
