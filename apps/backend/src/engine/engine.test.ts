import { describe, it, expect, beforeEach, vi } from "vitest"
import { and, eq } from "drizzle-orm"
import type {
  DiscoveredDrive,
  RunUpdateEvent,
  SelfTestProgress,
  StageProgressEvent,
} from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import { stageResults, smartSnapshots } from "../db/schema"
import * as repo from "../db/repositories"
import { FakeDeviceApi, type FakeDeviceApiState } from "../device/fakeDeviceApi"
import { regimeStages } from "./regime"
import { TestEngine, SafetyError, DriveNotFoundError, RunInProgressError } from "./engine"

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

const PASSED_SELFTEST: SelfTestProgress = {
  running: false,
  percentRemaining: 0,
  result: { status: "PASSED" },
}

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

/** Flushes pending microtasks (no real timers involved) so a fire-and-forget
 * async chain gets a chance to run to its next await point. */
async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/**
 * FakeDeviceApi variant whose pollSelfTest never resolves on its own — it
 * hands back a promise this test holds the resolver for. Parks the
 * self-test poll loop deterministically so a run can be held "actively
 * executing" (registered in the engine's internal controllers/activeSerials
 * bookkeeping, not terminal) for as long as a test needs, then released on
 * demand to let it unwind.
 */
class ParkableSelfTestApi extends FakeDeviceApi {
  #release?: (progress: SelfTestProgress) => void

  override async pollSelfTest(_devicePath: string): Promise<SelfTestProgress> {
    return new Promise((resolve) => {
      this.#release = resolve
    })
  }

  /** Resolves the currently-parked pollSelfTest call. */
  release(progress: SelfTestProgress): void {
    const resolve = this.#release
    if (!resolve) throw new Error("no parked pollSelfTest call to release")
    this.#release = undefined
    resolve(progress)
  }
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

/**
 * FakeDeviceApi variant whose listDevices() returns a different snapshot on
 * each call — used to simulate a drive's state changing between startRun's
 * initial safety check and the SURFACE stage's pre-write re-check.
 */
class ChangingDeviceApi extends FakeDeviceApi {
  private calls = 0
  constructor(
    state: FakeDeviceApiState,
    private readonly snapshots: DiscoveredDrive[][],
  ) {
    super(state)
  }

  override async listDevices(): Promise<DiscoveredDrive[]> {
    const idx = Math.min(this.calls, this.snapshots.length - 1)
    this.calls++
    const snapshot = this.snapshots[idx]
    if (!snapshot) throw new Error("no scripted listDevices snapshot")
    return snapshot
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
    await expect(engine.startRun({ serial: "NOPE", mode: "read-only" })).rejects.toThrow(
      DriveNotFoundError,
    )
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
    expect(audit[0]).toMatchObject({
      action: "DESTRUCTIVE_DENIED",
      driveSerial: d.serial,
      detail: "MOUNTED",
    })
  })

  it("rejects exactly one of two near-simultaneous startRun calls for the same brand-new serial (entry-reservation race guard)", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    // Never-seen serial, fired back-to-back with no await between them —
    // both calls hit startRun's synchronous top-of-method reservation check
    // before either has a chance to await listDevices(). Only one may win.
    const [a, b] = await Promise.allSettled([
      engine.startRun({ serial: d.serial, mode: "destructive" }),
      engine.startRun({ serial: d.serial, mode: "destructive" }),
    ])

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled")
    const rejected = [a, b].filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RunInProgressError)

    const runId = (fulfilled[0] as PromiseFulfilledResult<number>).value
    expect(repo.listRuns(db)).toHaveLength(1)
    expect(repo.listRuns(db)[0]?.driveSerial).toBe(d.serial)

