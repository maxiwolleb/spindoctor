import type { DriveType, Transport } from "@spindoctor/shared"

export interface LsblkDisk {
  devicePath: string
  serial: string | null
  wwn: string | null
  model: string
  sizeBytes: number
  type: DriveType
  transport: Transport
  mounted: boolean
  isSystemDisk: boolean
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {}
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

const SYSTEM_MOUNTPOINTS = new Set(["/", "/boot", "/boot/efi"])

/**
 * Walks a device node and its `children`, collecting every mountpoint.
 *
 * Modern `util-linux` `lsblk -J` (>= 2.37) reports mounts via a `mountpoints`
 * ARRAY (e.g. `["/", null]`) and may omit the older singular `mountpoint`
 * field entirely. Older versions only emit the singular field. Both shapes
 * must be considered per node, or a mounted/system disk on a modern host
 * would be misreported as unmounted — a safety-critical bug for a tool that
 * refuses destructive wipes based on these flags.
 */
function collectMountpoints(node: Record<string, any>, out: (string | null)[]): void {
  out.push(str(node.mountpoint))
  const mountpoints = Array.isArray(node.mountpoints) ? node.mountpoints : []
  for (const mp of mountpoints) {
    out.push(str(mp))
  }
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    collectMountpoints(asRecord(child), out)
  }
}

function classifyType(node: Record<string, any>): DriveType {
  const tran = str(node.tran)
  if (tran === "nvme") return "NVMe"
  if (node.rota === true) return "HDD"
  return "SSD"
}

function classifyTransport(node: Record<string, any>): Transport {
  switch (str(node.tran)) {
    case "sata":
      return "SATA"
    case "sas":
      return "SAS"
    case "usb":
      return "USB"
    case "nvme":
      return "NVMe"
    default:
      return "UNKNOWN"
  }
}

export function parseLsblk(json: unknown): LsblkDisk[] {
  const root = asRecord(json)
  const devices = Array.isArray(root.blockdevices) ? root.blockdevices : []

  const disks: LsblkDisk[] = []
  for (const raw of devices) {
    const node = asRecord(raw)
    if (node.type !== "disk") continue

    const mountpoints: (string | null)[] = []
    collectMountpoints(node, mountpoints)

    const name = str(node.name) ?? ""
    disks.push({
      devicePath: `/dev/${name}`,
      serial: str(node.serial),
      wwn: str(node.wwn),
      model: str(node.model) ?? "",
      sizeBytes: num(node.size) ?? 0,
      type: classifyType(node),
      transport: classifyTransport(node),
      mounted: mountpoints.some((m) => m != null),
      isSystemDisk: mountpoints.some((m) => m != null && SYSTEM_MOUNTPOINTS.has(m)),
    })
  }

  return disks
}
