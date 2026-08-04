import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_THRESHOLDS, STAGE_NAMES, resolveThresholds } from "./index"

const __dirname = dirname(fileURLToPath(import.meta.url))

describe("shared constants", () => {
  it("exposes strict default thresholds", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      reallocatedWarnMax: 4,
      commandTimeoutWarnMax: 100,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    })
  })

  it("lists the default regime stage names in order", () => {
    expect(STAGE_NAMES).toEqual([
      "SMART_BEFORE",
      "SELFTEST_LONG",
      "SURFACE",
      "SMART_AFTER",
      "VERDICT",
    ])
  })
})

// Issue #54: thresholds are a stored JSON blob, so an install predating a
// threshold has an object without that key — and comparing a counter against
// `undefined` is silently false for every drive.
describe("resolveThresholds", () => {
  it("fills in a threshold a stored config predates", () => {
    const stored = {
      reallocatedWarnMax: 10,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    }
    expect(resolveThresholds(stored)).toEqual({
      reallocatedWarnMax: 10,
      commandTimeoutWarnMax: DEFAULT_THRESHOLDS.commandTimeoutWarnMax,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    })
  })

  // A value someone may have tuned is never overwritten by a later change to
  // the default — that install keeps 10 until it's changed in Settings.
  it("keeps a stored value that differs from the current default", () => {
    expect(resolveThresholds({ reallocatedWarnMax: 10 }).reallocatedWarnMax).toBe(10)
    expect(DEFAULT_THRESHOLDS.reallocatedWarnMax).toBe(4)
  })

  it("falls back to every default for junk input", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(resolveThresholds(junk)).toEqual(DEFAULT_THRESHOLDS)
    }
  })

  it("ignores non-finite stored values rather than grading against NaN", () => {
    const resolved = resolveThresholds({
      reallocatedWarnMax: Number.NaN,
      ssdPercentageUsedWarn: "80",
    })
    expect(resolved.reallocatedWarnMax).toBe(DEFAULT_THRESHOLDS.reallocatedWarnMax)
    expect(resolved.ssdPercentageUsedWarn).toBe(DEFAULT_THRESHOLDS.ssdPercentageUsedWarn)
  })
})

// Issue #89: the README said the reallocated-sector default was 10 long after it
// became 4, so it documented a WARN band 2.5x wider than the shipped one. The
// docs are the only place an operator sees these numbers before running anything,
// so the published boundary is pinned to the constant rather than trusted to be
// updated by hand.
describe("the documented thresholds match the shipped ones", () => {
  const repoRoot = join(__dirname, "..", "..", "..")
  const docs = [
    { file: "README.md", path: join(repoRoot, "README.md") },
    {
      file: "website/guide/how-it-works.md",
      path: join(repoRoot, "website", "guide", "how-it-works.md"),
    },
  ]

  /** Whole file as one line, so a phrase wrapped across lines still matches. */
  const flatten = (path: string): string => readFileSync(path, "utf8").replace(/\s+/g, " ")

  it.each(docs)("$file quotes the current reallocatedWarnMax", ({ path }) => {
    const text = flatten(path)
    // Only sentences that both name the threshold and quote a number: a doc may
    // also mention it in prose ("configurable in Settings") with no figures.
    const sentences = text
      .split(". ")
      .filter((s) => s.includes("reallocatedWarnMax") && /`\d+`/.test(s))
    expect(sentences.length).toBeGreaterThan(0)

    const max = DEFAULT_THRESHOLDS.reallocatedWarnMax
    for (const sentence of sentences) {
      const numbers = [...sentence.matchAll(/`(\d+)`/g)].map((m) => Number(m[1]))
      // The current value has to appear — a doc still quoting the old, larger
      // default (the #89 bug) fails here.
      expect(numbers).toContain(max)
      // And nothing above it may: `1`-`4` and "above `4`" are all edges of the
      // same band, so a stale wider band shows up as a number past the max.
      // Together these catch drift in either direction.
      for (const n of numbers) expect(n).toBeLessThanOrEqual(max)
    }
  })

  it.each(docs)("$file documents the spin-retry and command-timeout rules", ({ path }) => {
    const text = flatten(path).toLowerCase()
    // Both were missing from the README's list, one of them a FAIL.
    expect(text).toContain("spin retries")
    expect(text).toContain("command timeout")
  })
})
