import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS, STAGE_NAMES } from "./index"

describe("shared constants", () => {
  it("exposes strict default thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      reallocatedWarnMax: 10,
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
