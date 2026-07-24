import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CreateRunRequest, DriveView, SettingsView } from "@spindoctor/shared"
import { ApiError, createApiClient } from "./client"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
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

describe("createApiClient", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("getDrives GETs /api/drives and returns the parsed list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([drive]))

    const result = await createApiClient().getDrives()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/drives")
    expect(result).toEqual([drive])
  })

  it("getDrive GETs /api/drives/:serial (encoded) and returns the composite view", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ drive, runs: [] }))

    const result = await createApiClient().getDrive("SER A/1")

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/drives/SER%20A%2F1")
    expect(result).toEqual({ drive, runs: [] })
  })

  it("createRun POSTs a JSON body to /api/runs and returns the new run id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ runId: 42 }, 201))
    const body: CreateRunRequest = { serial: "SERA", mode: "read-only" }

    const result = await createApiClient().createRun(body)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/runs")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(result).toEqual({ runId: 42 })
  })

  it("listRuns GETs /api/runs with no query when serial is omitted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    await createApiClient().listRuns()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs")
  })

  it("listRuns GETs /api/runs?serial=... when a serial is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    await createApiClient().listRuns("SERA")

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs?serial=SERA")
  })

  it("getRun GETs /api/runs/:id and returns the run + stages", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ run: { id: 7 }, stages: [] }))

    const result = await createApiClient().getRun(7)

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runs/7")
    expect(result).toEqual({ run: { id: 7 }, stages: [] })
  })

  it("abortRun POSTs /api/runs/:id/abort", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }, 202))

    const result = await createApiClient().abortRun(7)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/runs/7/abort")
    expect(init.method).toBe("POST")
    expect(result).toEqual({ ok: true })
  })

  it("getSettings GETs /api/settings", async () => {
    const settings: SettingsView = {
      thresholds: { reallocatedWarnMax: 10, ssdPercentageUsedWarn: 80, ssdPercentageUsedFail: 100 },
      concurrency: 2,
      autoModeEnabled: false,
      protectList: [],
    }
    fetchMock.mockResolvedValueOnce(jsonResponse(settings))

    const result = await createApiClient().getSettings()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings")
    expect(result).toEqual(settings)
  })

  it("putSettings PUTs a JSON patch to /api/settings", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        thresholds: { reallocatedWarnMax: 10, ssdPercentageUsedWarn: 80, ssdPercentageUsedFail: 100 },
        concurrency: 3,
        autoModeEnabled: false,
        protectList: [],
      }),
    )

    const result = await createApiClient().putSettings({ concurrency: 3 })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/settings")
    expect(init.method).toBe("PUT")
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
    expect(JSON.parse(init.body as string)).toEqual({ concurrency: 3 })
    expect(result.concurrency).toBe(3)
  })

  it("getAudit GETs /api/audit with no query when limit is omitted", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    await createApiClient().getAudit()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/audit")
  })

  it("getAudit GETs /api/audit?limit=... when a limit is given", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    await createApiClient().getAudit(50)

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/audit?limit=50")
  })

  it("prefixes every request with the given baseUrl", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([drive]))

    await createApiClient("http://localhost:8080").getDrives()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:8080/api/drives")
  })

  it("throws ApiError with status/code/message parsed from a non-2xx body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "confirmation required", code: "CONFIRM_REQUIRED" }, 400))

    const client = createApiClient()
    const rejection = client.createRun({ serial: "SERA", mode: "destructive" })

    await expect(rejection).rejects.toBeInstanceOf(ApiError)
    await expect(rejection).rejects.toMatchObject({
      status: 400,
      code: "CONFIRM_REQUIRED",
      message: "confirmation required",
    })
  })

  it("falls back to a generic error when the non-2xx body isn't the {error,code} shape", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }))

    const client = createApiClient()

    await expect(client.getDrives()).rejects.toMatchObject({
      status: 500,
      code: "UNKNOWN",
    })
  })
})
