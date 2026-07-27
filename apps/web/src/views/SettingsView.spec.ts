import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { SettingsView as SettingsViewDto } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import { setConsoleDeps } from "../stores/useConsoleStore"
import type { ApiClient } from "../api/client"
import SettingsView from "./SettingsView.vue"

const baseSettings: SettingsViewDto = {
  thresholds: {
    reallocatedWarnMax: 4,
    commandTimeoutWarnMax: 100,
    ssdPercentageUsedWarn: 80,
    ssdPercentageUsedFail: 100,
  },
  concurrency: 4,
  autoModeEnabled: false,
  protectList: ["EXISTING1"],
  skipCondemnedDrives: true,
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
  const button = Array.from(root.querySelectorAll("button")).find((b) =>
    b.textContent?.trim().includes(text),
  )
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

  it("reverts and re-locks the switch when the acknowledgment is unchecked after enabling auto-mode, and Save never sends autoModeEnabled: true", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    // Check the acknowledgment — this unlocks the switch.
    const ack = wrapper.find("#auto-mode-ack")
    ;(ack.element as HTMLInputElement).checked = true
    await ack.trigger("input")
    await ack.trigger("change")

    const toggle = wrapper.find("#auto-mode-toggle")
    expect((toggle.element as HTMLInputElement).disabled).toBe(false)

    // Turn the auto-mode switch ON.
    ;(toggle.element as HTMLInputElement).checked = true
    await toggle.trigger("input")
    await toggle.trigger("change")
    expect((wrapper.find("#auto-mode-toggle").element as HTMLInputElement).checked).toBe(true)

    // Now UN-check the acknowledgment.
    const ackAgain = wrapper.find("#auto-mode-ack")
    ;(ackAgain.element as HTMLInputElement).checked = false
    await ackAgain.trigger("input")
    await ackAgain.trigger("change")

    // (a) the switch must be disabled again AND reverted to off.
    const toggleAfterUncheck = wrapper.find("#auto-mode-toggle").element as HTMLInputElement
    expect(toggleAfterUncheck.disabled).toBe(true)
    expect(toggleAfterUncheck.checked).toBe(false)

    // (b) clicking Save must send autoModeEnabled: false — never true.
    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(api.putSettings).toHaveBeenCalledTimes(1)
    expect(api.putSettings).toHaveBeenCalledWith(
      expect.objectContaining({ autoModeEnabled: false }),
    )
    for (const call of api.putSettings.mock.calls) {
      expect(call[0]).not.toMatchObject({ autoModeEnabled: true })
    }

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
      thresholds: {
        reallocatedWarnMax: 4,
        commandTimeoutWarnMax: 100,
        ssdPercentageUsedWarn: 80,
        ssdPercentageUsedFail: 100,
      },
      concurrency: 6,
      autoModeEnabled: false,
      skipCondemnedDrives: true,
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

  // #49: unlike auto-mode, this one needs no acknowledgment gate — turning it
  // *off* is what costs hours, and turning it on can only save them.
  it("loads the condemned-drive early exit from the server and saves it turned off", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    const toggle = wrapper.find("#skip-condemned-toggle")
    expect((toggle.element as HTMLInputElement).checked).toBe(true)
    expect(toggle.attributes("disabled")).toBeUndefined()

    await toggle.setValue(false)
    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(api.putSettings).toHaveBeenCalledWith(
      expect.objectContaining({ skipCondemnedDrives: false }),
    )

    wrapper.unmount()
  })

  // #54: the command-timeout threshold joined the form when the rule was added.
  it("loads and saves the command-timeout threshold", async () => {
    const api = fakeApi()
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect((wrapper.find("#command-timeout-warn-max").element as HTMLInputElement).value).toBe(
      "100",
    )

    await wrapper.find("#command-timeout-warn-max").setValue(50)
    clickButton(document.body, "Save settings")
    await flushPromises()

    expect(api.putSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        thresholds: expect.objectContaining({ commandTimeoutWarnMax: 50 }),
      }),
    )

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

    // Actually trigger removal: click the existing serial's chip close (×)
    // control and confirm it drops out of both the DOM and the saved patch.
    const existingChip = wrapper
      .findAll(".v-chip")
      .find((chip) => chip.text().includes("EXISTING1"))
    if (!existingChip) throw new Error("chip for EXISTING1 not found")
    await existingChip.find(".v-chip__close").trigger("click")
    await flushPromises()

    expect(wrapper.text()).not.toContain("EXISTING1")
    expect(wrapper.text()).toContain("NEWSERIAL")

    clickButton(document.body, "Save settings")
    await flushPromises()
    expect(api.putSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ protectList: ["NEWSERIAL"] }),
    )

    wrapper.unmount()
  })
})