    // Park/settle cleanly.
    await waitForSettled(engine, runId)
  })

  it("frees the serial reservation when startRun rejects with DriveNotFoundError, so a later legitimate start succeeds", async () => {
    // Held externally (not just passed into the constructor) so it can be
    // mutated in place after construction — FakeDeviceApi reads through the
    // same reference on every call.
    const state: FakeDeviceApiState = { drives: [] }
    const api = new FakeDeviceApi(state)
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    await expect(engine.startRun({ serial: "GHOST", mode: "read-only" })).rejects.toThrow(
      DriveNotFoundError,
    )
    expect(engine.isDriveActive("GHOST")).toBe(false)

    // The drive shows up for real afterward; startRun for the same serial
    // must not be blocked by a stuck reservation from the earlier rejection.
    const d = drive({ serial: "GHOST" })
    state.drives = [d]
    state.smartByPath = { [d.devicePath]: smartRaw() }
    state.selfTestByPath = { [d.devicePath]: PASSED_SELFTEST }
    state.surface = { plan: [100], result: { mode: "read-only", badBlocks: 0, completed: true } }

    const runId = await engine.startRun({ serial: d.serial, mode: "read-only" })
    await waitForSettled(engine, runId)
    expect(repo.listRuns(db)).toHaveLength(1)
  })

  it("frees the serial reservation when startRun rejects with SafetyError, so a later legitimate start succeeds", async () => {
    const d = drive({ mounted: true })
    const state: FakeDeviceApiState = { drives: [d] }
    const api = new FakeDeviceApi(state)
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    await expect(engine.startRun({ serial: d.serial, mode: "destructive" })).rejects.toThrow(
      SafetyError,
    )
    expect(engine.isDriveActive(d.serial)).toBe(false)

    // Drive becomes eligible (unmounted); a subsequent startRun for the same
    // serial must succeed, proving the earlier denial didn't leave it stuck.
    const eligible = drive({ serial: d.serial, mounted: false })
    state.drives = [eligible]
    state.smartByPath = { [eligible.devicePath]: smartRaw() }
    state.selfTestByPath = { [eligible.devicePath]: PASSED_SELFTEST }
    state.surface = { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } }

    const runId = await engine.startRun({ serial: eligible.serial, mode: "destructive" })
    await waitForSettled(engine, runId)
    expect(repo.listRuns(db)).toHaveLength(1)
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
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

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

    // Fix 4: the SURFACE stage row persists the SurfaceResult for forensics.
    const surfaceStage = stages.find((s) => s.stage === "SURFACE")
    expect(surfaceStage?.metrics).toEqual({ mode: "write", badBlocks: 0, completed: true })

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
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(terminal.verdict).toBe("FAIL")

    const run = repo.getRun(db, runId)!
    expect(run.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "BADBLOCKS" })]),
    )
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
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

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
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "read-only" })
    await waitForSettled(engine, runId)

    expect(api.surfaceCalls).toEqual([{ devicePath: d.devicePath, mode: "read-only" }])
  })

  // Cancelling has to cancel the drive too: the engine breaking out of its poll
  // loop leaves the ATA routine running for up to ~90 minutes otherwise.
  it("tells the drive to stop when abortRun is called mid-self-test", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      // Never finishes on its own, so the only way out of the stage is the abort.
      selfTestByPath: {
        [d.devicePath]: { running: true, percentRemaining: 90, result: { status: "UNKNOWN" } },
      },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const ctx: { runId?: number } = {}
    engine.on("stage:progress", (evt: { stage: string }) => {
      if (evt.stage === "SELFTEST_LONG" && ctx.runId !== undefined) engine.abortRun(ctx.runId)
    })

    ctx.runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, ctx.runId)

    expect(terminal.status).toBe("ABORTED")
    expect(api.selfTestAborts).toEqual([d.devicePath])
  })

  it("does not tell the drive to stop when the self-test finishes on its own", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "read-only" })
    await waitForSettled(engine, runId)

    expect(api.selfTestAborts).toEqual([])
  })

  it("aborts a run when abortRun is called mid-surface-test", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const ctx: { runId?: number } = {}
    engine.on("stage:progress", (evt: { stage: string }) => {
      if (evt.stage === "SURFACE" && ctx.runId !== undefined) engine.abortRun(ctx.runId)
    })

    ctx.runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, ctx.runId)

    expect(terminal.status).toBe("ABORTED")
    const run = repo.getRun(db, ctx.runId)!
    expect(run.status).toBe("ABORTED")

    // Fix 2: the stage that was actually interrupted (SURFACE) must be
    // recorded ABORTED — not DONE — and currentStage must point at it, not
    // at the next stage in the regime.
    expect(terminal.currentStage).toBe("SURFACE")
    expect(run.currentStage).toBe("SURFACE")
    const stages = db.select().from(stageResults).where(eq(stageResults.runId, ctx.runId)).all()
    const surfaceStage = stages.find((s) => s.stage === "SURFACE")
    expect(surfaceStage?.status).toBe("ABORTED")

    // ...and it must keep the percentage it actually reached. This is the stage
    // that overwrites every sector, so recording an interrupted wipe as 100%
    // invites the reading that the whole disk was written.
    expect(surfaceStage?.progress).not.toBe(100)
    expect(surfaceStage?.progress).toBe(25)
  })

  it("does not let abortRun called from a DONE listener re-label an already-terminal run (Fix A)", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const terminalEvents: RunUpdateEvent[] = []
    engine.on("run:update", (evt: RunUpdateEvent) => {
      if (!isTerminal(evt.status)) return
      terminalEvents.push(evt)
      // Simulates Phase 4's SSE/cancel-button wiring: a listener reacting
      // synchronously to the terminal event calls abortRun on the very run
      // that just finished.
      if (evt.status === "DONE") engine.abortRun(evt.runId)
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)
    // Give any (incorrect) re-labelling a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(terminal.status).toBe("DONE")

    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("DONE")
    expect(run.verdict).toBe("PASS")

    expect(terminalEvents).toHaveLength(1)
    expect(terminalEvents[0]?.status).toBe("DONE")

    // A no-op abortRun on an already-terminal run must not touch the
    // controller/stage bookkeeping either.
    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages.every((s) => s.status === "DONE")).toBe(true)
  })
})

