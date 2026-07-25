import type {
  DiscoveredDrive,
  RegimeMode,
  SelfTestProgress,
  SurfaceResult,
} from "@spindoctor/shared"

export interface DeviceApi {
  listDevices(): Promise<DiscoveredDrive[]>
  readSmartRaw(devicePath: string): Promise<unknown>
  startLongSelfTest(devicePath: string): Promise<void>
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
