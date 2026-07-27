import type {
  DiscoveredDrive,
  RegimeMode,
  SelfTestProgress,
  SurfaceResult,
} from "@spindoctor/shared"
import type { DeviceApi } from "./deviceApi"

export interface FakeDeviceApiState {
  drives?: DiscoveredDrive[]
  smartByPath?: Record<string, unknown>
  selfTestByPath?: Record<string, SelfTestProgress>
  surface?: { plan?: number[]; result?: SurfaceResult; log?: string }
}

/** `RegimeMode` names the user-facing regime; `SurfaceResult.mode` names the badblocks flag used. */
function toSurfaceMode(mode: RegimeMode): SurfaceResult["mode"] {
  return mode === "destructive" ? "write" : "read-only"
}

export class FakeDeviceApi implements DeviceApi {
  readonly started: string[] = []
  /** Device paths a self-test abort was issued for, in order. */
  readonly selfTestAborts: string[] = []
  readonly surfaceCalls: { devicePath: string; mode: RegimeMode }[] = []
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
  async abortSelfTest(devicePath: string): Promise<void> {
    this.selfTestAborts.push(devicePath)
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

  async runSurfaceTest(
    devicePath: string,
    mode: RegimeMode,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
    onLog?: (log: string) => void,
  ): Promise<SurfaceResult> {
    this.surfaceCalls.push({ devicePath, mode })
    const plan = this.state.surface?.plan ?? [25, 50, 75, 100]
    const aborted: SurfaceResult = { mode: toSurfaceMode(mode), badBlocks: 0, completed: false }

    for (const percent of plan) {
      if (signal.aborted) return aborted
      onProgress(percent)
      // Yield so an abort fired from within (or concurrently with) onProgress
      // has a chance to land before the next step runs.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (signal.aborted) return aborted
    }

    // Only fires when a test fixture opts in — leaves every existing caller
    // that doesn't set `state.surface.log` untouched.
    if (this.state.surface?.log !== undefined) onLog?.(this.state.surface.log)

    return (
      this.state.surface?.result ?? { mode: toSurfaceMode(mode), badBlocks: 0, completed: true }
    )
  }
}
