import type {
  NumericSmartMetricKey,
  Reason,
  Verdict,
  VerdictInput,
  VerdictResult,
} from "@spindoctor/shared"

function grew(before: number | null, after: number | null): boolean {
  return before != null && after != null && after > before
}

export function evaluateVerdict(input: VerdictInput): VerdictResult {
  const { before, after, deviceType, selfTest, surface, thresholds } = input
  const reasons: Reason[] = []
  const push = (r: Reason) => reasons.push(r)

  // --- long self-test ---
  if (selfTest.status === "FAILED") {
    push({
      code: "SELFTEST_FAILED",
      severity: "fail",
      message: selfTest.message
        ? `Long self-test failed: ${selfTest.message}`
        : "Long self-test failed",
    })
  } else if (selfTest.status === "ABORTED" || selfTest.status === "UNKNOWN") {
    push({
      code: "SELFTEST_INCOMPLETE",
      severity: "warn",
      message: "Long self-test did not complete",
    })
  }

  // --- surface (badblocks) ---
  if (surface) {
    if (surface.badBlocks > 0) {
      push({
        code: "BADBLOCKS",
        severity: "fail",
        message: `${surface.badBlocks} bad block(s) found during surface test`,
        metric: "badBlocks",
        after: surface.badBlocks,
      })
    }
    if (!surface.completed) {
      push({
        code: "SURFACE_INCOMPLETE",
        severity: "warn",
        message: "Surface test did not complete",
      })
    }
  }

  // --- hard uncorrectable indicators (post-test) ---
  const hard: Array<[NumericSmartMetricKey, string, string]> = [
    ["currentPending", "CURRENT_PENDING", "Current pending sectors"],
    ["offlineUncorrectable", "OFFLINE_UNCORRECTABLE", "Offline uncorrectable sectors"],
    ["reportedUncorrect", "REPORTED_UNCORRECT", "Reported uncorrectable errors"],
  ]
  for (const [key, code, label] of hard) {
    const v = after[key]
    if (v != null && v > 0) {
      push({ code, severity: "fail", message: `${label}: ${v}`, metric: key, after: v })
    }
  }

  // --- growth during the test window ---
  if (grew(before.reallocatedSectors, after.reallocatedSectors)) {
    push({
      code: "REALLOCATED_GROWTH",
      severity: "fail",
      message: `Reallocated sectors grew during test (${before.reallocatedSectors} → ${after.reallocatedSectors})`,
      metric: "reallocatedSectors",
      before: before.reallocatedSectors,
      after: after.reallocatedSectors,
    })
  }
  if (grew(before.currentPending, after.currentPending)) {
    push({
      code: "PENDING_GROWTH",
      severity: "fail",
      message: `Current pending sectors grew during test (${before.currentPending} → ${after.currentPending})`,
      metric: "currentPending",
      before: before.currentPending,
      after: after.currentPending,
    })
  }

  // --- reallocated absolute value (post-test) ---
  const realloc = after.reallocatedSectors
  if (realloc != null) {
    if (realloc > thresholds.reallocatedWarnMax) {
      push({
        code: "REALLOCATED_HIGH",
        severity: "fail",
        message: `Reallocated sectors ${realloc} exceeds limit ${thresholds.reallocatedWarnMax}`,
        metric: "reallocatedSectors",
        after: realloc,
      })
    } else if (realloc > 0) {
      push({
        code: "REALLOCATED_PRESENT",
        severity: "warn",
        message: `${realloc} reallocated sector(s) present (stable)`,
        metric: "reallocatedSectors",
        after: realloc,
      })
    }
  }

  // --- SAS/SCSI grown defect list ---
  //
  // Growth is the signal, not the absolute count. Measured across a fleet of 18
  // in-service SAS drives, grown-defect counts of healthy drives and of drives
  // reporting impending failure overlap completely (7827 on a drive reporting
  // OK, 355 on one reporting failure), so there is deliberately no
  // absolute-count "fail" rule here — the ATA `reallocatedWarnMax` equivalent
  // would condemn most working SAS drives. A count that *rises* while we test
  // is the drive retiring blocks under our own load, which is real degradation.
  if (grew(before.grownDefects, after.grownDefects)) {
    push({
      code: "GROWN_DEFECT_GROWTH",
      severity: "fail",
      message: `Grown defect list grew during test (${before.grownDefects} → ${after.grownDefects})`,
      metric: "grownDefects",
      before: before.grownDefects,
      after: after.grownDefects,
    })
  } else if (after.grownDefects != null && after.grownDefects > 0) {
    push({
      code: "GROWN_DEFECTS_PRESENT",
      severity: "warn",
      message: `${after.grownDefects} grown defect(s) present (stable)`,
      metric: "grownDefects",
      after: after.grownDefects,
    })
  }

  // --- the drive's own health verdict ---
  //
  // Only acted on when the drive says it is failing. On SAS this is the
  // authoritative call and the only field separating a failing drive from a
  // healthy one when defect counts overlap; on ATA it is a vendor-threshold
  // summary that routinely still reads "passed" on a dying drive. So a false
  // here condemns, but a true is never treated as evidence of health — that is
  // what every other rule in this function is for.
  if (after.smartHealthPassed === false || before.smartHealthPassed === false) {
    push({
      code: "SMART_HEALTH_FAILED",
      severity: "fail",
      message: "Drive reports its own SMART health as failing",
      metric: "smartHealthPassed",
    })
  }

  // --- SAS link-layer errors ---
  //
  // Warn, never fail, and never on growth alone: the same audit found phys
  // carrying 239 and 255 invalid DWORDs that did not budge under load — the test
  // rig's cabling, not the drive. Same intent as the ATA CRC rule below.
  if (after.linkErrors != null && after.linkErrors > 0) {
    push({
      code: "LINK_ERRORS",
      severity: "warn",
      message: `${after.linkErrors} SAS link error(s) — check cabling/backplane, usually not the drive`,
      metric: "linkErrors",
      after: after.linkErrors,
    })
  }

  // --- interface CRC errors ---
  if (after.crcErrors != null && after.crcErrors > 0) {
    push({
      code: "CRC_ERRORS",
      severity: "warn",
      message: `${after.crcErrors} UDMA CRC error(s) — check cabling`,
      metric: "crcErrors",
      after: after.crcErrors,
    })
  }

  // --- SSD/NVMe wear ---
  if (deviceType === "SSD" || deviceType === "NVMe") {
    const used = after.percentageUsed
    if (used != null) {
      if (used >= thresholds.ssdPercentageUsedFail) {
        push({
          code: "WEAR_EXHAUSTED",
          severity: "fail",
          message: `SSD/NVMe wear ${used}% ≥ ${thresholds.ssdPercentageUsedFail}%`,
          metric: "percentageUsed",
          after: used,
        })
      } else if (used >= thresholds.ssdPercentageUsedWarn) {
        push({
          code: "WEAR_HIGH",
          severity: "warn",
          message: `SSD/NVMe wear ${used}% ≥ ${thresholds.ssdPercentageUsedWarn}%`,
          metric: "percentageUsed",
          after: used,
        })
      }
    }
    if (after.mediaErrors != null && after.mediaErrors > 0) {
      push({
        code: "MEDIA_ERRORS",
        severity: "fail",
        message: `${after.mediaErrors} media error(s)`,
        metric: "mediaErrors",
        after: after.mediaErrors,
      })
    }
  }

  const verdict: Verdict = reasons.some((r) => r.severity === "fail")
    ? "FAIL"
    : reasons.some((r) => r.severity === "warn")
      ? "WARN"
      : "PASS"

  return { verdict, reasons }
}
