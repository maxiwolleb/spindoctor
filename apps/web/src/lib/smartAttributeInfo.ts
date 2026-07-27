import type { SmartAttributeRow } from "@spindoctor/shared"

export interface SmartAttributeInfo {
  /** Short display label — usually a cleaned-up version of the raw name. */
  label: string
  /** Plain-language explanation of what the attribute measures and why it matters. */
  description: string
}

const FALLBACK = (name: string): SmartAttributeInfo => ({
  label: name,
  description: "Vendor-specific or uncommon attribute — no plain-language explanation yet.",
})

/**
 * ATA SMART attribute descriptions, keyed by the name smartctl reports
 * (e.g. "Reallocated_Sector_Ct"). Covers the standard attributes most drives
 * report plus the common SSD-wear ones; an unrecognized name falls back to
 * `BY_ID` (some vendors use non-standard names for the same id) and finally
 * to a generic message rather than hiding the row.
 */
const ATA_BY_NAME: Record<string, SmartAttributeInfo> = {
  Raw_Read_Error_Rate: {
    label: "Raw read error rate",
    description:
      "Rate of hardware read errors. Many drives report a non-zero baseline as normal; a climbing value is the concerning signal, not the raw number alone.",
  },
  Spin_Up_Time: {
    label: "Spin-up time",
    description:
      "Time the drive takes to spin up from a stopped state. A sudden increase can point at a struggling motor or bearing.",
  },
  Start_Stop_Count: {
    label: "Start/stop count",
    description:
      "Number of spindle start/stop cycles over the drive's life. Informational — tracks usage, not a fault by itself.",
  },
  Reallocated_Sector_Ct: {
    label: "Reallocated sectors",
    description:
      "Sectors the drive has retired after finding them bad and remapped to spares. More than a few is a warning sign; a large or growing count means the media is failing.",
  },
  Seek_Error_Rate: {
    label: "Seek error rate",
    description:
      "Rate of errors while positioning the heads. Some baseline is normal on most drives; a rising trend can suggest mechanical wear.",
  },
  Power_On_Hours: {
    label: "Power-on hours",
    description:
      "Total hours the drive has been powered on. A measure of age, not health by itself.",
  },
  Spin_Retry_Count: {
    label: "Spin retry count",
    description:
      "Number of retries needed to spin the platters up to speed. Any non-zero count points at a struggling motor or bearing.",
  },
  Power_Cycle_Count: {
    label: "Power cycle count",
    description:
      "Number of full power-on/power-off cycles. Informational — tracks usage, not a fault.",
  },
  Runtime_Bad_Block: {
    label: "Runtime bad blocks",
    description:
      "Bad blocks discovered during normal operation. Any non-zero count is a real defect found on the media.",
  },
  Reported_Uncorrect: {
    label: "Reported uncorrectable errors",
    description:
      "Errors that could not be recovered even with the drive's own error correction. Any non-zero count means real, uncorrected data errors occurred.",
  },
  Command_Timeout: {
    label: "Command timeouts",
    description:
      "Number of operations aborted because they timed out. Occasional counts can be benign; a growing trend suggests interface or drive trouble.",
  },
  High_Fly_Writes: {
    label: "High fly writes",
    description:
      "Writes performed while the head was flying higher than normal above the platter — a risk factor for weak writes. Occasional events are common.",
  },
  Airflow_Temperature_Cel: {
    label: "Airflow temperature",
    description:
      "Temperature reading from a sensor near the drive's airflow intake (some vendors report temperature here instead of, or alongside, the main temperature attribute).",
  },
  G_Sense_Error_Rate: {
    label: "Shock sensor errors",
    description:
      "Errors reported by a built-in shock/vibration sensor (mainly laptop drives). A high count suggests physical shock exposure.",
  },
  Power_Off_Retract_Count: {
    label: "Power-off retract count",
    description:
      "Number of times the heads were retracted (parked) due to power loss. Occasional counts are normal; a high rate suggests unclean shutdowns.",
  },
  Load_Cycle_Count: {
    label: "Load/unload cycle count",
    description:
      "Number of times the heads have been loaded/unloaded onto the ramp. Very high counts — especially on drives that park aggressively to save power — can predict head-wear failures.",
  },
  Temperature_Celsius: {
    label: "Temperature",
    description:
      "Drive temperature. Sustained high temperatures shorten lifespan; shown here for reference, not individually graded.",
  },
  Hardware_ECC_Recovered: {
    label: "Hardware ECC recovered",
    description:
      "Errors the drive's own error-correction fixed automatically. Non-zero counts are common on most drives and not necessarily concerning on their own.",
  },
  Reallocated_Event_Count: {
    label: "Reallocation events",
    description:
      "Number of sector-remap events (one event can move several sectors at once). Tracks alongside reallocated sectors — rising values mean the media keeps failing.",
  },
  Current_Pending_Sector: {
    label: "Current pending sectors",
    description:
      "Sectors flagged as unstable, waiting to be reallocated once rewritten (or confirmed good). Any non-zero count means the drive currently has unreadable sectors.",
  },
  Offline_Uncorrectable: {
    label: "Offline uncorrectable sectors",
    description:
      "Sectors that failed the drive's own offline surface scan and could not be corrected. Any non-zero count is a real, permanent defect.",
  },
  UDMA_CRC_Error_Count: {
    label: "UDMA CRC errors",
    description:
      "Errors on the data cable/interface rather than the media itself. Often fixed by reseating or replacing the SATA cable, not a sign of drive failure.",
  },
  Multi_Zone_Error_Rate: {
    label: "Multi-zone error rate",
    description:
      "Errors found by vendor-specific write self-checks. A rising value suggests developing media or head problems.",
  },
  Soft_Read_Error_Rate: {
    label: "Soft read error rate",
    description:
      "Uncorrected read errors some vendors report separately from the raw read error rate.",
  },
  // SSD / flash-wear attributes — the id varies by vendor, but these names are common.
  Wear_Leveling_Count: {
    label: "Wear-leveling count",
    description:
      "How evenly write wear is spread across the flash, or the remaining life estimate depending on vendor. Falling toward its threshold means the SSD is nearing end of life.",
  },
  Media_Wearout_Indicator: {
    label: "Media wear-out indicator",
    description:
      "Remaining usable life before the flash wears out. A falling value means the SSD is nearing end of life.",
  },
  SSD_Life_Left: {
    label: "SSD life left",
    description:
      "Manufacturer's estimate of remaining SSD life as a percentage. Falling toward zero is the warning sign.",
  },
  Available_Reservd_Space: {
    label: "Available reserved space",
    description:
      "Spare flash blocks kept in reserve to replace worn-out ones. A falling value means the spare pool is shrinking.",
  },
  Program_Fail_Count: {
    label: "Program (write) fail count",
    description:
      "Flash program operations that failed outright — a real defect, not just ordinary wear.",
  },
  Erase_Fail_Count: {
    label: "Erase fail count",
    description:
      "Flash block erase operations that failed outright — a real defect, not just ordinary wear.",
  },
  Total_LBAs_Written: {
    label: "Total data written",
    description:
      "Total data written to the drive over its life. Informational — used to estimate wear alongside percentage-used.",
  },
  Total_LBAs_Read: {
    label: "Total data read",
    description: "Total data read from the drive over its life. Purely informational.",
  },
}

