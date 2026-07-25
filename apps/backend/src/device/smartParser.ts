import type {
  DriveType,
  SelfTestResult,
  SmartAttributeHealth,
  SmartAttributeRow,
  SmartKeyMetrics,
  Thresholds,
} from "@spindoctor/shared"

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {}
}

export function parseDeviceType(json: unknown): DriveType {
  const j = asRecord(json)
  const device = asRecord(j.device)
  if (device.protocol === "NVMe" || device.type === "nvme") return "NVMe"
  if (num(j.rotation_rate) === 0) return "SSD"
  return "HDD"
}

/** SMART attribute IDs → SmartKeyMetrics fields (ATA). */
const ATA_ATTR_IDS = {
  reallocatedSectors: 5,
  powerOnHours: 9,
  reportedUncorrect: 187,
  currentPending: 197,
  offlineUncorrectable: 198,
  crcErrors: 199,
} as const

export function parseSmartMetrics(json: unknown): SmartKeyMetrics {
  const j = asRecord(json)
  const temperatureC = num(asRecord(j.temperature).current)
  const type = parseDeviceType(json)

  if (type === "NVMe") {
    const log = asRecord(j.nvme_smart_health_information_log)
    return {
      reallocatedSectors: null,
      currentPending: null,
      offlineUncorrectable: null,
      reportedUncorrect: null,
      crcErrors: null,
      powerOnHours: num(log.power_on_hours),
      percentageUsed: num(log.percentage_used),
      mediaErrors: num(log.media_errors),
      temperatureC,
    }
  }

  const table: any[] = Array.isArray(asRecord(j.ata_smart_attributes).table)
    ? asRecord(j.ata_smart_attributes).table
    : []
  const rawById = (id: number): number | null => {
    const row = table.find((r) => asRecord(r).id === id)
    return row ? num(asRecord(asRecord(row).raw).value) : null
  }

  return {
    reallocatedSectors: rawById(ATA_ATTR_IDS.reallocatedSectors),
    currentPending: rawById(ATA_ATTR_IDS.currentPending),
    offlineUncorrectable: rawById(ATA_ATTR_IDS.offlineUncorrectable),
    reportedUncorrect: rawById(ATA_ATTR_IDS.reportedUncorrect),
    crcErrors: rawById(ATA_ATTR_IDS.crcErrors),
    powerOnHours: rawById(ATA_ATTR_IDS.powerOnHours),
    percentageUsed: null,
    mediaErrors: null,
    temperatureC,
  }
}

/**
 * Per-row health for an ATA attribute (issue #14). The named checks mirror
 * `verdict/evaluate.ts`'s rules so a row's flag never disagrees with the
 * run's own verdict reasons; everything else falls back to the drive's own
 * pass/fail call on the attribute (normalized value at or below its own
 * threshold, or smartctl's `when_failed` marker) so vendor-specific
 * attributes the named checks don't know about still get flagged.
 */
function ataAttributeHealth(
  id: number | null,
  rawValue: number | null,
  value: number | null,
  thresh: number | null,
  whenFailed: string | null,
  thresholds: Thresholds,
): SmartAttributeHealth {
  if (id === ATA_ATTR_IDS.reallocatedSectors && rawValue != null && rawValue > 0) {
    return rawValue > thresholds.reallocatedWarnMax ? "fail" : "warn"
  }
  if (id === ATA_ATTR_IDS.currentPending && rawValue != null && rawValue > 0) return "fail"
  if (id === ATA_ATTR_IDS.offlineUncorrectable && rawValue != null && rawValue > 0) return "fail"
  if (id === ATA_ATTR_IDS.reportedUncorrect && rawValue != null && rawValue > 0) return "fail"
  if (id === ATA_ATTR_IDS.crcErrors && rawValue != null && rawValue > 0) return "warn"

  if (whenFailed) return "fail"
  if (thresh != null && thresh > 0 && value != null && value <= thresh) return "fail"

  return "ok"
}

function parseAtaAttributes(table: any[], thresholds: Thresholds): SmartAttributeRow[] {
  return table.map((r) => {
    const row = asRecord(r)
    const raw = asRecord(row.raw)
    const id = num(row.id)
    const rawValue = num(raw.value)
    const value = num(row.value)
    const thresh = num(row.thresh)
    const whenFailed =
      typeof row.when_failed === "string" && row.when_failed.length > 0 ? row.when_failed : null
    const rawString =
      typeof raw.string === "string" && raw.string !== String(rawValue) ? raw.string : null

    return {
      id,
      name: typeof row.name === "string" ? row.name : `unknown_attribute_${id ?? "?"}`,
      value,
      worst: num(row.worst),
      thresh,
      rawValue,
      rawString,
      health: ataAttributeHealth(id, rawValue, value, thresh, whenFailed, thresholds),
    }
  })
}

