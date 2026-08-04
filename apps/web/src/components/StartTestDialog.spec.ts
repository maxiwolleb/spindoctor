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

  // Issue #85 made the engine run the guards for every mode, so the dialog's
  // mirror of them had to follow: it used to disable only the destructive radio
  // and say "destructive testing is blocked", which advertised a read-only scan
  // the server would refuse with a 403.
  const BLOCKING = [
    { name: "mounted drive", patch: { mounted: true }, text: "This drive is mounted" },
    { name: "system disk", patch: { isSystemDisk: true }, text: "This is the system disk" },
    { name: "protected drive", patch: { protected: true }, text: "on the protected list" },
    {
      name: "drive the kernel says is in use",
      patch: { claim: "claimed" as const },
      text: "Something on this host is using this drive",
    },
  ]

  it.each(BLOCKING)("names the specific reason for a $name", ({ patch, text }) => {
    const { body } = mountDialog(patch)
    expect(body.text()).toContain(text)
  })

  it.each(BLOCKING)("disables the destructive option for a $name", ({ patch }) => {
    const { body } = mountDialog(patch)
    const destructiveRadio = body
      .findAll('input[type="radio"]')
      .find((r) => (r.element as HTMLInputElement).value === "destructive")
    expect((destructiveRadio!.element as HTMLInputElement).disabled).toBe(true)
  })

  it.each(BLOCKING)("blocks the read-only submit too for a $name", ({ patch }) => {
    // The whole point: read-only is the default mode, and the server 403s it for
    // exactly these drives, so the button must not offer to start one.
    const { body } = mountDialog(patch)
    const startButton = findButton(body, "Start scan")
    expect(startButton?.exists()).toBe(true)
    expect((startButton!.element as HTMLButtonElement).disabled).toBe(true)
  })

  it.each(BLOCKING)("emits nothing when submit is attempted for a $name", async ({ patch }) => {
    const { wrapper, body } = mountDialog(patch)
    findButton(body, "Start scan")!.trigger("click")
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted("submit")).toBeUndefined()
  })

  // Not a refusal — the drive is testable, but the check that would have told us
  // whether anything else is using it could not run (issue #83).
  it("warns without blocking when the in-use check could not answer", () => {
    const { body } = mountDialog({ claim: "unknown" })

    expect(body.text()).toContain("could not check whether anything else is using this drive")
    const startButton = findButton(body, "Start scan")
    expect((startButton!.element as HTMLButtonElement).disabled).toBe(false)
    const destructiveRadio = body
      .findAll('input[type="radio"]')
      .find((r) => (r.element as HTMLInputElement).value === "destructive")
    expect((destructiveRadio!.element as HTMLInputElement).disabled).toBe(false)
  })

  it("says nothing extra when the drive is free and eligible", () => {
    const { body } = mountDialog({ claim: "free" })
    expect(body.text()).not.toContain("could not check whether")
    expect(body.text()).not.toContain("will not test it")
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
      [
        {
          serial: "SERA1234",
          mode: "destructive",
          confirm: "SERA1234",
          forceFullRegime: false,
        },
      ],
    ])
  })

  // #49: opting out of the early exit is a destructive-only choice — the point
  // of it is wanting the write, and a read-only scan writes nothing.
  describe("early-exit override (#49)", () => {
    it("offers the override only for a destructive run", async () => {
      const { body } = mountDialog()
      expect(body.find('[data-test="force-full-regime"]').exists()).toBe(false)

      await selectDestructive(body)
      expect(body.find('[data-test="force-full-regime"]').exists()).toBe(true)
    })

    it("emits forceFullRegime: true once ticked", async () => {
      const { wrapper, body } = mountDialog()
      await selectDestructive(body)
      await body.find('input[type="text"]').setValue("SERA1234")
      await body.find('[data-test="force-full-regime"] input').setValue(true)

      await findButton(body, "Wipe & test")!.trigger("click")

      expect(wrapper.emitted("submit")).toEqual([
        [
          {
            serial: "SERA1234",
            mode: "destructive",
            confirm: "SERA1234",
            forceFullRegime: true,
          },
        ],
      ])
    })

    it("does not carry a ticked override over into the next time the dialog opens", async () => {
      const { wrapper, body } = mountDialog()
      await selectDestructive(body)
      await body.find('[data-test="force-full-regime"] input').setValue(true)

      await wrapper.setProps({ modelValue: false })
      await wrapper.setProps({ modelValue: true })

      // Reopening resets the mode to read-only, which hides the checkbox; the
      // underlying value must have gone back to false with it.
      await selectDestructive(body)
      const checkbox = body.find('[data-test="force-full-regime"] input')
        .element as HTMLInputElement
      expect(checkbox.checked).toBe(false)
    })
  })

  it("cancel closes without emitting submit", async () => {
    const { wrapper, body } = mountDialog()
    const cancelButton = findButton(body, "Cancel")
    await cancelButton!.trigger("click")

    expect(wrapper.emitted("submit")).toBeUndefined()
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]])
  })
})
