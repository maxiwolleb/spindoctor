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

// Issue #83: `mounted` and `isSystemDisk` come from `lsblk`, which reports only
// the calling process's mount namespace. Inside the container — the deployment
// this project ships as — the host's `/` and `/boot` are not mounted, so no host
// drive ever reported a mountpoint and both guards were structurally unable to
// fire, for the system disk included.
describe("checkRunAllowed with the kernel claim state", () => {
  it("denies a drive the kernel says is in use, even with no mountpoint visible", () => {
    // Exactly the container's view of the host's system disk: lsblk shows nothing
    // mounted, but the kernel refuses an exclusive open.
    const r = checkRunAllowed(
      { ...base, mounted: false, isSystemDisk: false, claim: "claimed" },
      { protectList: [] },
    )
    expect(r).toMatchObject({ allowed: false, code: "IN_USE" })
  })

  it("allows a drive the kernel says is free", () => {
    expect(checkRunAllowed({ ...base, claim: "free" }, { protectList: [] })).toEqual({
      allowed: true,
    })
  })

  it("does not deny on an unknown claim state", () => {
    // Denying here would make every drive ineligible wherever the probe can't
    // run, i.e. would stop the tool doing its job. The unknown is logged and
    // surfaced instead — a guard that can't see its input must say so, not guess
    // in either direction.
    for (const claim of ["unknown", undefined] as const) {
      expect(checkRunAllowed({ ...base, claim }, { protectList: [] })).toEqual({ allowed: true })
    }
  })

  it("still prefers the more specific reason when several apply", () => {
    // Order matters for the message the operator reads: being the system disk is
    // more informative than being busy, and both are more specific than IN_USE.
    expect(
      checkRunAllowed({ ...base, isSystemDisk: true, claim: "claimed" }, { protectList: [] }),
    ).toMatchObject({ code: "SYSTEM_DISK" })
    expect(
      checkRunAllowed({ ...base, mounted: true, claim: "claimed" }, { protectList: [] }),
    ).toMatchObject({ code: "MOUNTED" })
  })

  it("reports IN_USE ahead of PROTECTED when both apply", () => {
    // Named explicitly rather than asserting only `allowed: false`: the code is
    // what the operator reads, and "something is using this drive" is the more
    // actionable of the two.
    const r = checkRunAllowed({ ...base, claim: "claimed" }, { protectList: ["OK1"] })
    expect(r).toMatchObject({ allowed: false, code: "IN_USE" })
  })
})

describe("checkRunAllowed with a whitespace-only serial", () => {
  // A serial of only spaces used to slip through NO_SERIAL (it isn't "") while
  // also being impossible to protect: the protect list drops blank entries and
  // isProtected refuses to match an empty target. So the drive was destructively
  // eligible and no mechanism could stop it.
  it("refuses it as NO_SERIAL", () => {
    for (const serial of ["  ", "\t", "\n", " \t "]) {
      expect(checkRunAllowed({ ...base, serial }, { protectList: [] })).toMatchObject({
        allowed: false,
        code: "NO_SERIAL",
      })
    }
  })

  it("agrees with isProtected about what counts as no serial", () => {
    expect(isProtected("   ", ["ANYTHING"])).toBe(false)
    expect(checkRunAllowed({ ...base, serial: "   " }, { protectList: [] })).toMatchObject({
      code: "NO_SERIAL",
    })
  })

  it("still allows a serial that merely has padding around real characters", () => {
    expect(checkRunAllowed({ ...base, serial: "  OK1  " }, { protectList: [] })).toEqual({
      allowed: true,
    })
    // And that padded serial can still be protected.
    expect(checkRunAllowed({ ...base, serial: "  OK1  " }, { protectList: ["ok1"] })).toMatchObject(
      { code: "PROTECTED" },
    )
  })
})
