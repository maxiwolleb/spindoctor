import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import type { DriveType, SmartKeyMetrics } from "@spindoctor/shared"
import { parseSmartMetrics } from "../device/smartParser"
import { condemnedByBaseline } from "./baselineGate"
import ataHealthy from "../device/__fixtures__/ata-healthy.json"
import ataWarning from "../device/__fixtures__/ata-warning.json"
import ataFailing from "../device/__fixtures__/ata-failing.json"
import sasImpendingFailure from "../device/__fixtures__/sas-impending-failure.json"
import nvmeHealthy from "../device/__fixtures__/nvme-healthy.json"

function gate(before: SmartKeyMetrics, deviceType: DriveType = "HDD") {
  return condemnedByBaseline({ before, deviceType, thresholds: DEFAULT_THRESHOLDS })
}
const codes = (reasons: ReturnType<typeof gate>) => reasons.map((r) => r.code)

describe("condemnedByBaseline", () => {
  it("condemns a SAS drive that reports its own impending failure", () => {
    const reasons = gate(parseSmartMetrics(sasImpendingFailure))
    expect(codes(reasons)).toContain("SMART_HEALTH_FAILED")
  })

  it("condemns an ATA drive with pending/uncorrectable sectors at baseline", () => {
    const reasons = gate(parseSmartMetrics(ataFailing))
    expect(codes(reasons)).toContain("CURRENT_PENDING")
  })

  it("does not condemn a healthy drive", () => {
    expect(gate(parseSmartMetrics(ataHealthy))).toEqual([])
  })

  it("does not condemn a healthy NVMe drive", () => {
    expect(gate(parseSmartMetrics(nvmeHealthy), "NVMe")).toEqual([])
  })

  // The load-bearing case: the whole point of the gate is that it only fires on
  // findings no later stage could overturn. Everything warn-severity — stable
  // reallocated sectors, CRC errors — must still earn the full regime.
  it("does not condemn a drive that only has warnings", () => {
    const reasons = gate(parseSmartMetrics(ataWarning))
    expect(reasons).toEqual([])
  })

  it("does not condemn on stable SAS grown defects or link errors alone", () => {
    const before: SmartKeyMetrics = {
      reallocatedSectors: null,
      currentPending: null,
      offlineUncorrectable: null,
      reportedUncorrect: 0,
      crcErrors: null,
      powerOnHours: 30000,
      spinRetryCount: null,
      commandTimeouts: null,
      percentageUsed: null,
      mediaErrors: null,
      temperatureC: 34,
      grownDefects: 7827,
      linkErrors: 255,
      smartHealthPassed: true,
    }
    expect(gate(before)).toEqual([])
  })

  it("returns only fail-severity reasons, never the warnings beside them", () => {
    const before: SmartKeyMetrics = {
      reallocatedSectors: 4,
      currentPending: 2,
      offlineUncorrectable: 0,
      reportedUncorrect: 0,
      crcErrors: 9,
      powerOnHours: 100,
      spinRetryCount: null,
      commandTimeouts: null,
      percentageUsed: null,
      mediaErrors: null,
      temperatureC: 30,
      grownDefects: null,
      linkErrors: null,
      smartHealthPassed: true,
    }
    const reasons = gate(before)
    expect(codes(reasons)).toEqual(["CURRENT_PENDING"])
    expect(reasons.every((r) => r.severity === "fail")).toBe(true)
  })

  it("condemns an exhausted SSD on wear alone", () => {
    const before: SmartKeyMetrics = {
      reallocatedSectors: 0,
      currentPending: 0,
      offlineUncorrectable: 0,
      reportedUncorrect: 0,
      crcErrors: 0,
      powerOnHours: 40000,
      spinRetryCount: null,
      commandTimeouts: null,
      percentageUsed: 104,
      mediaErrors: 0,
      temperatureC: 40,
      grownDefects: null,
      linkErrors: null,
      smartHealthPassed: true,
    }
    expect(codes(gate(before, "SSD"))).toContain("WEAR_EXHAUSTED")
  })
})