describe("TestEngine run-state persistence (#12 timestamps, #16 progress)", () => {
  it("records start/finish timestamps on the run and every stage (#12)", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await waitForSettled(engine, runId)

    const run = repo.getRun(db, runId)!
    expect(run.startedAt).toBeInstanceOf(Date)
    expect(run.finishedAt).toBeInstanceOf(Date)

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages).toHaveLength(5)
    for (const s of stages) {
      expect(s.startedAt, `${s.stage} startedAt`).toBeInstanceOf(Date)
      expect(s.finishedAt, `${s.stage} finishedAt`).toBeInstanceOf(Date)
    }
  })

  it("persists in-progress stage percent to the DB, not just via SSE (#16)", async () => {
    const d = drive()
    const api = new SequencedSelfTestApi(
      {
        drives: [d],
        smartByPath: { [d.devicePath]: smartRaw() },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      [
        { running: true, percentRemaining: 60, result: null },
        { running: false, percentRemaining: 0, result: { status: "PASSED" } },
      ],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const ctx: { runId?: number } = {}
    let persistedMidStage: number | null | undefined
    engine.on("stage:progress", (evt: StageProgressEvent) => {
      if (evt.stage !== "SELFTEST_LONG" || evt.percent !== 40 || ctx.runId === undefined) return
      if (persistedMidStage !== undefined) return
      // Read straight from the DB (not the event) to prove the percent is
      // *persisted*, not merely emitted to SSE.
      const row = db
        .select()
        .from(stageResults)
        .where(and(eq(stageResults.runId, ctx.runId), eq(stageResults.stage, "SELFTEST_LONG")))
        .get()
      persistedMidStage = row?.progress ?? null
    })

    ctx.runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await waitForSettled(engine, ctx.runId)

    // First poll reports 60% remaining -> 40% done; that value must be in the
    // stage row while the run is still mid-flight, not just after it finishes.
    expect(persistedMidStage).toBe(40)
  })
})

