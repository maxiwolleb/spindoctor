import { readFile } from "node:fs/promises"
import type { CommandRunner } from "../device/runner"

/**
 * The versions of the CLI tools a run actually used, plus the kernel it ran on.
 *
 * Recorded per run unconditionally, outside the diagnostics flag: it is a couple
 * of hundred bytes of provenance about our own correctness rather than data about
 * the operator's drives. It exists because its absence hid a real defect — a
 * capability probe was written against a `smartctl` 7.5 JSON field and shipped
 * against an image carrying 7.3, where the field does not exist, so the probe
 * could never fire and every test still passed. A recorded version would have made
 * that visible immediately.
 */
export interface RunEnvironment {
  /** e.g. "7.4" — the first two components of smartctl's reported version. */
  smartctlVersion: string | null
  /** The e2fsprogs version, which is badblocks' version — see `probeEnvironment`. */
  e2fsprogsVersion: string | null
  kernel: string | null
}

/** Pulls "7.4" out of `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] ...`. */
function parseSmartctlVersion(stdout: string): string | null {
  return /^smartctl\s+(\d+\.\d+)/m.exec(stdout)?.[1] ?? null
}

/** Pulls "1.47.0" out of `dumpe2fs 1.47.0 (5-Feb-2023)`. */
function parseE2fsprogsVersion(output: string): string | null {
  return /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(output)?.[1] ?? null
}

/**
 * Probes the environment. Every field is independently nullable and every failure
 * is swallowed: this is diagnostic metadata, and a missing version must never be
 * the reason a drive test refuses to start.
 */
export async function probeEnvironment(runner: CommandRunner): Promise<RunEnvironment> {
  const smartctlVersion = await safely(async () => {
    const { stdout } = await runner.run("smartctl", ["--version"])
    return parseSmartctlVersion(stdout)
  })

  // Asked of `dumpe2fs`, not `badblocks`, which has no version flag at all — it
  // answers `-V` with "invalid option" and a usage block carrying no version.
  // Both ship in e2fsprogs and are versioned together, so dumpe2fs's answer is
  // badblocks' version. It prints to stderr.
  const e2fsprogsVersion = await safely(async () => {
    const { stdout, stderr } = await runner.run("dumpe2fs", ["-V"])
    return parseE2fsprogsVersion(`${stdout}\n${stderr}`)
  })

  const kernel = await safely(async () => {
    const release = await readFile("/proc/sys/kernel/osrelease", "utf8")
    return release.trim() || null
  })

  return { smartctlVersion, e2fsprogsVersion, kernel }
}

async function safely<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn()
  } catch {
    return null
  }
}
