import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { DriveView, RunUpdateEvent, SettingsView, StageProgressEvent } from "@spindoctor/shared"
import { setConsoleDeps, useConsoleStore } from "./useConsoleStore"
import type { EventSourceLike } from "./useConsoleStore"

/** Minimal `EventSource` double: records `addEventListener` callbacks per
 * event name and lets a test fire one via `emit`, which is exactly what a
 * real `EventSource` does when a frame arrives — construct a `MessageEvent`
 * -shaped object (`{ data: <json string> }`) and invoke every listener
 * registered for that event name. */
class FakeEventSource implements EventSourceLike {
  private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  closed = false

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  /** Test helper: dispatches a frame to every listener registered for
   * `type`, JSON-encoding `dataObj` the way a real SSE frame's `data` field
   * would arrive. Passing `undefined` (for `open`/`error`) emits an event
   * with no `data` field, matching a real `Event`. */
  emit(type: string, dataObj?: unknown): void {
    const list = this.listeners.get(type) ?? []
    const event = (dataObj === undefined ? {} : { data: JSON.stringify(dataObj) }) as MessageEvent
    for (const listener of list) listener(event)
  }
}

const drive: DriveView = {
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
}

const settings: SettingsView = {
  thresholds: { reallocatedWarnMax: 10, ssdPercentageUsedWarn: 80, ssdPercentageUsedFail: 100 },
  concurrency: 2,
  autoModeEnabled: false,
  protectList: [],
}

function fakeApi() {
  return {
    getDrives: vi.fn().mockResolvedValue([drive]),
    getDrive: vi.fn(),
    createRun: vi.fn().mockResolvedValue({ runId: 42 }),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    abortRun: vi.fn().mockResolvedValue({ ok: true }),
    getSettings: vi.fn().mockResolvedValue(settings),
    putSettings: vi.fn(),
    getAudit: vi.fn(),
  }
}

