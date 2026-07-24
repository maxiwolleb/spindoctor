import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { SmartKeyMetrics } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import SmartDiffTable from "./SmartDiffTable.vue"

const baseMetrics: SmartKeyMetrics = {
  reallocatedSectors: 0,
  currentPending: 0,
  offlineUncorrectable: 0,
  reportedUncorrect: 0,
  crcErrors: 0,
  powerOnHours: 1000,
  percentageUsed: null,
  mediaErrors: null,
  temperatureC: 32,
}

describe("SmartDiffTable", () => {
  it("highlights a worse delta when a bad-is-higher metric grew (reallocated 0 -> 5)", () => {
    const wrapper = mount(SmartDiffTable, {
      props: {
        before: baseMetrics,
        after: { ...baseMetrics, reallocatedSectors: 5 },
      },
      global: { plugins: [vuetify] },
    })

    const text = wrapper.text()
    expect(text).toContain("Reallocated sectors")
    expect(text).toContain("+5")

    const worseCell = wrapper.find(".smart-diff-table__delta--worse")
    expect(worseCell.exists()).toBe(true)
    expect(worseCell.text()).toBe("+5")
  })

  it("renders '—' for every column when a metric is null on both sides", () => {
    const wrapper = mount(SmartDiffTable, {
      props: { before: null, after: null },
      global: { plugins: [vuetify] },
    })

    const rows = wrapper.findAll("tbody tr")
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const cells = row.findAll("td")
      // label, before, after, delta
      expect(cells[1]?.text()).toBe("—")
      expect(cells[2]?.text()).toBe("—")
      expect(cells[3]?.text()).toBe("—")
    }
    expect(wrapper.find(".smart-diff-table__delta--worse").exists()).toBe(false)
  })

  it("renders an unchanged metric with a neutral (non-highlighted) zero delta", () => {
    const wrapper = mount(SmartDiffTable, {
      props: { before: baseMetrics, after: { ...baseMetrics } },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".smart-diff-table__delta--worse").exists()).toBe(false)
    const rows = wrapper.findAll("tbody tr")
    const reallocRow = rows.find((r) => r.text().includes("Reallocated sectors"))
    expect(reallocRow?.findAll("td")[3]?.text()).toBe("0")
  })

  it("does not highlight growth in a metric that is not bad-is-higher (powerOnHours)", () => {
    const wrapper = mount(SmartDiffTable, {
      props: {
        before: baseMetrics,
        after: { ...baseMetrics, powerOnHours: 1050 },
      },
      global: { plugins: [vuetify] },
    })

    const rows = wrapper.findAll("tbody tr")
    const row = rows.find((r) => r.text().includes("Power-on hours"))
    expect(row?.text()).toContain("+50")
    expect(row?.find(".smart-diff-table__delta--worse").exists()).toBe(false)
  })

  it("uses the mono class for the data table", () => {
    const wrapper = mount(SmartDiffTable, {
      props: { before: baseMetrics, after: baseMetrics },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find("table.mono").exists()).toBe(true)
  })
})
