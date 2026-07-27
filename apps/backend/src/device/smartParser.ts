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
  spinRetryCount: 10,
  powerOnHours: 9,
  reportedUncorrect: 187,
  commandTimeouts: 188,
  currentPending: 197,
  offlineUncorrectable: 198,
  crcErrors: 199,
} as const

/**
 * Attribute 188's 48-bit raw field is not one counter — it packs up to three
 * 16-bit counters, and smartctl passes it through as-is (unlike attribute
 * 190, whose `raw.string` it renders as "31 (Min/Max 29/47)"). A healthy Seagate
 * ST9500423AS on the test rig reports raw `4295032838` = `0x1_0001_0006`, i.e.
 * the words 6, 1, 1 — six command timeouts, not four billion.
 *
 * Read as a plain integer it trips any threshold instantly, so the low word is
 * taken as the count. This also explains the shape of the published failure-rate
 * bands for this attribute, whose boundaries run to 13, 26 and 39 *billion*:
 * that dataset contains the same undecoded composites, so only its lowest band
 * ("≤100", ordinary small counts) describes real timeout counts at all.
 *
 * The tradeoff: a drive with a genuine count above 65535 is indistinguishable
 * from a packed value and reads as its low word. That is a drive with tens of
 * thousands of aborted commands, which every other rule condemns anyway, so
 * losing the magnitude costs nothing.
 */
function decodeCommandTimeouts(raw: number | null): number | null {
  if (raw == null) return null
  return raw > 0xffff ? raw & 0xffff : raw
}

/**
 * SATA SSD wear attributes, in the order they're preferred. Each reports a
 * *normalized* value that counts down from 100 as the drive is written to, so
 * wear is `100 - value` — unlike every other attribute here, where the raw
 * counter is what matters.
 *
 * Without this mapping `percentageUsed` was null for every non-NVMe device, so
 * the evaluator's SSD-wear rule was unreachable on SATA SSDs: a worn-out SATA
 * SSD could pass. Several of these attribute ids are vendor-specific and a drive
 * typically reports just one, hence first-match-wins over an ordered list rather
 * than a single id.
 */
const ATA_SSD_WEAR_ATTR_IDS = [
  231, // "SSD_Life_Left" / "Life_Left" — most common
  233, // "Media_Wearout_Indicator" — Intel and others
  177, // "Wear_Leveling_Count" — Samsung
  202, // "Percent_Lifetime_Remain" — Crucial/Micron
] as const

/**
 * Whether the drive can run a device self-test at all. `false` only when the
 * drive positively says it cannot; `true` when it says it can or doesn't say —
 * absence of evidence must not turn into "unsupported", or a drive whose
 * capability page we simply failed to parse would silently skip the stage.
 *
 * NVMe advertises this in the optional-admin-commands bitmap; a real Realtek
 * RTL9210 enclosure on the test rig reports `self_test: false`, and
 * `smartctl -t long` on it prints "Self-tests not supported" and exits 0 — so
 * without this probe the stage "succeeded", polled an empty log, and returned
 * UNKNOWN, which graded as a warning and made a PASS unreachable.
 *
 * ATA exposes the equivalent in its capability flags.
 */
export function selfTestSupported(json: unknown): boolean {
  const j = asRecord(json)

  const nvme = asRecord(j.nvme_optional_admin_commands)
  if (typeof nvme.self_test === "boolean") return nvme.self_test

  const ata = asRecord(asRecord(j.ata_smart_data).capabilities)
  if (typeof ata.self_tests_supported === "boolean") return ata.self_tests_supported

  return true
}

/** True for a SAS/SCSI device, which reports health via SCSI log pages rather
 * than an ATA attribute table (see `parseScsiMetrics`). */
export function isScsiDevice(json: unknown): boolean {
  const device = asRecord(asRecord(json).device)
  return device.protocol === "SCSI" || device.type === "scsi"
}

