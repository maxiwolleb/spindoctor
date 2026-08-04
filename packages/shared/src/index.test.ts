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

  /** The part of a doc that states the rules, excluding the reference table of
   * observed failure rates — that table names every attribute regardless of
   * which rules exist, so searching it proves nothing about the rule list. */
  const rulesSection = (text: string): string => {
    // On the heading marker, not the bare phrase: the page also links to that
    // section by name earlier on, and cutting there would drop the rule list
    // itself — which is the half that has to be checked.
    const cut = text.indexOf("## Where the thresholds come from")
    return cut === -1 ? text : text.slice(0, cut)
  }

  /**
   * Every quoted integer stated near a mention of reallocated sectors, in the
   * rules part of the doc.
   *
   * A window per mention rather than one contiguous "section": the docs mention
   * reallocated sectors in passing before stating the rule, and any single
   * start/end pair either cuts the rule off or swallows the next threshold's
   * figures. `> 4`-style edges count too — the docs write those inside the
   * quotes, where a bare /`(\d+)`/ cannot see them.
   */
  const reallocatedFigures = (text: string): number[] => {
    const figures: number[] = []
    for (const match of rulesSection(text).matchAll(/reallocated/gi)) {
      const window = text.slice(match.index, match.index + 260)
      for (const n of window.matchAll(/`\s*(?:>|above|≥|<|up to)?\s*(\d+)\s*`/g)) {
        figures.push(Number(n[1]))
      }
    }
    return figures
  }

  it.each(docs)("$file quotes the current reallocatedWarnMax everywhere", ({ path }) => {
    const text = flatten(path)
    const max = DEFAULT_THRESHOLDS.reallocatedWarnMax

    // Every quoted integer in the whole reallocated-sector discussion, not
    // just the sentence that happens to name the threshold. The first version of
    // this test filtered on sentences containing "reallocatedWarnMax", which in
    // the README is only the trailing parenthetical — so the band itself could
    // still say `1`-`10` / above `10` and the test passed. That is precisely the
    // #89 bug shape, and it survived.
    //
    const quoted = reallocatedFigures(text)

    expect(quoted.length).toBeGreaterThan(0)
    expect(quoted).toContain(max)
    // `0` is the PASS edge and `1` the bottom of the WARN band; nothing else in
    // this discussion may name a figure other than the threshold itself.
    for (const n of quoted) {
      if (n === 0 || n === 1) continue
      expect(n).toBe(max)
    }
  })

  it.each(docs)("$file documents the spin-retry and command-timeout RULES", ({ path }) => {
    // Deliberately not a bare substring search over the whole file: both phrases
    // also appear in how-it-works.md's observed-failure-rate table, so grepping
    // the file passed even with both rule bullets deleted. Only the text before
    // that table counts, and the assertion names the verdict each rule produces.
    const text = rulesSection(flatten(path)).toLowerCase()

    expect(text).toMatch(/spin retries[^.]*fail/)
    expect(text).toMatch(/command timeout\w*[^.]*warn/)
  })
})
