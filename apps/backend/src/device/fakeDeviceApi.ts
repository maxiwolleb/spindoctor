import type { DiscoveredDrive, SelfTestProgress } from "@spindoctor/shared"
import type { DeviceApi } from "./deviceApi"

export interface FakeDeviceApiState {
  drives?: DiscoveredDrive[]
  smartByPath?: Record<string, unknown>
  selfTestByPath?: Record<string, SelfTestProgress>
}

export class FakeDeviceApi implements DeviceApi {
  readonly started: string[] = []
  constructor(private state: FakeDeviceApiState = {}) {}

  async listDevices(): Promise<DiscoveredDrive[]> {
    return this.state.drives ?? []
  }
  async readSmartRaw(devicePath: string): Promise<unknown> {
    const s = this.state.smartByPath?.[devicePath]
    if (s === undefined) throw new Error(`no SMART data for ${devicePath}`)
    return s
  }
  async startLongSelfTest(devicePath: string): Promise<void> {
    this.started.push(devicePath)
  }
  async pollSelfTest(devicePath: string): Promise<SelfTestProgress> {
    return (
      this.state.selfTestByPath?.[devicePath] ?? {
        running: false,
        percentRemaining: null,
        result: { status: "UNKNOWN" },
      }
    )
  }
}