describe("TestEngine per-stage captured log (#13)", () => {
  it("persists the SURFACE stage's captured device-api log alongside its metrics", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: {
        plan: [100],
        result: { mode: "write", badBlocks: 1, completed: true },
        log: "=== badblocks stdout ===\n(empty)\n\n=== bad-block logfile ===\n12345",
      },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await waitForSettled(engine, runId)

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    const surfaceStage = stages.find((s) => s.stage === "SURFACE")
    expect(surfaceStage?.log).toContain("=== badblocks stdout ===")
    expect(surfaceStage?.log).toContain("12345")
    // The captured log is additional to (not a replacement of) the existing
    // forensic metrics field.
    expect(surfaceStage?.metrics).toEqual({ mode: "write", badBlocks: 1, completed: true })
  })

  it("leaves a stage's log column null when the device api never calls onLog", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await waitForSettled(engine, runId)

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    const surfaceStage = stages.find((s) => s.stage === "SURFACE")
    expect(surfaceStage?.log).toBeNull()
  })

  it("persists a SELFTEST_LONG poll-trail log built from the poll sequence", async () => {
    const d = drive()
    const api = new SequencedSelfTestApi(
      {
        drives: [d],
        smartByPath: { [d.devicePath]: smartRaw() },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      [
        { running: true, percentRemaining: 60, result: null },
        { running: false, percentRemaining: 0, result: { status: "PASSED" } },
      ],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await waitForSettled(engine, runId)

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    const selfTestStage = stages.find((s) => s.stage === "SELFTEST_LONG")
    expect(selfTestStage?.log).toContain("smartctl -t long")
    expect(selfTestStage?.log).toContain("percentRemaining=60")
    expect(selfTestStage?.log).toContain("self-test finished: PASSED")
  })
})

describe("TestEngine SURFACE stage safety re-check (TOCTOU guard)", () => {
  it("denies the destructive write when the drive becomes mounted between startRun and the SURFACE stage", async () => {
    const clean = drive()
    const mountedNow = drive({ mounted: true })
    const api = new ChangingDeviceApi(
      {
        smartByPath: { [clean.devicePath]: smartRaw() },
        selfTestByPath: { [clean.devicePath]: PASSED_SELFTEST },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      [[clean], [mountedNow]],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: clean.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("FAILED")
    expect(api.surfaceCalls).toEqual([])

    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("FAILED")
    expect(run.error).toContain("MOUNTED")
    // Fix 3: current_stage shows where the FAILED run stopped.
    expect(run.currentStage).toBe("SURFACE")

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages.find((s) => s.stage === "SURFACE")?.status).toBe("FAILED")

    const audit = repo.listAudit(db)
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "DESTRUCTIVE_RECHECK_DENIED",
        driveSerial: clean.serial,
        detail: "MOUNTED",
      }),
    )
  })

  it("denies the destructive write when the drive is no longer present at the SURFACE stage", async () => {
    const clean = drive()
    const api = new ChangingDeviceApi(
      {
        smartByPath: { [clean.devicePath]: smartRaw() },
        selfTestByPath: { [clean.devicePath]: PASSED_SELFTEST },
      },
      [[clean], []],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: clean.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("FAILED")
    expect(api.surfaceCalls).toEqual([])

    const audit = repo.listAudit(db)
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: "DESTRUCTIVE_RECHECK_DENIED",
        driveSerial: clean.serial,
        detail: "DRIVE_GONE",
      }),
    )
  })

  it("does not re-check safety for a read-only regime", async () => {
    const clean = drive()
    const mountedNow = drive({ mounted: true })
    const api = new ChangingDeviceApi(
      {
        smartByPath: { [clean.devicePath]: smartRaw() },
        selfTestByPath: { [clean.devicePath]: PASSED_SELFTEST },
        surface: { plan: [100], result: { mode: "read-only", badBlocks: 0, completed: true } },
      },
      [[clean], [mountedNow]],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: clean.serial, mode: "read-only" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(api.surfaceCalls).toEqual([{ devicePath: clean.devicePath, mode: "read-only" }])
    expect(repo.listAudit(db).some((a) => a.action === "DESTRUCTIVE_RECHECK_DENIED")).toBe(false)
  })
})

describe("TestEngine.abortRun no-op guards (Fix A)", () => {
  it("no-ops for a run id with no active controller (unknown/already-finished run)", () => {
    const engine = new TestEngine({ db, deviceApi: new FakeDeviceApi({ drives: [] }) })
    expect(() => engine.abortRun(999)).not.toThrow()
  })
})

