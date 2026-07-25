import type { DiscoveredDrive } from "@spindoctor/shared"
import type { LsblkDisk } from "./lsblkParser"
import type { ScanDevice } from "./scanParser"

/** Strips a trailing NVMe namespace/partition suffix: `/dev/nvme0n1p1` -> `/dev/nvme0`. */
function controllerPrefix(devicePath: string): string {
  return devicePath.replace(/n\d+(p\d+)?$/, "")
}

export function mergeDiscovery(lsblk: LsblkDisk[], scan: ScanDevice[]): DiscoveredDrive[] {
  const scanPaths = new Set(scan.map((s) => s.devicePath))

  const isSmartctlVisible = (devicePath: string): boolean => {
    if (scanPaths.has(devicePath)) return true
    return scanPaths.has(controllerPrefix(devicePath))
  }

  const result: DiscoveredDrive[] = []
  for (const disk of lsblk) {
    if (disk.serial == null || disk.serial === "") continue
    if (!isSmartctlVisible(disk.devicePath)) continue
    // Skip virtual / non-physical block devices. Real drives always report a
    // physical transport (SATA/USB/NVMe/SAS); a disk with no
    // recognizable transport — a hypervisor's own virtual disks under WSL/VMs,
    // loop devices, etc. — is not something to test, and must never be
    // destructively writable by accident. Filtering here also keeps such a
    // device out of listDevices(), so startRun() can't target it either.
    if (disk.transport === "UNKNOWN") continue

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

  return result
}
