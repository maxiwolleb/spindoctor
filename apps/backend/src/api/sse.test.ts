import { EventEmitter } from "node:events"
import { describe, it, expect } from "vitest"
import { createDb } from "../db/client"
import {
  addStage,
  createRun,
  ensureConfig,
  updateRun,
  updateStage,
  upsertDrive,
} from "../db/repositories"
import { formatSse, snapshotFrames, subscribeEngine } from "./sse"

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

describe("formatSse", () => {
  it("formats an SSE frame exactly as event: <name>\\ndata: <json>\\n\\n", () => {
    expect(formatSse("run:update", { runId: 1, status: "DONE" })).toBe(
      'event: run:update\ndata: {"runId":1,"status":"DONE"}\n\n',
    )
  })
})

describe("subscribeEngine", () => {
  it("writes formatted frames for run:update/stage:progress and removes exactly those listeners on unsubscribe", () => {
    const engine = new EventEmitter()
    const frames: string[] = []

    const runUpdateListenersBefore = engine.listenerCount("run:update")
    const stageProgressListenersBefore = engine.listenerCount("stage:progress")

    const unsubscribe = subscribeEngine(engine, (frame) => frames.push(frame))

    expect(engine.listenerCount("run:update")).toBe(runUpdateListenersBefore + 1)
    expect(engine.listenerCount("stage:progress")).toBe(stageProgressListenersBefore + 1)

    engine.emit("run:update", {
      runId: 1,
      driveSerial: "SER1",
      status: "RUNNING",
      currentStage: "SMART_BEFORE",
    })
    engine.emit("stage:progress", { runId: 1, driveSerial: "SER1", stage: "SURFACE", percent: 42 })

    expect(frames).toEqual([
      'event: run:update\ndata: {"runId":1,"driveSerial":"SER1","status":"RUNNING","currentStage":"SMART_BEFORE"}\n\n',
      'event: stage:progress\ndata: {"runId":1,"driveSerial":"SER1","stage":"SURFACE","percent":42}\n\n',
    ])

    unsubscribe()

    // Listener counts back to baseline: unsubscribe removed exactly what it added, no leak.
    expect(engine.listenerCount("run:update")).toBe(runUpdateListenersBefore)
    expect(engine.listenerCount("stage:progress")).toBe(stageProgressListenersBefore)

    engine.emit("run:update", { runId: 2, driveSerial: "SER1", status: "DONE" })
    engine.emit("stage:progress", { runId: 2, driveSerial: "SER1", stage: "SURFACE", percent: 100 })

    expect(frames).toHaveLength(2)
  })
})

describe("snapshotFrames", () => {
  it("replays a RUNNING run's current stage + persisted progress as run:update + stage:progress", () => {
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

    expect(snapshotFrames(db)).toEqual([
      `event: run:update\ndata: {"runId":${runId},"driveSerial":"SER1","status":"RUNNING","currentStage":"SURFACE"}\n\n`,
      `event: stage:progress\ndata: {"runId":${runId},"driveSerial":"SER1","stage":"SURFACE","percent":42}\n\n`,
    ])
  })

  it("emits nothing when no run is RUNNING", () => {
    const { db } = createDb(":memory:")
    ensureConfig(db)
    seedDrive(db, "SER1")
    const runId = createRun(db, { driveSerial: "SER1", regime: { mode: "read-only", stages: [] } })
    updateRun(db, runId, { status: "DONE" })
    expect(snapshotFrames(db)).toEqual([])
  })
})