/** NVMe health-log fields worth surfacing as attribute rows — not every field
 * in the log, just the ones with a meaningful health story. */
const NVME_FIELDS: readonly string[] = [
  "critical_warning",
  "percentage_used",
  "available_spare",
  "available_spare_threshold",
  "media_errors",
  "num_err_log_entries",
  "power_on_hours",
  "unsafe_shutdowns",
  "controller_busy_time",
]

function nvmeAttributeHealth(
  name: string,
  v: number,
  log: Record<string, any>,
  thresholds: Thresholds,
): SmartAttributeHealth {
  switch (name) {
    case "percentage_used":
      if (v >= thresholds.ssdPercentageUsedFail) return "fail"
      if (v >= thresholds.ssdPercentageUsedWarn) return "warn"
      return "ok"
    case "media_errors":
      return v > 0 ? "fail" : "ok"
    case "critical_warning":
      return v !== 0 ? "fail" : "ok"
    case "available_spare": {
      const spareThreshold = num(log.available_spare_threshold)
      return spareThreshold != null && v <= spareThreshold ? "fail" : "ok"
    }
    default:
      return "ok"
  }
}

function parseNvmeAttributes(json: unknown, thresholds: Thresholds): SmartAttributeRow[] {
  const log = asRecord(asRecord(json).nvme_smart_health_information_log)
  const rows: SmartAttributeRow[] = []
  for (const name of NVME_FIELDS) {
    const v = num(log[name])
    if (v == null) continue // field not reported by this drive
    rows.push({
      id: null,
      name,
      value: null,
      worst: null,
      thresh: null,
      rawValue: v,
      rawString: null,
      health: nvmeAttributeHealth(name, v, log, thresholds),
    })
  }
  return rows
}

/**
 * The full SMART attribute table for a snapshot (issue #14) — every row
 * smartctl reported, each with a per-row health flag, for the "show me
 * everything and explain it" viewer. Returns `[]` when the raw JSON has no
 * attribute table at all rather than throwing, so a snapshot captured from a
 * device/tool version that doesn't populate one still renders an empty table
 * instead of crashing the route.
 */
export function parseSmartAttributes(json: unknown, thresholds: Thresholds): SmartAttributeRow[] {
  const type = parseDeviceType(json)
  if (type === "NVMe") return parseNvmeAttributes(json, thresholds)

  const table = asRecord(asRecord(json).ata_smart_attributes).table
  return Array.isArray(table) ? parseAtaAttributes(table, thresholds) : []
}

function classifySelfTest(str: string, value?: number, passed?: boolean): SelfTestResult {
  const t = str.toLowerCase()
  if (passed === true || value === 0 || t.includes("completed without error")) {
    return { status: "PASSED" }
  }
  if (t.includes("aborted") || t.includes("interrupted")) {
    return { status: "ABORTED", message: str }
  }
  if (passed === false || t.includes("failure") || t.includes("failed")) {
    return { status: "FAILED", message: str }
  }
  return str ? { status: "UNKNOWN", message: str } : { status: "UNKNOWN" }
}

export function parseSelfTest(json: unknown): SelfTestResult {
  const j = asRecord(json)
  const type = parseDeviceType(json)

  if (type === "NVMe") {
    const row = asRecord(asRecord(j.nvme_self_test_log).table?.[0])
    const res = asRecord(row.self_test_result)
    if (res.string == null && res.value == null) return { status: "UNKNOWN" }
    return classifySelfTest(String(res.string ?? ""), num(res.value) ?? undefined)
  }

  // Prefer the execution-status field (ata_smart_data.self_test.status): it
  // reflects the just-finished test the moment the test stops running, whereas
  // ata_smart_self_test_log's newest row can lag by a moment — or read empty —
  // right at completion. Reading the result from the log alone can therefore
  // surface a cleanly-completed test as UNKNOWN, which the verdict treats as
  // "incomplete" and downgrades a healthy drive to a spurious WARN.
  const execStatus = asRecord(asRecord(asRecord(j.ata_smart_data).self_test).status)
  const execResult = classifySelfTest(
    String(execStatus.string ?? ""),
    num(execStatus.value) ?? undefined,
    typeof execStatus.passed === "boolean" ? execStatus.passed : undefined,
  )
  if (execResult.status !== "UNKNOWN") return execResult

  // Fall back to the self-test log's newest row when the execution status
  // isn't usable (e.g. a drive/version that doesn't populate that field).
  const row = asRecord(j.ata_smart_self_test_log).standard?.table?.[0]
  if (!row) return { status: "UNKNOWN" }
  const status = asRecord(asRecord(row).status)
  return classifySelfTest(
    String(status.string ?? ""),
    num(status.value) ?? undefined,
    typeof status.passed === "boolean" ? status.passed : undefined,
  )
}
