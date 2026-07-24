import type {
  Reason,
  SmartKeyMetrics,
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
  const hard: Array<[keyof SmartKeyMetrics, string, string]> = [
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
