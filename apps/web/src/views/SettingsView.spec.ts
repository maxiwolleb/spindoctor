import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { DriveView, SettingsView as SettingsViewDto } from "@spindoctor/shared"
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
  diagnosticsEnabled: false,
  diagnosticsIncludeSerials: false,
}

function fakeApi(settings: SettingsViewDto = baseSettings, drives: DriveView[] = []) {
  return {
    // SettingsView loads drives too: the protect list is checked against what
    // spindoctor can currently see, so an entry that matches nothing can be
    // flagged as a possible typo (issue #88).
    getDrives: vi.fn().mockResolvedValue(drives),
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

/** Minimal `DriveView` — only `serial` matters to the protect-list check. */
function drive(serial: string): DriveView {
  return {
    serial,
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
      diagnosticsEnabled: false,
      diagnosticsIncludeSerials: false,
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

  // Diagnostics is opt-in, and the download follows what the SERVER has saved —
  // not the unsaved form — because the route 404s while the flag is off.
  describe("diagnostics", () => {
    it("hides the serials sub-toggle and the download until it is enabled", async () => {
      const api = fakeApi()
      setConsoleDeps({ api: api as unknown as ApiClient })
      const wrapper = mount(SettingsView, {
        global: { plugins: [vuetify] },
        attachTo: document.body,
      })
      await flushPromises()

      expect(wrapper.find("#diagnostics-toggle").exists()).toBe(true)
      expect(wrapper.find("#diagnostics-serials-toggle").exists()).toBe(false)
      expect(wrapper.find('a[href="/api/diagnostics/bundle"]').exists()).toBe(false)
      expect(wrapper.text()).toContain("Save settings to enable the download")

      wrapper.unmount()
    })

    it("reveals the sub-toggle as soon as it is switched on, before saving", async () => {
      const api = fakeApi()
      setConsoleDeps({ api: api as unknown as ApiClient })
      const wrapper = mount(SettingsView, {
        global: { plugins: [vuetify] },
        attachTo: document.body,
      })
      await flushPromises()

      await wrapper.find("#diagnostics-toggle").setValue(true)
      expect(wrapper.find("#diagnostics-serials-toggle").exists()).toBe(true)
      // Still no download: the server hasn't been told yet, so the route would 404.
      expect(wrapper.find('a[href="/api/diagnostics/bundle"]').exists()).toBe(false)

      wrapper.unmount()
    })

    it("offers the download once the server reports it enabled", async () => {
      const api = fakeApi({ ...baseSettings, diagnosticsEnabled: true })
      setConsoleDeps({ api: api as unknown as ApiClient })
      const wrapper = mount(SettingsView, {
        global: { plugins: [vuetify] },
        attachTo: document.body,
      })
      await flushPromises()

      const link = wrapper.find('a[href="/api/diagnostics/bundle"]')
      expect(link.exists()).toBe(true)
      expect(link.attributes("download")).toBeDefined()

      wrapper.unmount()
    })

    it("saves both flags", async () => {
      const api = fakeApi()
      setConsoleDeps({ api: api as unknown as ApiClient })
      const wrapper = mount(SettingsView, {
        global: { plugins: [vuetify] },
        attachTo: document.body,
      })
      await flushPromises()

      await wrapper.find("#diagnostics-toggle").setValue(true)
      await wrapper.find("#diagnostics-serials-toggle").setValue(true)
      clickButton(document.body, "Save settings")
      await flushPromises()

      expect(api.putSettings).toHaveBeenCalledWith(
        expect.objectContaining({ diagnosticsEnabled: true, diagnosticsIncludeSerials: true }),
      )

      wrapper.unmount()
    })
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
  // Issue #88: a mistyped protect-list entry looked exactly like a working one,
  // on the guard whose whole job is stopping the wrong drive being wiped.
  it("warns about a protected serial that matches no visible drive", async () => {
    const api = fakeApi({ ...baseSettings, protectList: ["EXISTING1", "MISTYPED-SERIAL"] }, [
      drive("EXISTING1"),
    ])
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).toContain("1 serial matches no drive spindoctor can currently see")
    // Not phrased as an error: pre-registering a serial is legitimate.
    expect(wrapper.text()).toContain("expected if the drive isn't attached yet")

    wrapper.unmount()
  })

  it("does not warn when every protected serial matches a visible drive", async () => {
    const api = fakeApi({ ...baseSettings, protectList: ["EXISTING1"] }, [drive("EXISTING1")])
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).not.toContain("no drive spindoctor can currently see")

    wrapper.unmount()
  })

  it("matches a visible drive whose serial differs only in case", async () => {
    const api = fakeApi({ ...baseSettings, protectList: ["EXISTING1"] }, [drive("existing1")])
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).not.toContain("no drive spindoctor can currently see")

    wrapper.unmount()
  })

  it("says nothing when no drives are visible at all, rather than flagging every entry", async () => {
    const api = fakeApi({ ...baseSettings, protectList: ["EXISTING1"] }, [])
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    expect(wrapper.text()).not.toContain("no drive spindoctor can currently see")

    wrapper.unmount()
  })

  it("upper-cases a newly typed serial, so it matches the way the guard compares", async () => {
    const api = fakeApi({ ...baseSettings, protectList: [] }, [drive("EXISTING1")])
    setConsoleDeps({ api: api as unknown as ApiClient })

    const wrapper = mount(SettingsView, { global: { plugins: [vuetify] }, attachTo: document.body })
    await flushPromises()

    await wrapper.find("#new-protected-serial").setValue("  existing1  ")
    clickButton(document.body, "Add")
    await flushPromises()

    expect(wrapper.text()).toContain("EXISTING1")
    expect(wrapper.text()).not.toContain("no drive spindoctor can currently see")

    clickButton(document.body, "Save settings")
    await flushPromises()
    expect(api.putSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ protectList: ["EXISTING1"] }),
    )

    wrapper.unmount()
  })
})
