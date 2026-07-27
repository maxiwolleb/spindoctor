import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import {
  isScsiDevice,
  scsiSelfTestInProgress,
  parseDeviceType,
  parseSmartAttributes,
  parseSmartMetrics,
  parseSelfTest,
} from "./smartParser"
import ataHealthy from "./__fixtures__/ata-healthy.json"
import ataFailing from "./__fixtures__/ata-failing.json"
import ataWarning from "./__fixtures__/ata-warning.json"
import nvmeHealthy from "./__fixtures__/nvme-healthy.json"
import scsiMinimal from "./__fixtures__/scsi-minimal.json"
import sasImpendingFailure from "./__fixtures__/sas-impending-failure.json"
import sasUncorrectedErrors from "./__fixtures__/sas-uncorrected-errors.json"

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
      grownDefects: null,
      linkErrors: null,
      smartHealthPassed: true,
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
    const m = parseSmartMetrics({
      device: { protocol: "ATA" },
      rotation_rate: 7200,
      ata_smart_attributes: { table: [] },
    })
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
      grownDefects: null,
      linkErrors: null,
      smartHealthPassed: true,
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
    expect(parseSelfTest({ device: { protocol: "ATA" }, rotation_rate: 7200 })).toEqual({
      status: "UNKNOWN",
    })
  })

  it("reads a completed self-test from the execution-status field when the log lags (#23)", () => {
    // Real-hardware race: ata_smart_data.self_test.status flips to "completed"
    // the moment the test stops running, but ata_smart_self_test_log's newest
    // row hasn't been written yet (here: empty). Reading the result from the
    // log alone surfaced UNKNOWN → a spurious WARN on a healthy drive. The
    // execution-status field must win.
    const raw = {
      device: { protocol: "ATA" },
      rotation_rate: 7200,
      ata_smart_data: {
        self_test: { status: { value: 0, string: "Completed without error", passed: true } },
      },
      ata_smart_self_test_log: { standard: { table: [] } },
    }
    expect(parseSelfTest(raw)).toEqual({ status: "PASSED" })
  })

  it("still reports a failed self-test from the execution-status field (log lagging)", () => {
    const raw = {
      device: { protocol: "ATA" },
      rotation_rate: 7200,
      ata_smart_data: {
        self_test: { status: { value: 117, string: "Completed: read failure", passed: false } },
      },
      ata_smart_self_test_log: { standard: { table: [] } },
    }
    expect(parseSelfTest(raw).status).toBe("FAILED")
  })
})

describe("parseSmartAttributes (ATA)", () => {
  it("returns every row healthy for a clean drive", () => {
    const rows = parseSmartAttributes(ataHealthy, DEFAULT_THRESHOLDS)
    expect(rows).toHaveLength(6)
    expect(rows.every((r) => r.health === "ok")).toBe(true)
    const realloc = rows.find((r) => r.id === 5)
    expect(realloc).toMatchObject({
      name: "Reallocated_Sector_Ct",
      rawValue: 0,
      health: "ok",
    })
  })

  it("flags reallocated/pending/uncorrectable as fail and CRC as warn on a failing drive", () => {
    const rows = parseSmartAttributes(ataFailing, DEFAULT_THRESHOLDS)
    const byId = (id: number) => rows.find((r) => r.id === id)

    // reallocatedSectors=48 exceeds reallocatedWarnMax(10) -> fail
    expect(byId(5)).toMatchObject({ rawValue: 48, health: "fail" })
    expect(byId(197)).toMatchObject({ rawValue: 8, health: "fail" })
    expect(byId(198)).toMatchObject({ rawValue: 8, health: "fail" })
    expect(byId(187)).toMatchObject({ rawValue: 12, health: "fail" })
    expect(byId(199)).toMatchObject({ rawValue: 2, health: "warn" })
  })

  it("warns (not fails) a stable reallocated count under the warn max", () => {
    const rows = parseSmartAttributes(ataWarning, DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.id === 5)).toMatchObject({ rawValue: 3, health: "warn" })
    expect(rows.find((r) => r.id === 199)).toMatchObject({ rawValue: 1, health: "warn" })
  })

  it("falls back to fail for an attribute the drive itself marked failed (when_failed set)", () => {
    const rows = parseSmartAttributes(ataWarning, DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.id === 1)).toMatchObject({
      name: "Raw_Read_Error_Rate",
      health: "fail",
    })
  })

  it("carries value/worst/thresh and a distinct raw string when smartctl provides one", () => {
    const rows = parseSmartAttributes(ataWarning, DEFAULT_THRESHOLDS)
    const powerOn = rows.find((r) => r.id === 9)
    expect(powerOn).toMatchObject({
      value: 88,
      worst: 88,
      thresh: 0,
      rawValue: 12000,
      rawString: "12000h+00m+00.000s",
    })
  })

  it("returns [] when the raw JSON has no attribute table", () => {
    expect(
      parseSmartAttributes(
        { device: { protocol: "ATA" }, rotation_rate: 7200 },
        DEFAULT_THRESHOLDS,
      ),
    ).toEqual([])
  })
})

