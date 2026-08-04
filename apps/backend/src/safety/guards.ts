import type { DiscoveredDrive } from "@spindoctor/shared"

export type SafetyDecision = { allowed: true } | { allowed: false; code: string; reason: string }

/**
 * Canonical form of a drive serial for protect-list comparison: trimmed and
 * upper-cased.
 *
 * The list was matched with exact string equality and stored verbatim, so
 * `"  zjv2geq7…  "` protected nothing while looking identical to a correct entry
 * in Settings (issue #88). Serials get copied off drive labels and out of
 * terminal output, where a case change or a stray space is routine, and this is
 * the last-resort guard against wiping the wrong drive — the one place a silent
 * near-miss is least acceptable.
 *
 * Case-folding is safe here: serials are not case-significant in practice, and
 * two real drives differing only in the case of their serial would be
 * indistinguishable to an operator reading a label anyway.
 */
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase()
}

/** True when this drive's serial is on the protect list, comparing canonical
 * forms so whitespace or case in either can't create a false negative. */
export function isProtected(serial: string, protectList: readonly string[]): boolean {
  const target = normalizeSerial(serial)
  if (target === "") return false
  return protectList.some((entry) => normalizeSerial(entry) === target)
}

/**
 * Whether a run may touch this drive at all — every mode, not just the
 * destructive one.
 *
 * It was `checkDestructiveAllowed` and the engine only consulted it for
 * destructive runs, which made all four checks inert for a read-only run: a
 * protected drive, a mounted one, or the system disk could be put through a
 * surface pass with one unauthenticated request and no typed-serial confirmation
 * (issue #85). Reading a drive is gentler than writing it, but "never touch this
 * one" is not a claim about write modes, and the surface stage keeps a drive busy
 * for hours either way.
 */
export function checkRunAllowed(
  drive: DiscoveredDrive,
  ctx: { protectList: string[] },
): SafetyDecision {
  // NO_SERIAL: drive has no serial
  if (drive.serial === "") {
    return {
      allowed: false,
      code: "NO_SERIAL",
      reason: "Drive has no serial number",
    }
  }

  // SYSTEM_DISK: drive is marked as system disk
  if (drive.isSystemDisk) {
    return {
      allowed: false,
      code: "SYSTEM_DISK",
      reason: "This is the system disk",
    }
  }

  // MOUNTED: drive is mounted in this process's own mount namespace
  if (drive.mounted) {
    return {
      allowed: false,
      code: "MOUNTED",
      reason: "Drive is currently mounted",
    }
  }

  // IN_USE: the kernel refused an exclusive open, so something holds this device
  // — a mounted filesystem in any namespace (including the host's), an LVM or md
  // member, swap, another container. This is the check that works inside the
  // container, where `mounted` above cannot see the host's mounts at all
  // (issue #83). `"unknown"` deliberately does not deny: the probe is unavailable
  // in some environments, and refusing every drive would leave the tool unable to
  // do its job, so an unknown is surfaced rather than enforced.
  if (drive.claim === "claimed") {
    return {
      allowed: false,
      code: "IN_USE",
      reason: "Something on this host is using the drive (the kernel refused exclusive access)",
    }
  }

  // PROTECTED: drive serial is in protection list
  if (isProtected(drive.serial, ctx.protectList)) {
    return {
      allowed: false,
      code: "PROTECTED",
      reason: "Drive is in the protected list",
    }
  }

  // All checks passed
  return { allowed: true }
}
