import type {
  DiscoveredDrive,
  RegimeMode,
  SelfTestProgress,
  SurfaceResult,
} from "@spindoctor/shared"

export interface DeviceApi {
  listDevices(): Promise<DiscoveredDrive[]>
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
