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

const defaultOpener: ExclusiveOpener = async (devicePath) => {
  const handle = await open(devicePath, constants.O_RDONLY | constants.O_EXCL)
  await handle.close()
}

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
 * disk, so a mounted *partition* also makes its parent disk report busy. That is
 * the same mechanism `wipefs` and `mkfs` use to refuse a mounted device, and it
 * catches holders a mount table would miss entirely — LVM and md members, swap,
 * another container.
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
