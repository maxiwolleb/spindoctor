import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { vuetify } from "../plugins/vuetify"
import RunProgress from "./RunProgress.vue"

describe("RunProgress", () => {
  it("renders the signature sweeping write-head bar and stage label for SURFACE", () => {
    const wrapper = mount(RunProgress, {
      props: { live: { stage: "SURFACE", percent: 42, status: "RUNNING" } },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".run-progress--signature").exists()).toBe(true)
    expect(wrapper.find(".v-progress-linear").exists()).toBe(true)
    expect(wrapper.text()).toContain("Surface scan")
  })

  it("renders a plain determinate bar and stage label for SELFTEST_LONG", () => {
    const wrapper = mount(RunProgress, {
      props: { live: { stage: "SELFTEST_LONG", percent: 10, status: "RUNNING" } },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".run-progress--signature").exists()).toBe(false)
    expect(wrapper.find(".v-progress-linear").exists()).toBe(true)
    expect(wrapper.text()).toContain("Self-test")
  })

  it("renders nothing when there is no live progress (idle)", () => {
    const wrapper = mount(RunProgress, {
      props: { live: null },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".v-progress-linear").exists()).toBe(false)
    expect(wrapper.text()).toBe("")
  })

  it("renders nothing for a stage with no progress treatment (e.g. VERDICT)", () => {
    const wrapper = mount(RunProgress, {
      props: { live: { stage: "VERDICT", percent: 100, status: "RUNNING" } },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.find(".v-progress-linear").exists()).toBe(false)
    expect(wrapper.text()).toBe("")
  })
})
