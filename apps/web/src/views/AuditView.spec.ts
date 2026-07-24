import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { vuetify } from "../plugins/vuetify"
import type { AuditEntry } from "../api/client"
import AuditView from "./AuditView.vue"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function mountView() {
  return mount(AuditView, { global: { plugins: [vuetify] } })
}

describe("AuditView", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders audit entries newest-first regardless of the order the api returned them", async () => {
    const entries: AuditEntry[] = [
      { id: 1, ts: "2026-01-01T00:00:00.000Z", action: "run.started", driveSerial: "OLDEST", detail: "read-only scan" },
      { id: 3, ts: "2026-01-03T00:00:00.000Z", action: "settings.updated", driveSerial: null, detail: "concurrency: 2 -> 4" },
      { id: 2, ts: "2026-01-02T00:00:00.000Z", action: "run.finished", driveSerial: "MIDDLE", detail: "verdict: PASS" },
    ]
    fetchMock.mockResolvedValueOnce(jsonResponse(entries))

    const wrapper = mountView()
    await flushPromises()

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/audit")

    const rows = wrapper.findAll("tbody tr")
    expect(rows).toHaveLength(3)
    expect(rows[0]?.text()).toContain("settings.updated")
    expect(rows[0]?.text()).toContain("concurrency: 2 -> 4")
    expect(rows[1]?.text()).toContain("MIDDLE")
    expect(rows[2]?.text()).toContain("OLDEST")

    // No drive serial on the settings.updated row renders as an em dash, not blank.
    expect(rows[0]?.text()).toContain("—")
  })

  it("shows an empty state when there is no audit history yet", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]))

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain("No activity yet.")
  })
})
