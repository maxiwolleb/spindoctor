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
  } else if (selfTest.status === "SKIPPED") {
    // Informational on purpose: the engine skipped the routine because the
    // baseline SMART read had already condemned the drive (issue #49), so the
    // reasons that *did* condemn it are in this same list. Recording it as a
    // warning would imply missing evidence; it isn't missing, it's redundant.
    push({
      code: "SELFTEST_SKIPPED",
      severity: "info",
      message: "Long self-test skipped — baseline SMART already condemned the drive",
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
  //
  // Any non-zero value fails, with no tolerance band, and Backblaze's fleet data
  // says that is not over-strict: against a ~2.5%/year baseline for drives
  // reporting zero, the very first recorded error takes the annual failure rate
  // to 34% for current-pending, 34% for reported-uncorrectable and 81% for
  // offline-uncorrectable — twelve to twenty-eight times baseline. There is no
  // gentle band to grade here; the first error is the signal.
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
  //
  // The threshold that separates warn from fail is the one number here taken
  // straight from observed failure rates: 1–4 reallocated sectors fails at
  // 2.74%/year against a 2.52% baseline (indistinguishable from a pristine
  // drive), while 4–16 fails at 7.50% and 16–70 at 23.6%. Hence a default
  // `reallocatedWarnMax` of 4 — see `DEFAULT_THRESHOLDS`.
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
  // Growth is the signal, not the absolute count. Across a fleet of 18
  // in-service SAS drives, the counts of healthy drives and of drives reporting
  // impending failure don't just overlap — they invert: the three drives
  // reporting "data channel impending failure" carried 636, 2601 and 3045 grown
  // defects, while drives reporting OK carried 0, 1, 2, 4, 11, 13, 19, 20, 100,
  // 155, 631, 1104, 6056 and 7827. The single highest count in the fleet is on a
  // drive the vendor considers fine. So there is deliberately no absolute-count
  // "fail" rule here — an ATA-style `reallocatedWarnMax` equivalent would condemn
  // most working SAS drives, including the healthiest one measured. A count that
  // *rises* while we test is the drive retiring blocks under our own load, which
  // is real degradation.
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

  // --- spin retries ---
  //
  // Mechanical, and decisive on the first occurrence: a drive that needed a
  // retry to bring its platters to speed fails at roughly ten times the rate of
  // one that never did. (Scrutiny flags the attribute critical but notes its
  // rate is extrapolated from the neighboring spin-up-retry attribute rather
  // than measured directly — so the multiplier is indicative, not exact. The
  // direction is not in doubt, and a drive whose motor already struggles is not
  // one to sell on, which is the call this tool exists to make.)
  if (after.spinRetryCount != null && after.spinRetryCount > 0) {
    push({
      code: "SPIN_RETRY",
      severity: "fail",
      message: `${after.spinRetryCount} spin retry/retries — the motor struggled to reach speed`,
      metric: "spinRetryCount",
      after: after.spinRetryCount,
    })
  }

  // --- command timeouts ---
  //
  // Given a tolerance band rather than any-non-zero, unlike the uncorrectable counters:
  // ≤100 timeouts fails at 2.49%/year, indistinguishable from baseline, while
  // above that it is 10.0%, four times baseline. Warn rather than fail because a
  // timeout can as easily be the cable or controller as the drive — the same
  // reasoning as the CRC rule below.
  if (after.commandTimeouts != null && after.commandTimeouts > thresholds.commandTimeoutWarnMax) {
    push({
      code: "COMMAND_TIMEOUTS",
      severity: "warn",
      message: `${after.commandTimeouts} command timeout(s) exceeds ${thresholds.commandTimeoutWarnMax} — check cabling and controller`,
      metric: "commandTimeouts",
      after: after.commandTimeouts,
    })
  }

  // --- interface CRC errors ---
  //
  // Warn, never fail, and the failure data agrees: the annual failure rate goes
  // from 4.1% at zero-to-one error to roughly 15% and then simply plateaus —
  // 15.4% at 4–8 errors, 14.9% at 8–16, 13.7% at 35–70, 18.3% at 130–260. No
  // dose-response at all, which is what a cable problem looks like rather than a
  // failing disk. Scrutiny reaches the same conclusion and marks the attribute
  // non-critical.
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
