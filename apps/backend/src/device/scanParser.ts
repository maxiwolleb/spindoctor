function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {}
}

export interface ScanDevice {
  devicePath: string
}

export function parseSmartctlScan(json: unknown): ScanDevice[] {
  const root = asRecord(json)
  const devices = Array.isArray(root.devices) ? root.devices : []

  const result: ScanDevice[] = []
  for (const raw of devices) {
    const device = asRecord(raw)
    if (typeof device.name === "string") {
      result.push({ devicePath: device.name })
    }
  }
  return result
}
