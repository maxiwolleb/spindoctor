import { describe, it, expect } from "vitest"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { checkDestructiveAllowed } from "./guards"

const base: DiscoveredDrive = {
  devicePath: "/dev/sdb",
  serial: "OK1",
  wwn: null,
  model: "M",
  sizeBytes: 1,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
}

describe("checkDestructiveAllowed", () => {
  it("allows a clean, unprotected, unmounted, non-system drive", () => {
    expect(checkDestructiveAllowed(base, { protectList: [] })).toEqual({ allowed: true })
  })
  it("denies a system disk", () => {
    const r = checkDestructiveAllowed({ ...base, isSystemDisk: true }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "SYSTEM_DISK" })
  })
  it("denies a mounted disk", () => {
    const r = checkDestructiveAllowed({ ...base, mounted: true }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "MOUNTED" })
  })
  it("denies a protected drive by serial", () => {
    const r = checkDestructiveAllowed(base, { protectList: ["OK1"] })
    expect(r).toMatchObject({ allowed: false, code: "PROTECTED" })
  })
  it("denies a drive with no serial", () => {
    const r = checkDestructiveAllowed({ ...base, serial: "" }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "NO_SERIAL" })
  })
  it("system-disk check wins over protected", () => {
    const r = checkDestructiveAllowed({ ...base, isSystemDisk: true }, { protectList: ["OK1"] })
    expect(r).toMatchObject({ allowed: false, code: "SYSTEM_DISK" })
  })
})
