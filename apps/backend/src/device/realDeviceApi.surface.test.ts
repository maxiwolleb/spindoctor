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
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--bad", "0"],
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
})
