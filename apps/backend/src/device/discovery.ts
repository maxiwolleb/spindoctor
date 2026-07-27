import type { DiscoveredDrive } from "@spindoctor/shared"
import type { LsblkDisk } from "./lsblkParser"
import type { ScanDevice } from "./scanParser"

/** Strips a trailing NVMe namespace/partition suffix: `/dev/nvme0n1p1` -> `/dev/nvme0`. */
function controllerPrefix(devicePath: string): string {
  return devicePath.replace(/n\d+(p\d+)?$/, "")
}

/** A block device discovery deliberately dropped, and the reason why. */
export type DiscoverySkip = {
  devicePath: string
  reason: string
}

const NO_SERIAL = "lsblk reported no serial"
/** Appended to `NO_SERIAL` only when the whole pass found nothing — that's the
 * case where a missing udev mount is actually the likely explanation. zram and
 * loop devices have no serial by nature, so pointing at a working mount would
 * send the operator to inspect correct configuration. */
const NO_SERIAL_UDEV_HINT = `${NO_SERIAL} — is /run/udev mounted into the container?`

export function mergeDiscovery(
  lsblk: LsblkDisk[],
  scan: ScanDevice[],
  onSkip?: (skip: DiscoverySkip) => void,
): DiscoveredDrive[] {
  const scanPaths = new Set(scan.map((s) => s.devicePath))
  // Buffered, not reported inline: whether the udev hint belongs on a
  // missing-serial reason depends on how the whole pass turned out.
  const skipped: DiscoverySkip[] = []
  const skip = (devicePath: string, reason: string): void =>
    void skipped.push({ devicePath, reason })

  const isSmartctlVisible = (devicePath: string): boolean => {
    if (scanPaths.has(devicePath)) return true
    return scanPaths.has(controllerPrefix(devicePath))
  }

  const result: DiscoveredDrive[] = []
  for (const disk of lsblk) {
    // Everything here is keyed on the serial, so a disk without one cannot be
    // tracked. In a container this is nearly always a missing /run/udev mount:
    // lsblk reads SERIAL from the udev database, and without it every disk
    // looks serial-less — which presents as a dashboard with no drives at all.
    if (disk.serial == null || disk.serial === "") {
      skip(disk.devicePath, NO_SERIAL)
      continue
    }
    if (!isSmartctlVisible(disk.devicePath)) {
      skip(disk.devicePath, "not visible to `smartctl --scan`")
      continue
    }
    // Skip virtual / non-physical block devices. Real drives always report a
    // physical transport (SATA/USB/NVMe/SAS); a disk with no
    // recognizable transport — a hypervisor's own virtual disks under WSL/VMs,
    // loop devices, etc. — is not something to test, and must never be
    // destructively writable by accident. Filtering here also keeps such a
    // device out of listDevices(), so startRun() can't target it either.
    if (disk.transport === "UNKNOWN") {
      skip(disk.devicePath, "no recognizable physical transport (virtual disk?)")
      continue
    }

    result.push({
      devicePath: disk.devicePath,
      serial: disk.serial,
      wwn: disk.wwn,
      model: disk.model,
      sizeBytes: disk.sizeBytes,
      type: disk.type,
      transport: disk.transport,
      mounted: disk.mounted,
      isSystemDisk: disk.isSystemDisk,
    })
  }

  if (onSkip) {
    const foundNothing = result.length === 0
    for (const s of skipped) {
      onSkip(s.reason === NO_SERIAL && foundNothing ? { ...s, reason: NO_SERIAL_UDEV_HINT } : s)
    }
  }

  return result
}
