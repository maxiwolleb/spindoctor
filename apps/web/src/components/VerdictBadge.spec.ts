import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { Verdict } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import VerdictBadge from "./VerdictBadge.vue"

describe("VerdictBadge", () => {
  const cases: Array<[Verdict, string, string]> = [
    ["PASS", "bg-success", "Pass"],
    ["WARN", "bg-warning", "Warn"],
    ["FAIL", "bg-error", "Fail"],
  ]

  it.each(cases)("renders %s as a %s chip labeled %s", (verdict, colorClass, label) => {
    const wrapper = mount(VerdictBadge, {
      props: { verdict },
      global: { plugins: [vuetify] },
    })

    const chip = wrapper.find(".v-chip")
    expect(chip.exists()).toBe(true)
    expect(chip.classes()).toContain(colorClass)
    expect(wrapper.text()).toBe(label)
  })

  it("renders a muted dash with no chip for a null verdict", () => {
    const wrapper = mount(VerdictBadge, {
      props: { verdict: null },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".v-chip").exists()).toBe(false)
    expect(wrapper.text()).toBe("—")
  })
})
