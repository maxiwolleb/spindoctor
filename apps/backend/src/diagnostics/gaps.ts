import { isAttributeUnexplained } from "@spindoctor/shared"
import type { DriveType, Reason, Thresholds, Verdict } from "@spindoctor/shared"
import { parseDeviceType, parseSmartAttributes, parseSmartMetrics } from "../device/smartParser"
import { selfTestSupported } from "../device/smartParser"

/**
 * What spindoctor could not explain about the drives it graded.
 *
 * Every check here corresponds to a defect real hardware produced while unit
 * tests stayed green, which is the point: these are the shapes of blind spot the
 * tool cannot see in itself from fixtures alone. Computed at export time from the
 * stored raw snapshots rather than recorded during a run, so re-exporting old
 * runs through a newer build surfaces gaps that were invisible when the run
 * happened.
 */
export interface GapReport {
  /** Attributes real drives carry that the description map has no text for. */
  unexplainedAttributes: UnexplainedAttribute[]
  /** Discovery's drive type disagreeing with the drive's own SMART data. */
  typeDisagreements: TypeDisagreement[]
  /** Drives whose firmware cannot run the self-test the regime asks for. */
  selfTestUnsupported: DriveNote[]
  /** Keys present in the raw payload that no parser reads. */
  unreadFields: UnreadField[]
  /** Runs where our verdict and the drive's own health claim disagree. */
  verdictDisagreements: VerdictDisagreement[]
  /** Metrics sitting close enough to a threshold that its placement matters. */
  thresholdProximity: ThresholdProximity[]
}

export interface UnexplainedAttribute {
  id: number | null
  name: string
  model: string
  /** How many snapshots carried it — a name on one drive is a curiosity, on
   * twenty it is a gap worth filling. */
  seen: number
}

export interface TypeDisagreement {
  driveRef: string
  model: string
  transport: string
  discovered: DriveType
  fromSmart: DriveType
}

export interface DriveNote {
  driveRef: string
  model: string
}

export interface UnreadField {
  /** Dotted path, e.g. `nvme_optional_admin_commands` or `ata_smart_data.self_test`. */
  path: string
  model: string
  seen: number
}

export interface VerdictDisagreement {
  runId: number
  driveRef: string
  model: string
  verdict: Verdict
  /** The drive's own `smart_status.passed`. */
  driveSaysHealthy: boolean
  /** Which of our rules drove the disagreement. */
  reasonCodes: string[]
}

export interface ThresholdProximity {
  driveRef: string
  model: string
  metric: string
  value: number
  threshold: number
  thresholdName: string
}

/** One run's inputs to the analysis. */
export interface GapInput {
  runId: number
  driveRef: string
  model: string
  transport: string
  discoveredType: DriveType
  verdict: Verdict | null
  reasons: Reason[]
  /** Raw `smartctl --json` payloads. `after` is absent for a run cut short. */
  before: unknown
  after: unknown | null
}

/**
 * Top-level payload keys the parsers consume, plus the ones that carry no health
 * signal at all. Anything outside this set that a real drive reports is
 * surfaced as an unread field — which is exactly how the next
 * `nvme_optional_admin_commands` gets noticed instead of sitting unused for
 * months.
 */
const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
  // consumed by the parsers
  "device",
  "rotation_rate",
  "smart_status",
  "temperature",
  "power_on_time",
  "ata_smart_attributes",
  "ata_smart_data",
  "ata_smart_self_test_log",
  "nvme_smart_health_information_log",
  "nvme_optional_admin_commands",
  "scsi_grown_defect_list",
  "scsi_error_counter_log",
  // identity and capability description — deliberately not health signals
  "json_format_version",
  "smartctl",
  "local_time",
  "model_name",
  "model_family",
  "serial_number",
  "firmware_version",
  "wwn",
  "user_capacity",
  "logical_block_size",
  "physical_block_size",
  "smart_support",
  "form_factor",
  "in_smartctl_database",
  "ata_version",
  "sata_version",
  "interface_speed",
  "trim",
  "ata_sct_capabilities",
  "read_lookahead",
  "write_cache",
  "ata_security",
  "power_cycle_count",
  "logical_unit_id",
  "scsi_vendor",
  "scsi_product",
  "scsi_revision",
  "scsi_version",
  "scsi_model_name",
  "scsi_transport_protocol",
  "scsi_lb_provisioning",
  "device_type",
  "nvme_version",
  "nvme_pci_vendor",
  "nvme_ieee_oui_identifier",
  "nvme_controller_id",
  "nvme_number_of_namespaces",
  "nvme_namespaces",
  "nvme_maximum_data_transfer_pages",
  "nvme_power_states",
  "nvme_log_page_attributes",
  "nvme_firmware_update_capabilities",
  "nvme_optional_nvm_commands",
  "nvme_composite_temperature_threshold",
  "nvme_total_capacity",
  "nvme_error_information_log",
  "spare_available",
  "endurance_used",
  "temperature_warning",
  "seagate_farm_log",
  "scsi_environmental_reports",
])

