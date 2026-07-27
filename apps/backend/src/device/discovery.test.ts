import { describe, it, expect } from "vitest"
import { parseLsblk } from "./lsblkParser"
import { parseSmartctlScan } from "./scanParser"
import { mergeDiscovery } from "./discovery"
import type { DiscoverySkip } from "./discovery"
import type { LsblkDisk } from "./lsblkParser"
import lsblk from "./__fixtures__/lsblk.json"
import scan from "./__fixtures__/smartctl-scan.json"

const lsblkDisk = (over: Partial<LsblkDisk> = {}): LsblkDisk => ({
  devicePath: "/dev/sdx",
  serial: "SER",
  wwn: null,
  model: "Some Model",
  sizeBytes: 1000,
  type: "HDD",
  transport: "USB",
  mounted: false,
  isSystemDisk: false,
  ...over,
})

describe("parseLsblk", () => {
  it("returns only disks, with derived fields", () => {
    const disks = parseLsblk(lsblk)
    const byPath = Object.fromEntries(disks.map((d) => [d.devicePath, d]))
    expect(Object.keys(byPath).sort()).toEqual(["/dev/nvme0n1", "/dev/sda", "/dev/sdb", "/dev/sdc"]) // sr0 (rom) excluded
    expect(byPath["/dev/sda"]).toMatchObject({
      type: "HDD",
      transport: "SATA",
      mounted: true,
      isSystemDisk: false,
      sizeBytes: 4000787030016,
    })
    expect(byPath["/dev/sdb"]).toMatchObject({ mounted: false, isSystemDisk: false })
    expect(byPath["/dev/nvme0n1"]).toMatchObject({
      type: "NVMe",
      transport: "NVMe",
      mounted: true,
      isSystemDisk: true,
    })
    expect(byPath["/dev/sdc"]).toMatchObject({ type: "SSD", transport: "USB", serial: null })
  })
})

describe("parseSmartctlScan", () => {
  it("extracts device paths", () => {
    expect(parseSmartctlScan(scan)).toEqual([
      { devicePath: "/dev/sda" },
      { devicePath: "/dev/sdb" },
      { devicePath: "/dev/nvme0" },
    ])
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

  it("drops virtual / non-physical disks (UNKNOWN transport), keeps physical ones", () => {
    const real = lsblkDisk({ devicePath: "/dev/sde", serial: "REAL1", transport: "USB" })
    // A hypervisor's own virtual disk (e.g. under WSL): has a serial and is
    // smartctl-visible, but reports no physical transport. Must be excluded so
    // it can't be listed or destructively targeted.
    const virtualDisk = lsblkDisk({
      devicePath: "/dev/sda",
      serial: "VIRTUAL1",
      transport: "UNKNOWN",
      model: "Virtual Disk",
    })
    const scanDevices = [{ devicePath: "/dev/sde" }, { devicePath: "/dev/sda" }]

    const result = mergeDiscovery([real, virtualDisk], scanDevices)
    expect(result.map((d) => d.serial)).toEqual(["REAL1"])
  })

  it("reports every dropped device, and why, so an empty dashboard is diagnosable", () => {
    const skips: DiscoverySkip[] = []
    const noSerial = lsblkDisk({ devicePath: "/dev/sdb", serial: null })
    const notScanned = lsblkDisk({ devicePath: "/dev/sdc", serial: "UNSEEN" })
    const virtualDisk = lsblkDisk({
      devicePath: "/dev/sdd",
      serial: "VIRTUAL2",
      transport: "UNKNOWN",
    })
    const kept = lsblkDisk({ devicePath: "/dev/sde", serial: "KEEP" })
    const scanDevices = [
      { devicePath: "/dev/sdb" },
      { devicePath: "/dev/sdd" },
      { devicePath: "/dev/sde" },
    ]

    const result = mergeDiscovery([noSerial, notScanned, virtualDisk, kept], scanDevices, (s) =>
      skips.push(s),
    )

    expect(result.map((d) => d.serial)).toEqual(["KEEP"])
    expect(skips).toEqual([
      { devicePath: "/dev/sdb", reason: expect.stringContaining("serial") },
      { devicePath: "/dev/sdc", reason: expect.stringContaining("smartctl") },
      { devicePath: "/dev/sdd", reason: expect.stringContaining("transport") },
    ])
  })

  // The no-serial case is almost always a container without /run/udev mounted:
  // lsblk resolves SERIAL out of the udev database, so without it every disk
  // looks serial-less and the dashboard comes up empty. Name the cause in the
  // message rather than making the operator guess.
  it("names the udev mount as the likely cause of a missing serial", () => {
    const skips: DiscoverySkip[] = []
    mergeDiscovery([lsblkDisk({ serial: null })], [{ devicePath: "/dev/sdx" }], (s) =>
      skips.push(s),
    )
    expect(skips[0]?.reason).toMatch(/udev/)
  })

  it("says nothing when every disk is kept", () => {
    const skips: DiscoverySkip[] = []
    mergeDiscovery(
      [lsblkDisk({ devicePath: "/dev/sde", serial: "KEEP" })],
      [{ devicePath: "/dev/sde" }],
      (s) => skips.push(s),
    )
    expect(skips).toEqual([])
  })
})
