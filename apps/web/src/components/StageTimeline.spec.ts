import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { StageView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import StageTimeline from "./StageTimeline.vue"

function stage(over: Partial<StageView>): StageView {
  return {
    id: 1,
    runId: 1,
    stage: "SMART_BEFORE",
    status: "DONE",
    progress: 100,
    logPath: null,
    log: null,
    metrics: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

describe("StageTimeline", () => {
  it("renders every stage's label and status, in the given order", () => {
    const stages: StageView[] = [
      stage({ id: 1, stage: "SMART_BEFORE", status: "DONE", progress: 100 }),
      stage({ id: 2, stage: "SELFTEST_LONG", status: "DONE", progress: 100 }),
      stage({ id: 3, stage: "SURFACE", status: "RUNNING", progress: 42 }),
      stage({ id: 4, stage: "SMART_AFTER", status: "PENDING", progress: 0 }),
      stage({ id: 5, stage: "VERDICT", status: "PENDING", progress: 0 }),
    ]

    const wrapper = mount(StageTimeline, {
      props: { stages },
      global: { plugins: [vuetify] },
    })

    const items = wrapper.findAll(".stage-timeline__item")
    expect(items).toHaveLength(5)

    const expected = [
      ["SMART (before)", "Done"],
      ["Self-test", "Done"],
      ["Surface scan", "Running"],
      ["SMART (after)", "Pending"],
      ["Verdict", "Pending"],
    ]
    items.forEach((item, i) => {
      const [label, status] = expected[i] as [string, string]
      expect(item.text()).toContain(label)
      expect(item.text()).toContain(status)
    })
  })

  it("renders failed/aborted/interrupted statuses distinctly", () => {
    const stages: StageView[] = [
      stage({ id: 1, stage: "SELFTEST_LONG", status: "FAILED" }),
      stage({ id: 2, stage: "SURFACE", status: "ABORTED" }),
      stage({ id: 3, stage: "SURFACE", status: "INTERRUPTED" }),
    ]

    const wrapper = mount(StageTimeline, {
      props: { stages },
      global: { plugins: [vuetify] },
    })

    const text = wrapper.text()
    expect(text).toContain("Failed")
    expect(text).toContain("Aborted")
    expect(text).toContain("Interrupted")
  })

  it("shows the progress percentage for a running stage", () => {
    const wrapper = mount(StageTimeline, {
      props: { stages: [stage({ stage: "SURFACE", status: "RUNNING", progress: 42 })] },
      global: { plugins: [vuetify] },
    })

    expect(wrapper.text()).toContain("42%")
  })

  describe("captured stage log panel (#13)", () => {
    it("shows no log toggle for a stage with no captured log", () => {
      const wrapper = mount(StageTimeline, {
        props: { stages: [stage({ stage: "SMART_BEFORE", log: null })] },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__log-toggle").exists()).toBe(false)
      expect(wrapper.find(".stage-timeline__log").exists()).toBe(false)
    })

    it("renders a toggle for a stage with a captured log, collapsed by default", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [stage({ stage: "SURFACE", log: "=== badblocks stdout ===\n(empty)\n\n12345" })],
        },
        global: { plugins: [vuetify] },
      })

      const toggle = wrapper.find(".stage-timeline__log-toggle")
      expect(toggle.exists()).toBe(true)
      expect(toggle.text()).toBe("Show log")
      expect(wrapper.find(".stage-timeline__log").exists()).toBe(false)
    })

    it("expands to show the raw log text on click, and collapses again on a second click", async () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [stage({ stage: "SURFACE", log: "=== badblocks stdout ===\nsome output" })],
        },
        global: { plugins: [vuetify] },
      })

      const toggle = wrapper.find(".stage-timeline__log-toggle")
      await toggle.trigger("click")

      expect(wrapper.find(".stage-timeline__log-toggle").text()).toBe("Hide log")
      const pre = wrapper.find(".stage-timeline__log")
      expect(pre.exists()).toBe(true)
      expect(pre.text()).toContain("=== badblocks stdout ===")
      expect(pre.text()).toContain("some output")

      await wrapper.find(".stage-timeline__log-toggle").trigger("click")
      expect(wrapper.find(".stage-timeline__log-toggle").text()).toBe("Show log")
      expect(wrapper.find(".stage-timeline__log").exists()).toBe(false)
    })

    it("keeps each stage's expanded state independent", async () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({ id: 1, stage: "SELFTEST_LONG", log: "self-test log" }),
            stage({ id: 2, stage: "SURFACE", log: "surface log" }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      const toggles = wrapper.findAll(".stage-timeline__log-toggle")
      expect(toggles).toHaveLength(2)

      await toggles[0]!.trigger("click")

      const logs = wrapper.findAll(".stage-timeline__log")
      expect(logs).toHaveLength(1)
      expect(logs[0]!.text()).toContain("self-test log")
    })
  })
})
