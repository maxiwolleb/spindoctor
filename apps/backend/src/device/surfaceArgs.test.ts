import { describe, it, expect } from "vitest"
import { BADBLOCKS_BLOCK_CEILING, surfaceBlockSize, buildSurfaceArgs } from "./surfaceArgs"

/** Byte sizes of the drives on the SAS bench that found issue #84, plus the
 * sizes either side of each block-size step. */
const SIZES = {
  hdd500g: 500_107_862_016,
  ssd120g: 120_034_123_776,
  sas8t: 8_001_563_222_016,
  sas12t: 12_000_138_625_024,
  /** Either side of the 16 TiB ceiling that `-b 4096` buys. The last size that
   * still fits is one block short of it: the highest usable block *number* is
   * `BADBLOCKS_BLOCK_CEILING - 1`, so a count equal to the ceiling is already
   * one too many. */
  under16t: (BADBLOCKS_BLOCK_CEILING - 1) * 4096,
  over16t: BADBLOCKS_BLOCK_CEILING * 4096,
  huge: 400_000_000_000_000,
}

describe("surfaceBlockSize", () => {
  it("uses the 4 KiB physical sector size for ordinary drives", () => {
    expect(surfaceBlockSize(SIZES.ssd120g)).toBe(4096)
    expect(surfaceBlockSize(SIZES.hdd500g)).toBe(4096)
  })

  it("keeps every bench drive under badblocks' 32-bit block ceiling", () => {
    // The regression this test exists for: with badblocks' default 1024-byte
    // block, both of these exceed the ceiling and badblocks exits before any
    // I/O ("invalid end block ... must be 32-bit value").
    for (const size of [SIZES.sas8t, SIZES.sas12t]) {
      expect(size / 1024).toBeGreaterThan(BADBLOCKS_BLOCK_CEILING)
      expect(size / surfaceBlockSize(size)).toBeLessThan(BADBLOCKS_BLOCK_CEILING)
    }
  })

  it("scales past the 16 TiB that -b 4096 addresses", () => {
    expect(surfaceBlockSize(SIZES.under16t)).toBe(4096)
    expect(surfaceBlockSize(SIZES.over16t)).toBe(8192)
  })

  it("produces a runnable block count for any size, however large", () => {
    // Property, not a table: whatever the capacity, the block count must fit
    // in badblocks' 32-bit block number, or the stage cannot start at all.
    for (const size of [...Object.values(SIZES), SIZES.huge * 1000]) {
      expect(size / surfaceBlockSize(size)).toBeLessThan(BADBLOCKS_BLOCK_CEILING)
    }
  })

  it("returns a power of two at or above 4096", () => {
    for (const size of Object.values(SIZES)) {
      const bs = surfaceBlockSize(size)
      expect(bs).toBeGreaterThanOrEqual(4096)
      expect(Number.isInteger(Math.log2(bs))).toBe(true)
    }
  })

  it("falls back to 4096 when the size is unknown or nonsensical", () => {
    // Discovery records 0 when lsblk reported no size. Guessing small is the
    // safe direction: it only risks the 4 TiB error we already handle, never a
    // block size the drive can't do.
    expect(surfaceBlockSize(0)).toBe(4096)
    expect(surfaceBlockSize(-1)).toBe(4096)
    expect(surfaceBlockSize(Number.NaN)).toBe(4096)
  })
})

describe("buildSurfaceArgs", () => {
  it("passes an explicit -b, so a 12 TB drive is addressable", () => {
    const args = buildSurfaceArgs({
      mode: "destructive",
      logfile: "/tmp/bb.log",
      sizeBytes: SIZES.sas12t,
      devicePath: "/dev/sda",
    })

    expect(args).toEqual(["-b", "4096", "-w", "-s", "-o", "/tmp/bb.log", "/dev/sda"])
  })

  it("scales -b for a drive past the 4096 ceiling", () => {
    const args = buildSurfaceArgs({
      mode: "destructive",
      logfile: "/tmp/bb.log",
      sizeBytes: SIZES.over16t,
      devicePath: "/dev/sda",
    })

    expect(args.slice(0, 2)).toEqual(["-b", "8192"])
  })

  it("uses -n for a read-only run and -w for a destructive one", () => {
    const base = { logfile: "/tmp/bb.log", sizeBytes: SIZES.hdd500g, devicePath: "/dev/sdb" }

    expect(buildSurfaceArgs({ ...base, mode: "destructive" })).toContain("-w")
    expect(buildSurfaceArgs({ ...base, mode: "read-only" })).toContain("-n")
  })

  it("puts the device path last, as badblocks expects", () => {
    const args = buildSurfaceArgs({
      mode: "read-only",
      logfile: "/tmp/bb.log",
      sizeBytes: SIZES.hdd500g,
      devicePath: "/dev/sdc",
    })

    expect(args[args.length - 1]).toBe("/dev/sdc")
  })
})
