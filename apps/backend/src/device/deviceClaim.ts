import { constants, open } from "node:fs/promises"

/**
 * Whether the kernel considers a block device already claimed by something else.
 *
 * `"unknown"` is a real answer, not a placeholder: it means the probe could not
 * run (no permission, device gone, unexpected errno), and it must not be
 * mistaken for `"free"`. Reporting a guess as a fact is what issue #83 was.
 */
export type ClaimState = "claimed" | "free" | "unknown"

/** Test seam: attempts the exclusive open. Resolves when it succeeds (and has
 * closed again), rejects with an errno-bearing error when it doesn't. */
export type ExclusiveOpener = (devicePath: string) => Promise<void>

/**
 * The flags the probe opens with, and the entire mechanism this module relies on.
 *
 * `O_EXCL` is what makes the answer meaningful: without it the open succeeds on
 * any readable block device, the probe reports every drive `"free"`, and the
 * whole guard silently reverts to the issue #83 behavior. It is named and
 * asserted separately because dropping that one token is invisible in every test
 * that injects its own opener.
 *
 * `O_RDONLY` because the probe must never be able to modify a drive.
 */
export const CLAIM_OPEN_FLAGS = constants.O_RDONLY | constants.O_EXCL

/** Builds an opener over an injectable `open`, so a test can assert the flags
 * that reach the syscall rather than trusting them. */
export function makeExclusiveOpener(openFn: typeof open = open): ExclusiveOpener {
  return async (devicePath) => {
    const handle = await openFn(devicePath, CLAIM_OPEN_FLAGS)
    await handle.close()
  }
}

const defaultOpener: ExclusiveOpener = makeExclusiveOpener()

/**
 * Asks the kernel whether a block device is in use, by trying to open it
 * exclusively.
 *
 * This exists because the `MOUNTED` and `SYSTEM_DISK` guards were derived from
 * `lsblk` mountpoints, and `lsblk` reports the *calling process's* mount
 * namespace. Inside the container the host's `/` and `/boot` are not mounted, so
 * no host drive ever reported a mountpoint and both flags were always false —
 * including for the host's own system disk (issue #83).
 *
 * An exclusive open is namespace-independent because the claim lives in the
 * kernel's block layer, not in a mount table: mounting a filesystem takes an
 * exclusive claim on the device, and the claim is recorded against the whole
 * disk, so a mounted *partition* also makes its parent disk report busy
 * (verified on a real device: with a partition of a loop device mounted, the
 * whole disk returns EBUSY). That is the same mechanism `wipefs` and `mkfs` use
 * to refuse a mounted device.
 *
 * What it does NOT catch: a writer that never took an exclusive claim. Verified
 * against real e2fsprogs — `badblocks -w` holds its working fd `O_RDWR` without
 * `O_EXCL`, so while one is mid-scan this probe still answers `"free"`, and two
 * concurrent destructive scans of the same device will each run to completion.
 * So this covers exclusive holders (mounted filesystems in any namespace, LVM and
 * md members, swap) but not a raw `dd` or `badblocks` in another container.
 *
 * spindoctor's own writers are handled separately, because they are the ones it
 * can actually know about: a drive whose surface process was abandoned rather
 * than reaped is remembered and reported `claimed` until that pid is gone (see
 * `RealDeviceApi.hasAbandonedWriter`, issue #105). A second writer from outside
 * spindoctor remains out of reach of both mechanisms.
 *
 * Read-only and non-destructive: it opens `O_RDONLY`, closes immediately, and a
 * probe that fails changes nothing about the holder.
 */
export async function probeDeviceClaim(
  devicePath: string,
  opener: ExclusiveOpener = defaultOpener,
): Promise<ClaimState> {
  try {
    await opener(devicePath)
    return "free"
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // The one answer we can act on: something else holds this device.
    if (code === "EBUSY") return "claimed"
    // Everything else is genuinely unknown rather than free. ENOENT means the
    // device went away between discovery and here; EACCES means we can't ask
    // (which shouldn't happen for a device this container can run smartctl
    // against, but guessing "free" on it is exactly the wrong direction).
    return "unknown"
  }
}