/** Fallback lookup by numeric ATA attribute id, for vendor-specific names the
 * table above doesn't recognize. Standard ids only — the common ones this
 * viewer already grades (see `verdict/evaluate.ts` and `smartParser.ts`). */
const ATA_BY_ID: Record<number, SmartAttributeInfo> = {
  5: {
    label: "Reallocated sectors",
    description:
      "Sectors the drive has retired after finding them bad and remapped to spares. More than a few is a warning sign; a large or growing count means the media is failing.",
  },
  9: {
    label: "Power-on hours",
    description:
      "Total hours the drive has been powered on. A measure of age, not health by itself.",
  },
  187: {
    label: "Reported uncorrectable errors",
    description:
      "Errors that could not be recovered even with the drive's own error correction. Any non-zero count means real, uncorrected data errors occurred.",
  },
  197: {
    label: "Current pending sectors",
    description:
      "Sectors flagged as unstable, waiting to be reallocated once rewritten (or confirmed good). Any non-zero count means the drive currently has unreadable sectors.",
  },
  198: {
    label: "Offline uncorrectable sectors",
    description:
      "Sectors that failed the drive's own offline surface scan and could not be corrected. Any non-zero count is a real, permanent defect.",
  },
  199: {
    label: "UDMA CRC errors",
    description:
      "Errors on the data cable/interface rather than the media itself. Often fixed by reseating or replacing the SATA cable, not a sign of drive failure.",
  },
}

