import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type {
  DriveView,
  RunUpdateEvent,
  SettingsView,
  StageProgressEvent,
} from "@spindoctor/shared"
import { setConsoleDeps, useConsoleStore } from "./useConsoleStore"
import type { RealtimeConnection } from "../api/realtime"

/** Minimal `RealtimeConnection` double: records the listener registered for
 * each event and lets a test fire it via `emit`. Payloads are passed through
 * as-is, exactly as socket.io-client delivers them (already decoded — no
 * JSON string to unwrap, unlike the raw SSE frames this replaced). */
class FakeRealtime implements RealtimeConnection {
  private readonly listeners = new Map<string, Array<(payload?: unknown) => void>>()
  closed = false

  private add(type: string, listener: (payload?: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  onConnect(listener: () => void): void {
    this.add("connect", listener)
  }
  onDisconnect(listener: () => void): void {
    this.add("disconnect", listener)
  }
  onRunUpdate(listener: (payload: RunUpdateEvent) => void): void {
    this.add("run:update", listener as (payload?: unknown) => void)
  }
  onStageProgress(listener: (payload: StageProgressEvent) => void): void {
    this.add("stage:progress", listener as (payload?: unknown) => void)
  }
  close(): void {
    this.closed = true
  }

  /** Test helper: dispatches `payload` to every listener registered for `type`. */
  emit(type: string, payload?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(payload)
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
  thresholds: {
    reallocatedWarnMax: 4,
    commandTimeoutWarnMax: 100,
    ssdPercentageUsedWarn: 80,
    ssdPercentageUsedFail: 100,
  },
  concurrency: 2,
  autoModeEnabled: false,
  protectList: [],
  skipCondemnedDrives: true,
}

function fakeApi() {
  return {
    getDrives: vi.fn().mockResolvedValue([drive]),
    getDrive: vi.fn(),
    createRun: vi.fn().mockResolvedValue({ runId: 42 }),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    getRunLogUrl: vi.fn(),
    getRunSmartUrl: vi.fn(),
    abortRun: vi.fn().mockResolvedValue({ ok: true }),
    getSettings: vi.fn().mockResolvedValue(settings),
    putSettings: vi.fn(),
    getAudit: vi.fn(),
  }
}

describe("useConsoleStore", () => {
  let api: ReturnType<typeof fakeApi>
  let source: FakeRealtime

  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    source = new FakeRealtime()
    setConsoleDeps({ api, realtimeFactory: () => source })
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

  it("connectEvents flips connected true on connect, false on disconnect", () => {
    const store = useConsoleStore()

    store.connectEvents()
    expect(store.connected).toBe(false)

    source.emit("connect")
    expect(store.connected).toBe(true)

    source.emit("disconnect")
    expect(store.connected).toBe(false)
  })

  it("a second connectEvents() call closes the previous connection (no double-subscribe)", () => {
    const store = useConsoleStore()

    store.connectEvents()
    const first = source
    first.emit("connect")
    expect(first.closed).toBe(false)
    expect(store.connected).toBe(true)

    const second = new FakeRealtime()
    setConsoleDeps({ realtimeFactory: () => second })
    store.connectEvents()

    expect(first.closed).toBe(true)
    // Re-mount tore down the stale connection: connected reflects only the
    // new source now, not a leftover "true" from the closed one.
    expect(store.connected).toBe(false)

    second.emit("connect")
    expect(store.connected).toBe(true)
  })

  it("disconnectEvents closes the source and sets connected false", () => {
    const store = useConsoleStore()
    store.connectEvents()
    source.emit("connect")
    expect(store.connected).toBe(true)

    store.disconnectEvents()

    expect(source.closed).toBe(true)
    expect(store.connected).toBe(false)
  })

  it("a stage:progress frame updates liveByDrive percent/stage/startedAt for the known driveSerial", () => {
    const store = useConsoleStore()
    store.connectEvents()

    const frame: StageProgressEvent = {
      runId: 1,
      driveSerial: "SERA",
      stage: "SURFACE",
      percent: 42,
      startedAt: "2026-07-25T09:00:00.000Z",
      declaredTotalMinutes: null,
    }
    source.emit("stage:progress", frame)

    expect(store.liveByDrive.SERA).toMatchObject({
      runId: 1,
      stage: "SURFACE",
      percent: 42,
      startedAt: "2026-07-25T09:00:00.000Z",
      declaredTotalMinutes: null,
    })
    expect(store.liveForDrive("SERA")).toMatchObject({ stage: "SURFACE", percent: 42 })
  })

  // #61: the dashboard's ETA cell has no access to stage rows, so the drive's
  // own self-test duration has to ride along on the live frame.
  it("threads a stage:progress frame's declared duration into liveByDrive", () => {
    const store = useConsoleStore()
    store.connectEvents()

    source.emit("stage:progress", {
      runId: 1,
      driveSerial: "SERA",
      stage: "SELFTEST_LONG",
      percent: 10,
      startedAt: "2026-07-25T09:00:00.000Z",
      declaredTotalMinutes: 97,
    } satisfies StageProgressEvent)

    expect(store.liveByDrive.SERA).toMatchObject({ declaredTotalMinutes: 97 })
  })

  it("a non-terminal run:update frame updates liveByDrive without touching drives", async () => {
    const store = useConsoleStore()
    await store.refreshDrives()
    store.connectEvents()

    const frame: RunUpdateEvent = {
      runId: 1,
      driveSerial: "SERA",
      status: "RUNNING",
      currentStage: "SELFTEST_LONG",
    }
    source.emit("run:update", frame)

    expect(store.liveByDrive.SERA).toMatchObject({
      runId: 1,
      stage: "SELFTEST_LONG",
      status: "RUNNING",
    })
    expect(store.driveBySerial("SERA")?.latestRun).toBeNull()
  })

  it("a stage transition drops the previous stage's percent/startedAt instead of carrying them under the new stage's name", () => {
    const store = useConsoleStore()
    store.connectEvents()

    source.emit("stage:progress", {
      runId: 1,
      driveSerial: "SERA",
      stage: "SELFTEST_LONG",
      percent: 80,
      startedAt: "2026-07-25T08:00:00.000Z",
      declaredTotalMinutes: 97,
    } satisfies StageProgressEvent)
    expect(store.liveByDrive.SERA).toMatchObject({ stage: "SELFTEST_LONG", percent: 80 })

    // SELFTEST_LONG finished; the run moves on to SURFACE. Until SURFACE's
    // own stage:progress frame arrives, percent/startedAt must reset rather
    // than keep showing SELFTEST_LONG's 80%/08:00 under the SURFACE label —
    // and the self-test's declared duration must go with them, or the surface
    // scan would be estimated from the self-test's clock (#61).
    source.emit("run:update", {
      runId: 1,
      driveSerial: "SERA",
      status: "RUNNING",
      currentStage: "SURFACE",
    } satisfies RunUpdateEvent)

    expect(store.liveByDrive.SERA).toMatchObject({
      stage: "SURFACE",
      percent: 0,
      startedAt: null,
      declaredTotalMinutes: null,
    })
  })

  it("a terminal run:update frame patches the drive's latestRun verdict and clears liveByDrive", async () => {
    const store = useConsoleStore()
    await store.refreshDrives()
    store.connectEvents()

    source.emit("stage:progress", {
      runId: 1,
      driveSerial: "SERA",
      stage: "SURFACE",
      percent: 90,
      startedAt: "2026-07-25T09:00:00.000Z",
      declaredTotalMinutes: null,
    } satisfies StageProgressEvent)
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

    await store.startTest({ serial: "SERA", mode: "read-only" })

    expect(api.createRun).toHaveBeenCalledWith({ serial: "SERA", mode: "read-only" })
    expect(api.getDrives).toHaveBeenCalledTimes(1)
    expect(store.drives).toEqual([drive])
  })

  it("startTest rethrows when createRun rejects, without refreshing drives", async () => {
    const store = useConsoleStore()
    const failure = new Error("confirmation required")
    api.createRun.mockRejectedValueOnce(failure)

    await expect(
      store.startTest({ serial: "SERA", mode: "destructive", confirm: "WRONG" }),
    ).rejects.toThrow("confirmation required")

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

    await expect(store.saveSettings({ concurrency: 0 })).rejects.toThrow(
      "concurrency must be an integer >= 1",
    )
    expect(store.error).toBe("concurrency must be an integer >= 1")
  })
})