/**
 * SAS/SCSI metrics. There is no ATA attribute table here — smartctl reports
 * the grown defect list and an error counter log split by operation
 * (`read`/`write`/`verify`), each with its own uncorrected-error total.
 *
 * The uncorrected totals are summed across all three operations into
 * `reportedUncorrect`: the ATA attribute of that name (187) counts the same
 * thing — errors the drive could not recover — so a SAS drive lands on the
 * existing verdict rule rather than needing a parallel one.
 *
 * Fields with no SAS analogue stay `null`: SAS has no current-pending or
 * offline-uncorrectable concept, no interface CRC attribute, and no wear
 * percentage. Power-on hours are absent on some vendors' drives (HGST omits
 * the Seagate/Hitachi vendor page this is read from), so it stays nullable.
 */
function parseScsiMetrics(j: Record<string, any>, temperatureC: number | null): SmartKeyMetrics {
  const counters = asRecord(j.scsi_error_counter_log)
  const uncorrectedFor = (op: string): number | null =>
    num(asRecord(counters[op]).total_uncorrected_errors)

  const uncorrected = ["read", "write", "verify"]
    .map(uncorrectedFor)
    .filter((v): v is number => v != null)

  return {
    reallocatedSectors: null,
    currentPending: null,
    offlineUncorrectable: null,
    reportedUncorrect: uncorrected.length > 0 ? uncorrected.reduce((a, b) => a + b, 0) : null,
    crcErrors: null,
    powerOnHours: num(asRecord(j.power_on_time).hours),
    spinRetryCount: null,
    commandTimeouts: null,
    percentageUsed: null,
    mediaErrors: null,
    temperatureC,
    grownDefects: num(j.scsi_grown_defect_list),
    linkErrors: parseSasLinkErrors(j),
    smartHealthPassed: healthPassed(j),
  }
}

/** The drive's own overall verdict, if it reported one. */
function healthPassed(j: Record<string, any>): boolean | null {
  const passed = asRecord(j.smart_status).passed
  return typeof passed === "boolean" ? passed : null
}

/**
 * SAS link-layer error total: invalid DWORDs plus loss-of-sync across every phy
 * of every port (`scsi_sas_port_0.phy_0`, …).
 *
 * smartctl writes these with human-readable keys containing spaces — literally
 * `jref["Invalid DWORD count"]` — so both that form and a snake_case variant are
 * accepted, since which one lands in the JSON is a detail of smartctl's own key
 * handling rather than something this parser should depend on. Returns null when
 * no port reported any phy counters, so "no SAS link data" stays distinct from
 * "a clean link".
 */
function parseSasLinkErrors(j: Record<string, any>): number | null {
  const COUNTER_KEYS = [
    ["Invalid DWORD count", "invalid_dword_count"],
    ["Loss of DWORD synchronization count", "loss_of_dword_synchronization_count"],
  ] as const

  let total: number | null = null
  for (const [portKey, port] of Object.entries(j)) {
    if (!portKey.startsWith("scsi_sas_port_")) continue
    for (const [phyKey, phy] of Object.entries(asRecord(port))) {
      if (!phyKey.startsWith("phy_")) continue
      const record = asRecord(phy)
      for (const names of COUNTER_KEYS) {
        const value = names.map((n) => num(record[n])).find((v) => v != null)
        if (value != null) total = (total ?? 0) + value
      }
    }
  }
  return total
}

/**
 * SATA SSD wear as a percentage used, from whichever wear attribute the drive
 * reports (see `ATA_SSD_WEAR_ATTR_IDS`). Only consulted for SSDs: several of
 * these ids mean something entirely different on a spinning disk (202 is
 * "Data Address Mark errors" on an HDD), so reading them there would invent a
 * wear figure for a drive that has no such thing.
 *
 * A normalized value of 100 is a new drive and 0 is one at its rated endurance,
 * so used = 100 - value. Values are clamped at 0 rather than allowed negative;
 * unlike NVMe's `percentage_used`, an ATA normalized value cannot express
 * "beyond rated endurance", so the ceiling here is 100.
 */
function ataSsdPercentageUsed(
  type: DriveType,
  normalizedById: (id: number) => number | null,
): number | null {
  if (type !== "SSD") return null
  for (const id of ATA_SSD_WEAR_ATTR_IDS) {
    const value = normalizedById(id)
    if (value != null) return Math.max(0, 100 - value)
  }
  return null
}

