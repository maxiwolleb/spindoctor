import { afterEach, describe, expect, it } from "vitest"
import { mount, DOMWrapper, type VueWrapper } from "@vue/test-utils"
import type { DriveView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import StartTestDialog from "./StartTestDialog.vue"

// v-dialog teleports its content to a single shared `.v-overlay-container`
// under document.body (reused across mounts, not scoped per-component), so
// an unmounted-but-still-teleported dialog from a previous test would
// otherwise leak into the next test's `document.body` queries. Track and
// unmount every dialog mounted via `mountDialog` so each test starts clean.
let mountedWrappers: VueWrapper[] = []

afterEach(() => {
  for (const wrapper of mountedWrappers) wrapper.unmount()
  mountedWrappers = []
})

function drive(over: Partial<DriveView> = {}): DriveView {
  return {
    serial: "SERA1234",
    model: "WDC WD40EFRX",
    sizeBytes: 4_000_787_030_016,
    type: "HDD",
    transport: "SATA",
    present: true,
    mounted: false,
    isSystemDisk: false,
    protected: false,
    latestRun: null,
    ...over,
  }
}

function mountDialog(driveOverride: Partial<DriveView> = {}) {
  const wrapper = mount(StartTestDialog, {
    props: { drive: drive(driveOverride), modelValue: true },
    global: { plugins: [vuetify] },
    attachTo: document.body,
  })
  mountedWrappers.push(wrapper)
  return { wrapper, body: new DOMWrapper(document.body) }
}

function findButton(body: DOMWrapper<Element>, text: string) {
  return body.findAll("button").find((b) => b.text() === text)
}

async function selectDestructive(body: DOMWrapper<Element>): Promise<void> {
  const radios = body.findAll('input[type="radio"]')
  const destructive = radios.find((r) => (r.element as HTMLInputElement).value === "destructive")!
  ;(destructive.element as HTMLInputElement).checked = true
  await destructive.trigger("input")
}

describe("StartTestDialog", () => {
  it("keeps 'Wipe & test' disabled until the typed serial matches, then enables it", async () => {
    const { body } = mountDialog()
    await selectDestructive(body)

    const wipeButton = findButton(body, "Wipe & test")
    expect(wipeButton?.exists()).toBe(true)
    expect((wipeButton!.element as HTMLButtonElement).disabled).toBe(true)

    const confirmField = body.find('input[type="text"]')
    await confirmField.setValue("WRONG")
    expect((findButton(body, "Wipe & test")!.element as HTMLButtonElement).disabled).toBe(true)

    await confirmField.setValue("SERA1234")
    expect((findButton(body, "Wipe & test")!.element as HTMLButtonElement).disabled).toBe(false)
  })

  it("disables the destructive option and shows the guard reason for a mounted drive", async () => {
    const { body } = mountDialog({ mounted: true })

    const destructiveRadio = body
      .findAll('input[type="radio"]')
      .find((r) => (r.element as HTMLInputElement).value === "destructive")
    expect((destructiveRadio!.element as HTMLInputElement).disabled).toBe(true)
    expect(body.text()).toContain(
      "This drive is mounted / is the system disk / is protected — destructive testing is blocked.",
    )
  })

  it("disables the destructive option for a system disk", () => {
    const { body } = mountDialog({ isSystemDisk: true })
    const destructiveRadio = body
      .findAll('input[type="radio"]')
      .find((r) => (r.element as HTMLInputElement).value === "destructive")
    expect((destructiveRadio!.element as HTMLInputElement).disabled).toBe(true)
    expect(body.text()).toContain("destructive testing is blocked")
  })

  it("disables the destructive option for a protected drive", () => {
    const { body } = mountDialog({ protected: true })
    const destructiveRadio = body
      .findAll('input[type="radio"]')
      .find((r) => (r.element as HTMLInputElement).value === "destructive")
    expect((destructiveRadio!.element as HTMLInputElement).disabled).toBe(true)
    expect(body.text()).toContain("destructive testing is blocked")
  })

  it("read-only submit needs no confirmation and emits confirm: undefined", async () => {
    const { wrapper, body } = mountDialog()

    const startButton = findButton(body, "Start scan")
    expect(startButton?.exists()).toBe(true)
    expect((startButton!.element as HTMLButtonElement).disabled).toBe(false)
    await startButton!.trigger("click")

    expect(wrapper.emitted("submit")).toEqual([
      [{ serial: "SERA1234", mode: "read-only", confirm: undefined }],
    ])
    expect(wrapper.emitted("update:modelValue")).toContainEqual([false])
  })

  it("destructive submit emits the typed confirm value", async () => {
    const { wrapper, body } = mountDialog()
    await selectDestructive(body)

    const confirmField = body.find('input[type="text"]')
    await confirmField.setValue("SERA1234")

    const wipeButton = findButton(body, "Wipe & test")
    await wipeButton!.trigger("click")

    expect(wrapper.emitted("submit")).toEqual([
      [{ serial: "SERA1234", mode: "destructive", confirm: "SERA1234" }],
    ])
  })

  it("cancel closes without emitting submit", async () => {
    const { wrapper, body } = mountDialog()
    const cancelButton = findButton(body, "Cancel")
    await cancelButton!.trigger("click")

    expect(wrapper.emitted("submit")).toBeUndefined()
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]])
  })
})
