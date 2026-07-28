import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import type { StageView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import { formatEtaClock } from "../lib/eta"
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
    declaredTotalMinutes: null,
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

  // #49: a stage the baseline gate ruled out must read as skipped, never as
  // one that ran and passed.
  it("labels a skipped stage as skipped, with no progress bar", () => {
    const wrapper = mount(StageTimeline, {
      props: {
        stages: [
          stage({ id: 1, stage: "SMART_BEFORE", status: "DONE", progress: 100 }),
          stage({ id: 2, stage: "SELFTEST_LONG", status: "SKIPPED", progress: 0 }),
          stage({ id: 3, stage: "SURFACE", status: "SKIPPED", progress: 0 }),
        ],
      },
      global: { plugins: [vuetify] },
    })

    const items = wrapper.findAll(".stage-timeline__item")
    expect(items[1]!.text()).toContain("Skipped")
    expect(items[1]!.text()).not.toContain("Done")
    expect(items[1]!.find(".v-progress-linear").exists()).toBe(false)
    expect(items[1]!.find(".stage-timeline__eta").exists()).toBe(false)
    expect(items[1]!.text()).not.toContain("0%")
    // Its own muted marker — not the phosphor one a passed stage gets, and not
    // the filled secondary one a pending stage gets either.
    expect(items[1]!.find(".stage-timeline__marker--success").exists()).toBe(false)
    expect(items[1]!.find(".stage-timeline__marker--secondary").exists()).toBe(false)
    expect(items[1]!.find(".stage-timeline__marker--skipped").exists()).toBe(true)
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

  describe("ETA for a running stage (#15)", () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("shows a remaining-time + completion-clock estimate for a RUNNING stage", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({
              stage: "SURFACE",
              status: "RUNNING",
              progress: 50,
              startedAt: "2026-07-25T09:00:00.000Z", // 1h elapsed, 50% done -> 1h left, eta 11:00
            }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      // 1h elapsed, 50% done -> 1h remaining -> eta at 11:00 UTC. The clock
      // half renders in local time (see `formatEtaClock`), so build the
      // expected string with it too instead of hardcoding a UTC hour that'd
      // only match in a UTC-local test environment.
      const expectedEtaMs = Date.parse("2026-07-25T11:00:00.000Z")
      const eta = wrapper.find(".stage-timeline__eta")
      expect(eta.exists()).toBe(true)
      expect(eta.text()).toBe(`~1h 0m left (${formatEtaClock(expectedEtaMs)})`)
    })

    it("shows 'estimating…' when progress is too low to extrapolate from", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({
              stage: "SURFACE",
              status: "RUNNING",
              progress: 1,
              startedAt: "2026-07-25T09:59:00.000Z",
            }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__eta").text()).toBe("estimating…")
    })

    it("shows 'estimating…' when startedAt hasn't been recorded", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({ stage: "SELFTEST_LONG", status: "RUNNING", progress: 40, startedAt: null }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__eta").text()).toBe("estimating…")
    })

    it("shows no ETA line at all for a DONE stage", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({
              stage: "SURFACE",
              status: "DONE",
              progress: 100,
              startedAt: "2026-07-25T09:00:00.000Z",
            }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__eta").exists()).toBe(false)
    })

    // #61: an ATA self-test reports "90% remaining" seconds in, so
    // extrapolating told the operator ~6m for a 97-minute routine.
    it("prefers the duration the drive declares for a self-test over extrapolation", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({
              stage: "SELFTEST_LONG",
              status: "RUNNING",
              progress: 10,
              declaredTotalMinutes: 97,
              startedAt: "2026-07-25T09:59:20.000Z", // 40s in
            }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      const expectedEtaMs = Date.parse("2026-07-25T10:00:00.000Z") + 87.3 * 60_000
      const eta = wrapper.find(".stage-timeline__eta")
      expect(eta.text()).toBe(`~1h 27m left (${formatEtaClock(expectedEtaMs)})`)
      expect(eta.text()).not.toContain("~6m")
    })

    it("estimates a self-test at 0% from the declared duration, not 'estimating…'", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [
            stage({
              stage: "SELFTEST_LONG",
              status: "RUNNING",
              progress: 0,
              declaredTotalMinutes: 97,
              startedAt: "2026-07-25T09:59:55.000Z",
            }),
          ],
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__eta").text()).toContain("~1h 37m left")
    })

    it("shows no ETA line for a PENDING stage", () => {
      const wrapper = mount(StageTimeline, {
        props: {
          stages: [stage({ stage: "SMART_AFTER", status: "PENDING", progress: 0 })],
        },
        global: { plugins: [vuetify] },
      })

      expect(wrapper.find(".stage-timeline__eta").exists()).toBe(false)
    })
  })
})
