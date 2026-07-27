import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { DriveView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import DriveTable from "./DriveTable.vue"

const driveA: DriveView = {
  serial: "SERA1234",
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  present: true,
  mounted: false,
  isSystemDisk: false,
  protected: false,
  latestRun: { id: 1, status: "DONE", verdict: "PASS", currentStage: "VERDICT" },
}

const driveB: DriveView = {
  serial: "SERB5678",
  model: "Samsung 870 EVO",
  sizeBytes: 1_000_000_000_000,
  type: "SSD",
  transport: "SATA",
  present: true,
  mounted: true,
  isSystemDisk: false,
  protected: false,
  latestRun: null,
}

describe("DriveTable", () => {
  it("renders a row per drive with mono serial, human-readable size, and a verdict badge", () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA, driveB], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const text = wrapper.text()
    expect(text).toContain("WDC WD40EFRX")
    expect(text).toContain("SERA1234")
    expect(text).toContain("SERB5678")
    expect(text).toContain("4.0 TB")
    expect(text).toContain("1.0 TB")
    expect(text).toContain("Pass")

    const monoSerial = wrapper.findAll(".mono").find((el) => el.text() === "SERA1234")
    expect(monoSerial?.exists()).toBe(true)
  })

  it("shows the Mounted health chip for a mounted drive", () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveB], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.text()).toContain("Mounted")
  })

  // That column only ever renders Absent/Mounted/System/Protected chips, so
  // "Health" promised something it never showed — a healthy drive left it blank.
  it("labels the flag column for what it actually shows", () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const headers = wrapper.findAll("th").map((th) => th.text())
    expect(headers).toContain("Flags")
    expect(headers).not.toContain("Health")
  })

  // The engine 409s a second start while a run is non-terminal (RUNNING or
  // PENDING), so the button should not offer it in the first place.
  it.each(["RUNNING", "PENDING"] as const)("disables 'Start test' while a run is %s", (status) => {
    const busy: DriveView = {
      ...driveA,
      latestRun: { id: 2, status, verdict: null, currentStage: "SURFACE" },
    }
    const wrapper = mount(DriveTable, {
      props: { drives: [busy], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const startButton = wrapper.findAll("button").find((btn) => btn.text() === "Start test")
    expect(startButton?.attributes("disabled")).toBeDefined()
  })

  it.each(["DONE", "FAILED", "ABORTED"] as const)(
    "keeps 'Start test' enabled after a run is %s",
    (status) => {
      const settled: DriveView = {
        ...driveA,
        latestRun: { id: 2, status, verdict: "PASS", currentStage: "VERDICT" },
      }
      const wrapper = mount(DriveTable, {
        props: { drives: [settled], liveByDrive: {} },
        global: { plugins: [vuetify] },
      })

      const startButton = wrapper.findAll("button").find((btn) => btn.text() === "Start test")
      expect(startButton?.attributes("disabled")).toBeUndefined()
    },
  )

  it("shows RunProgress (the signature bar) for a drive with a liveByDrive entry", () => {
    const wrapper = mount(DriveTable, {
      props: {
        drives: [driveA, driveB],
        liveByDrive: { SERB5678: { runId: 9, stage: "SURFACE", percent: 55, status: "RUNNING" } },
      },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".run-progress--signature").exists()).toBe(true)
    expect(wrapper.text()).toContain("Surface scan")
  })

  it("emits start with the serial when 'Start test' is clicked", async () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const startButton = wrapper.findAll("button").find((btn) => btn.text() === "Start test")
    expect(startButton?.exists()).toBe(true)
    await startButton?.trigger("click")

    expect(wrapper.emitted("start")).toEqual([["SERA1234"]])
  })

  it("emits open with the serial when the row is clicked", async () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    await wrapper.find("tr.v-data-table__tr").trigger("click")

    expect(wrapper.emitted("open")).toEqual([["SERA1234"]])
  })

  it("is keyboard-openable: the row is focusable and Enter emits open", async () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const row = wrapper.find("tr.v-data-table__tr")
    expect(row.attributes("tabindex")).toBe("0")

    await row.trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("open")).toEqual([["SERA1234"]])
  })

  it("is keyboard-openable via Space too", async () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    await wrapper.find("tr.v-data-table__tr").trigger("keydown", { key: " " })

    expect(wrapper.emitted("open")).toEqual([["SERA1234"]])
  })

  it("does not let clicking 'Start test' also emit open (event does not bubble into the row)", async () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [driveA], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    const startButton = wrapper.findAll("button").find((btn) => btn.text() === "Start test")
    await startButton?.trigger("click")

    expect(wrapper.emitted("open")).toBeUndefined()
  })

  it("shows an empty-state message when there are no drives", () => {
    const wrapper = mount(DriveTable, {
      props: { drives: [], liveByDrive: {} },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.text()).toContain("No drives detected. Attach a drive and it'll appear here.")
  })
})
