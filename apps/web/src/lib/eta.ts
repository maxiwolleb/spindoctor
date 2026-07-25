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
 * Extrapolates a running stage's remaining time from elapsed time and
 * percent done — `elapsed / (progress / 100)` gives the total time the
 * stage is projected to take, and remaining is whatever's left of that.
 * Works generically for any stage that reports `progress` (self-test,
 * surface scan), not just one hardcoded kind (issue #15).
 *
 * Returns `null` — "can't estimate yet" — when there isn't enough signal to
 * extrapolate from: no start time, no/invalid progress, progress still under
 * `MIN_MEANINGFUL_PROGRESS_PCT`, or a start time that isn't actually in the
 * past (clock skew, or a stage that hasn't really started). The caller shows
 * "estimating…" in every one of those cases rather than trying to
 * distinguish them.
 */
export function computeEta(
  startedAtMs: number | null | undefined,
  progress: number | null | undefined,
  nowMs: number,
): EtaEstimate | null {
  if (startedAtMs == null || !Number.isFinite(startedAtMs)) return null
  if (progress == null || !Number.isFinite(progress)) return null
  if (progress < MIN_MEANINGFUL_PROGRESS_PCT) return null

  const elapsedMs = nowMs - startedAtMs
  if (elapsedMs <= 0) return null

  const clampedProgress = Math.min(progress, 100)
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
