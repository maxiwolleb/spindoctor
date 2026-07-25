import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type {
  SmartKeyMetrics,
  SelfTestResult,
  SurfaceResult,
  VerdictInput,
} from "@spindoctor/shared"
import { evaluateVerdict } from "./evaluate"

const clean: SmartKeyMetrics = {
  reallocatedSectors: 0,
  currentPending: 0,
  offlineUncorrectable: 0,
  reportedUncorrect: 0,
  crcErrors: 0,
  powerOnHours: 21000,
  percentageUsed: null,
  mediaErrors: null,
  temperatureC: 33,
}
const selfTestOk: SelfTestResult = { status: "PASSED" }
const surfaceOk: SurfaceResult = { mode: "write", badBlocks: 0, completed: true }

function input(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    before: clean,
    after: clean,
    deviceType: "HDD",
    selfTest: selfTestOk,
    surface: surfaceOk,
    thresholds: DEFAULT_THRESHOLDS,
    ...over,
  }
}
const codes = (r: ReturnType<typeof evaluateVerdict>) => r.reasons.map((x) => x.code)

describe("evaluateVerdict", () => {
  it("PASS when everything is clean", () => {
    const r = evaluateVerdict(input())
    expect(r.verdict).toBe("PASS")
    expect(r.reasons).toEqual([])
  })

  it("WARN when a small stable reallocated count is present", () => {
    const after = { ...clean, reallocatedSectors: 5 }
    const r = evaluateVerdict(input({ before: after, after }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("REALLOCATED_PRESENT")
  })

  it("FAIL when reallocated exceeds the warn max", () => {
    const after = { ...clean, reallocatedSectors: 20 }
    const r = evaluateVerdict(input({ before: after, after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("REALLOCATED_HIGH")
  })

  it("FAIL when reallocated grows during the test", () => {
    const before = { ...clean, reallocatedSectors: 2 }
    const after = { ...clean, reallocatedSectors: 5 }
    const r = evaluateVerdict(input({ before, after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("REALLOCATED_GROWTH")
  })

  it("FAIL on current pending sectors", () => {
    const after = { ...clean, currentPending: 1 }
    const r = evaluateVerdict(input({ after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("CURRENT_PENDING")
  })

  it("FAIL on offline uncorrectable and reported uncorrect", () => {
    const after = { ...clean, offlineUncorrectable: 3, reportedUncorrect: 2 }
    const r = evaluateVerdict(input({ after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toEqual(
      expect.arrayContaining(["OFFLINE_UNCORRECTABLE", "REPORTED_UNCORRECT"]),
    )
  })

  it("FAIL when the long self-test failed", () => {
    const r = evaluateVerdict(input({ selfTest: { status: "FAILED", message: "read failure" } }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("SELFTEST_FAILED")
  })

  it("WARN when the long self-test did not complete", () => {
    const r = evaluateVerdict(input({ selfTest: { status: "ABORTED" } }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("SELFTEST_INCOMPLETE")
  })

  it("FAIL when badblocks found errors", () => {
    const r = evaluateVerdict(input({ surface: { mode: "write", badBlocks: 2, completed: true } }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("BADBLOCKS")
  })

  it("WARN when the surface test did not complete", () => {
    const r = evaluateVerdict(input({ surface: { mode: "write", badBlocks: 0, completed: false } }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("SURFACE_INCOMPLETE")
  })

  it("WARN on UDMA CRC errors (cabling)", () => {
    const after = { ...clean, crcErrors: 3 }
    const r = evaluateVerdict(input({ after }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("CRC_ERRORS")
  })

  it("handles a null surface (regime without a surface stage)", () => {
    const r = evaluateVerdict(input({ surface: null }))
    expect(r.verdict).toBe("PASS")
  })

  it("WARN then FAIL on NVMe wear thresholds", () => {
    const warnAfter = { ...clean, percentageUsed: 85 }
    const warn = evaluateVerdict(input({ deviceType: "NVMe", before: warnAfter, after: warnAfter }))
    expect(warn.verdict).toBe("WARN")
    expect(codes(warn)).toContain("WEAR_HIGH")

    const failAfter = { ...clean, percentageUsed: 100 }
    const fail = evaluateVerdict(input({ deviceType: "NVMe", before: failAfter, after: failAfter }))
    expect(fail.verdict).toBe("FAIL")
    expect(codes(fail)).toContain("WEAR_EXHAUSTED")
  })

  it("FAIL on NVMe media errors", () => {
    const after = { ...clean, mediaErrors: 1 }
    const r = evaluateVerdict(input({ deviceType: "NVMe", after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("MEDIA_ERRORS")
  })

  it("ignores SSD/NVMe wear rules for HDDs", () => {
    const after = { ...clean, percentageUsed: 99 }
    const r = evaluateVerdict(input({ deviceType: "HDD", after }))
    expect(r.verdict).toBe("PASS")
  })

  it("skips rules for null (unreported) metrics", () => {
    const after: SmartKeyMetrics = {
      reallocatedSectors: null,
      currentPending: null,
      offlineUncorrectable: null,
      reportedUncorrect: null,
      crcErrors: null,
      powerOnHours: null,
      percentageUsed: null,
      mediaErrors: null,
      temperatureC: null,
    }
    const r = evaluateVerdict(input({ before: after, after }))
    expect(r.verdict).toBe("PASS")
  })

  it("WARN at exactly the reallocated warn-max (10, stable)", () => {
    const after = { ...clean, reallocatedSectors: 10 }
    const r = evaluateVerdict(input({ before: after, after }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("REALLOCATED_PRESENT")
  })

  it("FAIL one past the reallocated warn-max (11)", () => {
    const after = { ...clean, reallocatedSectors: 11 }
    const r = evaluateVerdict(input({ before: after, after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("REALLOCATED_HIGH")
  })

  it("WARN at exactly the SSD wear warn floor (80)", () => {
    const after = { ...clean, percentageUsed: 80 }
    const r = evaluateVerdict(input({ deviceType: "SSD", before: after, after }))
    expect(r.verdict).toBe("WARN")
    expect(codes(r)).toContain("WEAR_HIGH")
  })

  it("emits PENDING_GROWTH when current pending grows during the test", () => {
    const before = { ...clean, currentPending: 2 }
    const after = { ...clean, currentPending: 5 }
    const r = evaluateVerdict(input({ before, after }))
    expect(r.verdict).toBe("FAIL")
    expect(codes(r)).toContain("PENDING_GROWTH")
  })
})
