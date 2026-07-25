import { EventEmitter } from "node:events"
import { describe, it, expect } from "vitest"
import { formatSse, subscribeEngine } from "./sse"

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