export function parseSmartMetrics(json: unknown): SmartKeyMetrics {
  const j = asRecord(json)
  const temperatureC = num(asRecord(j.temperature).current)
  const type = parseDeviceType(json)

  if (isScsiDevice(json)) return parseScsiMetrics(j, temperatureC)

  if (type === "NVMe") {
    const log = asRecord(j.nvme_smart_health_information_log)
    return {
      reallocatedSectors: null,
      currentPending: null,
      offlineUncorrectable: null,
      reportedUncorrect: null,
      crcErrors: null,
      powerOnHours: num(log.power_on_hours),
      spinRetryCount: null,
      commandTimeouts: null,
      percentageUsed: num(log.percentage_used),
      mediaErrors: num(log.media_errors),
      temperatureC,
      grownDefects: null,
      linkErrors: null,
      smartHealthPassed: healthPassed(j),
    }
  }

  const table: any[] = Array.isArray(asRecord(j.ata_smart_attributes).table)
    ? asRecord(j.ata_smart_attributes).table
    : []
  const rawById = (id: number): number | null => {
    const row = table.find((r) => asRecord(r).id === id)
    return row ? num(asRecord(asRecord(row).raw).value) : null
  }
  const normalizedById = (id: number): number | null => {
    const row = table.find((r) => asRecord(r).id === id)
    return row ? num(asRecord(row).value) : null
  }

  return {
    reallocatedSectors: rawById(ATA_ATTR_IDS.reallocatedSectors),
    currentPending: rawById(ATA_ATTR_IDS.currentPending),
    offlineUncorrectable: rawById(ATA_ATTR_IDS.offlineUncorrectable),
    reportedUncorrect: rawById(ATA_ATTR_IDS.reportedUncorrect),
    crcErrors: rawById(ATA_ATTR_IDS.crcErrors),
    powerOnHours: rawById(ATA_ATTR_IDS.powerOnHours),
    spinRetryCount: rawById(ATA_ATTR_IDS.spinRetryCount),
    commandTimeouts: decodeCommandTimeouts(rawById(ATA_ATTR_IDS.commandTimeouts)),
    percentageUsed: ataSsdPercentageUsed(type, normalizedById),
    mediaErrors: null,
    temperatureC,
    grownDefects: null,
    linkErrors: null,
    smartHealthPassed: healthPassed(j),
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

    // Attribute 188 packs three counters into its raw field and smartctl leaves
    // them packed (see `decodeCommandTimeouts`), so the table would otherwise
    // show a healthy drive's six command timeouts as 4295032838. Show the count
    // and keep the composite visible beside it rather than hiding what the drive
    // actually reported.
    const isPacked = id === ATA_ATTR_IDS.commandTimeouts && rawValue != null && rawValue > 0xffff
    const decoded = isPacked ? decodeCommandTimeouts(rawValue) : rawValue

    return {
      id,
      name: typeof row.name === "string" ? row.name : `unknown_attribute_${id ?? "?"}`,
      value,
      worst: num(row.worst),
      thresh,
      rawValue: decoded,
      rawString: isPacked ? `${decoded} (packed: ${rawValue})` : rawString,
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
      // The threshold must be set for this comparison to mean anything. Plenty of
      // controllers implement no spare tracking and report available_spare 0
      // *and* threshold 0 — a real Realtek RTL9210 enclosure on the test rig does
      // exactly that, alongside zeroed power-on hours and data-unit counters.
      // Read naively, `0 <= 0` condemned a healthy drive, putting a failing row
      // next to a PASS verdict.
      //
      // Genuine exhaustion is not missed: a drive that tracks spare capacity
      // publishes the threshold it wants to be warned at (commonly 10), and a
      // drive that has actually run out also raises the spare bit in
      // `critical_warning`, which fails on its own above.
      const spareThreshold = num(log.available_spare_threshold)
      if (spareThreshold == null || spareThreshold <= 0) return "ok"
      return v <= spareThreshold ? "fail" : "ok"
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
 * One SAS/SCSI row's numeric value and the health flag it earns. SCSI has no
 * normalized value/worst/threshold triplet and no `when_failed` marker, so
 * unlike ATA there is no drive-provided verdict to fall back on — every flag
 * here has to come from a rule this project owns.
 *
 * Which is why the graded set is deliberately narrow: exactly the fields
 * `verdict/evaluate.ts` acts on, with the same severities (see
 * `scsiAttributeHealth`). Everything else is `ok` and carries its meaning in
 * the plain-language description instead — inventing a threshold for, say,
 * ECC-corrected reads would put a red row next to a PASS verdict and make the
 * table disagree with the run.
 */
interface ScsiRowSpec {
  name: string
  rawValue: number | null
  rawString?: string
  health: SmartAttributeHealth
}

/** Per-operation error counters from `scsi_error_counter_log`, in the order
 * they're shown: what the drive gave up on, what it had to work for, then the
 * bulk-corrected total. */
const SCSI_COUNTER_FIELDS = [
  "total_uncorrected_errors",
  "errors_corrected_by_rereads_rewrites",
  "total_errors_corrected",
] as const

const SCSI_OPERATIONS = ["read", "write", "verify"] as const

/** SAS phy counters, summed across every phy of every port the drive reports —
 * the same aggregation `parseSasLinkErrors` does for the graded metric, so the
 * row and the verdict reason are counting the same thing. The `[human, snake]`
 * key pairs mirror `parseSasLinkErrors`'s tolerance for either spelling. */
const SAS_PHY_COUNTERS = [
  ["sas_invalid_dword_count", ["Invalid DWORD count", "invalid_dword_count"]],
  [
    "sas_loss_of_dword_synchronization_count",
    ["Loss of DWORD synchronization count", "loss_of_dword_synchronization_count"],
  ],
  [
    "sas_running_disparity_error_count",
    ["Running disparity error count", "running_disparity_error_count"],
  ],
  ["sas_phy_reset_problem_count", ["Phy reset problem count", "phy_reset_problem_count"]],
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>

/**
 * Health for a SAS/SCSI row, mirroring `verdict/evaluate.ts` rule for rule so a
 * row's flag can never disagree with the verdict the same snapshot produces:
 *
 *  - uncorrected errors, any operation → **fail** (`REPORTED_UNCORRECT`, which
 *    sums the same three counters);
 *  - grown defects → **warn** (`GROWN_DEFECTS_PRESENT`). Not fail at any count:
 *    healthy in-service SAS drives routinely carry thousands, so only growth
 *    during a run condemns — and growth is a two-snapshot judgement this
 *    single-snapshot view can't make;
 *  - invalid DWORDs / loss-of-sync → **warn** (`LINK_ERRORS`), the cabling
 *    signal that must never fail a drive.
 *
 * Everything else is `ok` on purpose — see `ScsiRowSpec`.
 */
function scsiAttributeHealth(name: string, value: number): SmartAttributeHealth {
  if (name.endsWith("total_uncorrected_errors")) return value > 0 ? "fail" : "ok"
  if (name === "scsi_grown_defect_list") return value > 0 ? "warn" : "ok"
  if (name === "sas_invalid_dword_count" || name === "sas_loss_of_dword_synchronization_count") {
    return value > 0 ? "warn" : "ok"
  }
  return "ok"
}

/** Sums one phy counter across every `scsi_sas_port_*.phy_*` the drive reports;
 * `null` when no phy reported it, so "not reported" stays distinct from "zero". */
function sumPhyCounter(j: Record<string, any>, keys: readonly string[]): number | null {
  let total: number | null = null
  for (const [portKey, port] of Object.entries(j)) {
    if (!portKey.startsWith("scsi_sas_port_")) continue
    for (const [phyKey, phy] of Object.entries(asRecord(port))) {
      if (!phyKey.startsWith("phy_")) continue
      const record = asRecord(phy)
      const value = keys.map((k) => num(record[k])).find((v) => v != null)
      if (value != null) total = (total ?? 0) + value
    }
  }
  return total
}

/**
 * The SAS/SCSI attribute table (issue #54). Before this, SAS drives — the ones
 * this tool is mostly pointed at — got an empty table, because there is no
 * `ata_smart_attributes` to read and the health data lives in SCSI log pages
 * instead: the grown defect list, the per-operation error counter log, and the
 * SAS phy counters.
 *
 * Rows are ordered worst-signal-first (the drive's own assessment, then defects,
 * then error counters, then the cabling counters, then age/temperature), and a
 * field the drive doesn't report is omitted rather than shown as zero — a
 * missing counter and a clean one mean different things.
 */
function parseScsiAttributes(json: unknown): SmartAttributeRow[] {
  const j = asRecord(json)
  const specs: ScsiRowSpec[] = []

  // On SAS this is the authoritative failure signal — it is what carries
  // conditions like "impending failure data error rate too high" — so it leads.
  const passed = asRecord(j.smart_status).passed
  if (typeof passed === "boolean") {
    specs.push({
      name: "scsi_smart_status",
      rawValue: null,
      rawString: passed ? "OK" : "FAILING",
      health: passed ? "ok" : "fail",
    })
  }

  const defects = num(j.scsi_grown_defect_list)
  if (defects != null) {
    specs.push({
      name: "scsi_grown_defect_list",
      rawValue: defects,
      health: scsiAttributeHealth("scsi_grown_defect_list", defects),
    })
  }

  const counters = asRecord(j.scsi_error_counter_log)
  for (const field of SCSI_COUNTER_FIELDS) {
    for (const op of SCSI_OPERATIONS) {
      const value = num(asRecord(counters[op])[field])
      if (value == null) continue
      const name = `${op}_${field}`
      specs.push({ name, rawValue: value, health: scsiAttributeHealth(name, value) })
    }
  }

  for (const [name, keys] of SAS_PHY_COUNTERS) {
    const value = sumPhyCounter(j, keys)
    if (value == null) continue
    specs.push({ name, rawValue: value, health: scsiAttributeHealth(name, value) })
  }

  const hours = num(asRecord(j.power_on_time).hours)
  if (hours != null) specs.push({ name: "power_on_hours", rawValue: hours, health: "ok" })

  // Same source as `parseSmartMetrics`'s `temperatureC`, deliberately: a drive
  // that reports temperature only under `scsi_environmental_reports` shows it in
  // neither place rather than in one and not the other.
  const temperature = num(asRecord(j.temperature).current)
  if (temperature != null) {
    specs.push({ name: "temperature_celsius", rawValue: temperature, health: "ok" })
  }

  return specs.map((spec) => ({
    id: null,
    name: spec.name,
    value: null,
    worst: null,
    thresh: null,
    rawValue: spec.rawValue,
    rawString: spec.rawString ?? null,
    health: spec.health,
  }))
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
  // Checked before the ATA table: a SCSI device has no `ata_smart_attributes`,
  // so without this it fell through to an empty table (issue #54).
  if (isScsiDevice(json)) return parseScsiAttributes(json)

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

/**
 * The newest SCSI self-test log entry. smartctl emits these as flat, numbered
 * keys (`scsi_self_test_0` … `scsi_self_test_19`) rather than an array, with
 * index 0 being the most recent run.
 */
export function scsiNewestSelfTest(json: unknown): Record<string, any> | null {
  const entry = asRecord(asRecord(json).scsi_self_test_0)
  return Object.keys(entry).length > 0 ? entry : null
}

/** True while the drive is running a SCSI self-test. The percentage remaining
 * that `smartctl -x` prints for SCSI is console-only — it never reaches the
 * JSON — so this is a boolean, not a progress figure. */
export function scsiSelfTestInProgress(json: unknown): boolean {
  return scsiNewestSelfTest(json)?.self_test_in_progress === true
}

export function parseSelfTest(json: unknown): SelfTestResult {
  const j = asRecord(json)
  const type = parseDeviceType(json)

  // SAS/SCSI: a numbered log entry whose `result` carries both the code and the
  // drive's own wording. Real SAS drives report "Completed" (not ATA's
  // "completed without error") and "Aborted (device reset ?)", both of which
  // classify correctly off the numeric result — 0 is a clean pass.
  if (isScsiDevice(json)) {
    const entry = scsiNewestSelfTest(json)
    if (!entry) return { status: "UNKNOWN" }
    if (entry.self_test_in_progress === true) {
      return { status: "UNKNOWN", message: "Self-test still in progress" }
    }
    const result = asRecord(entry.result)
    if (result.string == null && result.value == null) return { status: "UNKNOWN" }
    return classifySelfTest(String(result.string ?? ""), num(result.value) ?? undefined)
  }

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
