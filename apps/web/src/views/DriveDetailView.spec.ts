import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { useConsoleStore } from "../stores/useConsoleStore"
import type { DriveView, RunView, SmartAttributeRow, StageView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import DriveDetailView from "./DriveDetailView.vue"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const drive: DriveView = {
  serial: "SERA1234",
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  present: true,
  mounted: false,
  isSystemDisk: false,
  protected: false,
  latestRun: { id: 9, status: "DONE", verdict: "PASS", currentStage: "VERDICT" },
}

const run: RunView = {
  id: 9,
  driveSerial: "SERA1234",
  mode: "destructive",
  status: "DONE",
  verdict: "PASS",
  reasons: [],
  currentStage: "VERDICT",
  restartCount: 0,
  error: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T01:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
}

const stages: StageView[] = [
  {
    id: 1,
    runId: 9,
    stage: "SMART_BEFORE",
    status: "DONE",
    progress: 100,
    logPath: null,
    log: null,
    metrics: null,
    startedAt: null,
    finishedAt: null,
  },
  {
    id: 2,
    runId: 9,
    stage: "VERDICT",
    status: "DONE",
    progress: 100,
    logPath: null,
    log: null,
    metrics: null,
    startedAt: null,
    finishedAt: null,
  },
]

const reallocatedAttribute: SmartAttributeRow = {
  id: 5,
  name: "Reallocated_Sector_Ct",
  value: 100,
  worst: 100,
  thresh: 10,
  rawValue: 5,
  rawString: null,
  health: "warn",
}

function mountView(serial = "SERA1234") {
  // The view reads live run state off the shared store now (#21), so it needs an
  // active Pinia. Activated here too, so a test can grab the same store
  // instance with useConsoleStore() and drive the live state directly.
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>dashboard</div>" } },
      { path: "/drives/:serial", component: DriveDetailView, props: true },
    ],
  })
  return mount(DriveDetailView, {
    props: { serial },
    global: { plugins: [vuetify, pinia, router] },
  })
}

/** The two fetches a mount performs: `GET /api/drives/:serial`, then
 * `GET /api/runs/:id` for the newest run. */
function mockLoad(fetchMock: ReturnType<typeof vi.fn>, over: Partial<RunView> = {}): void {
  fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [{ ...run, ...over }] }))
  fetchMock.mockResolvedValueOnce(
    jsonResponse({
      run: { ...run, ...over },
      stages,
      snapshots: { before: { reallocatedSectors: 0 }, after: { reallocatedSectors: 5 } },
      attributes: { before: [], after: [] },
    }),
  )
}

