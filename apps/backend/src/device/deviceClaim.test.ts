import { describe, it, expect } from "vitest"
import { probeDeviceClaim } from "./deviceClaim"

/** Rejects the way `fs.open` does: an Error carrying an errno `code`. */
function failsWith(code: string): () => Promise<void> {
  return async () => {
    const err = new Error(`mock ${code}`) as NodeJS.ErrnoException
    err.code = code
    throw err
  }
}

describe("probeDeviceClaim", () => {
  it("reports a device whose exclusive open succeeds as free", async () => {
    expect(await probeDeviceClaim("/dev/sdb", async () => {})).toBe("free")
  })

  // The signal that closes issue #83: the kernel refuses an exclusive open of a
  // device something already holds, whatever mount namespace we are in.
  it("reports EBUSY as claimed", async () => {
    expect(await probeDeviceClaim("/dev/sda", failsWith("EBUSY"))).toBe("claimed")
  })

  it("reports anything else as unknown rather than free", async () => {
    // Guessing "free" here is the bug: it is what made the guards report a
    // reassuring "not mounted" for a drive nobody had actually checked.
    for (const code of ["EACCES", "EPERM", "ENOENT", "ENXIO", "EIO"]) {
      expect(await probeDeviceClaim("/dev/sdc", failsWith(code))).toBe("unknown")
    }
  })

  it("reports an error with no errno code as unknown", async () => {
    expect(
      await probeDeviceClaim("/dev/sdc", async () => {
        throw new Error("no code on this one")
      }),
    ).toBe("unknown")
  })

  it("passes the device path through to the opener untouched", async () => {
    const seen: string[] = []
    await probeDeviceClaim("/dev/nvme0n1", async (path) => {
      seen.push(path)
    })
    expect(seen).toEqual(["/dev/nvme0n1"])
  })
})
