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
/** A bare progress update, i.e. one that isn't prefixed by a phase header. */
const PROGRESS_LINE = /^(\d+(?:\.\d+)?)% done/

/**
 * Collapses badblocks' in-place progress counter into ordinary lines.
 *
 * badblocks rewrites the counter by emitting an update, then a run of
 * backspaces to rub it out. Captured verbatim that is enormous and unreadable:
 * a real 500 GB `-w` run produced 3.87 MB across 42,990 updates, half of it
 * literally `\x08`, with 120 newlines — effectively one giant line. Since the
 * log is stored inline in the DB and rendered in a `<pre>`, that cost scales
 * with drive size for no benefit.
 *
 * Each backspace run becomes a line break, then consecutive updates within the
 * same whole percent collapse to their first. Phase headers ("Testing with
 * pattern 0x55:", "Reading and comparing:"), the trailing "done", and the final
 * update are always kept — those carry the signal — and each phase starts its
 * own percent sequence, since badblocks restarts the counter per pass.
 */
export function collapseProgressRedraw(stderr: string): string {
  // The control characters are the whole point here: badblocks separates its
  // updates with runs of backspaces (and \r on some builds), so matching them
  // is deliberate, not the accident no-control-regex is guarding against.
  // eslint-disable-next-line no-control-regex
  const segments = stderr.split(/[\x08\r]+/)
  const out: string[] = []
  let lastWholePercent: number | null = null

  segments.forEach((segment, i) => {
    const line = segment.replace(/\s+$/, "")
    if (line.trim().length === 0) return

    const match = PROGRESS_LINE.exec(line.trim())
    if (!match) {
      // A phase header, "done", or anything unexpected: keep it verbatim. A
      // header arrives with the phase's first reading attached ("Testing with
      // pattern 0xaa:   0.00% done, ..."), so seed the counter from it when
      // there is one — otherwise the next bare update repeats the same percent
      // on its own line. Anything else starts the next phase from scratch.
      out.push(line)
      const seeded = /(\d+(?:\.\d+)?)% done/.exec(line)
      lastWholePercent = seeded ? Math.floor(Number(seeded[1])) : null
      return
    }

    const whole = Math.floor(Number(match[1]))
    const isFinal = i === segments.length - 1
    if (lastWholePercent === null || whole !== lastWholePercent || isFinal) {
      out.push(line)
      lastWholePercent = whole
    }
  })

  return out.join("\n")
}

export function formatSurfaceLog(input: {
  stdout: string
  stderr: string
  badBlocksLog: string
}): string {
  const section = (label: string, content: string): string =>
    `=== ${label} ===\n${content.trim().length > 0 ? content : "(empty)"}`

  return [
    section("badblocks stdout", input.stdout),
    section("badblocks stderr (progress)", collapseProgressRedraw(input.stderr)),
    section("bad-block logfile", input.badBlocksLog),
  ].join("\n\n")
}
