import { execFile } from "node:child_process"

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }>
}

export const execFileRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { timeout: opts?.timeoutMs ?? 0, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? 1
                : 0
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code })
        },
      )
    })
  },
}