describe("TestEngine SMART_AFTER/VERDICT fresh device path (Fix B)", () => {
  it("re-resolves the drive by serial before SMART_AFTER and reads from the fresh device path", async () => {
    const original = drive()
    const relocated = drive({ devicePath: "/dev/sdz" })
    const api = new ChangingDeviceApi(
      {
        smartByPath: {
          [original.devicePath]: smartRaw({ temperature: { current: 30 } }),
          [relocated.devicePath]: smartRaw({ temperature: { current: 31 } }),
        },
        selfTestByPath: { [original.devicePath]: PASSED_SELFTEST },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      // call 0: startRun's listDevices, call 1: SURFACE's destructive
      // re-check (drive hasn't moved yet), call 2: the new pre-SMART_AFTER
      // re-resolve — this is where the device node has been reassigned.
      [[original], [original], [relocated]],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })
    const readSmartSpy = vi.spyOn(api, "readSmartRaw")

    const runId = await engine.startRun({ serial: original.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")

    // SURFACE wrote to the path resolved at that point (unchanged here).
    expect(api.surfaceCalls).toEqual([{ devicePath: original.devicePath, mode: "destructive" }])

    // SMART_BEFORE read the original path; SMART_AFTER must have read the
    // freshly re-resolved one, not the stale startRun-time snapshot.
    expect(readSmartSpy.mock.calls).toEqual([[original.devicePath], [relocated.devicePath]])

    const snapshots = db.select().from(smartSnapshots).where(eq(smartSnapshots.runId, runId)).all()
    expect(snapshots.map((s) => s.phase).sort()).toEqual(["after", "before"])
  })

  it("fails the run with DRIVE_GONE, without reading SMART_AFTER, when the drive disappears before SMART_AFTER", async () => {
    const clean = drive()
    const api = new ChangingDeviceApi(
      {
        smartByPath: { [clean.devicePath]: smartRaw() },
        selfTestByPath: { [clean.devicePath]: PASSED_SELFTEST },
        surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      // call 0: startRun, call 1: SURFACE's destructive re-check (still
      // present, the write proceeds), call 2: pre-SMART_AFTER re-resolve —
      // the drive is gone.
      [[clean], [clean], []],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })
    const readSmartSpy = vi.spyOn(api, "readSmartRaw")

    const runId = await engine.startRun({ serial: clean.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("FAILED")

    const run = repo.getRun(db, runId)!
    expect(run.status).toBe("FAILED")
    expect(run.error).toContain("DRIVE_GONE")
    // Fix 3: current_stage shows where the FAILED run stopped.
    expect(run.currentStage).toBe("SMART_AFTER")

    // The destructive surface write already happened (the drive was still
    // present at that point)...
    expect(api.surfaceCalls).toHaveLength(1)

    // ...but the after-read must fail closed: only the "before" SMART read
    // was ever attempted, never an "after" read against a vanished drive.
    expect(readSmartSpy.mock.calls).toEqual([[clean.devicePath]])
    const snapshots = db.select().from(smartSnapshots).where(eq(smartSnapshots.runId, runId)).all()
    expect(snapshots.map((s) => s.phase)).toEqual(["before"])

    const stages = db.select().from(stageResults).where(eq(stageResults.runId, runId)).all()
    expect(stages.find((s) => s.stage === "SMART_AFTER")?.status).toBe("FAILED")
    // VERDICT never ran.
    expect(stages.find((s) => s.stage === "VERDICT")).toBeUndefined()
  })

  it("re-resolves the drive before SMART_AFTER for a read-only regime too (device paths are transient regardless of mode)", async () => {
    const original = drive()
    const relocated = drive({ devicePath: "/dev/sdz" })
    const api = new ChangingDeviceApi(
      {
        smartByPath: {
          [original.devicePath]: smartRaw(),
          [relocated.devicePath]: smartRaw(),
        },
        selfTestByPath: { [original.devicePath]: PASSED_SELFTEST },
        surface: { plan: [100], result: { mode: "read-only", badBlocks: 0, completed: true } },
      },
      // call 0: startRun, call 1: pre-SMART_AFTER re-resolve (no SURFACE
      // re-check call for read-only regimes).
      [[original], [relocated]],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })
    const readSmartSpy = vi.spyOn(api, "readSmartRaw")

    const runId = await engine.startRun({ serial: original.serial, mode: "read-only" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(readSmartSpy.mock.calls).toEqual([[original.devicePath], [relocated.devicePath]])
  })
})

describe("TestEngine per-drive active-run guard (Fix 1)", () => {
  it("rejects a second startRun for a drive with an in-flight run, creating no second run row", async () => {
    const d = drive()
    const api = new ParkableSelfTestApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    // Let SMART_BEFORE finish and SELFTEST_LONG's poll loop park on its
    // first pollSelfTest call — the run is now actively executing but not
    // terminal, so its serial must be registered as active.
    await flushMicrotasks()

    expect(engine.isDriveActive(d.serial)).toBe(true)

    let caught: unknown
    try {
      await engine.startRun({ serial: d.serial, mode: "destructive" })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(RunInProgressError)
    expect((caught as RunInProgressError).serial).toBe(d.serial)
    // No second run/audit row: the guard must fire before any DB write.
    expect(repo.listRuns(db)).toHaveLength(1)
    expect(repo.listRuns(db)[0]?.id).toBe(runId)
    expect(repo.listAudit(db).filter((a) => a.action === "DESTRUCTIVE_START")).toHaveLength(1)

    // Unwind cleanly rather than leaving the parked run hanging.
    const settled = waitForSettled(engine, runId)
    engine.abortRun(runId)
    api.release({ running: true, percentRemaining: 50, result: null })
    const terminal = await settled
    expect(terminal.status).toBe("ABORTED")
    // waitForSettled resolves as soon as the terminal event fires, which is
    // slightly before #execute's own finally block (a few microtask ticks
    // later) clears the serial — flush before asserting it's released.
    await flushMicrotasks()
    expect(engine.isDriveActive(d.serial)).toBe(false)
  })

  it("rejects a fresh startRun for a drive whose active run was dispatched via reconcile() (reconcile-vs-startRun)", async () => {
    const d = drive()
    repo.upsertDrive(db, d)
    const runId = repo.createRun(db, {
      driveSerial: d.serial,
      regime: { mode: "destructive", stages: regimeStages("destructive").map((s) => s.stage) },
    })
    repo.updateRun(db, runId, { status: "RUNNING" })
    repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
    repo.addStage(db, { runId, stage: "SELFTEST_LONG", status: "RUNNING" })

    const api = new ParkableSelfTestApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    await engine.reconcile()
    // Let #reconcileRun resume SELFTEST_LONG by polling and park on its
    // first pollSelfTest call.
    await flushMicrotasks()

    expect(engine.isDriveActive(d.serial)).toBe(true)

    await expect(engine.startRun({ serial: d.serial, mode: "destructive" })).rejects.toThrow(
      RunInProgressError,
    )
    // Only the reconcile()-resumed run row exists — startRun must not have
    // created a second one.
    expect(repo.listRuns(db)).toHaveLength(1)

    const settled = waitForSettled(engine, runId)
    engine.abortRun(runId)
    api.release({ running: true, percentRemaining: 50, result: null })
    const terminal = await settled
    expect(terminal.status).toBe("ABORTED")
  })

  it("skips resuming a run in reconcile() when its drive serial is already active from a startRun dispatched in this process", async () => {
    const d = drive()
    const api = new ParkableSelfTestApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    // startRun dispatches (and parks) a run for this drive's serial.
    const activeRunId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    await flushMicrotasks()
    expect(engine.isDriveActive(d.serial)).toBe(true)

    // A second, stale RUNNING run row for the SAME drive serial — e.g. left
    // behind by a previous process death — must NOT be resumed by
    // reconcile() while the drive is already active.
    const staleRunId = repo.createRun(db, {
      driveSerial: d.serial,
      regime: { mode: "destructive", stages: regimeStages("destructive").map((s) => s.stage) },
    })
    repo.updateRun(db, staleRunId, { status: "RUNNING" })

    const eventsForStaleRun: RunUpdateEvent[] = []
    engine.on("run:update", (evt: RunUpdateEvent) => {
      if (evt.runId === staleRunId) eventsForStaleRun.push(evt)
    })

    await engine.reconcile()
    await flushMicrotasks()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // reconcile() must not have dispatched the stale run at all: no events,
    // no status change, no stage rows inserted for it.
    expect(eventsForStaleRun).toHaveLength(0)
    expect(repo.getRun(db, staleRunId)!.status).toBe("RUNNING")
    const staleStages = db
      .select()
      .from(stageResults)
      .where(eq(stageResults.runId, staleRunId))
      .all()
    expect(staleStages).toHaveLength(0)

    // Unwind the active run.
    const settled = waitForSettled(engine, activeRunId)
    engine.abortRun(activeRunId)
    api.release({ running: true, percentRemaining: 50, result: null })
    const terminal = await settled
    expect(terminal.status).toBe("ABORTED")
  })
})

describe("TestEngine current_stage persistence (Fix 3)", () => {
  it("persists current_stage in the DB as a RUNNING run advances through stages, observable mid-run via an event hook", async () => {
    const d = drive()
    const api = new FakeDeviceApi({
      drives: [d],
      smartByPath: { [d.devicePath]: smartRaw() },
      selfTestByPath: { [d.devicePath]: PASSED_SELFTEST },
      surface: { plan: [100], result: { mode: "write", badBlocks: 0, completed: true } },
    })
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const ctx: { runId?: number } = {}
    let observedAtSelfTest: string | null | undefined
    engine.on("run:update", (evt: RunUpdateEvent) => {
      if (ctx.runId === undefined) return
      if (
        evt.runId === ctx.runId &&
        evt.status === "RUNNING" &&
        evt.currentStage === "SELFTEST_LONG" &&
        observedAtSelfTest === undefined
      ) {
        // Read straight from the DB (not the event payload) to prove the
        // stage is *persisted*, not just emitted.
        observedAtSelfTest = repo.getRun(db, ctx.runId)?.currentStage ?? null
      }
    })

    ctx.runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, ctx.runId)

    expect(terminal.status).toBe("DONE")
    expect(observedAtSelfTest).toBe("SELFTEST_LONG")

    const run = repo.getRun(db, ctx.runId)!
    expect(run.currentStage).toBe("VERDICT")
  })
})

describe("TestEngine driveSerial in events (Fix 3)", () => {
  it("stamps driveSerial on every run:update AND stage:progress event, so a listener can map any frame to a drive without a round-trip", async () => {
    const d = drive()
    const api = new SequencedSelfTestApi(
      {
        drives: [d],
        smartByPath: { [d.devicePath]: smartRaw() },
        surface: { plan: [50, 100], result: { mode: "write", badBlocks: 0, completed: true } },
      },
      [
        { running: true, percentRemaining: 50, result: null },
        { running: false, percentRemaining: 0, result: { status: "PASSED" } },
      ],
    )
    const engine = new TestEngine({
      db,
      deviceApi: api,
      sleep: async () => {},
      selfTestPollIntervalMs: 0,
    })

    const runUpdates: RunUpdateEvent[] = []
    const stageProgress: StageProgressEvent[] = []
    engine.on("run:update", (evt: RunUpdateEvent) => runUpdates.push(evt))
    engine.on("stage:progress", (evt: StageProgressEvent) => stageProgress.push(evt))

    const runId = await engine.startRun({ serial: d.serial, mode: "destructive" })
    const terminal = await waitForSettled(engine, runId)

    expect(terminal.status).toBe("DONE")
    expect(terminal.driveSerial).toBe(d.serial)

    // Every run:update across the whole run (RUNNING x N stages + terminal
    // DONE) carries the drive's serial, not just the final event.
    expect(runUpdates.length).toBeGreaterThan(1)
    expect(runUpdates.every((e) => e.driveSerial === d.serial)).toBe(true)

    // Both SELFTEST_LONG polling and SURFACE progress callbacks emit
    // stage:progress — confirm both stamp driveSerial too.
    expect(stageProgress.some((e) => e.stage === "SELFTEST_LONG")).toBe(true)
    expect(stageProgress.some((e) => e.stage === "SURFACE")).toBe(true)
    expect(stageProgress.every((e) => e.driveSerial === d.serial)).toBe(true)
  })
})
