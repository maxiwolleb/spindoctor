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
