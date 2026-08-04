import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import type { ChildProcess } from "node:child_process"
import { RealDeviceApi } from "./realDeviceApi"
import { execFileRunner } from "./runner"

/** Capacity passed to `runSurfaceTest`; only the badblocks `-b` arithmetic
 * reads it (issue #84), so any plausible drive size does. */
const SIZE_BYTES = 500_107_862_016

// Runs the fake-badblocks emulator (a plain Node script) in place of the real
// `badblocks` binary — no real disk or real badblocks involved.
const __dirname = dirname(fileURLToPath(import.meta.url))
const emulatorPath = join(__dirname, "__testhelpers__", "fake-badblocks.mjs")

describe("RealDeviceApi.runSurfaceTest (against the badblocks emulator)", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spindoctor-surface-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("drives onProgress to increasing percents ending at 100 and completes clean", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      // --phases 8 emulates a real destructive `-w` run's eight phases, so the
      // monotonic overall percent the tracker produces actually reaches 100
      // (each phase's raw percent only climbs to 100 within that phase).
      surfaceArgsPrefix: (logfile) => [
        emulatorPath,
        "--log",
        logfile,
        "--bad",
        "0",
        "--phases",
        "8",
      ],
    })
    const percents: number[] = []

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      (p) => percents.push(p),
      new AbortController().signal,
    )

    expect(percents.length).toBeGreaterThan(0)
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThan(percents[i - 1] as number)
    }
    expect(percents[percents.length - 1]).toBe(100)
    expect(result).toEqual({ mode: "write", badBlocks: 0, completed: true })
  }, 8000)

  it("reports bad blocks parsed from the logfile", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--bad", "2"],
    })

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "read-only",
      () => {},
      new AbortController().signal,
    )

    expect(result).toEqual({ mode: "read-only", badBlocks: 2, completed: true })
  }, 8000)

  it("kills a hanging process on abort and resolves completed:false", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
    })
    const controller = new AbortController()

    const start = Date.now()
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    const elapsed = Date.now() - start

    // A broken kill would leave the emulator looping forever (--hang never
    // exits on its own), so a prompt resolution is itself proof the child
    // process was actually terminated rather than left running.
    expect(elapsed).toBeLessThan(2000)
    expect(result).toEqual({ mode: "write", badBlocks: 0, completed: false })
  }, 8000)

  // Issue #86: SIGTERM was the only kill, and the promise resolved only from
  // `close`/`error`. A badblocks that ignores SIGTERM — which is what a process
  // stuck in an uninterruptible I/O wait on a failing drive looks like — left
  // the run in SURFACE forever and leaked its concurrency permit, while the
  // abort call had already reported success.
  it("escalates to SIGKILL when the process ignores SIGTERM", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [
        emulatorPath,
        "--log",
        logfile,
        "--hang",
        "--ignore-sigterm",
      ],
      surfaceKillGraceMs: 150,
      surfaceAbandonMs: 5000,
    })
    const controller = new AbortController()

    const start = Date.now()
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    const elapsed = Date.now() - start

    // Resolved because SIGKILL landed, not because the abandon timer fired:
    // well after the grace period, well before the abandon deadline.
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(4000)
    expect(result).toMatchObject({ mode: "write", completed: false })
    expect(result.startFailed).toBeUndefined()
  }, 10000)

  it("settles even if the process never exits at all, so the run can never wedge", async () => {
    // The case SIGKILL cannot fix either: a task in uninterruptible sleep
    // ignores it too. The promise still has to settle, or the engine's
    // concurrency permit is never released.
    // Swallows the signals so the process genuinely outlives them, and keeps the
    // handle so the test can clean it up afterwards — the emulator's --hang loop
    // would otherwise be orphaned and run forever.
    let child: ChildProcess | undefined
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
      killer: (c) => {
        child = c
      },
      surfaceKillGraceMs: 50,
      surfaceAbandonMs: 300,
    })
    const controller = new AbortController()

    const start = Date.now()
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    const elapsed = Date.now() - start
    child?.kill("SIGKILL")

    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(3000)
    expect(result).toMatchObject({ completed: false })
  }, 10000)

  // The clause that actually needs covering: an abort arriving *after* the child
  // is running but before it has printed a single percent. Without excluding
  // aborts, `finish` would see a non-zero exit and no progress and call it
  // SURFACE_COULD_NOT_START — failing the run with no verdict instead of
  // recording a deliberate stop. The test above only exercised the pre-spawn
  // early return, so removing that exclusion left the suite green.
  it("does not call a mid-run abort a start failure, even with no progress reported", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--silent-hang"],
      surfaceKillGraceMs: 50,
      surfaceAbandonMs: 4000,
    })
    const controller = new AbortController()
    const percents: number[] = []
    // Abort once the child is definitely up, but it has printed nothing.
    setTimeout(() => controller.abort(), 120)

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      (p) => percents.push(p),
      controller.signal,
    )

    expect(percents).toEqual([])
    expect(result.completed).toBe(false)
    expect(result.startFailed).toBeUndefined()
  }, 10000)

  // #86 claimed "timers are cleared on every settle path", which nothing checked:
  // both timers are only armed inside onAbort, so a clean run has nothing to
  // clear. The leak that matters is abort-then-child-exits-promptly, which settles
  // at once while the SIGKILL timer stays armed for the whole grace period.
  it("does not escalate to SIGKILL after the child has already exited on SIGTERM", async () => {
    const signals: string[] = []
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
      // Forwards SIGTERM for real so the child dies, and records what was sent.
      killer: (child, signal) => {
        signals.push(signal)
        child.kill(signal)
      },
      surfaceKillGraceMs: 60,
      surfaceAbandonMs: 120,
    })
    const controller = new AbortController()

    await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    // Well past both deadlines: a timer left armed would fire in this window.
    await new Promise((r) => setTimeout(r, 300))

    expect(signals).toEqual(["SIGTERM"])
  }, 10000)

  // #90's other half: the caller has to feed every percent in a chunk to the
  // tracker. Nothing covered it, because the emulator emits one percent per
  // write — so the pre-#90 last-only behavior passed the whole suite.
  it("carries a phase boundary that arrives inside a single chunk through to progress", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      // 8 phases, as a destructive run has, so the overall percent is per-phase.
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--burst"],
    })
    const percents: number[] = []

    await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      (p) => percents.push(p),
      new AbortController().signal,
    )

    // The chunk spans ...93.75, 100, reset to 0, 6.25 — so the tracker must have
    // counted phase 1 complete and be reporting inside phase 2 of 8 (>12.5%).
    // Reading only the chunk's last percent gives 6.25/8 = 0.78%.
    expect(percents.length).toBeGreaterThanOrEqual(4)
    expect(percents.at(-1)).toBeGreaterThan(12.5)
    expect(percents.at(-1)).toBeLessThan(25)
  }, 10000)

  it("sends no signal at all on a clean run", async () => {
    // A run that finishes normally must not be left holding armed timers that
    // later fire a SIGKILL at a recycled pid.
    const signals: string[] = []
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--bad", "0"],
      killer: (_child, signal) => signals.push(signal),
      surfaceKillGraceMs: 50,
      surfaceAbandonMs: 100,
    })

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "read-only",
      () => {},
      new AbortController().signal,
    )
    // Well past both deadlines, had either been left armed.
    await new Promise((r) => setTimeout(r, 250))

    expect(result.completed).toBe(true)
    expect(signals).toEqual([])
  }, 8000)

  it("sends SIGTERM first, then SIGKILL, in that order", async () => {
    const signals: string[] = []
    let child: ChildProcess | undefined
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
      // Records instead of killing, so the escalation runs to completion and the
      // abandon timer provides the exit.
      killer: (c, signal) => {
        child = c
        signals.push(signal)
      },
      surfaceKillGraceMs: 60,
      surfaceAbandonMs: 400,
    })
    const controller = new AbortController()

    await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    child?.kill("SIGKILL")

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  }, 8000)

  it("captures the badblocks stdout+stderr and bad-block logfile into onLog", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [
        emulatorPath,
        "--log",
        logfile,
        "--bad",
        "2",
        "--stdout",
        "surface scan starting",
      ],
    })

    let capturedLog: string | undefined
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => {},
      new AbortController().signal,
      (log) => {
        capturedLog = log
      },
    )

    expect(result).toEqual({ mode: "write", badBlocks: 2, completed: true })
    expect(capturedLog).toBeDefined()
    expect(capturedLog).toContain("=== badblocks stdout ===")
    expect(capturedLog).toContain("surface scan starting")
    expect(capturedLog).toContain("=== badblocks stderr (progress) ===")
    expect(capturedLog).toContain("% done")
    expect(capturedLog).toContain("=== bad-block logfile ===")
    expect(capturedLog).toContain("1000")
    expect(capturedLog).toContain("1001")
  }, 8000)

  it("still calls onLog with whatever was captured before a kill on abort", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
    })
    const controller = new AbortController()

    let capturedLog: string | undefined
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => controller.abort(),
      controller.signal,
      (log) => {
        capturedLog = log
      },
    )

    expect(result.completed).toBe(false)
    expect(capturedLog).toBeDefined()
    expect(capturedLog).toContain("=== badblocks stderr (progress) ===")
    // The hanging emulator never writes the logfile — the log still has a
    // labelled (empty) section for it rather than throwing/omitting it.
    expect(capturedLog).toContain("=== bad-block logfile ===\n(empty)")
  }, 8000)

  it("does not call onLog when the caller omits it", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--bad", "0"],
    })

    // No 5th argument at all — must not throw from an unconditional call.
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "read-only",
      () => {},
      new AbortController().signal,
    )

    expect(result).toEqual({ mode: "read-only", badBlocks: 0, completed: true })
  }, 8000)

  it("resolves once (not hanging or throwing) when the command fails to spawn", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: "/nonexistent/definitely-not-badblocks-xyz",
    })

    // Both the child's `error` and `close` events fire on a spawn failure
    // (confirmed on Node 22) — without a single-resolution guard this would
    // either throw on a double `resolve()` call or hang the test.
    const start = Date.now()
    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => {},
      new AbortController().signal,
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(result).toMatchObject({ completed: false, badBlocks: 0 })
    // A binary that isn't there never scanned anything, so this is a tool
    // failure rather than an incomplete measurement.
    expect(result.startFailed).toBe(true)
  }, 3000)

  it("flags a scan that never started, and keeps the tool's own error in the log", async () => {
    // The shape of issue #84: badblocks rejects the device before any I/O, so
    // there is no progress and no logfile — only a message on stderr.
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--fail-start"],
    })
    let captured: string | undefined
    const percents: number[] = []

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      (p) => percents.push(p),
      new AbortController().signal,
      (log) => {
        captured = log
      },
    )

    expect(percents).toEqual([])
    expect(result).toMatchObject({ mode: "write", badBlocks: 0, completed: false })
    expect(result.startFailed).toBe(true)
    expect(captured).toContain("must be 32-bit value")
  }, 5000)

  it("does not flag a scan that started and then failed", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [
        emulatorPath,
        "--log",
        logfile,
        "--exit-code",
        "1",
        "--phases",
        "1",
      ],
    })

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => {},
      new AbortController().signal,
    )

    // Reported progress, then exited non-zero: an incomplete measurement, which
    // is a fact about the run and stays a WARN.
    expect(result.completed).toBe(false)
    expect(result.startFailed).toBeUndefined()
  }, 5000)

  it("returns early for a signal already aborted before the process is spawned", async () => {
    const api = new RealDeviceApi(execFileRunner, {
      logDir: dir,
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
    })
    const controller = new AbortController()
    controller.abort()

    const result = await api.runSurfaceTest(
      "/dev/fake",
      SIZE_BYTES,
      "destructive",
      () => {},
      controller.signal,
    )

    expect(result.startFailed).toBeUndefined()
  }, 5000)

  it("passes an explicit -b on the production path, sized for the drive", async () => {
    // Goes through the real argument builder — no `surfaceArgsPrefix` seam — and
    // uses `echo` as the command so the arguments spindoctor actually produces
    // come back through the captured stdout. Without this, nothing asserts that
    // the block size reaches badblocks at all (issue #84).
    const api = new RealDeviceApi(execFileRunner, { logDir: dir, surfaceCommand: "/bin/echo" })
    let captured = ""

    const result = await api.runSurfaceTest(
      "/dev/fake",
      12_000_138_625_024, // 12 TB: 11.7e9 blocks at badblocks' 1024-byte default
      "destructive",
      () => {},
      new AbortController().signal,
      (log) => {
        captured = log
      },
    )

    // One assertion on the whole argument line, so an argument reordered into
    // the wrong position still fails: block size first, device path last.
    expect(captured).toMatch(/-b 4096 -w -s -o \S+ \/dev\/fake/)
    expect(result.startFailed).toBeUndefined()
  }, 5000)
})
