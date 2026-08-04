import { spawn, type ChildProcess } from "node:child_process"
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
import { probeDeviceClaim, type ExclusiveOpener } from "./deviceClaim"
import { normalizeSerial } from "../safety/guards"
import { parseSelfTest, scsiSelfTestInProgress } from "./smartParser"
import { silentLogger, type Logger } from "../logger"
import {
  parseBadblocksPercents,
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
  /**
   * How long an aborted surface process is given to exit on SIGTERM before it
   * gets SIGKILL. Defaults to 5 s — badblocks has a logfile to flush, so it is
   * worth asking politely first.
   */
  surfaceKillGraceMs?: number
  /**
   * How long after an abort the surface promise settles regardless of whether
   * the process actually died. Defaults to 15 s. SIGKILL does not reach a task
   * in an uninterruptible kernel I/O wait either, so without this deadline the
   * promise could never settle and the engine's concurrency permit — released in
   * its `finally` — would leak (issue #86).
   */
  surfaceAbandonMs?: number
  /** Test seam: delivers a signal to the surface child. Defaults to `child.kill`. */
  killer?: (child: ChildProcess, signal: NodeJS.Signals) => void
  /** Test seam: performs the exclusive-open claim probe (see `deviceClaim.ts`). */
  exclusiveOpener?: ExclusiveOpener
  /** Serials to treat as system disks, comma-separated. Defaults to
   * `process.env.SPINDOCTOR_SYSTEM_DISK_SERIALS`. */
  systemDiskSerials?: string
  /**
   * True for a drive spindoctor is itself testing right now, which is not probed.
   *
   * Two reasons. The probe holds an exclusive claim for a few microseconds, and
   * real badblocks takes its own `O_EXCL` probe when it starts `-w`: if the two
   * coincide, badblocks refuses ("apparently in use by the system"), which since
   * #84 fails the run outright — throwing away the SMART read and the hours-long
   * self-test that preceded it. And the answer would be about us anyway, which
   * tells the guard nothing it doesn't already enforce via the active-run check.
   */
  isDriveUnderTest?: (serial: string) => boolean
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
    const merged = mergeDiscovery(lsblk, scan, ({ devicePath, reason }) => {
      const key = `${devicePath}\t${reason}`
      if (this.reportedSkips.has(key)) return
      this.reportedSkips.add(key)
      this.log.warn({ devicePath, reason }, "ignoring block device during discovery")
    })

    // Ask the kernel who else is using each drive. `lsblk`'s mountpoints only
    // describe this process's mount namespace, so in the container they are
    // empty for every host drive — the host's system disk included (issue #83).
    //
    // There is a theoretical race with our own badblocks: the probe holds an
    // exclusive claim for a few microseconds, so a surface stage opening the same
    // device in that instant could fail. It is a microsecond against a poll
    // interval measured in seconds, and since #84 such a failure is loud rather
    // than silently graded as a WARN — worth it for a guard that otherwise cannot
    // fire at all.
    const systemSerials = this.systemDiskSerials()
    return Promise.all(
      merged.map(async (drive) => {
        // Not probed at all (so reported as unknown) while we are the ones using
        // it: probing would race our own badblocks for no new information.
        const claim = this.opts.isDriveUnderTest?.(drive.serial)
          ? "unknown"
          : await probeDeviceClaim(drive.devicePath, this.opts.exclusiveOpener)
        if (claim === "unknown" && this.opts.isDriveUnderTest?.(drive.serial) !== true) {
          this.reportClaimUnknown(drive.devicePath)
        }
        return {
          ...drive,
          claim,
          // An operator-declared system disk stays refused whatever any probe
          // says: serials survive namespace differences, device renumbering and
          // reboots, which is what makes this worth having in addition.
          isSystemDisk: drive.isSystemDisk || systemSerials.has(normalizeSerial(drive.serial)),
        }
      }),
    )
  }

  /**
   * Serials the operator has declared to be system disks, via
   * `SPINDOCTOR_SYSTEM_DISK_SERIALS` (comma-separated).
   *
   * The container cannot work out which disk the host booted from, so this is the
   * one way to state it that does not depend on the container's own view of the
   * world.
   */
  private systemDiskSerials(): Set<string> {
    const raw = this.opts.systemDiskSerials ?? process.env.SPINDOCTOR_SYSTEM_DISK_SERIALS ?? ""
    return new Set(
      raw
        .split(",")
        .map((entry) => normalizeSerial(entry))
        .filter((entry) => entry !== ""),
    )
  }

  /** Logged once per device: `listDevices` runs on every auto-mode poll, and a
   * guard whose input is missing is worth saying out loud but not every minute. */
  private reportClaimUnknown(devicePath: string): void {
    const key = `${devicePath}\tclaim-unknown`
    if (this.reportedSkips.has(key)) return
    this.reportedSkips.add(key)
    this.log.warn(
      { devicePath },
      "could not determine whether the drive is in use (exclusive-open probe unavailable) — " +
        "the mounted/system-disk guards cannot vouch for this device",
    )
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

      const kill = this.opts.killer ?? ((c: ChildProcess, s: NodeJS.Signals) => c.kill(s))
      const graceMs = this.opts.surfaceKillGraceMs ?? 5_000
      const abandonMs = this.opts.surfaceAbandonMs ?? 15_000
      let killTimer: NodeJS.Timeout | undefined
      let abandonTimer: NodeJS.Timeout | undefined

      const onAbort = () => {
        kill(child, "SIGTERM")
        // badblocks on a failing drive is routinely blocked in a kernel I/O wait
        // that no signal interrupts, so both of these are needed: SIGKILL for a
        // process that merely ignored SIGTERM, and a hard deadline for one that
        // cannot be killed at all.
        killTimer = setTimeout(() => {
          this.log.warn(
            { devicePath, pid: child.pid },
            "surface process did not exit on SIGTERM — escalating to SIGKILL",
          )
          kill(child, "SIGKILL")
        }, graceMs)
        abandonTimer = setTimeout(() => {
          this.log.error(
            { devicePath, pid: child.pid },
            "surface process survived SIGKILL — abandoning it and settling the stage " +
              "so the run cannot wedge; it may still hold the device open",
          )
          void finish(null)
        }, abandonMs)
      }
      signal.addEventListener("abort", onAbort, { once: true })

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk)
        if (signal.aborted) return
        // Every percent in the chunk, in order — a chunk can span a phase
        // boundary, and the tracker needs to see the reset to count the phase
        // (issue #90).
        for (const percent of parseBadblocksPercents(chunk.toString())) {
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
        // Whichever path got here first, the other two must not fire: a stale
        // kill timer would signal a pid the OS may have recycled.
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (abandonTimer !== undefined) clearTimeout(abandonTimer)
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
