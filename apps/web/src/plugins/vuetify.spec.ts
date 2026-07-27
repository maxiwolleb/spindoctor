import { describe, expect, it } from "vitest"
import { h } from "vue"
import { mount } from "@vue/test-utils"
import { VCheckbox, VRadio, VRadioGroup } from "vuetify/components"
import { vuetify } from "./vuetify"

/**
 * Issue #55: Vuetify's default `mdi` icon set resolves to CSS class names and
 * expects the Material Design Icons webfont to be present. The app never shipped
 * it, so `v-checkbox` and `v-radio` rendered as labels with an empty gap — the
 * elements carried `mdi-checkbox-blank-outline` and no glyph came out. These
 * assert the control is actually drawn, which a class-name-only set can't do.
 */
describe("vuetify icon configuration", () => {
  it("renders a checkbox control as an inline SVG path, not a bare class name", () => {
    const wrapper = mount(VCheckbox, {
      props: { label: "I understand" },
      global: { plugins: [vuetify] },
    })

    const svg = wrapper.find(".v-selection-control svg")
    expect(svg.exists()).toBe(true)
    // A real glyph has path data; an unresolved icon renders an empty <svg>.
    expect(svg.find("path").attributes("d")).toBeTruthy()
  })

  it("renders radio controls as inline SVG paths", () => {
    const wrapper = mount(VRadioGroup, {
      global: { plugins: [vuetify] },
      slots: { default: () => [h(VRadio, { label: "a", value: "a" })] },
    })

    const svg = wrapper.find(".v-selection-control svg")
    expect(svg.exists()).toBe(true)
    expect(svg.find("path").attributes("d")).toBeTruthy()
  })

  it("keeps the phosphor theme as the default", () => {
    expect(vuetify.theme.global.name.value).toBe("spindoctor")
  })
})
