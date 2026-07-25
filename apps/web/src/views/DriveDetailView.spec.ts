import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createMemoryHistory, createRouter } from "vue-router"
import type { DriveView, RunView, StageView } from "@spindoctor/shared"
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
    metrics: null,
    startedAt: null,
    finishedAt: null,
  },
]

function mountView(serial = "SERA1234") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div>dashboard</div>" } },
      { path: "/drives/:serial", component: DriveDetailView, props: true },
    ],
  })
  return mount(DriveDetailView, {
    props: { serial },
    global: { plugins: [vuetify, router] },
  })
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
      jsonResponse({ run, stages, snapshots: { before: null, after: null } }),
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
