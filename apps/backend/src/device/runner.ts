import { execFile, type ChildProcess } from "node:child_process"

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: {
      /**
       * How long to wait for the command before giving up on it entirely. Omit
       * (or pass 0) to wait forever — see `createExecFileRunner` for why every
       * caller that touches a device should pass one (issue #109).
       */
      timeoutMs?: number
    },
  ): Promise<{ stdout: string; stderr: string; code: number }>
}

/**
 * Exit code reported for a command that hit its deadline, borrowed from GNU
 * `timeout` so it reads the same in a log. Any non-zero code would do: what
 * matters is that callers see a failure rather than an empty success.
 */
export const TIMED_OUT_EXIT_CODE = 124

export interface ExecFileRunnerOpts {
  /**
   * How long a timed-out child gets to exit on SIGTERM before it gets SIGKILL.
   * Defaults to 5 s. These are read-only query commands with nothing to flush,
   * so the grace is politeness rather than data safety.
   */
  killGraceMs?: number
  /** Test seam: delivers a signal to a timed-out child. Defaults to `child.kill`. */
  killer?: (child: ChildProcess, signal: NodeJS.Signals) => void
}

/**
 * A `CommandRunner` whose `timeoutMs` is a real deadline on the *promise*, not
 * just on the child process.
 *
 * `execFile`'s own `timeout` option is not enough: it signals the child and
 * settles from the exit callback, so a child that does not die never settles the
 * promise at all. That is not a hypothetical here — a `smartctl` blocked in an
 * ioctl on a failing or half-disconnected drive is precisely the hardware this
 * tool exists to qualify. Unbounded, one such call parked the self-test poll
 * loop forever: the run stayed RUNNING and unabortable, held its concurrency
 * permit, and came back on the next `reconcile()` (issue #109).
 *
 * So the deadline resolves the promise regardless of what the child does, and
 * the kill is best-effort cleanup that happens alongside it — the same shape
 * issue #86 settled on for the surface stage one layer up.
 */
export function createExecFileRunner(opts: ExecFileRunnerOpts = {}): CommandRunner {
  const killGraceMs = opts.killGraceMs ?? 5_000
  const kill =
    opts.killer ?? ((child: ChildProcess, signal: NodeJS.Signals) => void child.kill(signal))

  return {
    run(cmd, args, runOpts) {
      return new Promise((resolve) => {
        let settled = false
        let deadline: NodeJS.Timeout | undefined
        let escalation: NodeJS.Timeout | undefined

        // Whatever ends the child ends the timers with it: a SIGKILL still armed
        // for a child that has already exited would land on whatever pid the OS
        // handed out next (issue #86).
        const clearTimers = (): void => {
          if (deadline) clearTimeout(deadline)
          if (escalation) clearTimeout(escalation)
        }
        const settle = (result: { stdout: string; stderr: string; code: number }): void => {
          if (settled) return
          settled = true
          resolve(result)
        }

        const child = execFile(
          cmd,
          args,
          { maxBuffer: 32 * 1024 * 1024 },
          (error, stdout, stderr) => {
            // Also cleared here, not only on `exit`: a command that never
            // started (ENOENT) emits no exit event.
            clearTimers()
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? (error as { code: number }).code
                : error
                  ? 1
                  : 0
            settle({ stdout: stdout.toString(), stderr: stderr.toString(), code })
          },
        )
        child.once("exit", clearTimers)

        const timeoutMs = runOpts?.timeoutMs ?? 0
        if (timeoutMs > 0) {
          deadline = setTimeout(() => {
            kill(child, "SIGTERM")
            escalation = setTimeout(() => kill(child, "SIGKILL"), killGraceMs)
            // Settled now rather than once the child is confirmed dead: SIGKILL
            // does not reach a task in an uninterruptible kernel wait either.
            settle({
              stdout: "",
              stderr: `${cmd} timed out after ${timeoutMs}ms`,
              code: TIMED_OUT_EXIT_CODE,
            })
          }, timeoutMs)
        }
      })
    },
  }
}

export const execFileRunner = createExecFileRunner()
