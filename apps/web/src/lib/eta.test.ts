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