/** Prefixes for the per-port/per-phy and per-entry keys smartctl numbers. */
const KNOWN_PREFIXES: readonly string[] = ["scsi_sas_port_", "scsi_self_test_", "ata_smart_error"]

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function bump<T>(map: Map<string, T & { seen: number }>, key: string, make: () => T): void {
  const existing = map.get(key)
  if (existing) {
    existing.seen += 1
    return
  }
  map.set(key, { ...make(), seen: 1 })
}

/**
 * Runs every check over a set of runs. Pure — no DB, no clock, no device access —
 * so it is table-testable against the captured fixtures.
 */
export function analyzeGaps(runs: GapInput[], thresholds: Thresholds): GapReport {
  const unexplained = new Map<string, UnexplainedAttribute>()
  const unread = new Map<string, UnreadField>()
  const typeDisagreements: TypeDisagreement[] = []
  const selfTestUnsupported = new Map<string, DriveNote>()
  const verdictDisagreements: VerdictDisagreement[] = []
  const proximity: ThresholdProximity[] = []

  for (const run of runs) {
    for (const raw of [run.before, run.after]) {
      if (raw == null) continue

      for (const row of parseSmartAttributes(raw, thresholds)) {
        if (!isAttributeUnexplained(row)) continue
        bump(unexplained, `${row.id ?? "x"}:${row.name}:${run.model}`, () => ({
          id: row.id,
          name: row.name,
          model: run.model,
        }))
      }

      for (const key of Object.keys(asRecord(raw))) {
        if (KNOWN_TOP_LEVEL.has(key)) continue
        if (KNOWN_PREFIXES.some((p) => key.startsWith(p))) continue
        bump(unread, `${key}:${run.model}`, () => ({ path: key, model: run.model }))
      }
    }

    const fromSmart = parseDeviceType(run.before)
    if (fromSmart !== run.discoveredType) {
      typeDisagreements.push({
        driveRef: run.driveRef,
        model: run.model,
        transport: run.transport,
        discovered: run.discoveredType,
        fromSmart,
      })
    }

    if (!selfTestSupported(run.before)) {
      selfTestUnsupported.set(run.driveRef, { driveRef: run.driveRef, model: run.model })
    }

    const metrics = parseSmartMetrics(run.after ?? run.before)

    // The disagreements worth a human's attention run both ways: a drive calling
    // itself healthy while we fail it is where our rules earn their keep (an HGST
    // in the audit batch reported OK with 158 uncorrected read errors), and a
    // drive calling itself failing while we pass it means we are missing
    // something it can see.
    if (run.verdict != null && metrics.smartHealthPassed != null) {
      const weFailed = run.verdict === "FAIL"
      if (weFailed !== !metrics.smartHealthPassed) {
        verdictDisagreements.push({
          runId: run.runId,
          driveRef: run.driveRef,
          model: run.model,
          verdict: run.verdict,
          driveSaysHealthy: metrics.smartHealthPassed,
          reasonCodes: run.reasons.filter((r) => r.severity === "fail").map((r) => r.code),
        })
      }
    }

    proximity.push(...nearThresholds(run, metrics.reallocatedSectors, thresholds))
  }

  return {
    unexplainedAttributes: [...unexplained.values()].sort((a, b) => b.seen - a.seen),
    typeDisagreements,
    selfTestUnsupported: [...selfTestUnsupported.values()],
    unreadFields: [...unread.values()].sort((a, b) => b.seen - a.seen),
    verdictDisagreements,
    thresholdProximity: proximity,
  }
}

/**
 * Flags a metric sitting within a factor of two of the threshold that decides it.
 *
 * The point is calibration, not alarm: a fleet whose reallocated-sector counts
 * all cluster just under the limit says something different about where that
 * limit belongs than a fleet with none near it. Only the reallocated threshold is
 * covered — it is the one default derived from a bucket boundary rather than from
 * an unambiguous "any non-zero fails" rule, so it is the one whose placement is
 * genuinely open to evidence.
 */
function nearThresholds(
  run: GapInput,
  reallocated: number | null,
  thresholds: Thresholds,
): ThresholdProximity[] {
  if (reallocated == null || reallocated <= 0) return []
  const limit = thresholds.reallocatedWarnMax
  if (reallocated > limit * 2) return []
  return [
    {
      driveRef: run.driveRef,
      model: run.model,
      metric: "reallocatedSectors",
      value: reallocated,
      threshold: limit,
      thresholdName: "reallocatedWarnMax",
    },
  ]
}
