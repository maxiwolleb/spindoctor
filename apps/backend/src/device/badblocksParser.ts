/**
 * Parse badblocks command output and extract progress/results.
 */

/**
 * Extract the last percentage-done value from badblocks progress output.
 * badblocks prints progress lines like: `\r  12.50% done, 0:03 elapsed. (0/0/0 errors)`
 *
 * @param chunk - A string chunk from badblocks stderr
 * @returns The percentage as a number, or null if no match found
 */
export function parseBadblocksPercent(chunk: string): number | null {
  const regex = /([\d.]+)%\s*done/g
  let lastMatch: RegExpExecArray | null = null
  let match: RegExpExecArray | null

  while ((match = regex.exec(chunk)) !== null) {
    lastMatch = match
  }

  if (lastMatch === null) {
    return null
  }

  const percentStr = lastMatch[1]
  if (percentStr === undefined) {
    return null
  }

  return parseFloat(percentStr)
}

/**
 * How many 0-100% progress phases badblocks runs for a mode. `-w` (destructive)
 * writes and then verifies each of its four default patterns
 * (0xaa/0x55/0xff/0x00) — eight phases in all — so its progress percentage
 * resets to ~0 eight times over one run. `-n` (non-destructive) does a single
 * pass. badblocks only ever reports the *current phase's* percent, so this is
 * what a caller needs to turn that into one overall figure.
 */
export function badblocksPhaseCount(mode: "write" | "read-only"): number {
  return mode === "write" ? 8 : 1
}

/** A backward jump this large in the per-phase percent only happens at a phase
 * boundary — within a phase badblocks' percentage climbs monotonically, so an
 * ordinary update never drops by anywhere near this much. */
const PHASE_RESET_DROP_PCT = 25

/**
 * Turns badblocks' per-phase 0-100% into a monotonic 0-100% across the whole
 * surface stage. Without this, a destructive run's reported progress cycles
 * 0→100 eight times (once per phase) — the bar appears to run backwards and
 * any ETA built on it is meaningless.
 *
 * Feed each per-phase percent from `parseBadblocksPercent`; a large backward
 * jump is read as "a new phase started". The completed-phase count is capped
 * at `totalPhases - 1` so a stray reset can never push the overall past 100%.
 */
export class BadblocksProgressTracker {
  #completedPhases = 0
  #lastPercent: number | null = null

  constructor(private readonly totalPhases: number) {}

  update(phasePercent: number): number {
    if (this.#lastPercent !== null && phasePercent < this.#lastPercent - PHASE_RESET_DROP_PCT) {
      this.#completedPhases = Math.min(this.#completedPhases + 1, this.totalPhases - 1)
    }
    this.#lastPercent = phasePercent

    const clamped = Math.max(0, Math.min(100, phasePercent))
    const overall = ((this.#completedPhases + clamped / 100) / this.totalPhases) * 100
    return Math.max(0, Math.min(100, overall))
  }
}

/**
 * Count non-empty lines in badblocks output.
 * badblocks `-o` logfile lists one bad LBA per line.
 *
 * @param logContent - The full content of the badblocks logfile
 * @returns The number of non-empty lines (trimmed)
 */
export function countBadBlocks(logContent: string): number {
  return logContent.split("\n").filter((line) => line.trim() !== "").length
}

/**
 * Combines the raw pieces captured from a `badblocks` run into one plain-text
 * log suitable for persisting/displaying — its stdout, its stderr (progress
 * output), and its `-o` bad-block logfile, each in its own labelled section
 * so the sections stay distinguishable once concatenated.
 */
export function formatSurfaceLog(input: {
  stdout: string
  stderr: string
  badBlocksLog: string
}): string {
  const section = (label: string, content: string): string =>
    `=== ${label} ===\n${content.trim().length > 0 ? content : "(empty)"}`

  return [
    section("badblocks stdout", input.stdout),
    section("badblocks stderr (progress)", input.stderr),
    section("bad-block logfile", input.badBlocksLog),
  ].join("\n\n")
}
