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
})
