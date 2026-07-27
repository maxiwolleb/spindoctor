import { EventEmitter } from "node:events"
import { createServer as createHttpServer } from "node:http"
import type { AddressInfo } from "node:net"
import { eq } from "drizzle-orm"
import { describe, it, expect, afterEach } from "vitest"
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client"
import type { RunUpdateEvent, StageProgressEvent } from "@spindoctor/shared"
import { createDb } from "../db/client"
import {
  addStage,
  createRun,
  ensureConfig,
  updateRun,
  updateStage,
  upsertDrive,
} from "../db/repositories"
import { stageResults } from "../db/schema"
import { attachRealtime, snapshotEvents, subscribeEngine } from "./realtime"

const seedDrive = (db: Parameters<typeof upsertDrive>[0], serial: string): void =>
  upsertDrive(db, {
    devicePath: "/dev/sda",
    serial,
    wwn: null,
    model: "M",
    sizeBytes: 1,
    type: "HDD",
    transport: "SATA",
    mounted: false,
    isSystemDisk: false,
  })

describe("subscribeEngine", () => {
  it("forwards run:update/stage:progress and removes exactly those listeners on unsubscribe", () => {
    const engine = new EventEmitter()
    const seen: { name: string; payload: unknown }[] = []

    const runBefore = engine.listenerCount("run:update")
    const stageBefore = engine.listenerCount("stage:progress")

    const unsubscribe = subscribeEngine(engine, (name, payload) => seen.push({ name, payload }))

    expect(engine.listenerCount("run:update")).toBe(runBefore + 1)
    expect(engine.listenerCount("stage:progress")).toBe(stageBefore + 1)

    engine.emit("run:update", { runId: 1, driveSerial: "SER1", status: "RUNNING" })
    engine.emit("stage:progress", { runId: 1, driveSerial: "SER1", stage: "SURFACE", percent: 42 })

    expect(seen).toEqual([
      { name: "run:update", payload: { runId: 1, driveSerial: "SER1", status: "RUNNING" } },
      {
        name: "stage:progress",
        payload: { runId: 1, driveSerial: "SER1", stage: "SURFACE", percent: 42 },
      },
    ])

    unsubscribe()

    // Back to baseline: unsubscribe removed exactly what it added, no leak.
    expect(engine.listenerCount("run:update")).toBe(runBefore)
    expect(engine.listenerCount("stage:progress")).toBe(stageBefore)

    engine.emit("run:update", { runId: 2, driveSerial: "SER1", status: "DONE" })
    expect(seen).toHaveLength(2)
  })
})

describe("snapshotEvents", () => {
  it("replays a RUNNING run's current stage + persisted progress", () => {
    const { db } = createDb(":memory:")
    ensureConfig(db)
    seedDrive(db, "SER1")
    const runId = createRun(db, {
      driveSerial: "SER1",
      regime: { mode: "destructive", stages: [] },
    })
    updateRun(db, runId, { status: "RUNNING", currentStage: "SURFACE" })
    const stageId = addStage(db, { runId, stage: "SURFACE", status: "RUNNING" })
    updateStage(db, stageId, { progress: 42 })
    const stageRow = db.select().from(stageResults).where(eq(stageResults.id, stageId)).get()

    expect(snapshotEvents(db)).toEqual([
      {
        name: "run:update",
        payload: { runId, driveSerial: "SER1", status: "RUNNING", currentStage: "SURFACE" },
      },
      {
        name: "stage:progress",
        payload: {
          runId,
          driveSerial: "SER1",
          stage: "SURFACE",
          percent: 42,
          startedAt: stageRow?.startedAt?.toISOString(),
        },
      },
    ])
  })

  it("replays nothing when no run is RUNNING", () => {
    const { db } = createDb(":memory:")
    ensureConfig(db)
    seedDrive(db, "SER1")
    const runId = createRun(db, { driveSerial: "SER1", regime: { mode: "read-only", stages: [] } })
    updateRun(db, runId, { status: "DONE" })
    expect(snapshotEvents(db)).toEqual([])
  })
})

