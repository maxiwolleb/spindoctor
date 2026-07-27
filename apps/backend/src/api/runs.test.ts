import { describe, it, expect, beforeEach } from "vitest"
import type {
  CreateRunRequest,
  DiscoveredDrive,
  RunView,
  SelfTestProgress,
} from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { FakeDeviceApi, type FakeDeviceApiState } from "../device/fakeDeviceApi"
import { TestEngine } from "../engine/engine"
import { buildApp } from "./app"

const cleanDrive: DiscoveredDrive = {
  devicePath: "/dev/sda",
  serial: "CLEAN1",
  wwn: null,
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
}

const mountedDrive: DiscoveredDrive = {
  devicePath: "/dev/sdb",
  serial: "MOUNTED1",
  wwn: null,
  model: "Samsung 870 EVO",
  sizeBytes: 1_000_000_000_000,
  type: "SSD",
  transport: "SATA",
  mounted: true,
  isSystemDisk: false,
}

const smartRaw = (): unknown => ({ ata_smart_attributes: { table: [] }, temperature: {} })
const PASSED_SELFTEST: SelfTestProgress = {
  running: false,
  percentRemaining: 0,
  result: { status: "PASSED" },
}

/**
 * FakeDeviceApi variant whose pollSelfTest never resolves on its own — hands
 * back a promise this test holds the resolver for, so a run can be held
 * "actively executing" (registered in the engine's active-serial bookkeeping,
 * not terminal) for as long as a test needs, then released on demand.
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

/** Flushes pending microtasks (no real timers involved) so a fire-and-forget
 * async chain gets a chance to run to its next await point. */
async function flushMicrotasks(times = 50): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

let db: Db
let state: FakeDeviceApiState

beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
  state = {
    drives: [cleanDrive, mountedDrive],
    smartByPath: {
      [cleanDrive.devicePath]: smartRaw(),
      [mountedDrive.devicePath]: smartRaw(),
    },
    selfTestByPath: {
      [cleanDrive.devicePath]: PASSED_SELFTEST,
      [mountedDrive.devicePath]: PASSED_SELFTEST,
    },
  }
})

function build(deviceApi: FakeDeviceApi = new FakeDeviceApi(state)) {
  const engine = new TestEngine({ db, deviceApi, sleep: async () => {}, selfTestPollIntervalMs: 0 })
  const app = buildApp({ db, deviceApi, engine })
  return { app, engine, deviceApi }
}

