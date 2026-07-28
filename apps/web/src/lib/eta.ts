/** Below this percent, extrapolating a total-time estimate from elapsed time
 * is too noisy to be worth showing — a stage at 1% could still be seconds
 * or hours from done, and projecting from that would just be a wild number
 * dressed up as a real estimate. */
const MIN_MEANINGFUL_PROGRESS_PCT = 2

export interface EtaEstimate {
  remainingMs: number
  etaMs: number
}

/**
 * A running stage's remaining time, from the duration the device itself declares
 * for the stage when there is one, and otherwise extrapolated from elapsed time
 * and percent done — `elapsed / (progress / 100)` gives the projected total, and
 * remaining is whatever's left of it. Works generically for any stage that
 * reports `progress` (self-test, surface scan), not one hardcoded kind (#15).
 *
 * `declaredTotalMinutes` wins wherever it's available because extrapolation is
 * unusable for the ATA long self-test (issue #61): the drive reports its
 * remaining percentage in 10% steps and jumps to "90% remaining" within seconds
 * of starting, so `40s / 0.1` announced "~6m left" for a 97-minute routine —
 * wrong by ~15x, and in the direction that invites someone to wait for it. Given
 * the declared total, the remainder is simple subtraction, needs no elapsed time
 * at all, and is right from the first frame.
 *
 * Returns `null` — "can't estimate yet" — when nothing supports an estimate:
 * no/invalid progress, or, on the extrapolation path, no start time, progress
 * still under `MIN_MEANINGFUL_PROGRESS_PCT`, or a start time that isn't actually
 * in the past (clock skew, or a stage that hasn't really started). The caller
 * shows "estimating…" in every one of those cases rather than trying to
 * distinguish them.
 */
export function computeEta(
  startedAtMs: number | null | undefined,
  progress: number | null | undefined,
  nowMs: number,
  declaredTotalMinutes?: number | null,
): EtaEstimate | null {
  if (progress == null || !Number.isFinite(progress)) return null
  const clampedProgress = Math.min(Math.max(progress, 0), 100)

  if (
    declaredTotalMinutes != null &&
    Number.isFinite(declaredTotalMinutes) &&
    declaredTotalMinutes > 0
  ) {
    const remainingMs = declaredTotalMinutes * 60_000 * ((100 - clampedProgress) / 100)
    return { remainingMs, etaMs: nowMs + remainingMs }
  }

  if (startedAtMs == null || !Number.isFinite(startedAtMs)) return null
  if (progress < MIN_MEANINGFUL_PROGRESS_PCT) return null

  const elapsedMs = nowMs - startedAtMs
  if (elapsedMs <= 0) return null

  const totalEstimateMs = elapsedMs / (clampedProgress / 100)
  const remainingMs = Math.max(0, totalEstimateMs - elapsedMs)
  return { remainingMs, etaMs: nowMs + remainingMs }
}

/** "~Xh Ym left" for an hour or more, "~Ym left" under an hour, and "<1m
 * left" once it rounds all the way down to zero — never a bare "~0m left",
 * which would read as "already done" while the stage is still running. */
export function formatRemaining(remainingMs: number): string {
  const totalMinutes = Math.round(Math.max(0, remainingMs) / 60_000)
  if (totalMinutes < 1) return "<1m left"

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `~${hours}h ${minutes}m left` : `~${minutes}m left`
}

/** Wall-clock completion estimate as "≈ HH:MM", always 24-hour local time.
 * Deliberately hand-formatted rather than `toLocaleTimeString` so it renders
 * identically regardless of the browser's locale (and stays deterministic
 * in tests). */
export function formatEtaClock(etaMs: number): string {
  const d = new Date(etaMs)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  return `≈ ${hh}:${mm}`
}
