import { describe, it, expect } from "vitest"
import { parseLsblk } from "./lsblkParser"
import lsblk from "./__fixtures__/lsblk.json"
import lsblkMountpointsArray from "./__fixtures__/lsblk-mountpoints-array.json"

describe("parseLsblk — modern `mountpoints` array (util-linux >= 2.37)", () => {
  it("derives mounted/isSystemDisk from the mountpoints array when the singular mountpoint field is absent", () => {
    const disks = parseLsblk(lsblkMountpointsArray)
    const byPath = Object.fromEntries(disks.map((d) => [d.devicePath, d]))

    expect(byPath["/dev/sda"]).toMatchObject({ mounted: true, isSystemDisk: false })
    expect(byPath["/dev/nvme0n1"]).toMatchObject({ mounted: true, isSystemDisk: true })
  })
})

describe("parseLsblk — legacy singular `mountpoint` field (regression)", () => {
  it("still derives mounted/isSystemDisk correctly", () => {
    const disks = parseLsblk(lsblk)
    const byPath = Object.fromEntries(disks.map((d) => [d.devicePath, d]))

    expect(byPath["/dev/sda"]).toMatchObject({ mounted: true, isSystemDisk: false })
    expect(byPath["/dev/nvme0n1"]).toMatchObject({ mounted: true, isSystemDisk: true })
  })
})
