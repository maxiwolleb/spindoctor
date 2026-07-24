import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { DiscoveredDrive, RegimeMode, SelfTestProgress, SurfaceResult } from "@spindoctor/shared"
import type { CommandRunner } from "./runner"
import type { DeviceApi } from "./deviceApi"
import { parseLsblk } from "./lsblkParser"
import { parseSmartctlScan } from "./scanParser"
import { mergeDiscovery } from "./discovery"
import { parseSelfTest } from "./smartParser"
import { parseBadblocksPercent, countBadBlocks } from "./badblocksParser"

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === "object" ? (v as Record<string, any>) : {}
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** `RegimeMode` names the user-facing regime; `SurfaceResult.mode` names the badblocks flag used. */
function toSurfaceMode(mode: RegimeMode): SurfaceResult["mode"] {
  return mode === "destructive" ? "write" : "read-only"
}

export interface RealDeviceApiOpts {
  /** Directory the badblocks logfile is created in. Defaults to `os.tmpdir()`. */
  logDir?: string
  /** Test seam: command to spawn instead of the real `badblocks` binary. */
  surfaceCommand?: string
  /** Test seam: builds the arg list (given the logfile path) instead of the real `-w/-n -s -o` flags. */
  surfaceArgsPrefix?: (logfile: string) => string[]
}

/**
 * `DeviceApi` implementation that shells out to `lsblk`/`smartctl` via a
 * `CommandRunner`. Contains no direct process-spawning logic itself — that's
 * the runner's job — so it stays trivially testable with a fake runner.
 *
 * `runSurfaceTest` is the one exception: badblocks is long-running, streams
 * progress on stderr, and must be abortable mid-run, so it spawns directly
 * via `node:child_process` rather than going through the fire-and-wait
 * `CommandRunner`.
 */
export class RealDeviceApi implements DeviceApi {
  constructor(
    private runner: CommandRunner,
    private opts: RealDeviceApiOpts = {},
  ) {}

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

  async runSurfaceTest(
    devicePath: string,
    mode: RegimeMode,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<SurfaceResult> {
    const surfaceMode = toSurfaceMode(mode)
    if (signal.aborted) {
      return { mode: surfaceMode, badBlocks: 0, completed: false }
    }

    const logDir = this.opts.logDir ?? tmpdir()
    const logfile = join(logDir, `badblocks-${randomUUID()}.log`)

    const command = this.opts.surfaceCommand ?? "badblocks"
    const flags = this.opts.surfaceArgsPrefix
      ? this.opts.surfaceArgsPrefix(logfile)
      : [mode === "destructive" ? "-w" : "-n", "-s", "-o", logfile]
    const args = [...flags, devicePath]

    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] })

      const onAbort = () => {
        child.kill("SIGTERM")
      }
      signal.addEventListener("abort", onAbort, { once: true })

      child.stderr.on("data", (chunk: Buffer) => {
        const percent = parseBadblocksPercent(chunk.toString())
        if (percent !== null) onProgress(percent)
      })

      const finish = async (code: number | null) => {
        signal.removeEventListener("abort", onAbort)
        let log = ""
        try {
          log = await readFile(logfile, "utf8")
        } catch {
          // Logfile may legitimately be absent (killed before badblocks wrote it).
          log = ""
        }
        resolve({ mode: surfaceMode, badBlocks: countBadBlocks(log), completed: code === 0 })
      }

      child.on("close", (code) => {
        void finish(code)
      })

      child.on("error", () => {
        void finish(null)
      })
    })
  }
}