describe("POST /api/runs", () => {
  it("400s a destructive request without a confirm, creating no run", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { serial: cleanDrive.serial, mode: "destructive" } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "CONFIRM_REQUIRED" })
    expect(repo.listRuns(db)).toHaveLength(0)
  })

  it("201s a destructive request with confirm===serial on a clean drive, creating a run row", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: cleanDrive.serial,
        mode: "destructive",
        confirm: cleanDrive.serial,
      } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ runId: number }>()
    expect(body.runId).toBeTypeOf("number")
    expect(repo.getRun(db, body.runId)).toBeDefined()
  })

  // #49: the flag has to survive into the persisted regime, or a container
  // restart mid-run would silently re-apply the gate the operator opted out of.
  it("persists forceFullRegime into the run's regime", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: cleanDrive.serial,
        mode: "destructive",
        confirm: cleanDrive.serial,
        forceFullRegime: true,
      } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(201)
    const { runId } = res.json<{ runId: number }>()
    expect(repo.getRun(db, runId)?.regime).toMatchObject({ forceFullRegime: true })
  })

  it("omits forceFullRegime from the regime when the request doesn't ask for it", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: cleanDrive.serial,
        mode: "read-only",
      } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(201)
    const { runId } = res.json<{ runId: number }>()
    expect(repo.getRun(db, runId)?.regime).not.toHaveProperty("forceFullRegime")
  })

  it("403s a destructive request on a mounted drive with the safety code, creating no run", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: mountedDrive.serial,
        mode: "destructive",
        confirm: mountedDrive.serial,
      } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: "MOUNTED" })
    expect(repo.listRuns(db)).toHaveLength(0)
  })

  it("409s a second destructive start for a drive that already has an active run", async () => {
    const deviceApi = new ParkableSelfTestApi(state)
    const { app, engine } = build(deviceApi)

    const first = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: cleanDrive.serial,
        mode: "destructive",
        confirm: cleanDrive.serial,
      } satisfies CreateRunRequest,
    })
    expect(first.statusCode).toBe(201)
    const { runId } = first.json<{ runId: number }>()

    // Let SMART_BEFORE finish and SELFTEST_LONG's poll loop park on its
    // first pollSelfTest call — the run is now actively executing but not
    // terminal.
    await flushMicrotasks()
    expect(engine.isDriveActive(cleanDrive.serial)).toBe(true)

    const second = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: {
        serial: cleanDrive.serial,
        mode: "destructive",
        confirm: cleanDrive.serial,
      } satisfies CreateRunRequest,
    })
    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ code: "RUN_IN_PROGRESS" })
    expect(repo.listRuns(db)).toHaveLength(1)
    expect(repo.listRuns(db)[0]?.id).toBe(runId)

    // Unwind cleanly rather than leaving the parked run hanging.
    engine.abortRun(runId)
    deviceApi.release({ running: true, percentRemaining: 50, result: null })
    await flushMicrotasks()
  })

  it("404s an unknown serial", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { serial: "NOPE", mode: "read-only" } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "DRIVE_NOT_FOUND" })
    expect(repo.listRuns(db)).toHaveLength(0)
  })

  it("201s a read-only request with no confirm needed", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { serial: cleanDrive.serial, mode: "read-only" } satisfies CreateRunRequest,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ runId: number }>()
    expect(repo.getRun(db, body.runId)).toBeDefined()
  })

  it("400s an invalid body (empty serial / bad mode)", async () => {
    const { app } = build()
    const res = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { serial: "", mode: "destructive" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const res2 = await app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { serial: cleanDrive.serial, mode: "bogus" },
    })
    expect(res2.statusCode).toBe(400)
    expect(res2.json()).toMatchObject({ code: "BAD_REQUEST" })
  })
})

