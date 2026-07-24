import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { SettingsView as SettingsViewDto } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import { setConsoleDeps } from "../stores/useConsoleStore"
import type { ApiClient } from "../api/client"
import SettingsView from "./SettingsView.vue"

const baseSettings: SettingsViewDto = {
  thresholds: { reallocatedWarnMax: 10, ssdPercentageUsedWarn: 80, ssdPercentageUsedFail: 100 },
  concurrency: 4,
  autoModeEnabled: false,
  protectList: ["EXISTING1"],
}

function fakeApi(settings: SettingsViewDto = baseSettings) {
  return {
    getDrives: vi.fn(),
    getDrive: vi.fn(),
    createRun: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    abortRun: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(settings),
    putSettings: vi.fn().mockImplementation((patch) => Promise.resolve({ ...settings, ...patch })),
    getAudit: vi.fn(),
  }
}

function clickButton(root: HTMLElement, text: string): void {
  const button = Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim().includes(text))
  if (!button) throw new Error(`button "${text}" not found`)
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

describe("SettingsView", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ""
  })

  it("keeps the auto-mode switch disabled until the acknowledgment checkbox is checked", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    const toggle = wrapper.find("#auto-mode-toggle")
    expect((toggle.element as HTMLInputElement).disabled).toBe(true)

    const ack = wrapper.find("#auto-mode-ack")
    ;(ack.element as HTMLInputElement).checked = true
    await ack.trigger("input")
    await ack.trigger("change")

    expect((wrapper.find("#auto-mode-toggle").element as HTMLInputElement).disabled).toBe(false)

    wrapper.unmount()
  })

  it("already-enabled auto-mode from the server loads with the switch on and unlocked", async () => {
    const api = fakeApi({ ...baseSettings, autoModeEnabled: true })
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    const toggle = wrapper.find("#auto-mode-toggle").element as HTMLInputElement
    expect(toggle.disabled).toBe(false)
    expect(toggle.checked).toBe(true)

    wrapper.unmount()
  })

  it("blocks save when concurrency is invalid (0), without calling putSettings", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    await wrapper.find("#concurrency").setValue(0)
    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(api.putSettings).not.toHaveBeenCalled()
    expect(wrapper.text().toLowerCase()).toContain("concurrency")

    wrapper.unmount()
  })

  it("saves a valid patch and shows a success message", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    await wrapper.find("#concurrency").setValue(6)
    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(api.putSettings).toHaveBeenCalledWith({
      thresholds: { reallocatedWarnMax: 10, ssdPercentageUsedWarn: 80, ssdPercentageUsedFail: 100 },
      concurrency: 6,
      autoModeEnabled: false,
      protectList: ["EXISTING1"],
    })
    // v-snackbar teleports its content to the shared overlay container under
    // document.body, so it won't show up in wrapper.text().
    expect(document.body.textContent).toContain("Settings saved")

    wrapper.unmount()
  })

  it("shows an error message with the ApiError text when save fails", async () => {
    const api = fakeApi()
    api.putSettings.mockRejectedValueOnce(new Error("concurrency must be an integer >= 1"))
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(document.body.textContent).toContain("concurrency must be an integer >= 1")

    wrapper.unmount()
  })

  it("adds and removes protect-list entries", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain("EXISTING1")

    await wrapper.find("#new-protected-serial").setValue("NEWSERIAL")
    clickButton(document.body, "Add")
    await flushPromises()
    expect(wrapper.text()).toContain("NEWSERIAL")

    clickButton(document.body, "Save settings")
    await flushPromises()
    expect(api.putSettings).toHaveBeenCalledWith(
      expect.objectContaining({ protectList: ["EXISTING1", "NEWSERIAL"] }),
    )

    wrapper.unmount()
  })
})