describe("parseSmartAttributes (NVMe)", () => {
  it("maps the NVMe health log fields it reported, all healthy", () => {
    const rows = parseSmartAttributes(nvmeHealthy, DEFAULT_THRESHOLDS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.id === null && r.value === null)).toBe(true)
    expect(rows.find((r) => r.name === "percentage_used")).toMatchObject({
      rawValue: 4,
      health: "ok",
    })
    expect(rows.find((r) => r.name === "media_errors")).toMatchObject({
      rawValue: 0,
      health: "ok",
    })
  })

  it("flags high wear and media errors", () => {
    const worn = {
      ...nvmeHealthy,
      nvme_smart_health_information_log: {
        ...(nvmeHealthy as any).nvme_smart_health_information_log,
        percentage_used: 100,
        media_errors: 3,
        critical_warning: 1,
      },
    }
    const rows = parseSmartAttributes(worn, DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.name === "percentage_used")).toMatchObject({ health: "fail" })
    expect(rows.find((r) => r.name === "media_errors")).toMatchObject({ health: "fail" })
    expect(rows.find((r) => r.name === "critical_warning")).toMatchObject({ health: "fail" })
  })

  it("warns (not fails) at the SSD wear warn floor", () => {
    const worn = {
      ...nvmeHealthy,
      nvme_smart_health_information_log: {
        ...(nvmeHealthy as any).nvme_smart_health_information_log,
        percentage_used: 85,
      },
    }
    const rows = parseSmartAttributes(worn, DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.name === "percentage_used")).toMatchObject({ health: "warn" })
  })
})

// SAS/SCSI (#18). Field semantics and the value ranges below come from a real
// 18-drive SAS burn-in archive (Seagate ST12000NM0027/ST12000NM0038, HGST
// HUH721212AL5200); serials in the fixtures are anonymized. `scsi-minimal.json`
// is a genuine capture from a kernel `scsi_debug` target, which is why it has a
// SCSI envelope but none of the log pages a real SAS disk reports.
describe("parseSmartMetrics — SAS/SCSI", () => {
  it("detects a SCSI device by protocol", () => {
    expect(isScsiDevice(scsiMinimal)).toBe(true)
    expect(isScsiDevice(sasImpendingFailure)).toBe(true)
    expect(isScsiDevice(ataHealthy)).toBe(false)
  })

  it("maps the grown defect list and the drive's own failing health verdict", () => {
    const m = parseSmartMetrics(sasImpendingFailure)

    expect(m.grownDefects).toBe(636)
    expect(m.smartHealthPassed).toBe(false)
    expect(m.temperatureC).toBe(40)
    expect(m.powerOnHours).toBe(56724)
  })

  it("sums uncorrected errors across read/write/verify into reportedUncorrect", () => {
    // 158 read + 0 write + 0 verify — the ATA attribute of that name counts the
    // same thing, so a SAS drive lands on the existing rule.
    expect(parseSmartMetrics(sasUncorrectedErrors).reportedUncorrect).toBe(158)
    expect(parseSmartMetrics(sasImpendingFailure).reportedUncorrect).toBe(0)
  })

  it("leaves ATA-only metrics null rather than inventing SAS equivalents", () => {
    const m = parseSmartMetrics(sasImpendingFailure)

    // SAS has no current-pending / offline-uncorrectable / CRC attribute, and
    // grown defects deliberately do NOT populate reallocatedSectors: the scales
    // differ by orders of magnitude, so the ATA threshold would grade them wrongly.
    expect(m.reallocatedSectors).toBeNull()
    expect(m.currentPending).toBeNull()
    expect(m.offlineUncorrectable).toBeNull()
    expect(m.crcErrors).toBeNull()
    expect(m.percentageUsed).toBeNull()
  })

  it("survives a SCSI device that reports no log pages at all", () => {
    const m = parseSmartMetrics(scsiMinimal)

    expect(m.smartHealthPassed).toBe(true)
    expect(m.grownDefects).toBeNull()
    expect(m.reportedUncorrect).toBeNull()
    expect(m.powerOnHours).toBeNull()
  })

  it("reports power-on hours as null for a vendor that omits the page (real HGST behavior)", () => {
    expect(parseSmartMetrics(sasUncorrectedErrors).powerOnHours).toBeNull()
  })

  it("still records the health verdict for ATA, where it is a weaker signal", () => {
    expect(parseSmartMetrics(ataHealthy).smartHealthPassed).toBe(true)
  })
})