// End-to-end over a real socket, not a stubbed emitter: this is the contract the
// browser actually depends on, and the thing SSE hijacking used to provide.
describe("attachRealtime", () => {
  const clients: ClientSocket[] = []
  const closers: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) c.disconnect()
    for (const close of closers.splice(0)) await close()
  })

  /** Connects a client with an `onAny` recorder attached from the moment the
   * socket is created — the browser likewise registers its handlers
   * synchronously, before the connection round trip completes, so anything the
   * server emits on `connection` is observed rather than raced. */
  async function connect(port: number) {
    const client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
    })
    clients.push(client)
    const events: { name: string; payload: unknown }[] = []
    client.onAny((name: string, payload: unknown) => events.push({ name, payload }))

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => resolve())
      client.on("connect_error", reject)
    })
    return { client, events }
  }

  async function harness(seed?: (db: ReturnType<typeof createDb>["db"]) => void) {
    const { db } = createDb(":memory:")
    ensureConfig(db)
    seedDrive(db, "SER1")
    seed?.(db)

    const engine = new EventEmitter()
    const httpServer = createHttpServer()
    const realtime = attachRealtime({ httpServer, db, engine })

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
    const { port } = httpServer.address() as AddressInfo

    closers.push(async () => {
      await realtime.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    })

    const { client, events } = await connect(port)
    return { db, engine, client, events, port, realtime }
  }

  it("replays in-flight run state to a client the moment it connects", async () => {
    const { events } = await harness((db) => {
      const runId = createRun(db, {
        driveSerial: "SER1",
        regime: { mode: "destructive", stages: [] },
      })
      updateRun(db, runId, { status: "RUNNING", currentStage: "SURFACE" })
      const stageId = addStage(db, { runId, stage: "SURFACE", status: "RUNNING" })
      updateStage(db, stageId, { progress: 42 })
    })

    await new Promise((resolve) => setTimeout(resolve, 150))

    const runUpdates = events.filter((e) => e.name === "run:update")
    const progress = events.filter((e) => e.name === "stage:progress")
    expect(runUpdates).toHaveLength(1)
    expect(runUpdates[0]?.payload as RunUpdateEvent).toMatchObject({
      driveSerial: "SER1",
      status: "RUNNING",
    })
    expect(progress[0]?.payload as StageProgressEvent).toMatchObject({
      stage: "SURFACE",
      percent: 42,
    })
  })

  it("replays nothing to a client that connects while the system is idle", async () => {
    const { events } = await harness()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(events).toEqual([])
  })

  it("pushes engine events to a connected client", async () => {
    const { engine, client } = await harness()

    const got = new Promise<StageProgressEvent>((resolve) => {
      client.on("stage:progress", resolve)
    })
    // Give the snapshot pass time to finish so this is unambiguously live.
    await new Promise((resolve) => setTimeout(resolve, 100))
    engine.emit("stage:progress", {
      runId: 7,
      driveSerial: "SER1",
      stage: "SURFACE",
      percent: 73,
    })

    await expect(got).resolves.toMatchObject({ runId: 7, percent: 73 })
  })

  it("broadcasts to every connected client off a single engine subscription", async () => {
    const { engine, port } = await harness()
    const baseline = engine.listenerCount("stage:progress")

    const others = await Promise.all([connect(port), connect(port)])

    // Fan-out is io.emit's job, so extra clients must not each add a listener —
    // otherwise every open tab would grow the emitter and eventually trip
    // Node's max-listeners warning.
    expect(engine.listenerCount("stage:progress")).toBe(baseline)

    engine.emit("stage:progress", {
      runId: 9,
      driveSerial: "SER1",
      stage: "SURFACE",
      percent: 55,
    })
    await new Promise((resolve) => setTimeout(resolve, 150))

    for (const { events } of others) {
      expect(events.filter((e) => e.name === "stage:progress")).toHaveLength(1)
    }
  })

  it("releases its engine listeners on close", async () => {
    const engine = new EventEmitter()
    const { db } = createDb(":memory:")
    ensureConfig(db)
    const httpServer = createHttpServer()

    const before = engine.listenerCount("run:update")
    const realtime = attachRealtime({ httpServer, db, engine })
    expect(engine.listenerCount("run:update")).toBe(before + 1)

    await realtime.close()
    expect(engine.listenerCount("run:update")).toBe(before)
  })
})
