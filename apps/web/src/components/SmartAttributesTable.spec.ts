import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { SmartAttributeRow } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import SmartAttributesTable from "./SmartAttributesTable.vue"

const row = (over: Partial<SmartAttributeRow> = {}): SmartAttributeRow => ({
  id: 5,
  name: "Reallocated_Sector_Ct",
  value: 100,
  worst: 100,
  thresh: 10,
  rawValue: 0,
  rawString: null,
  health: "ok",
  ...over,
})

describe("SmartAttributesTable", () => {
  it("renders a row per attribute with value/worst/thresh/raw and its plain-language description", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: { attributes: [row({ rawValue: 3, health: "warn" })] },
      global: { plugins: [vuetify] },
    })

    const text = wrapper.text()
    expect(text).toContain("Reallocated sectors")
    expect(text).toContain("retired after finding them bad")

    const cells = wrapper.find("tbody tr").findAll("td")
    expect(cells[1]?.text()).toBe("100") // value
    expect(cells[2]?.text()).toBe("100") // worst
    expect(cells[3]?.text()).toBe("10") // thresh
    expect(cells[4]?.text()).toBe("3") // raw
  })

  it("shows a distinct raw string when smartctl reports one (e.g. a duration)", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: {
        attributes: [
          row({ id: 9, name: "Power_On_Hours", rawValue: 21000, rawString: "21000h+02m+00.000s" }),
        ],
      },
      global: { plugins: [vuetify] },
    })
    expect(wrapper.text()).toContain("21000h+02m+00.000s")
  })

  it("flags a warn-health row with the warn row class and a Warn chip", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: { attributes: [row({ health: "warn" })] },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".smart-attributes-table__row--warn").exists()).toBe(true)
    expect(wrapper.text()).toContain("Warn")
  })

  it("flags a fail-health row with the fail row class and a Fail chip", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: {
        attributes: [row({ id: 197, name: "Current_Pending_Sector", rawValue: 2, health: "fail" })],
      },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".smart-attributes-table__row--fail").exists()).toBe(true)
    expect(wrapper.text()).toContain("Fail")
    expect(wrapper.text()).toContain("Current pending sectors")
  })

  it("does not tint an ok-health row", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: { attributes: [row({ health: "ok" })] },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".smart-attributes-table__row--warn").exists()).toBe(false)
    expect(wrapper.find(".smart-attributes-table__row--fail").exists()).toBe(false)
    expect(wrapper.find(".smart-attributes-table__row--ok").exists()).toBe(true)
  })

  it("still renders an unrecognized attribute, with a generic fallback description", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: { attributes: [row({ id: 250, name: "Some_Weird_Vendor_Attr" })] },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.text()).toContain("Some_Weird_Vendor_Attr")
    expect(wrapper.text()).toContain("no plain-language explanation yet")
  })

  it("renders a placeholder message and no table when there are no attributes", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: { attributes: [] },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find("table").exists()).toBe(false)
    expect(wrapper.text()).toContain("No SMART attributes available")
  })
})

// #54: SAS/SCSI (and NVMe) rows have no normalized value/worst/threshold, so
// those columns were three columns of "—" on exactly the drives this tool is
// mostly pointed at.
describe("SmartAttributesTable normalized columns", () => {
  const scsiRow = (name: string, rawValue: number, health: SmartAttributeRow["health"] = "ok") => ({
    id: null,
    name,
    value: null,
    worst: null,
    thresh: null,
    rawValue,
    rawString: null,
    health,
  })

  it("hides value/worst/thresh when no row reports them", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: {
        attributes: [
          scsiRow("scsi_grown_defect_list", 636, "warn"),
          scsiRow("sas_invalid_dword_count", 255, "warn"),
        ],
      },
      global: { plugins: [vuetify] },
    })

    const headers = wrapper.findAll("th").map((th) => th.text())
    expect(headers).toEqual(["Attribute", "Raw", "Status"])
    expect(wrapper.findAll("tbody tr")[0]!.findAll("td")).toHaveLength(3)
    expect(wrapper.text()).toContain("Grown defects")
    expect(wrapper.text()).toContain("636")
  })

  it("keeps them for an ATA table that does report them", () => {
    const wrapper = mount(SmartAttributesTable, {
      props: {
        attributes: [
          {
            id: 5,
            name: "Reallocated_Sector_Ct",
            value: 100,
            worst: 100,
            thresh: 10,
            rawValue: 0,
            rawString: null,
            health: "ok" as const,
          },
        ],
      },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.findAll("th").map((th) => th.text())).toEqual([
      "Attribute",
      "Value",
      "Worst",
      "Thresh",
      "Raw",
      "Status",
    ])
  })
})
