import type { RegimeMode } from "@spindoctor/shared"

/**
 * badblocks holds block numbers in a 32-bit type, so it can address at most
 * this many blocks — whatever `-b` says a block is. Past it, badblocks exits
 * before any I/O with "invalid end block (…): must be 32-bit value".
 */
export const BADBLOCKS_BLOCK_CEILING = 2 ** 32

/**
 * The block size we ask badblocks for, and the reason this module exists
 * (issue #84).
 *
 * badblocks' own default is 1024 bytes, which caps the addressable device at
 * 2^32 × 1024 B = 4 TiB. Every drive on the SAS bench that found the bug is
 * larger than that, so the surface stage — the strongest evidence in the whole
 * regime — could not start on any of them, and the failure graded as a WARN.
 *
 * 4096 is the floor rather than 1024 because it is the physical sector size of
 * every drive this tool is aimed at, so it is both safe (a larger I/O size is
 * always valid; only bad-block *granularity* coarsens, and any bad block at all
 * is a FAIL) and faster than 1024. That buys 16 TiB; above that we double until
 * the block count fits, which keeps the arithmetic honest for drives that don't
 * exist yet rather than picking a new magic constant per capacity generation.
 */
export function surfaceBlockSize(sizeBytes: number): number {
  let blockSize = 4096
  // A size we don't trust (discovery records 0 when lsblk reported none) gets
  // the floor: guessing small can only reproduce the 4 TiB error, never ask a
  // drive for a block size it cannot do.
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return blockSize
  while (sizeBytes / blockSize >= BADBLOCKS_BLOCK_CEILING) blockSize *= 2
  return blockSize
}

/**
 * Builds the badblocks argument list for a surface run.
 *
 * Split out as a pure function so the block-size arithmetic is testable without
 * a device, a container, or the 4 TiB drive that would otherwise be needed to
 * notice it is wrong.
 */
export function buildSurfaceArgs(opts: {
  mode: RegimeMode
  logfile: string
  sizeBytes: number
  devicePath: string
}): string[] {
  return [
    "-b",
    String(surfaceBlockSize(opts.sizeBytes)),
    // `-w` writes four patterns over every sector and verifies each. A read-only
    // run passes no mode flag at all, which is badblocks' actual read-only test.
    //
    // It used to pass `-n`, badblocks' *non-destructive read-write* test: opens
    // the device O_RDWR and writes a pattern to every sector, restoring the
    // original as it goes. Data survives a clean `-n`; it does not survive one
    // interrupted by power loss, an OOM kill, or a `docker kill`, and on a
    // mounted filesystem the read-modify-write races the live filesystem even
    // when it completes. Every label in the UI and the docs promised "read-only"
    // (issue #85) — so the code now matches the promise rather than the reverse.
    ...(opts.mode === "destructive" ? ["-w"] : []),
    "-s",
    "-o",
    opts.logfile,
    opts.devicePath,
  ]
}