const NVME_BY_NAME: Record<string, SmartAttributeInfo> = {
  critical_warning: {
    label: "Critical warning",
    description:
      "Bitmask of critical conditions the controller is reporting (low spare space, high temperature, degraded reliability, read-only mode, or backup-device failure). Any non-zero value means something needs attention.",
  },
  percentage_used: {
    label: "Percentage used",
    description:
      "Manufacturer's estimate of drive life consumed, 0-100+ (values over 100 mean the drive has exceeded its rated endurance).",
  },
  available_spare: {
    label: "Available spare",
    description: "Percentage of spare flash capacity remaining.",
  },
  available_spare_threshold: {
    label: "Available spare threshold",
    description:
      "The available-spare percentage below which the drive itself considers its spare capacity critically low.",
  },
  media_errors: {
    label: "Media errors",
    description:
      "Number of data-integrity errors the drive could not recover from. Any non-zero count means data was actually lost or corrupted.",
  },
  num_err_log_entries: {
    label: "Error log entries",
    description:
      "Number of entries in the controller's error log — a rough count of all logged error events over the drive's life.",
  },
  power_on_hours: {
    label: "Power-on hours",
    description:
      "Total hours the drive has been powered on. Informational — a measure of age, not health by itself.",
  },
  unsafe_shutdowns: {
    label: "Unsafe shutdowns",
    description:
      "Number of shutdowns that weren't a clean power-down. Occasional counts are normal; a high rate can stress the drive's power-loss protection.",
  },
  controller_busy_time: {
    label: "Controller busy time",
    description:
      "Time the controller has spent actively processing commands. Purely informational.",
  },
}

/**
 * SAS/SCSI field descriptions (issue #54), keyed by the synthetic row names
 * `parseScsiAttributes` emits. SAS drives report health through SCSI log pages
 * rather than an attribute table, so these are counters rather than normalized
 * attributes — and several of them are routinely large on a perfectly good
 * drive, which is exactly why they need explaining rather than just showing.
 */
