import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS, STAGE_NAMES, resolveThresholds } from "./index"

describe("shared constants", () => {
  it("exposes strict default thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      reallocatedWarnMax: 4,
      commandTimeoutWarnMax: 100,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    })
  })

  it("lists the default regime stage names in order", () => {
    expect(STAGE_NAMES).toEqual([
      "SMART_BEFORE",
      "SELFTEST_LONG",
      "SURFACE",
      "SMART_AFTER",
      "VERDICT",
    ])
  })
})

// Issue #54: thresholds are a stored JSON blob, so an install predating a
// threshold has an object without that key — and comparing a counter against
// `undefined` is silently false for every drive.
describe("resolveThresholds", () => {
  it("fills in a threshold a stored config predates", () => {
    const stored = {
      reallocatedWarnMax: 10,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    }
    expect(resolveThresholds(stored)).toEqual({
      reallocatedWarnMax: 10,
      commandTimeoutWarnMax: DEFAULT_THRESHOLDS.commandTimeoutWarnMax,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    })
  })

  // A value someone may have tuned is never overwritten by a later change to
  // the default — that install keeps 10 until it's changed in Settings.
  it("keeps a stored value that differs from the current default", () => {
    expect(resolveThresholds({ reallocatedWarnMax: 10 }).reallocatedWarnMax).toBe(10)
    expect(DEFAULT_THRESHOLDS.reallocatedWarnMax).toBe(4)
  })

  it("falls back to every default for junk input", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(resolveThresholds(junk)).toEqual(DEFAULT_THRESHOLDS)
    }
  })

  it("ignores non-finite stored values rather than grading against NaN", () => {
    const resolved = resolveThresholds({
      reallocatedWarnMax: Number.NaN,
      ssdPercentageUsedWarn: "80",
    })
    expect(resolved.reallocatedWarnMax).toBe(DEFAULT_THRESHOLDS.reallocatedWarnMax)
    expect(resolved.ssdPercentageUsedWarn).toBe(DEFAULT_THRESHOLDS.ssdPercentageUsedWarn)
  })
})
