import type { DiscoveredDrive, RegimeMode, SelfTestProgress, SurfaceResult } from "@spindoctor/shared"

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
  ): Promise<SurfaceResult>
}
