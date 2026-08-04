import type { DiscoveredDrive } from "@spindoctor/shared"

export type SafetyDecision = { allowed: true } | { allowed: false; code: string; reason: string }

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

  // MOUNTED: drive is currently mounted
  if (drive.mounted) {
    return {
      allowed: false,
      code: "MOUNTED",
      reason: "Drive is currently mounted",
    }
  }

  // PROTECTED: drive serial is in protection list
  if (ctx.protectList.includes(drive.serial)) {
    return {
      allowed: false,
      code: "PROTECTED",
      reason: "Drive is in the protected list",
    }
  }

  // All checks passed
  return { allowed: true }
}