// SCSI self-test log + SAS link counters (#18). Structures verified against
// smartmontools RELEASE_7_5 scsiprint.cpp: entries are flat numbered keys with
// scsi_self_test_0 newest, phys are phy_N under scsi_sas_port_N. The log wording
// below is what real SAS drives emit ("Completed", not ATA's "completed without
// error"; "Aborted (device reset ?)").
describe("parseSelfTest — SAS/SCSI", () => {
  it("reads a completed SCSI self-test off the newest numbered entry", () => {
    expect(parseSelfTest(sasImpendingFailure)).toEqual({ status: "PASSED" })
  })

  it("classifies a device-reset abort as ABORTED, not FAILED", () => {
    const r = parseSelfTest(sasUncorrectedErrors)
    expect(r.status).toBe("ABORTED")
    expect(r.message).toContain("device reset")
  })

  it("does not call an in-progress SCSI test a result", () => {
    const running = {
      ...scsiMinimal,
      scsi_self_test_0: { self_test_in_progress: true, code: { string: "Background long" } },
    }
    expect(parseSelfTest(running).status).toBe("UNKNOWN")
    expect(scsiSelfTestInProgress(running)).toBe(true)
    expect(scsiSelfTestInProgress(sasImpendingFailure)).toBe(false)
  })

  it("returns UNKNOWN for a SCSI device with no self-test log at all", () => {
    expect(parseSelfTest(scsiMinimal)).toEqual({ status: "UNKNOWN" })
  })
})

describe("parseSmartMetrics — SAS link counters", () => {
  it("sums invalid DWORDs and loss-of-sync across phys", () => {
    // 255 invalid + 6 loss-of-sync on the real drive this mirrors. Running
    // disparity is deliberately not counted — it tracks the same cable fault and
    // would double-report it.
    expect(parseSmartMetrics(sasImpendingFailure).linkErrors).toBe(261)
  })

  it("reports zero for a clean link, distinct from no SAS link data at all", () => {
    expect(parseSmartMetrics(sasUncorrectedErrors).linkErrors).toBe(0)
    expect(parseSmartMetrics(scsiMinimal).linkErrors).toBeNull()
  })

  it("accepts the spaced key form smartctl writes in its own output", () => {
    const spaced = {
      ...scsiMinimal,
      scsi_sas_port_0: {
        phy_0: { "Invalid DWORD count": 10, "Loss of DWORD synchronization count": 2 },
        phy_1: { "Invalid DWORD count": 1, "Loss of DWORD synchronization count": 0 },
      },
    }
    expect(parseSmartMetrics(spaced).linkErrors).toBe(13)
  })
})
