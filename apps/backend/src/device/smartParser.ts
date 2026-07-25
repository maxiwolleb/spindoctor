import type { DriveType, SelfTestResult, SmartKeyMetrics } from "@spindoctor/shared"

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

  const row = asRecord(j.ata_smart_self_test_log).standard?.table?.[0]
  if (!row) return { status: "UNKNOWN" }
  const status = asRecord(asRecord(row).status)
  return classifySelfTest(
    String(status.string ?? ""),
    num(status.value) ?? undefined,
    typeof status.passed === "boolean" ? status.passed : undefined,
  )
}
