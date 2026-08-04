import { describe, it, expect } from "vitest"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { checkRunAllowed, isProtected } from "./guards"

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

describe("checkRunAllowed", () => {
  it("allows a clean, unprotected, unmounted, non-system drive", () => {
    expect(checkRunAllowed(base, { protectList: [] })).toEqual({ allowed: true })
  })
  it("denies a system disk", () => {
    const r = checkRunAllowed({ ...base, isSystemDisk: true }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "SYSTEM_DISK" })
  })
  it("denies a mounted disk", () => {
    const r = checkRunAllowed({ ...base, mounted: true }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "MOUNTED" })
  })
  it("denies a protected drive by serial", () => {
    const r = checkRunAllowed(base, { protectList: ["OK1"] })
    expect(r).toMatchObject({ allowed: false, code: "PROTECTED" })
  })
  it("denies a drive with no serial", () => {
    const r = checkRunAllowed({ ...base, serial: "" }, { protectList: [] })
    expect(r).toMatchObject({ allowed: false, code: "NO_SERIAL" })
  })
  it("system-disk check wins over protected", () => {
    const r = checkRunAllowed({ ...base, isSystemDisk: true }, { protectList: ["OK1"] })
    expect(r).toMatchObject({ allowed: false, code: "SYSTEM_DISK" })
  })
})

// Issue #88: matching was exact string equality against whatever was stored, so
// an entry with a stray space or the wrong case protected nothing — and did so
// invisibly, on the one guard that exists to stop the wrong drive being wiped.
describe("normalizeSerial / isProtected", () => {
  it("matches regardless of surrounding whitespace on either side", () => {
    expect(isProtected("OK1", ["  OK1  "])).toBe(true)
    expect(isProtected("  OK1  ", ["OK1"])).toBe(true)
  })

  it("matches regardless of case", () => {
    // The exact reproduction from the report: a lower-cased real serial.
    expect(isProtected("ZJV2GEQ70000C909M0J0", ["zjv2geq70000c909m0j0"])).toBe(true)
    expect(isProtected("ok1", ["OK1"])).toBe(true)
  })

  it("still refuses to match a genuinely different serial", () => {
    expect(isProtected("OK1", ["OK2", "TOTALLY-MADE-UP"])).toBe(false)
    // One character off — the near-miss the typed-serial guard also has to catch.
    expect(isProtected("ZJV2GEQ70000C909M0J0", ["ZJV2GEQ70000C909M0J1"])).toBe(false)
  })

  it("never matches an empty serial, whatever the list holds", () => {
    // A drive with no serial is refused by NO_SERIAL, but a blank list entry
    // must not turn into a wildcard on the way there.
    expect(isProtected("", [""])).toBe(false)
    expect(isProtected("", ["   "])).toBe(false)
    expect(isProtected("  ", ["OK1"])).toBe(false)
  })

  it("denies through checkRunAllowed for a differently-cased list entry", () => {
    const r = checkRunAllowed(base, { protectList: ["  ok1  "] })
    expect(r).toMatchObject({ allowed: false, code: "PROTECTED" })
  })
})
