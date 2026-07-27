import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type { SmartKeyMetrics, Verdict } from "@spindoctor/shared"
import { evaluateVerdict } from "./evaluate"

/**
 * The evaluator replayed against a real 18-drive SAS batch (issue #54).
 *
 * The counters below are the baseline SMART readings actually captured from that
 * batch, paired with what each drive's own firmware said about itself. It is the
 * only ground truth this project has where "the drive is dying" is known
 * independently of our own rules, which makes it the test that matters most when
 * a threshold changes: a threshold tuned on published failure-rate tables can
 * still be wrong for the drives in front of you.
 *
 * What it pins down:
 *
 *  - every drive its own firmware condemns must FAIL;
 *  - the two drives carrying uncorrected read errors must FAIL *even though*
 *    their firmware reports OK — the case our rules exist to catch;
 *  - no other drive may FAIL, however large its grown-defect count. The highest
 *    count in the batch (7827) is on a drive the vendor considers healthy, so any
 *    absolute-count rule would condemn the healthiest disk measured.
 */

const base: SmartKeyMetrics = {
  reallocatedSectors: null,
  currentPending: null,
  offlineUncorrectable: null,
  reportedUncorrect: null,
  crcErrors: null,
  powerOnHours: null,
  spinRetryCount: null,
  commandTimeouts: null,
  percentageUsed: null,
  mediaErrors: null,
  temperatureC: null,
  grownDefects: null,
  linkErrors: null,
  smartHealthPassed: null,
}

interface FleetDrive {
  id: string
  grownDefects: number
  reportedUncorrect: number
  /** What the drive's own firmware said — `false` is "data channel impending
   * failure, data error rate too high". */
  vendorHealthy: boolean
}

const FLEET: FleetDrive[] = [
  { id: "ST12000NM0027 #1", grownDefects: 636, reportedUncorrect: 0, vendorHealthy: false },
  { id: "ST12000NM0027 #2", grownDefects: 7827, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #3", grownDefects: 0, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #4", grownDefects: 100, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0038 #5", grownDefects: 4, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #6", grownDefects: 1104, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #7", grownDefects: 3045, reportedUncorrect: 0, vendorHealthy: false },
  { id: "ST12000NM0027 #8", grownDefects: 2601, reportedUncorrect: 0, vendorHealthy: false },
  { id: "HUH721212AL5200 #9", grownDefects: 2, reportedUncorrect: 160, vendorHealthy: true },
  { id: "HUH721212AL5200 #10", grownDefects: 0, reportedUncorrect: 34, vendorHealthy: true },
  { id: "ST12000NM0027 #11", grownDefects: 11, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #12", grownDefects: 1, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #13", grownDefects: 155, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #14", grownDefects: 631, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #15", grownDefects: 19, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #16", grownDefects: 6056, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #17", grownDefects: 20, reportedUncorrect: 0, vendorHealthy: true },
  { id: "ST12000NM0027 #18", grownDefects: 13, reportedUncorrect: 0, vendorHealthy: true },
]

/** Grades a drive from its baseline alone, the way the #49 gate does. */
function gradeBaseline(drive: FleetDrive): { verdict: Verdict; codes: string[] } {
  const metrics: SmartKeyMetrics = {
    ...base,
    grownDefects: drive.grownDefects,
    reportedUncorrect: drive.reportedUncorrect,
    smartHealthPassed: drive.vendorHealthy,
  }
  const { verdict, reasons } = evaluateVerdict({
    before: metrics,
    after: metrics,
    deviceType: "HDD",
    selfTest: { status: "PASSED" },
    surface: null,
    thresholds: DEFAULT_THRESHOLDS,
  })
  return { verdict, codes: reasons.map((r) => r.code) }
}

describe("evaluateVerdict against the real 18-drive SAS batch (#54)", () => {
  it("fails every drive its own firmware condemns", () => {
    const condemned = FLEET.filter((d) => !d.vendorHealthy)
    expect(condemned).toHaveLength(3)
    for (const drive of condemned) {
      const { verdict, codes } = gradeBaseline(drive)
      expect(verdict, drive.id).toBe("FAIL")
      expect(codes, drive.id).toContain("SMART_HEALTH_FAILED")
    }
  })

  it("fails the drives with uncorrected read errors that their firmware still calls OK", () => {
    const missedByVendor = FLEET.filter((d) => d.vendorHealthy && d.reportedUncorrect > 0)
    expect(missedByVendor).toHaveLength(2)
    for (const drive of missedByVendor) {
      const { verdict, codes } = gradeBaseline(drive)
      expect(verdict, drive.id).toBe("FAIL")
      expect(codes, drive.id).toContain("REPORTED_UNCORRECT")
    }
  })

  // The regression that matters if anyone is ever tempted to add an absolute
  // grown-defect threshold: it would condemn working drives, starting with the
  // one carrying the highest count in the batch.
  it("fails no healthy drive, however large its grown-defect count", () => {
    const healthy = FLEET.filter((d) => d.vendorHealthy && d.reportedUncorrect === 0)
    expect(healthy).toHaveLength(13)
    for (const drive of healthy) {
      const { verdict } = gradeBaseline(drive)
      expect(verdict, `${drive.id} (${drive.grownDefects} grown defects)`).not.toBe("FAIL")
    }
  })

  it("warns rather than fails on the batch's highest grown-defect count", () => {
    const worst = FLEET.reduce((a, b) => (b.grownDefects > a.grownDefects ? b : a))
    expect(worst.grownDefects).toBe(7827)
    expect(worst.vendorHealthy).toBe(true)

    const { verdict, codes } = gradeBaseline(worst)
    expect(verdict).toBe("WARN")
    expect(codes).toEqual(["GROWN_DEFECTS_PRESENT"])
  })

  it("passes the one drive in the batch with no defects and no errors", () => {
    const pristine = FLEET.find((d) => d.grownDefects === 0 && d.reportedUncorrect === 0)!
    expect(gradeBaseline(pristine).verdict).toBe("PASS")
  })
})
