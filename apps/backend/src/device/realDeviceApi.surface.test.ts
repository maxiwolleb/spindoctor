import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { RealDeviceApi } from "./realDeviceApi"
import { execFileRunner } from "./runner"

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
      "destructive",
      () => {},
      new AbortController().signal,
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2000)
    expect(result).toMatchObject({ completed: false, badBlocks: 0 })
  }, 3000)
})
