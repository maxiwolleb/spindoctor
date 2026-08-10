import { describe, it, expect, afterEach } from "vitest"
import type { ChildProcess } from "node:child_process"
import { createExecFileRunner, execFileRunner } from "./runner"
import { isProcessAlive } from "./realDeviceApi"

describe("execFileRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await execFileRunner.run(process.execPath, ["-e", "process.stdout.write('hi')"])
    expect(r.stdout).toBe("hi")
    expect(r.code).toBe(0)
  })
  it("reports a non-zero exit code without throwing", async () => {
    const r = await execFileRunner.run(process.execPath, ["-e", "process.exit(3)"])
    expect(r.code).toBe(3)
  })
})

// Issue #109: every smartctl call was unbounded, and `execFile`'s own `timeout`
// is not enough on its own — it signals the child and settles from the exit
// callback, so a child that does not die (a task in an uninterruptible ioctl on
// a half-disconnected drive, which is exactly the hardware this tool is pointed
// at) never settles the promise. That parked the self-test poll loop forever:
// the run stayed RUNNING, could not be aborted, held its concurrency permit, and
// was resumed again by reconcile() after a restart.
describe("execFileRunner deadline (#109)", () => {
  /** Ignores SIGTERM, so only the escalation can end it. */
  const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  /** Exits promptly on SIGTERM, like a healthy child. */
  const EXITS_ON_SIGTERM =
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"

  const strays: ChildProcess[] = []
  afterEach(() => {
    for (const child of strays.splice(0)) child.kill("SIGKILL")
  })

  /** Keeps a handle on the child so a test that deliberately lets one outlive
   * its runner can still clean it up — an orphaned `setInterval` would run for
   * the life of the test process. */
  function keeping(signals?: string[]) {
    return createExecFileRunner({
      killGraceMs: 150,
      killer: (child, signal) => {
        signals?.push(signal)
        if (!strays.includes(child)) strays.push(child)
        child.kill(signal)
      },
    })
  }

  it("settles at its deadline even when the command ignores SIGTERM", async () => {
    const start = Date.now()

    const r = await keeping().run(process.execPath, ["-e", IGNORES_SIGTERM], { timeoutMs: 200 })

    // Settling at all is the whole point: this promise previously never
    // resolved, so a hung poll could not be given up on.
    expect(Date.now() - start).toBeLessThan(3000)
    expect(r.code).not.toBe(0)
    // Empty stdout is what makes a timed-out `readSmartRaw` fail its JSON parse
    // and the stage fail visibly, rather than pass an empty reading along.
    expect(r.stdout).toBe("")
    expect(r.stderr).toMatch(/timed out/i)
  }, 10000)

  it("kills the command it gave up on", async () => {
    let child: ChildProcess | undefined
    const runner = createExecFileRunner({
      killGraceMs: 150,
      killer: (c, signal) => {
        child = c
        if (!strays.includes(c)) strays.push(c)
        c.kill(signal)
      },
    })

    await runner.run(process.execPath, ["-e", IGNORES_SIGTERM], { timeoutMs: 200 })
    await waitFor(() => child !== undefined && !isProcessAlive(child.pid!))

    // A deadline that only abandons the child would leave a smartctl per poll
    // holding the drive open for the rest of the run.
    expect(isProcessAlive(child!.pid!)).toBe(false)
  }, 10000)

  it("sends SIGTERM first, then SIGKILL", async () => {
    const signals: string[] = []

    await keeping(signals).run(process.execPath, ["-e", IGNORES_SIGTERM], { timeoutMs: 200 })
    await waitFor(() => signals.length === 2)

    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
  }, 10000)

  it("does not escalate to SIGKILL after the command exited on SIGTERM", async () => {
    // #86's lesson, one layer down: an armed timer that outlives the child can
    // fire SIGKILL at a pid the OS has since handed to somebody else.
    const signals: string[] = []

    await keeping(signals).run(process.execPath, ["-e", EXITS_ON_SIGTERM], { timeoutMs: 200 })
    await delay(600)

    expect(signals).toEqual(["SIGTERM"])
  }, 10000)

  it("leaves a command that answers inside its deadline alone", async () => {
    const signals: string[] = []

    const r = await keeping(signals).run(process.execPath, ["-e", "process.stdout.write('ok')"], {
      timeoutMs: 5000,
    })
    await delay(300)

    expect(r).toMatchObject({ stdout: "ok", code: 0 })
    expect(signals).toEqual([])
  })

  it("stays unbounded when no deadline is asked for", async () => {
    // The runner imposes nothing of its own: the caller decides what is a
    // sensible wait for the command it is running.
    const r = await execFileRunner.run(process.execPath, [
      "-e",
      "setTimeout(() => process.stdout.write('slow'), 300)",
    ])

    expect(r).toMatchObject({ stdout: "slow", code: 0 })
  }, 10000)
})

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await delay(20)
}
