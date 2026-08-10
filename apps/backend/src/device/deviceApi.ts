import type {
  DiscoveredDrive,
  RegimeMode,
  SelfTestProgress,
  SurfaceResult,
} from "@spindoctor/shared"

export interface ListDevicesOpts {
  /**
   * A serial whose claim must be probed even if the caller is otherwise treated
   * as already testing it.
   *
   * `startRun` reserves the serial *before* it fetches the drive it is about to
   * judge, so without this the claim probe is suppressed for the one drive whose
   * claim decides whether the run may start at all — and the `IN_USE` guard can
   * never fire on the only path that starts a run. Verified against real
   * hardware: a destructive start on a drive the same process reported
   * `"claim": "claimed"` returned 201.
   *
   * Exempting it is safe: `startRun` throws `RunInProgressError` before reaching
   * discovery if the serial was already reserved, so a reservation seen here is
   * always this call's own and there is no badblocks of ours to race.
   */
  alwaysProbe?: string
}

export interface DeviceApi {
  listDevices(opts?: ListDevicesOpts): Promise<DiscoveredDrive[]>
  readSmartRaw(devicePath: string): Promise<unknown>
  /**
   * Asks the drive to begin its long self-test. Resolves `false` when the drive
   * cannot run one — plenty of cheap NVMe controllers don't implement the
   * command, and `smartctl` reports that by printing "Self-tests not supported"
   * while still exiting 0, so the caller cannot learn it from an exit code.
   */
  startLongSelfTest(devicePath: string): Promise<boolean>
  /** Tells the drive to stop the self-test routine it is running. Needed on
   * abort: dropping out of the poll loop leaves the drive running the routine
   * on its own for as long as it takes (~90 min on a 500 GB HDD). */
  abortSelfTest(devicePath: string): Promise<void>
  pollSelfTest(devicePath: string): Promise<SelfTestProgress>
  runSurfaceTest(
    devicePath: string,
    /** The drive's capacity. Required because badblocks' default 1024-byte
     * block size caps the addressable device at 4 TiB, so the block size has to
     * be derived from the size of the drive in front of us (issue #84) — a
     * surface stage that silently cannot start is worse than no surface stage. */
    sizeBytes: number,
    mode: RegimeMode,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
    /** Called once, after the underlying tool exits, with the captured raw
     * output for the stage (e.g. combined stdout/stderr + bad-block logfile
     * contents) so callers can persist it. Optional — a caller that doesn't
     * need the raw log (or an implementation with nothing to capture) can
     * omit/ignore it. */
    onLog?: (log: string) => void,
  ): Promise<SurfaceResult>
}
