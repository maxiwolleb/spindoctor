import type { DiscoveredDrive, SelfTestProgress } from "@spindoctor/shared"
import type { CommandRunner } from "./runner"
import type { DeviceApi } from "./deviceApi"
import { parseLsblk } from "./lsblkParser"
import { parseSmartctlScan } from "./scanParser"
import { mergeDiscovery } from "./discovery"
import { parseSelfTest } from "./smartParser"

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {}
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * `DeviceApi` implementation that shells out to `lsblk`/`smartctl` via a
 * `CommandRunner`. Contains no direct process-spawning logic itself — that's
 * the runner's job — so it stays trivially testable with a fake runner.
 */
export class RealDeviceApi implements DeviceApi {
  constructor(private runner: CommandRunner) {}

  async listDevices(): Promise<DiscoveredDrive[]> {
    const [lsblkResult, scanResult] = await Promise.all([
      this.runner.run("lsblk", ["-b", "-J", "-O"]),
      this.runner.run("smartctl", ["--scan", "--json=c"]),
    ])
    const lsblk = parseLsblk(JSON.parse(lsblkResult.stdout))
    const scan = parseSmartctlScan(JSON.parse(scanResult.stdout))
    return mergeDiscovery(lsblk, scan)
  }

  async readSmartRaw(devicePath: string): Promise<unknown> {
    // smartctl uses its exit code as a bitmask of condition flags and returns
    // non-zero even for perfectly healthy drives (e.g. bit 0x40 for a "self
    // test in the past has found errors" advisory) — the exit code must be
    // ignored here. Only a stdout that fails to parse as JSON is a failure.
    const { stdout } = await this.runner.run("smartctl", ["-x", "--json=c", devicePath])
    try {
      return JSON.parse(stdout)
    } catch (err) {
      throw new Error(
        `smartctl produced non-JSON output for ${devicePath}: ${(err as Error).message}`,
      )
    }
  }

  async startLongSelfTest(devicePath: string): Promise<void> {
    await this.runner.run("smartctl", ["-t", "long", devicePath])
  }

  async pollSelfTest(devicePath: string): Promise<SelfTestProgress> {
    const raw = await this.readSmartRaw(devicePath)
    const j = asRecord(raw)

    // NVMe: a non-zero current self-test operation code means one is running.
    const nvmeLog = asRecord(j.nvme_self_test_log)
    const nvmeOp = asRecord(nvmeLog.current_self_test_operation)
    const nvmeOpValue = num(nvmeOp.value)
    if (nvmeOpValue !== null && nvmeOpValue !== 0) {
      return {
        running: true,
        percentRemaining: num(nvmeLog.current_self_test_completion_percent),
        result: null,
      }
    }

    // ATA: in-progress self-tests report a "... in progress ..." status
    // string and/or a remaining_percent alongside it.
    const ataSelfTest = asRecord(asRecord(j.ata_smart_data).self_test)
    const ataStatus = asRecord(ataSelfTest.status)
    const ataStatusString = typeof ataStatus.string === "string" ? ataStatus.string.toLowerCase() : ""
    const remainingPercent = num(ataStatus.remaining_percent)
    if (ataStatusString.includes("in progress") || remainingPercent !== null) {
      return { running: true, percentRemaining: remainingPercent, result: null }
    }

    return { running: false, percentRemaining: null, result: parseSelfTest(raw) }
  }
}
