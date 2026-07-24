import type { DiscoveredDrive } from "@spindoctor/shared"

export type SafetyDecision = { allowed: true } | { allowed: false; code: string; reason: string }

export function checkDestructiveAllowed(
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
