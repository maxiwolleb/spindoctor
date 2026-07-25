import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

  describe("ETA (#15)", () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("shows a remaining-time estimate once there's enough signal", () => {
      const wrapper = mount(RunProgress, {
        props: {
          live: {
            stage: "SURFACE",
            percent: 50,
            status: "RUNNING",
            startedAt: "2026-07-25T09:00:00.000Z", // 1h elapsed, 50% done -> 1h left
          },
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".run-progress__eta").exists()).toBe(true)
      expect(wrapper.text()).toContain("~1h 0m left")
    })

    it("shows 'estimating…' when there's a live stage but not enough signal yet", () => {
      const wrapper = mount(RunProgress, {
        props: {
          live: { stage: "SELFTEST_LONG", percent: 1, status: "RUNNING", startedAt: null },
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.text()).toContain("estimating…")
    })

    it("shows 'estimating…' when startedAt hasn't arrived yet (undefined)", () => {
      const wrapper = mount(RunProgress, {
        props: { live: { stage: "SURFACE", percent: 42, status: "RUNNING" } },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.text()).toContain("estimating…")
    })

    it("shows no ETA line at all when there's no live progress", () => {
      const wrapper = mount(RunProgress, {
        props: { live: null },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".run-progress__eta").exists()).toBe(false)
    })
  })
})
