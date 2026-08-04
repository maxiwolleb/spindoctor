import { describe, it, expect } from "vitest"
import { constants } from "node:fs"
import { CLAIM_OPEN_FLAGS, makeExclusiveOpener, probeDeviceClaim } from "./deviceClaim"

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

// The mechanism the whole guard rests on. Every test above injects its own
// opener, so none of them touch the real one — deleting `O_EXCL` from it leaves
// the suite green while making `probeDeviceClaim` answer "free" for every drive,
// including the host's mounted system disk. That is the issue #83 hole
// reintroduced by removing one token, so the flags are pinned directly.
describe("the exclusive open itself", () => {
  it("asks for O_EXCL — without it the probe cannot detect anything", () => {
    expect(CLAIM_OPEN_FLAGS & constants.O_EXCL).toBe(constants.O_EXCL)
  })

  it("opens read-only, so the probe can never modify a drive", () => {
    expect(CLAIM_OPEN_FLAGS & constants.O_WRONLY).toBe(0)
    expect(CLAIM_OPEN_FLAGS & constants.O_RDWR).toBe(0)
    // O_CREAT would turn a probe of a missing path into a file we created.
    expect(CLAIM_OPEN_FLAGS & constants.O_CREAT).toBe(0)
  })

  it("passes those flags to open, and closes the handle again", async () => {
    const calls: Array<{ path: string; flags: number }> = []
    let closed = 0
    const fakeOpen = (async (path: string, flags: number) => {
      calls.push({ path, flags })
      return {
        close: async () => {
          closed += 1
        },
      }
    }) as unknown as typeof import("node:fs/promises").open

    await makeExclusiveOpener(fakeOpen)("/dev/sdb")

    expect(calls).toEqual([{ path: "/dev/sdb", flags: CLAIM_OPEN_FLAGS }])
    // Leaking the handle would leave us holding the exclusive claim ourselves,
    // which would make our own badblocks fail to open the drive.
    expect(closed).toBe(1)
  })

  it("propagates the open error so probeDeviceClaim can classify it", async () => {
    const failing = (async () => {
      const err = new Error("busy") as NodeJS.ErrnoException
      err.code = "EBUSY"
      throw err
    }) as unknown as typeof import("node:fs/promises").open

    expect(await probeDeviceClaim("/dev/sda", makeExclusiveOpener(failing))).toBe("claimed")
  })
})