describe("DriveDetailView", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("loads the drive + latest run and renders header, SMART diff, and stage timeline", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [run] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run,
        stages,
        snapshots: { before: { reallocatedSectors: 0 }, after: { reallocatedSectors: 5 } },
        attributes: { before: [], after: [] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/drives/SERA1234")
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/runs/9")

    const text = wrapper.text()
    expect(text).toContain("WDC WD40EFRX")
    expect(text).toContain("SERA1234")
    expect(text).toContain("4.0 TB")
    expect(text).toContain("Pass")
    expect(text).toContain("Reallocated sectors")
    expect(text).toContain("+5")
    expect(text).toContain("SMART (before)")
    expect(text).toContain("Back to dashboard")
  })

  // #49: a run the baseline gate cut short is a FAIL with skipped stages, so
  // the reasons are the only thing on the page that explains it.
  it("renders the verdict's reasons, worst first, for a run cut short by the baseline gate", async () => {
    const failed: Partial<RunView> = {
      verdict: "FAIL",
      reasons: [
        {
          code: "SELFTEST_SKIPPED",
          severity: "info",
          message: "Long self-test skipped — baseline SMART already condemned the drive",
        },
        { code: "SMART_HEALTH_FAILED", severity: "fail", message: "Drive reports failing health" },
      ],
    }
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [{ ...run, ...failed }] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run: { ...run, ...failed },
        stages: [
          stages[0]!,
          { ...stages[0]!, id: 3, stage: "SELFTEST_LONG", status: "SKIPPED", progress: 0 },
          stages[1]!,
        ],
        snapshots: { before: { reallocatedSectors: 0 }, after: null },
        attributes: { before: [], after: [] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain("Why this verdict")
    expect(wrapper.text()).toContain("Drive reports failing health")
    expect(wrapper.text()).toContain("Long self-test skipped")
    expect(wrapper.text()).toContain("Skipped")
    const items = wrapper.findAll(".verdict-reasons__item")
    expect(items[0]!.text()).toContain("SMART_HEALTH_FAILED")
  })

  it("shows no reasons section for a run with no verdict yet", async () => {
    mockLoad(fetchMock, { verdict: null, status: "RUNNING" })

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).not.toContain("Why this verdict")
  })

  it("renders a download-log link pointing at the latest run's log endpoint (#13)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [run] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run,
        stages,
        snapshots: { before: null, after: null },
        attributes: { before: [], after: [] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    const link = wrapper.find(`a[href="/api/runs/${run.id}/log"]`)
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain("Download log")
    expect(link.attributes("download")).toBeDefined()
  })

  it("renders the full SMART attribute table (defaulting to the after snapshot) with a raw-SMART download link (#14)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [run] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run,
        stages,
        snapshots: { before: { reallocatedSectors: 0 }, after: { reallocatedSectors: 5 } },
        attributes: { before: [], after: [reallocatedAttribute] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain("SMART attributes")
    expect(wrapper.text()).toContain("retired after finding them bad")
    expect(wrapper.find(".smart-attributes-table__row--warn").exists()).toBe(true)

    const link = wrapper.find(`a[href="/api/runs/${run.id}/smart"]`)
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain("Download raw SMART")
    expect(link.attributes("download")).toBeDefined()
  })

  it("falls back to the before snapshot for the attribute table when after has none yet", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [run] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run,
        stages,
        snapshots: { before: { reallocatedSectors: 5 }, after: null },
        attributes: { before: [reallocatedAttribute], after: [] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain("Reallocated sectors")
    expect(wrapper.find(".smart-attributes-table__row--warn").exists()).toBe(true)
  })

  it("shows a not-found message for an unknown serial instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'no drive found with serial "GHOST"', code: "DRIVE_NOT_FOUND" }, 404),
    )

    const wrapper = mountView("GHOST")
    await flushPromises()

    expect(wrapper.text()).toContain("No drive found")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("lists every run in the history with mode and verdict", async () => {
    const secondRun: RunView = { ...run, id: 8, verdict: "FAIL", mode: "read-only" }
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [run, secondRun] }))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        run,
        stages,
        snapshots: { before: null, after: null },
        attributes: { before: [], after: [] },
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain("Fail")
    expect(text).toContain("Read-only scan")
    expect(text).toContain("Full destructive test")
  })

  it("shows an empty state when the drive has no runs yet", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ drive: { ...drive, latestRun: null }, runs: [] }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain("No test runs yet")
    expect(wrapper.text()).toContain("No runs recorded")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("DriveDetailView live updates (#21)", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows live activity and advances the timeline's running stage from the shared connection", async () => {
    mockLoad(fetchMock, { status: "RUNNING", verdict: null, currentStage: "SMART_BEFORE" })

    const wrapper = mountView()
    await flushPromises()

    const store = useConsoleStore()
    store.liveByDrive.SERA1234 = {
      runId: 9,
      stage: "SMART_BEFORE",
      percent: 64,
      status: "RUNNING",
      verdict: null,
      startedAt: "2026-01-01T00:00:00.000Z",
    }
    await flushPromises()

    expect(wrapper.find('[data-test="live-activity"]').exists()).toBe(true)
    // The fetched row said 100%; the live percent must win for the running stage.
    expect(wrapper.text()).toContain("64%")
  })

  it("renders no live activity block when nothing is running for this drive", async () => {
    mockLoad(fetchMock)

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-test="live-activity"]').exists()).toBe(false)
  })

  it("reloads when the run goes terminal, so verdict and after-SMART appear without a reload", async () => {
    mockLoad(fetchMock, { status: "RUNNING", verdict: null, currentStage: "SURFACE" })

    const wrapper = mountView()
    await flushPromises()

    const store = useConsoleStore()
    store.liveByDrive.SERA1234 = {
      runId: 9,
      stage: "SURFACE",
      percent: 12,
      status: "RUNNING",
      verdict: null,
      startedAt: null,
    }
    await flushPromises()
    const callsBefore = fetchMock.mock.calls.length

    // Terminal drops the live entry — the store's own behavior on a terminal
    // run:update — which is this page's cue that everything it shows changed.
    mockLoad(fetchMock)
    delete store.liveByDrive.SERA1234
    await flushPromises()

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(wrapper.find('[data-test="live-activity"]').exists()).toBe(false)
  })
})
