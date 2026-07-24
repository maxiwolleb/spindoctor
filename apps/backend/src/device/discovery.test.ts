import { describe, it, expect } from "vitest"
import { parseLsblk } from "./lsblkParser"
import { parseSmartctlScan } from "./scanParser"
import { mergeDiscovery } from "./discovery"
import lsblk from "./__fixtures__/lsblk.json"
import scan from "./__fixtures__/smartctl-scan.json"

describe("parseLsblk", () => {
  it("returns only disks, with derived fields", () => {
    const disks = parseLsblk(lsblk)
    const byPath = Object.fromEntries(disks.map((d) => [d.devicePath, d]))
    expect(Object.keys(byPath).sort()).toEqual(["/dev/nvme0n1", "/dev/sda", "/dev/sdb", "/dev/sdc"]) // sr0 (rom) excluded
    expect(byPath["/dev/sda"]).toMatchObject({ type: "HDD", transport: "SATA", mounted: true, isSystemDisk: false, sizeBytes: 4000787030016 })
    expect(byPath["/dev/sdb"]).toMatchObject({ mounted: false, isSystemDisk: false })
    expect(byPath["/dev/nvme0n1"]).toMatchObject({ type: "NVMe", transport: "NVMe", mounted: true, isSystemDisk: true })
    expect(byPath["/dev/sdc"]).toMatchObject({ type: "SSD", transport: "USB", serial: null })
  })
})

describe("parseSmartctlScan", () => {
  it("extracts device paths", () => {
    expect(parseSmartctlScan(scan)).toEqual([{ devicePath: "/dev/sda" }, { devicePath: "/dev/sdb" }, { devicePath: "/dev/nvme0" }])
  })
})

describe("mergeDiscovery", () => {
  it("keeps only serial-bearing, smartctl-visible disks; matches nvme by controller prefix", () => {
    const result = mergeDiscovery(parseLsblk(lsblk), parseSmartctlScan(scan))
    const serials = result.map((d) => d.serial).sort()
    expect(serials).toEqual(["S4EWNX0M", "WD-WCC7K1", "ZFL9AB"]) // sdc dropped (no serial)
    const nvme = result.find((d) => d.serial === "S4EWNX0M")!
    expect(nvme.devicePath).toBe("/dev/nvme0n1")
    expect(nvme.isSystemDisk).toBe(true)
  })
})