describe("GET /api/runs", () => {
  it("returns all runs as RunView[]", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "read-only", stages: [] },
    })
    repo.updateRun(db, runId, {
      status: "DONE",
      verdict: "PASS",
      reasons: [],
      currentStage: "VERDICT",
    })

    const res = await app.inject({ method: "GET", url: "/api/runs" })
    expect(res.statusCode).toBe(200)
    const body = res.json<RunView[]>()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      id: runId,
      driveSerial: cleanDrive.serial,
      mode: "read-only",
      status: "DONE",
      verdict: "PASS",
      currentStage: "VERDICT",
    })
  })

  it("filters by ?serial=", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    repo.upsertDrive(db, mountedDrive)
    repo.createRun(db, { driveSerial: cleanDrive.serial, regime: { mode: "read-only" } })
    repo.createRun(db, { driveSerial: mountedDrive.serial, regime: { mode: "read-only" } })

    const res = await app.inject({ method: "GET", url: `/api/runs?serial=${cleanDrive.serial}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<RunView[]>()
    expect(body).toHaveLength(1)
    expect(body[0]?.driveSerial).toBe(cleanDrive.serial)
  })

  it("returns runs newest-first (Fix 4)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const first = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "read-only" },
    })
    const second = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "read-only" },
    })
    const third = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "read-only" },
    })

    const res = await app.inject({ method: "GET", url: "/api/runs" })
    expect(res.statusCode).toBe(200)
    const body = res.json<RunView[]>()
    expect(body.map((r) => r.id)).toEqual([third, second, first])
  })

  it("serializes timestamps as ISO strings (or null), never raw Date objects (Fix 1)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "read-only" },
    })
    repo.updateRun(db, runId, {
      status: "RUNNING",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    })

    const res = await app.inject({ method: "GET", url: "/api/runs" })
    const body = res.json<RunView[]>()
    const run = body.find((r) => r.id === runId)

    expect(run?.startedAt).toBe("2026-01-01T00:00:00.000Z")
    expect(run?.finishedAt).toBeNull()
    expect(typeof run?.createdAt).toBe("string")
    // A string round-trips through Date parsing; a raw Date serialized by
    // JSON.stringify would already look like a string here too, so the real
    // regression this guards is `.getTime is not a function` on the
    // frontend if this field were ever a bare object instead.
    expect(Number.isNaN(new Date(run?.createdAt as string).getTime())).toBe(false)
  })
})

describe("GET /api/runs/:id", () => {
  it("returns the run and its stage rows", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    const stageId = repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ run: RunView; stages: unknown[] }>()
    expect(body.run.id).toBe(runId)
    expect(body.run.driveSerial).toBe(cleanDrive.serial)
    expect(body.stages).toHaveLength(1)
    expect(body.stages[0]).toMatchObject({ id: stageId, stage: "SMART_BEFORE", status: "DONE" })
  })

  it("serializes run and stage timestamps as ISO strings (or null) (Fix 1)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.updateRun(db, runId, {
      status: "RUNNING",
      startedAt: new Date("2026-02-02T00:00:00.000Z"),
    })
    const stageId = repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
    repo.updateStage(db, stageId, {
      startedAt: new Date("2026-02-02T00:01:00.000Z"),
      finishedAt: new Date("2026-02-02T00:02:00.000Z"),
    })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      run: RunView
      stages: { startedAt: string | null; finishedAt: string | null }[]
    }>()

    expect(body.run.startedAt).toBe("2026-02-02T00:00:00.000Z")
    expect(body.run.finishedAt).toBeNull()
    expect(body.stages[0]?.startedAt).toBe("2026-02-02T00:01:00.000Z")
    expect(body.stages[0]?.finishedAt).toBe("2026-02-02T00:02:00.000Z")
  })

  it("404s for an unknown run id with a RUN_NOT_FOUND code (Fix 2)", async () => {
    const { app } = build()
    const res = await app.inject({ method: "GET", url: "/api/runs/999" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "RUN_NOT_FOUND" })
  })

  it("includes the before/after SMART key-metrics snapshots, null for a phase not yet captured", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: smartRaw(),
      keyMetrics: {
        reallocatedSectors: 0,
        currentPending: 0,
        offlineUncorrectable: 0,
        reportedUncorrect: 0,
        crcErrors: 0,
        powerOnHours: 100,
        spinRetryCount: null,
        commandTimeouts: null,
        percentageUsed: null,
        mediaErrors: null,
        temperatureC: 30,
        grownDefects: null,
        linkErrors: null,
        smartHealthPassed: null,
      },
    })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ snapshots: { before: unknown; after: unknown } }>()
    expect(body.snapshots.before).toMatchObject({ reallocatedSectors: 0, powerOnHours: 100 })
    expect(body.snapshots.after).toBeNull()
  })

  it("includes the full before/after SMART attribute tables, [] for a phase not yet captured (#14)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: {
        device: { protocol: "ATA" },
        rotation_rate: 7200,
        ata_smart_attributes: {
          table: [
            { id: 5, name: "Reallocated_Sector_Ct", raw: { value: 3, string: "3" } },
            { id: 197, name: "Current_Pending_Sector", raw: { value: 0, string: "0" } },
          ],
        },
      },
      keyMetrics: { reallocatedSectors: 3 } as any,
    })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ attributes: { before: any[]; after: any[] } }>()
    expect(body.attributes.after).toEqual([])
    expect(body.attributes.before).toHaveLength(2)
    expect(body.attributes.before.find((r) => r.id === 5)).toMatchObject({
      name: "Reallocated_Sector_Ct",
      rawValue: 3,
      health: "warn",
    })
  })

  it("includes each stage's captured log, null for a stage that has none (#13)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    const smartStageId = repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
    const surfaceStageId = repo.addStage(db, { runId, stage: "SURFACE", status: "DONE" })
    repo.updateStage(db, surfaceStageId, { log: "=== badblocks stdout ===\n(empty)" })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ stages: { id: number; log: string | null }[] }>()
    expect(body.stages.find((s) => s.id === smartStageId)?.log).toBeNull()
    expect(body.stages.find((s) => s.id === surfaceStageId)?.log).toContain(
      "=== badblocks stdout ===",
    )
  })
})

describe("GET /api/runs/:id/log", () => {
  it("returns the concatenated per-stage log as a text/plain attachment", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
    const surfaceStageId = repo.addStage(db, { runId, stage: "SURFACE", status: "DONE" })
    repo.updateStage(db, surfaceStageId, { log: "=== badblocks stdout ===\nall clear" })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/log` })

    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/plain")
    expect(res.headers["content-disposition"]).toContain("attachment")
    expect(res.headers["content-disposition"]).toContain(`spindoctor-run-${runId}-log.txt`)
    expect(res.body).toContain("SMART_BEFORE")
    expect(res.body).toContain("(no log captured for this stage)")
    expect(res.body).toContain("SURFACE")
    expect(res.body).toContain("all clear")
  })

  it("orders stages oldest-first in the downloaded text, matching the timeline order", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.addStage(db, { runId, stage: "SMART_BEFORE", status: "DONE" })
    repo.addStage(db, { runId, stage: "SELFTEST_LONG", status: "DONE" })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/log` })
    expect(res.statusCode).toBe(200)
    expect(res.body.indexOf("SMART_BEFORE")).toBeLessThan(res.body.indexOf("SELFTEST_LONG"))
  })

  it("404s for an unknown run id with a RUN_NOT_FOUND code", async () => {
    const { app } = build()
    const res = await app.inject({ method: "GET", url: "/api/runs/999/log" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "RUN_NOT_FOUND" })
  })
})

describe("GET /api/runs/:id/smart", () => {
  it("returns the stored raw smartctl JSON per phase as a JSON attachment", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.saveSnapshot(db, {
      runId,
      phase: "before",
      raw: { model_name: "WDC WD40EFRX", ata_smart_attributes: { table: [] } },
      keyMetrics: { reallocatedSectors: 0 } as any,
    })

    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}/smart` })

    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("application/json")
    expect(res.headers["content-disposition"]).toContain("attachment")
    expect(res.headers["content-disposition"]).toContain(`spindoctor-run-${runId}-smart.json`)
    const body = res.json<{ before: unknown; after: unknown }>()
    expect(body.before).toMatchObject({ model_name: "WDC WD40EFRX" })
    expect(body.after).toBeNull()
  })

  it("404s for an unknown run id with a RUN_NOT_FOUND code", async () => {
    const { app } = build()
    const res = await app.inject({ method: "GET", url: "/api/runs/999/smart" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "RUN_NOT_FOUND" })
  })
})

describe("POST /api/runs/:id/abort", () => {
  it("202s and aborts an existing run (idempotent even once terminal)", async () => {
    const { app } = build()
    repo.upsertDrive(db, cleanDrive)
    const runId = repo.createRun(db, {
      driveSerial: cleanDrive.serial,
      regime: { mode: "destructive" },
    })
    repo.updateRun(db, runId, { status: "DONE", verdict: "PASS" })

    const res = await app.inject({ method: "POST", url: `/api/runs/${runId}/abort` })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ ok: true })
  })

  it("404s for a nonexistent run id with a RUN_NOT_FOUND code (Fix 2)", async () => {
    const { app } = build()
    const res = await app.inject({ method: "POST", url: "/api/runs/999/abort" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "RUN_NOT_FOUND" })
  })
})
