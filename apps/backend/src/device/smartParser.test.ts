import { describe, it, expect } from "vitest"
import { parseDeviceType, parseSmartMetrics, parseSelfTest } from "./smartParser"
import ataHealthy from "./__fixtures__/ata-healthy.json"
import ataFailing from "./__fixtures__/ata-failing.json"
import nvmeHealthy from "./__fixtures__/nvme-healthy.json"

describe("parseDeviceType", () => {
  it("detects HDD from rotation rate", () => {
    expect(parseDeviceType(ataHealthy)).toBe("HDD")
  })
  it("detects NVMe from protocol", () => {
    expect(parseDeviceType(nvmeHealthy)).toBe("NVMe")
  })
  it("detects SSD from zero rotation rate on an ATA device", () => {
    expect(parseDeviceType({ device: { protocol: "ATA" }, rotation_rate: 0 })).toBe("SSD")
  })
})

describe("parseSmartMetrics (ATA)", () => {
  it("maps healthy ATA attributes", () => {
    expect(parseSmartMetrics(ataHealthy)).toEqual({
      reallocatedSectors: 0,
      currentPending: 0,
      offlineUncorrectable: 0,
      reportedUncorrect: 0,
      crcErrors: 0,
      powerOnHours: 21000,
      percentageUsed: null,
      mediaErrors: null,
      temperatureC: 33,
    })
  })
  it("maps failing ATA attributes", () => {
    const m = parseSmartMetrics(ataFailing)
    expect(m.reallocatedSectors).toBe(48)
    expect(m.currentPending).toBe(8)
    expect(m.offlineUncorrectable).toBe(8)
    expect(m.reportedUncorrect).toBe(12)
    expect(m.crcErrors).toBe(2)
  })
  it("returns null for attributes absent from the table", () => {
    const m = parseSmartMetrics({ device: { protocol: "ATA" }, rotation_rate: 7200, ata_smart_attributes: { table: [] } })
    expect(m.reallocatedSectors).toBeNull()
    expect(m.currentPending).toBeNull()
  })
})

describe("parseSmartMetrics (NVMe)", () => {
  it("maps the NVMe health log", () => {
    expect(parseSmartMetrics(nvmeHealthy)).toEqual({
      reallocatedSectors: null,
      currentPending: null,
      offlineUncorrectable: null,
      reportedUncorrect: null,
      crcErrors: null,
      powerOnHours: 1200,
      percentageUsed: 4,
      mediaErrors: 0,
      temperatureC: 41,
    })
  })
})

describe("parseSelfTest", () => {
  it("reads a passed ATA self-test", () => {
    expect(parseSelfTest(ataHealthy)).toEqual({ status: "PASSED" })
  })
  it("reads a failed ATA self-test", () => {
    const r = parseSelfTest(ataFailing)
    expect(r.status).toBe("FAILED")
    expect(r.message).toContain("read failure")
  })
  it("reads a passed NVMe self-test", () => {
    expect(parseSelfTest(nvmeHealthy)).toEqual({ status: "PASSED" })
  })
  it("returns UNKNOWN when no self-test log is present", () => {
    expect(parseSelfTest({ device: { protocol: "ATA" }, rotation_rate: 7200 })).toEqual({ status: "UNKNOWN" })
  })
})