const SCSI_BY_NAME: Record<string, SmartAttributeInfo> = {
  scsi_smart_status: {
    label: "Drive self-assessment",
    description:
      'The drive\'s own overall verdict on itself. On SAS this is the authoritative failure signal — it is what carries conditions like "impending failure, data error rate too high" — so FAILING here condemns the drive on its own. OK is not proof of health: every other row still matters.',
  },
  scsi_grown_defect_list: {
    label: "Grown defects",
    description:
      "Blocks the drive has retired since it was formatted — the SAS equivalent of reallocated sectors, but on a completely different scale: healthy in-service SAS drives routinely carry counts in the thousands. A high number is not by itself a failure; a count that rises while the drive is under test is.",
  },
  read_total_uncorrected_errors: {
    label: "Read errors — uncorrected",
    description:
      "Reads the drive could not recover even with retries and error correction. Any non-zero count means data could not be read back.",
  },
  write_total_uncorrected_errors: {
    label: "Write errors — uncorrected",
    description:
      "Writes the drive could not complete successfully even after retries. Any non-zero count means data could not be written.",
  },
  verify_total_uncorrected_errors: {
    label: "Verify errors — uncorrected",
    description:
      "Verify operations that failed outright — the drive read back something it could not reconcile with what should be there. Any non-zero count is a real defect.",
  },
  read_errors_corrected_by_rereads_rewrites: {
    label: "Read recoveries (rereads)",
    description:
      "Reads that only succeeded after the drive re-read the block — the fast error-correction path had already failed. Recovered, so no data was lost, but this is the counter that usually starts climbing before uncorrected errors appear. Worth watching over time rather than reacting to once.",
  },
  write_errors_corrected_by_rereads_rewrites: {
    label: "Write recoveries (rewrites)",
    description:
      "Writes that only succeeded after being rewritten. Recovered, but a sign the media is making the drive work for it.",
  },
  verify_errors_corrected_by_rereads_rewrites: {
    label: "Verify recoveries (rereads)",
    description: "Verify operations that only succeeded after a re-read. Recovered, not lost.",
  },
  read_total_errors_corrected: {
    label: "Read errors corrected",
    description:
      "Every read error the drive fixed on its own, overwhelmingly by fast error correction. Counts in the millions are normal on a healthy drive that has read a lot of data — this is what error correction is for, not a defect count.",
  },
  write_total_errors_corrected: {
    label: "Write errors corrected",
    description:
      "Write errors the drive corrected on its own. As with reads, a large number here is normal operation rather than damage.",
  },
  verify_total_errors_corrected: {
    label: "Verify errors corrected",
    description: "Verify errors the drive corrected on its own. Informational.",
  },
  sas_invalid_dword_count: {
    label: "Invalid DWORDs (SAS link)",
    description:
      "Malformed words received on the SAS link, summed over every phy. This is a cable, connector or backplane signal-quality measure, not a media one — counts in the hundreds that don't move under load are the wiring, not the disk. Flagged as a warning only, never a failure.",
  },
  sas_loss_of_dword_synchronization_count: {
    label: "Loss of sync (SAS link)",
    description:
      "Times the SAS link lost word synchronization and had to recover. Same cabling story as invalid DWORDs: check the cable and backplane before suspecting the drive.",
  },
  sas_running_disparity_error_count: {
    label: "Running disparity errors (SAS link)",
    description:
      "Encoding errors on the SAS link — another signal-integrity counter that tracks alongside invalid DWORDs. Shown for reference; not graded.",
  },
  sas_phy_reset_problem_count: {
    label: "Phy reset problems (SAS link)",
    description:
      "Times the link failed to come back cleanly after a reset. Usually points at the connection or the expander rather than the drive.",
  },
  temperature_celsius: {
    label: "Temperature",
    description:
      "Current drive temperature. Sustained high temperatures shorten lifespan; shown for reference, not individually graded.",
  },
}

/** Plain-language label + description for a `SmartAttributeRow` (issue #14).
 * ATA rows are looked up by their smartctl-reported `name` first, then by
 * numeric id (covers vendor-specific naming of the same standard attribute);
 * NVMe and SAS/SCSI rows (no numeric id) are looked up by field name across
 * both tables — the two vocabularies don't collide, and `power_on_hours` is
 * deliberately shared. Anything unrecognized still renders — with a generic
 * fallback message — rather than being hidden. */
export function describeAttribute(row: SmartAttributeRow): SmartAttributeInfo {
  if (row.id != null) {
    return ATA_BY_NAME[row.name] ?? ATA_BY_ID[row.id] ?? FALLBACK(row.name)
  }
  return NVME_BY_NAME[row.name] ?? SCSI_BY_NAME[row.name] ?? FALLBACK(row.name)
}
