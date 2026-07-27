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
import { evaluateVerdict } from "../verdict/evaluate"
import ataHealthy from "./__fixtures__/ata-healthy.json"
import ataFailing from "./__fixtures__/ata-failing.json"
import ataWarning from "./__fixtures__/ata-warning.json"
import nvmeHealthy from "./__fixtures__/nvme-healthy.json"
import scsiMinimal from "./__fixtures__/scsi-minimal.json"
import sasImpendingFailure from "./__fixtures__/sas-impending-failure.json"
import sasUncorrectedErrors from "./__fixtures__/sas-uncorrected-errors.json"
import sataSsdWorn from "./__fixtures__/sata-ssd-worn.json"
import nvmeUsbBridgeReal from "./__fixtures__/nvme-usb-bridge-real.json"

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
      spinRetryCount: null,
      commandTimeouts: null,
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
      spinRetryCount: null,
      commandTimeouts: null,
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

// Issue #54: SAS/SCSI drives had an empty attribute table — `parseSmartAttributes`
// only knew the ATA table and the NVMe health log — even though the health data
// is in the raw JSON we already store.
describe("parseSmartAttributes (SAS/SCSI)", () => {
  const byName = (rows: ReturnType<typeof parseSmartAttributes>, name: string) =>
    rows.find((r) => r.name === name)

  it("surfaces the drive's own failing self-assessment as the leading row", () => {
    const rows = parseSmartAttributes(sasImpendingFailure, DEFAULT_THRESHOLDS)

    // On SAS this is the authoritative failure signal, so it leads the table.
    expect(rows[0]).toMatchObject({
      name: "scsi_smart_status",
      id: null,
      rawValue: null,
      rawString: "FAILING",
      health: "fail",
    })
  })

  it("grades grown defects as a warning and link counters as cabling warnings", () => {
    const rows = parseSmartAttributes(sasImpendingFailure, DEFAULT_THRESHOLDS)

    // Warn, not fail: healthy in-service SAS drives routinely carry thousands,
    // so only growth during a run condemns (see verdict/evaluate.ts).
    expect(byName(rows, "scsi_grown_defect_list")).toMatchObject({ rawValue: 636, health: "warn" })
    expect(byName(rows, "sas_invalid_dword_count")).toMatchObject({ rawValue: 255, health: "warn" })
    expect(byName(rows, "sas_loss_of_dword_synchronization_count")).toMatchObject({
      rawValue: 6,
      health: "warn",
    })
    // Never graded — same cabling story, but the evaluator doesn't act on them.
    expect(byName(rows, "sas_running_disparity_error_count")).toMatchObject({
      rawValue: 249,
      health: "ok",
    })
    expect(byName(rows, "sas_phy_reset_problem_count")).toMatchObject({ rawValue: 0, health: "ok" })
  })

  it("fails uncorrected errors per operation, and leaves ECC-corrected counts alone", () => {
    const rows = parseSmartAttributes(sasUncorrectedErrors, DEFAULT_THRESHOLDS)

    expect(byName(rows, "read_total_uncorrected_errors")).toMatchObject({
      rawValue: 158,
      health: "fail",
    })
    expect(byName(rows, "write_total_uncorrected_errors")).toMatchObject({ health: "ok" })
    // 19.6M ECC-corrected reads is normal operation, not a defect — this row
    // exists to be read, not to be graded.
    const corrected = byName(
      parseSmartAttributes(sasImpendingFailure, DEFAULT_THRESHOLDS),
      "read_total_errors_corrected",
    )
    expect(corrected).toMatchObject({ rawValue: 19650581, health: "ok" })
  })

  it("surfaces reread/rewrite recoveries, the counter that precedes real trouble", () => {
    const rows = parseSmartAttributes(sasUncorrectedErrors, DEFAULT_THRESHOLDS)
    expect(byName(rows, "read_errors_corrected_by_rereads_rewrites")).toMatchObject({
      rawValue: 158,
      health: "ok",
    })
  })

  it("includes power-on hours and temperature as informational rows", () => {
    const rows = parseSmartAttributes(sasImpendingFailure, DEFAULT_THRESHOLDS)
    expect(byName(rows, "power_on_hours")).toMatchObject({ rawValue: 56724, health: "ok" })
    expect(byName(rows, "temperature_celsius")).toMatchObject({ rawValue: 40, health: "ok" })
  })

  it("every row agrees with the verdict the same snapshot produces", () => {
    const rows = parseSmartAttributes(sasImpendingFailure, DEFAULT_THRESHOLDS)
    const metrics = parseSmartMetrics(sasImpendingFailure)
    const { reasons } = evaluateVerdict({
      before: metrics,
      after: metrics,
      deviceType: "HDD",
      selfTest: { status: "PASSED" },
      surface: null,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const worst = reasons.some((r) => r.severity === "fail") ? "fail" : "warn"
    const worstRow = rows.some((r) => r.health === "fail") ? "fail" : "warn"
    expect(worstRow).toBe(worst)
  })

  it("omits rows a drive doesn't report rather than inventing zeros", () => {
    // scsi-minimal has no error counter log, no defect list, no phy counters
    // and no power-on time — only a self-assessment.
    const rows = parseSmartAttributes(scsiMinimal, DEFAULT_THRESHOLDS)
    expect(rows.map((r) => r.name)).toEqual(["scsi_smart_status"])
    expect(rows[0]).toMatchObject({ rawString: "OK", health: "ok" })
  })

  it("still returns an empty table for a device that reports nothing at all", () => {
    expect(parseSmartAttributes({ device: { protocol: "SCSI" } }, DEFAULT_THRESHOLDS)).toEqual([])
  })
})

// Issue #54: percentageUsed was null for every non-NVMe device, so the
// evaluator's SSD-wear rule was unreachable on SATA SSDs — a worn-out SATA SSD
// could pass. These attributes report a NORMALIZED value counting down from 100,
// not a raw counter, which is what made them easy to miss.
describe("parseSmartMetrics SATA SSD wear (#54)", () => {
  it("derives percentage-used from the normalized wear attribute, not the raw value", () => {
    const metrics = parseSmartMetrics(sataSsdWorn)
    // 231 SSD_Life_Left normalized 12 -> 88% used. The raw column also reads 12,
    // which would have given 12% used had it been read instead.
    expect(metrics.percentageUsed).toBe(88)
  })

  it("condemns a worn SATA SSD that the drive's own SMART status still passes", () => {
    const metrics = parseSmartMetrics(sataSsdWorn)
    expect(metrics.smartHealthPassed).toBe(true)
    const { verdict, reasons } = evaluateVerdict({
      before: metrics,
      after: metrics,
      deviceType: "SSD",
      selfTest: { status: "PASSED" },
      surface: null,
      thresholds: DEFAULT_THRESHOLDS,
    })
    expect(verdict).toBe("WARN")
    expect(reasons.map((r) => r.code)).toContain("WEAR_HIGH")
  })

  it("prefers the first wear attribute the drive reports, in order", () => {
    // Only 233 (Media_Wearout_Indicator) present: normalized 30 -> 70% used.
    const json = {
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 0,
      ata_smart_attributes: {
        table: [{ id: 233, name: "Media_Wearout_Indicator", value: 30, raw: { value: 0 } }],
      },
    }
    expect(parseSmartMetrics(json).percentageUsed).toBe(70)
  })

  it("leaves wear null on a spinning disk, where those attribute ids mean other things", () => {
    // 202 is "Data Address Mark errors" on an HDD, not a wear percentage.
    const json = {
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 7200,
      ata_smart_attributes: {
        table: [{ id: 202, name: "Data_Address_Mark_Errs", value: 100, raw: { value: 0 } }],
      },
    }
    expect(parseSmartMetrics(json).percentageUsed).toBeNull()
  })

  it("leaves wear null for an SSD that reports no wear attribute at all", () => {
    const json = {
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 0,
      ata_smart_attributes: {
        table: [{ id: 5, name: "Reallocated_Sector_Ct", raw: { value: 0 } }],
      },
    }
    expect(parseSmartMetrics(json).percentageUsed).toBeNull()
  })

  it("clamps rather than reporting negative wear for a value above 100", () => {
    const json = {
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 0,
      ata_smart_attributes: {
        table: [{ id: 231, name: "SSD_Life_Left", value: 120, raw: { value: 0 } }],
      },
    }
    expect(parseSmartMetrics(json).percentageUsed).toBe(0)
  })
})

// The two ATA attributes the threshold audit added (#54).
describe("parseSmartMetrics spin retries and command timeouts (#54)", () => {
  it("reads attribute 10 and 188 raw values", () => {
    const json = {
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 7200,
      ata_smart_attributes: {
        table: [
          { id: 10, name: "Spin_Retry_Count", value: 100, raw: { value: 2 } },
          { id: 188, name: "Command_Timeout", value: 100, raw: { value: 143 } },
        ],
      },
    }
    const metrics = parseSmartMetrics(json)
    expect(metrics.spinRetryCount).toBe(2)
    expect(metrics.commandTimeouts).toBe(143)
  })
})

// Found on real hardware during the e2e: a healthy ST9500423AS reports attribute
// 188 as 4295032838 = 0x1_0001_0006, three packed 16-bit counters (6, 1, 1).
// smartctl leaves it packed, so reading it as an integer trips any threshold.
describe("parseSmartMetrics command-timeout packing (attribute 188)", () => {
  const withCommandTimeout = (rawValue: number) => ({
    device: { protocol: "ATA", type: "sat" },
    rotation_rate: 7200,
    ata_smart_attributes: {
      table: [{ id: 188, name: "Command_Timeout", value: 100, raw: { value: rawValue } }],
    },
  })

  it("takes the low word of a packed raw value", () => {
    // The exact reading from the rig's healthy drive.
    expect(parseSmartMetrics(withCommandTimeout(4295032838)).commandTimeouts).toBe(6)
  })

  it("leaves a plain small count alone", () => {
    expect(parseSmartMetrics(withCommandTimeout(6)).commandTimeouts).toBe(6)
    expect(parseSmartMetrics(withCommandTimeout(0)).commandTimeouts).toBe(0)
    expect(parseSmartMetrics(withCommandTimeout(65535)).commandTimeouts).toBe(65535)
  })

  // The regression that matters: before decoding, this healthy drive earned a
  // spurious COMMAND_TIMEOUTS warning on every run.
  it("does not warn on a healthy drive whose raw value is packed", () => {
    const metrics = parseSmartMetrics(withCommandTimeout(4295032838))
    const { verdict, reasons } = evaluateVerdict({
      before: metrics,
      after: metrics,
      deviceType: "HDD",
      selfTest: { status: "PASSED" },
      surface: null,
      thresholds: DEFAULT_THRESHOLDS,
    })
    expect(verdict).toBe("PASS")
    expect(reasons.map((r) => r.code)).not.toContain("COMMAND_TIMEOUTS")
  })

  it("shows the count in the attribute table, keeping the composite visible", () => {
    const rows = parseSmartAttributes(withCommandTimeout(4295032838), DEFAULT_THRESHOLDS)
    const row = rows.find((r) => r.id === 188)
    expect(row).toMatchObject({ rawValue: 6, rawString: "6 (packed: 4295032838)" })
  })

  it("leaves an unpacked row's raw rendering untouched", () => {
    const rows = parseSmartAttributes(withCommandTimeout(6), DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.id === 188)).toMatchObject({ rawValue: 6, rawString: null })
  })
})

// Real capture from a Realtek RTL9210 USB-NVMe enclosure — the first
// non-hand-authored NVMe fixture in the repo. It exposed a false positive: a
// controller that implements no spare reporting sends available_spare 0 AND
// threshold 0, which "spare <= threshold" read as exhausted.
describe("parseSmartAttributes NVMe available_spare on a real USB-bridged drive", () => {
  const row = (name: string) =>
    parseSmartAttributes(nvmeUsbBridgeReal, DEFAULT_THRESHOLDS).find((r) => r.name === name)

  it("classifies a USB-bridged NVMe as NVMe, not as a SCSI disk", () => {
    // smartctl auto-detects the bridge (type sntrealtek, protocol NVMe), so the
    // NVMe path works over USB with no -d flag.
    expect(parseDeviceType(nvmeUsbBridgeReal)).toBe("NVMe")
  })

  it("does not flag a drive that reports no spare data as spare-exhausted", () => {
    const log = (nvmeUsbBridgeReal as { nvme_smart_health_information_log: Record<string, number> })
      .nvme_smart_health_information_log
    expect(log.available_spare).toBe(0)
    expect(log.available_spare_threshold).toBe(0)

    // Both zero means the feature is unimplemented, not that the drive is spent.
    expect(row("available_spare")?.health).toBe("ok")
  })

  it("still flags genuine spare exhaustion, where the drive sets a threshold", () => {
    const exhausted = {
      device: { protocol: "NVMe" },
      nvme_smart_health_information_log: {
        available_spare: 3,
        available_spare_threshold: 10,
        percentage_used: 90,
      },
    }
    const rows = parseSmartAttributes(exhausted, DEFAULT_THRESHOLDS)
    expect(rows.find((r) => r.name === "available_spare")?.health).toBe("fail")
  })

  it("flags spare at zero when the drive does set a threshold", () => {
    const exhausted = {
      device: { protocol: "NVMe" },
      nvme_smart_health_information_log: { available_spare: 0, available_spare_threshold: 10 },
    }
    expect(
      parseSmartAttributes(exhausted, DEFAULT_THRESHOLDS).find((r) => r.name === "available_spare")
        ?.health,
    ).toBe("fail")
  })

  it("grades the whole real drive as healthy, with no failing row", () => {
    const rows = parseSmartAttributes(nvmeUsbBridgeReal, DEFAULT_THRESHOLDS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => r.health === "fail")).toEqual([])
  })

  it("reads its metrics without inventing values the controller never sent", () => {
    const m = parseSmartMetrics(nvmeUsbBridgeReal)
    expect(m.percentageUsed).toBe(0)
    expect(m.mediaErrors).toBe(0)
    expect(m.temperatureC).toBe(35)
    expect(m.smartHealthPassed).toBe(true)
    // ATA/SAS-only metrics stay null rather than defaulting to 0.
    expect(m.reallocatedSectors).toBeNull()
    expect(m.spinRetryCount).toBeNull()
    expect(m.commandTimeouts).toBeNull()
    expect(m.grownDefects).toBeNull()
  })
})
