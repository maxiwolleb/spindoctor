import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { Verdict } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import VerdictBadge from "./VerdictBadge.vue"

describe("VerdictBadge", () => {
  // PASS renders as a solid (flat) phosphor pill — it's a *state*, not just
  // colored text — so Vuetify emits a `bg-*` class. WARN/FAIL stay tonal
  // pills, which Vuetify renders via a `text-*` class instead.
  const cases: Array<[Verdict, string, string, string]> = [
    ["PASS", "v-chip--variant-flat", "bg-success", "Pass"],
    ["WARN", "v-chip--variant-tonal", "text-warning", "Warn"],
    ["FAIL", "v-chip--variant-tonal", "text-error", "Fail"],
  ]

  it.each(cases)(
    "renders %s as a %s chip labeled %s",
    (verdict, variantClass, colorClass, label) => {
      const wrapper = mount(VerdictBadge, {
        props: { verdict },
        global: { plugins: [vuetify] },
      })

      const chip = wrapper.find(".v-chip")
      expect(chip.exists()).toBe(true)
      expect(chip.classes()).toContain(variantClass)
      expect(chip.classes()).toContain(colorClass)
      expect(wrapper.text()).toBe(label)
    },
  )

  it("forces dark text on the solid PASS pill so it reads on the phosphor fill", () => {
    const wrapper = mount(VerdictBadge, {
      props: { verdict: "PASS" },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".v-chip").classes()).toContain("verdict-badge--pass")
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
