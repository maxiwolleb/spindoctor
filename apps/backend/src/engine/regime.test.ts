import { describe, it, expect } from "vitest"
import { regimeStages } from "./regime"

describe("regimeStages", () => {
  it("returns the five stages in order for destructive mode", () => {
    const stages = regimeStages("destructive")

    expect(stages).toHaveLength(5)
    expect(stages[0]).toEqual({ stage: "SMART_BEFORE" })
    expect(stages[1]).toEqual({ stage: "SELFTEST_LONG" })
    expect(stages[2]).toEqual({ stage: "SURFACE", surfaceMode: "destructive" })
    expect(stages[3]).toEqual({ stage: "SMART_AFTER" })
    expect(stages[4]).toEqual({ stage: "VERDICT" })
  })

  it("returns the five stages in order for read-only mode", () => {
    const stages = regimeStages("read-only")

    expect(stages).toHaveLength(5)
    expect(stages[0]).toEqual({ stage: "SMART_BEFORE" })
    expect(stages[1]).toEqual({ stage: "SELFTEST_LONG" })
    expect(stages[2]).toEqual({ stage: "SURFACE", surfaceMode: "read-only" })
    expect(stages[3]).toEqual({ stage: "SMART_AFTER" })
    expect(stages[4]).toEqual({ stage: "VERDICT" })
  })

  it("passes the mode to the SURFACE stage", () => {
    const destructive = regimeStages("destructive")
    const readOnly = regimeStages("read-only")

    const destructiveSurface = destructive.find((s) => s.stage === "SURFACE")
    const readOnlySurface = readOnly.find((s) => s.stage === "SURFACE")

    expect(destructiveSurface?.surfaceMode).toBe("destructive")
    expect(readOnlySurface?.surfaceMode).toBe("read-only")
  })
})
