import { describe, it, expect, beforeEach } from "vitest"
import type { DiscoveredDrive, DriveView } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { FakeDeviceApi, type FakeDeviceApiState } from "../device/fakeDeviceApi"
import { TestEngine } from "../engine/engine"
import { buildApp } from "./app"

const driveA: DiscoveredDrive = {
  devicePath: "/dev/sda",
  serial: "SERA",
  wwn: null,
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
}

const driveB: DiscoveredDrive = {
  devicePath: "/dev/sdb",
  serial: "SERB",
  wwn: "0xabc",
  model: "Samsung 870 EVO",
  sizeBytes: 1_000_000_000_000,
  type: "SSD",
  transport: "SATA",
  mounted: true,
  isSystemDisk: false,
}

const driveC: DiscoveredDrive = {
  devicePath: "/dev/sdc",
  serial: "SERC",
  wwn: null,
  model: "Old External",
  sizeBytes: 500_000_000_000,
  type: "HDD",
  transport: "USB",
  mounted: false,
  isSystemDisk: false,
}

let db: Db
let state: FakeDeviceApiState

beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
  state = { drives: [driveA, driveB] }
})

function build() {
  const deviceApi = new FakeDeviceApi(state)
  const engine = new TestEngine({ db, deviceApi })
  return buildApp({ db, deviceApi, engine })
}

describe("GET /api/drives", () => {
  it("returns discovered drives as present:true with correct fields", async () => {
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/drives" })
    expect(res.statusCode).toBe(200)
    const body = res.json<DriveView[]>()
    expect(body).toHaveLength(2)

    const a = body.find((d) => d.serial === "SERA")
    expect(a).toMatchObject({
      serial: "SERA",
      model: "WDC WD40EFRX",
      sizeBytes: 4_000_787_030_016,
      type: "HDD",
      transport: "SATA",
      present: true,
      mounted: false,
      isSystemDisk: false,
      protected: false,
      latestRun: null,
    })

    const b = body.find((d) => d.serial === "SERB")
    expect(b).toMatchObject({
      serial: "SERB",
      model: "Samsung 870 EVO",
      sizeBytes: 1_000_000_000_000,
      type: "SSD",
      transport: "SATA",
      present: true,
      mounted: true,
      isSystemDisk: false,
      protected: false,
      latestRun: null,
    })
  })

  it("persists discovered drives to the db (upsert)", async () => {
    const app = build()
    await app.inject({ method: "GET", url: "/api/drives" })
    expect(repo.getDrive(db, "SERA")).toBeDefined()
    expect(repo.getDrive(db, "SERB")).toBeDefined()
  })

  it("shows a known-but-not-discovered drive as present:false", async () => {
    repo.upsertDrive(db, driveC)
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/drives" })
    expect(res.statusCode).toBe(200)
    const body = res.json<DriveView[]>()
    expect(body).toHaveLength(3)

    const c = body.find((d) => d.serial === "SERC")
    expect(c).toMatchObject({
      serial: "SERC",
      model: "Old External",
      present: false,
      mounted: false,
      isSystemDisk: false,
    })
  })

  it("attaches the newest run per drive as latestRun", async () => {
    const app = build()
    await app.inject({ method: "GET", url: "/api/drives" }) // discover + upsert so the FK on test_runs is satisfied
    const olderRunId = repo.createRun(db, { driveSerial: "SERA", regime: { mode: "read-only" } })
    repo.updateRun(db, olderRunId, { status: "DONE", verdict: "PASS" })
    const newerRunId = repo.createRun(db, { driveSerial: "SERA", regime: { mode: "read-only" } })
    repo.updateRun(db, newerRunId, { status: "RUNNING", currentStage: "SURFACE" })

    const res = await app.inject({ method: "GET", url: "/api/drives" })
    const body = res.json<DriveView[]>()
    const a = body.find((d) => d.serial === "SERA")
    expect(a?.latestRun).toEqual({
      id: newerRunId,
      status: "RUNNING",
      verdict: null,
      currentStage: "SURFACE",
    })
  })
})

describe("GET /api/drives/:serial", () => {
  it("returns the drive and its runs", async () => {
    const app = build()
    await app.inject({ method: "GET", url: "/api/drives" }) // discover + upsert
    const runId = repo.createRun(db, { driveSerial: "SERA", regime: { mode: "read-only" } })
    repo.updateRun(db, runId, { status: "DONE", verdict: "PASS" })

    const res = await app.inject({ method: "GET", url: "/api/drives/SERA" })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ drive: DriveView; runs: unknown[] }>()
    expect(body.drive.serial).toBe("SERA")
    expect(body.drive.present).toBe(true)
    expect(body.runs).toHaveLength(1)
  })

  it("returns a known-but-absent drive with present:false", async () => {
    repo.upsertDrive(db, driveC)
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/drives/SERC" })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ drive: DriveView; runs: unknown[] }>()
    expect(body.drive.present).toBe(false)
    expect(body.runs).toEqual([])
  })

  it("404s for an unknown serial with a DRIVE_NOT_FOUND code (Fix 2)", async () => {
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/drives/NOPE" })
    expect(res.statusCode).toBe(404)
    const body = res.json<{ error: string; code: string }>()
    expect(body.error).toBeTypeOf("string")
    expect(body.code).toBe("DRIVE_NOT_FOUND")
  })
})

describe("uncaught route errors (Fix 2)", () => {
  it("returns a uniform {error, code:\"INTERNAL\"} 500 instead of Fastify's default {statusCode,error,message} shape", async () => {
    class ThrowingDeviceApi extends FakeDeviceApi {
      override async listDevices(): Promise<DiscoveredDrive[]> {
        throw new Error("smartctl: command not found")
      }
    }
    const deviceApi = new ThrowingDeviceApi(state)
    const engine = new TestEngine({ db, deviceApi })
    const app = buildApp({ db, deviceApi, engine })

    const res = await app.inject({ method: "GET", url: "/api/drives" })

    expect(res.statusCode).toBe(500)
    const body = res.json<{ error: string; code: string; statusCode?: number; message?: string }>()
    expect(body.error).toBe("smartctl: command not found")
    expect(body.code).toBe("INTERNAL")
    // The Fastify-default fields must not leak through.
    expect(body.statusCode).toBeUndefined()
    expect(body.message).toBeUndefined()
  })
})
