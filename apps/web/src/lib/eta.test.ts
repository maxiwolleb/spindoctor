import { describe, expect, it } from "vitest"
import { computeEta, formatEtaClock, formatRemaining } from "./eta"

describe("computeEta", () => {
  it("extrapolates remaining/eta from elapsed time and percent done", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z") // 1h elapsed

    // 50% done in 1h -> 1h total -> 1h remaining -> eta at 11:00
    const result = computeEta(startedAtMs, 50, nowMs)
    expect(result).toEqual({
      remainingMs: 60 * 60 * 1000,
      etaMs: Date.parse("2026-07-25T11:00:00.000Z"),
    })
  })

  it("handles a stage nearly done", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z") // 1h elapsed

    // 90% done in 1h -> total = 1h / 0.9 = 1h06m40s -> 6m40s remaining
    const result = computeEta(startedAtMs, 90, nowMs)
    expect(result?.remainingMs).toBeCloseTo(400_000, -2)
  })

  it("returns null when progress is too low to be meaningful (< 2%)", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z")

    expect(computeEta(startedAtMs, 0, nowMs)).toBeNull()
    expect(computeEta(startedAtMs, 1, nowMs)).toBeNull()
    expect(computeEta(startedAtMs, 1.9, nowMs)).toBeNull()
  })

  it("treats exactly the 2% threshold as meaningful", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z")

    expect(computeEta(startedAtMs, 2, nowMs)).not.toBeNull()
  })

  it("returns null when startedAt is missing", () => {
    expect(computeEta(null, 50, Date.now())).toBeNull()
    expect(computeEta(undefined, 50, Date.now())).toBeNull()
  })

  it("returns null when progress is missing or not a finite number", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z")

    expect(computeEta(startedAtMs, null, nowMs)).toBeNull()
    expect(computeEta(startedAtMs, undefined, nowMs)).toBeNull()
    expect(computeEta(startedAtMs, Number.NaN, nowMs)).toBeNull()
  })

  it("returns null when startedAt is not actually in the past (clock skew / not started)", () => {
    const startedAtMs = Date.parse("2026-07-25T10:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T09:00:00.000Z") // now is before startedAt

    expect(computeEta(startedAtMs, 50, nowMs)).toBeNull()
  })

  it("clamps progress over 100 instead of producing a negative remaining", () => {
    const startedAtMs = Date.parse("2026-07-25T09:00:00.000Z")
    const nowMs = Date.parse("2026-07-25T10:00:00.000Z")

    const result = computeEta(startedAtMs, 150, nowMs)
    expect(result?.remainingMs).toBe(0)
  })
})

describe("computeEta with a duration the device declares (#61)", () => {
  const nowMs = Date.parse("2026-07-25T10:00:00.000Z")

  // The reported bug: an ATA drive jumps to "90% remaining" seconds in, so
  // extrapolating 40s / 0.1 claimed ~6 minutes for a 97-minute routine.
  it("uses the declared total instead of extrapolating from a 10%-granular counter", () => {
    const startedAtMs = nowMs - 40_000

    const extrapolated = computeEta(startedAtMs, 10, nowMs)
    expect(extrapolated?.remainingMs).toBeCloseTo(360_000, -3) // ~6m — the wrong answer

    const declared = computeEta(startedAtMs, 10, nowMs, 97)
    // 97 min x 90% still to go = 87.3 min, and the ETA clock agrees.
    expect(declared?.remainingMs).toBeCloseTo(87.3 * 60_000, -2)
    expect(declared?.etaMs).toBe(nowMs + 87.3 * 60_000)
  })

  // The whole figure is available before the drive has reported any progress at
  // all, so the extrapolation floor doesn't apply — "~1h 37m left" from the
  // first frame beats "estimating…" followed by a wild number.
  it("estimates from 0% too, where extrapolation has nothing to work with", () => {
    expect(computeEta(nowMs - 5_000, 0, nowMs, 97)?.remainingMs).toBe(97 * 60_000)
    expect(computeEta(nowMs - 5_000, 0, nowMs)).toBeNull()
  })

  it("needs no elapsed time: the figure is the drive's, not an extrapolation", () => {
    expect(computeEta(null, 50, nowMs, 90)?.remainingMs).toBe(45 * 60_000)
    expect(computeEta(nowMs + 60_000, 50, nowMs, 90)?.remainingMs).toBe(45 * 60_000)
  })

  it("falls back to extrapolation when the drive declares nothing usable", () => {
    const startedAtMs = nowMs - 60 * 60_000 // 1h elapsed, 50% done -> 1h left
    for (const declared of [null, undefined, 0, -97, Number.NaN]) {
      expect(computeEta(startedAtMs, 50, nowMs, declared)?.remainingMs).toBe(60 * 60_000)
    }
  })

  it("still returns null without a progress figure to subtract from the total", () => {
    expect(computeEta(nowMs - 60_000, null, nowMs, 97)).toBeNull()
  })

  it("clamps progress outside 0..100 rather than over/under-reporting the remainder", () => {
    expect(computeEta(nowMs - 60_000, 150, nowMs, 97)?.remainingMs).toBe(0)
    expect(computeEta(nowMs - 60_000, -20, nowMs, 97)?.remainingMs).toBe(97 * 60_000)
  })
})

describe("formatRemaining", () => {
  const cases: Array<[number, string]> = [
    [0, "<1m left"],
    [20_000, "<1m left"],
    [30_000, "~1m left"], // rounds half up
    [60_000, "~1m left"],
    [5 * 60_000, "~5m left"],
    [59 * 60_000, "~59m left"],
    [60 * 60_000, "~1h 0m left"],
    [125 * 60_000, "~2h 5m left"],
  ]

  it.each(cases)("formats %ims remaining as %s", (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected)
  })

  it("never shows a negative duration", () => {
    expect(formatRemaining(-5000)).toBe("<1m left")
  })
})

describe("formatEtaClock", () => {
  it("formats a timestamp as a 24-hour ≈ HH:MM clock", () => {
    const d = new Date()
    d.setHours(3, 10, 0, 0)
    expect(formatEtaClock(d.getTime())).toBe("≈ 03:10")
  })

  it("pads single-digit hours and minutes", () => {
    const d = new Date()
    d.setHours(9, 5, 0, 0)
    expect(formatEtaClock(d.getTime())).toBe("≈ 09:05")
  })

  it("handles midday/midnight boundaries", () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    expect(formatEtaClock(d.getTime())).toBe("≈ 00:00")
  })
})
