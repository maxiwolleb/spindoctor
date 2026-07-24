import type { DiscoveredDrive, SelfTestProgress } from "@spindoctor/shared"

export interface DeviceApi {
  listDevices(): Promise<DiscoveredDrive[]>
  readSmartRaw(devicePath: string): Promise<unknown>
  startLongSelfTest(devicePath: string): Promise<void>
  pollSelfTest(devicePath: string): Promise<SelfTestProgress>
}
