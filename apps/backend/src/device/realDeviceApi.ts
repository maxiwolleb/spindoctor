import { spawn } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type {
  DiscoveredDrive,
  RegimeMode,
  SelfTestProgress,
  SurfaceResult,
} from "@spindoctor/shared"
import type { CommandRunner } from "./runner"
import type { DeviceApi } from "./deviceApi"
import { parseLsblk } from "./lsblkParser"
import { parseSmartctlScan } from "./scanParser"
import { mergeDiscovery } from "./discovery"
import { buildSurfaceArgs } from "./surfaceArgs"
import { parseSelfTest, scsiSelfTestInProgress } from "./smartParser"
import { silentLogger, type Logger } from "../logger"
import {
  parseBadblocksPercent,
  countBadBlocks,
  formatSurfaceLog,
  badblocksPhaseCount,
  BadblocksProgressTracker,
} from "./badblocksParser"

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
  /** Structured logger; silent by default. */
  logger?: Logger
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
  /**
   * Skips already reported, as `devicePath\treason`. `listDevices` runs on
   * every auto-mode poll cycle, so an unreported skip must be logged once
   * rather than on every pass.
   */
  private reportedSkips = new Set<string>()

  private readonly log: Logger

  constructor(
    private runner: CommandRunner,
    private opts: RealDeviceApiOpts = {},
  ) {
    this.log = opts.logger ?? silentLogger()
  }

  async listDevices(): Promise<DiscoveredDrive[]> {
    const [lsblkResult, scanResult] = await Promise.all([
      this.runner.run("lsblk", ["-b", "-J", "-O"]),
      this.runner.run("smartctl", ["--scan", "--json=c"]),
    ])
    const lsblk = parseLsblk(JSON.parse(lsblkResult.stdout))
    const scan = parseSmartctlScan(JSON.parse(scanResult.stdout))
    return mergeDiscovery(lsblk, scan, ({ devicePath, reason }) => {
      const key = `${devicePath}\t${reason}`
      if (this.reportedSkips.has(key)) return
      this.reportedSkips.add(key)
      this.log.warn({ devicePath, reason }, "ignoring block device during discovery")
    })
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
        { cause: err },
      )
    }
  }

  async startLongSelfTest(devicePath: string): Promise<boolean> {
    const { stdout, stderr } = await this.runner.run("smartctl", ["-t", "long", devicePath])
    // smartctl exits 0 whether or not it started anything, so the only signal is
    // what it printed. Checked as a substring rather than parsed: this string is
    // console output, not JSON, and the capability is not in the JSON at all
    // before smartmontools 7.5 (`nvme_optional_admin_commands`), while the
    // message is there from 7.4 — which is what the image ships.
    return !/self[-\s]?tests? not supported/i.test(`${stdout}\n${stderr}`)
  }

  async abortSelfTest(devicePath: string): Promise<void> {
    // Exit code is ignored for the same reason as everywhere else here:
    // smartctl uses it as a condition bitmask, not a success flag. A drive
    // that had no routine running simply reports nothing to abort.
    await this.runner.run("smartctl", ["-X", devicePath])
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

    // SAS/SCSI: the newest self-test log entry carries an explicit
    // `self_test_in_progress` flag. There is no percentage to report — smartctl
    // prints "N% of test remaining" for SCSI to the console only, never into the
    // JSON — so a SAS self-test shows as running-without-progress until it ends.
    if (scsiSelfTestInProgress(raw)) {
      return { running: true, percentRemaining: null, result: null }
    }

    // ATA: in-progress self-tests report a "... in progress ..." status
    // string and/or a remaining_percent alongside it.
    const ataSelfTest = asRecord(asRecord(j.ata_smart_data).self_test)
    const ataStatus = asRecord(ataSelfTest.status)
    const ataStatusString =
      typeof ataStatus.string === "string" ? ataStatus.string.toLowerCase() : ""
    const remainingPercent = num(ataStatus.remaining_percent)
    if (ataStatusString.includes("in progress") || remainingPercent !== null) {
      return { running: true, percentRemaining: remainingPercent, result: null }
    }

    return { running: false, percentRemaining: null, result: parseSelfTest(raw) }
  }

  async runSurfaceTest(
    devicePath: string,
    sizeBytes: number,
    mode: RegimeMode,
    onProgress: (percent: number) => void,
    signal: AbortSignal,
    onLog?: (log: string) => void,
  ): Promise<SurfaceResult> {
    const surfaceMode = toSurfaceMode(mode)
    // badblocks reports its percentage per phase (a destructive `-w` run cycles
    // 0→100 eight times); this turns that into one monotonic overall percent.
    const progress = new BadblocksProgressTracker(badblocksPhaseCount(surfaceMode))
    if (signal.aborted) {
      return { mode: surfaceMode, badBlocks: 0, completed: false }
    }

    const logDir = this.opts.logDir ?? tmpdir()
    const logfile = join(logDir, `badblocks-${randomUUID()}.log`)

    const command = this.opts.surfaceCommand ?? "badblocks"
    const args = this.opts.surfaceArgsPrefix
      ? [...this.opts.surfaceArgsPrefix(logfile), devicePath]
      : buildSurfaceArgs({ mode, logfile, sizeBytes, devicePath })

    return new Promise((resolve) => {
      // stdout is piped (not ignored) even though badblocks rarely writes to
      // it: it's captured for the persisted log, and an unconsumed pipe can
      // otherwise backpressure/hang the child if it ever does write.
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      // Whether badblocks ever reported a percentage. Distinguishes a scan that
      // never started (bad arguments, a device too large for its block size, a
      // missing binary) from one that started and was cut short — the first is a
      // tool failure the operator has to fix, the second is a fact about the
      // run, and grading them the same hid issue #84 behind a WARN.
      let sawProgress = false

      const onAbort = () => {
        child.kill("SIGTERM")
      }
      signal.addEventListener("abort", onAbort, { once: true })

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk)
        if (signal.aborted) return
        const percent = parseBadblocksPercent(chunk.toString())
        if (percent !== null) {
          sawProgress = true
          onProgress(progress.update(percent))
        }
      })

      // Both `close` and `error` fire on a spawn failure (confirmed on Node
      // 22), so `finish` must only act once: only the first termination
      // event reads the logfile, tears down listeners, and resolves.
      let settled = false
      const finish = async (code: number | null) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        let badBlocksLog: string
        try {
          badBlocksLog = await readFile(logfile, "utf8")
        } catch {
          // Logfile may legitimately be absent (killed before badblocks wrote it).
          badBlocksLog = ""
        }
        const badBlocks = countBadBlocks(badBlocksLog)
        onLog?.(
          formatSurfaceLog({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            badBlocksLog,
          }),
        )
        const completed = code === 0
        resolve({
          mode: surfaceMode,
          badBlocks,
          completed,
          // An abort is a deliberate stop, not a start failure, however early it
          // lands — so it never sets this even though no progress was seen.
          ...(!completed && !sawProgress && !signal.aborted ? { startFailed: true } : {}),
        })
        try {
          await rm(logfile, { force: true })
        } catch {
          // Best-effort cleanup only — a failure/absent file must never throw.
        }
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