describe("useConsoleStore", () => {
  let api: ReturnType<typeof fakeApi>
  let source: FakeEventSource

  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    source = new FakeEventSource()
    setConsoleDeps({ api, eventSourceFactory: () => source })
  })

  it("refreshDrives populates drives from the api", async () => {
    const store = useConsoleStore()

    await store.refreshDrives()

    expect(api.getDrives).toHaveBeenCalledTimes(1)
    expect(store.drives).toEqual([drive])
  })

  it("refreshSettings populates settings from the api", async () => {
    const store = useConsoleStore()

    await store.refreshSettings()

    expect(api.getSettings).toHaveBeenCalledTimes(1)
    expect(store.settings).toEqual(settings)
  })

  it("connectEvents flips connected true on open, false on error", () => {
    const store = useConsoleStore()

    store.connectEvents()
    expect(store.connected).toBe(false)

    source.emit("open")
    expect(store.connected).toBe(true)

    source.emit("error")
    expect(store.connected).toBe(false)
  })

  it("a second connectEvents() call closes the previous EventSource (no double-subscribe)", () => {
    const store = useConsoleStore()

    store.connectEvents()
    const first = source
    first.emit("open")
    expect(first.closed).toBe(false)
    expect(store.connected).toBe(true)

    const second = new FakeEventSource()
    setConsoleDeps({ eventSourceFactory: () => second })
    store.connectEvents()

    expect(first.closed).toBe(true)
    // Re-mount tore down the stale connection: connected reflects only the
    // new source now, not a leftover "true" from the closed one.
    expect(store.connected).toBe(false)

    second.emit("open")
    expect(store.connected).toBe(true)
  })

  it("disconnectEvents closes the source and sets connected false", () => {
    const store = useConsoleStore()
    store.connectEvents()
    source.emit("open")
    expect(store.connected).toBe(true)

    store.disconnectEvents()

    expect(source.closed).toBe(true)
    expect(store.connected).toBe(false)
  })

  it("a stage:progress frame updates liveByDrive percent/stage for the known driveSerial", () => {
    const store = useConsoleStore()
    store.connectEvents()

    const frame: StageProgressEvent = { runId: 1, driveSerial: "SERA", stage: "SURFACE", percent: 42 }
    source.emit("stage:progress", frame)

    expect(store.liveByDrive.SERA).toMatchObject({ runId: 1, stage: "SURFACE", percent: 42 })
    expect(store.liveForDrive("SERA")).toMatchObject({ stage: "SURFACE", percent: 42 })
  })

  it("a non-terminal run:update frame updates liveByDrive without touching drives", async () => {
    const store = useConsoleStore()
    await store.refreshDrives()
    store.connectEvents()

    const frame: RunUpdateEvent = { runId: 1, driveSerial: "SERA", status: "RUNNING", currentStage: "SELFTEST_LONG" }
    source.emit("run:update", frame)

    expect(store.liveByDrive.SERA).toMatchObject({ runId: 1, stage: "SELFTEST_LONG", status: "RUNNING" })
    expect(store.driveBySerial("SERA")?.latestRun).toBeNull()
  })

  it("a terminal run:update frame patches the drive's latestRun verdict and clears liveByDrive", async () => {
    const store = useConsoleStore()
    await store.refreshDrives()
    store.connectEvents()

    source.emit("stage:progress", { runId: 1, driveSerial: "SERA", stage: "SURFACE", percent: 90 } satisfies StageProgressEvent)
    expect(store.liveByDrive.SERA).toBeDefined()

    const frame: RunUpdateEvent = {
      runId: 1,
      driveSerial: "SERA",
      status: "DONE",
      currentStage: "VERDICT",
      verdict: "PASS",
    }
    source.emit("run:update", frame)

    expect(store.driveBySerial("SERA")?.latestRun).toEqual({
      id: 1,
      status: "DONE",
      verdict: "PASS",
      currentStage: "VERDICT",
    })
    expect(store.liveByDrive.SERA).toBeUndefined()
  })

  it("startTest calls createRun with the right args and then refreshes drives", async () => {
    const store = useConsoleStore()

    await store.startTest("SERA", "read-only")

    expect(api.createRun).toHaveBeenCalledWith({ serial: "SERA", mode: "read-only", confirm: undefined })
    expect(api.getDrives).toHaveBeenCalledTimes(1)
    expect(store.drives).toEqual([drive])
  })

  it("startTest rethrows when createRun rejects, without refreshing drives", async () => {
    const store = useConsoleStore()
    const failure = new Error("confirmation required")
    api.createRun.mockRejectedValueOnce(failure)

    await expect(store.startTest("SERA", "destructive", "WRONG")).rejects.toThrow("confirmation required")

    expect(api.getDrives).not.toHaveBeenCalled()
    expect(store.error).toBe("confirmation required")
  })

  it("abort calls api.abortRun and records an error on failure without throwing", async () => {
    const store = useConsoleStore()
    api.abortRun.mockRejectedValueOnce(new Error("run not found"))

    await store.abort(7)

    expect(api.abortRun).toHaveBeenCalledWith(7)
    expect(store.error).toBe("run not found")
  })

  it("saveSettings calls putSettings with the patch and adopts the response", async () => {
    const store = useConsoleStore()
    const updated: SettingsView = { ...settings, concurrency: 6 }
    api.putSettings.mockResolvedValue(updated)

    await store.saveSettings({ concurrency: 6 })

    expect(api.putSettings).toHaveBeenCalledWith({ concurrency: 6 })
    expect(store.settings).toEqual(updated)
  })

  it("saveSettings rethrows and records the error message on failure", async () => {
    const store = useConsoleStore()
    api.putSettings.mockRejectedValueOnce(new Error("concurrency must be an integer >= 1"))

    await expect(store.saveSettings({ concurrency: 0 })).rejects.toThrow("concurrency must be an integer >= 1")
    expect(store.error).toBe("concurrency must be an integer >= 1")
  })
})
