import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { Reason } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import VerdictReasons from "./VerdictReasons.vue"

function mountWith(reasons: Reason[]) {
  return mount(VerdictReasons, { props: { reasons }, global: { plugins: [vuetify] } })
}

describe("VerdictReasons", () => {
  it("renders each reason's message, severity and code", () => {
    const wrapper = mountWith([
      { code: "CURRENT_PENDING", severity: "fail", message: "Current pending sectors: 8" },
    ])

    const text = wrapper.text()
    expect(text).toContain("Current pending sectors: 8")
    expect(text).toContain("Failure")
    expect(text).toContain("CURRENT_PENDING")
  })

  // The operator's question is "why did this fail", so failures lead regardless
  // of the order the evaluator happened to emit them in.
  it("orders failures before warnings before notes", () => {
    const wrapper = mountWith([
      { code: "SELFTEST_SKIPPED", severity: "info", message: "Long self-test skipped" },
      { code: "LINK_ERRORS", severity: "warn", message: "255 SAS link error(s)" },
      { code: "SMART_HEALTH_FAILED", severity: "fail", message: "Drive reports failing health" },
    ])

    const items = wrapper.findAll(".verdict-reasons__item")
    expect(items.map((i) => i.find(".verdict-reasons__severity").text())).toEqual([
      "Failure",
      "Warning",
      "Note",
    ])
    expect(items.map((i) => i.find(".verdict-reasons__code").text())).toEqual([
      "SMART_HEALTH_FAILED",
      "LINK_ERRORS",
      "SELFTEST_SKIPPED",
    ])
  })

  it("shows an informational reason without an error or warning color", () => {
    const wrapper = mountWith([
      { code: "SELFTEST_SKIPPED", severity: "info", message: "Long self-test skipped" },
    ])

    expect(wrapper.text()).toContain("Note")
    expect(wrapper.find(".text-error").exists()).toBe(false)
    expect(wrapper.find(".text-warning").exists()).toBe(false)
  })

  it("says so plainly when a run recorded no reasons at all", () => {
    const wrapper = mountWith([])
    expect(wrapper.find(".verdict-reasons").exists()).toBe(false)
    expect(wrapper.text()).toContain("Nothing to report")
  })
})
