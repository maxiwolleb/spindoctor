import { describe, it, expect } from "vitest"
import {
  parseBadblocksPercent,
  countBadBlocks,
  formatSurfaceLog,
  badblocksPhaseCount,
  BadblocksProgressTracker,
} from "./badblocksParser"

describe("parseBadblocksPercent", () => {
  it("extracts a percent from a typical progress line", () => {
    expect(parseBadblocksPercent("\r  12.50% done, 0:03 elapsed. (0/0/0 errors)")).toBe(12.5)
  })
  it("returns the last percent when a chunk has several", () => {
    expect(parseBadblocksPercent("6.25% done\r12.50% done\r18.75% done")).toBe(18.75)
  })
  it("returns null when there is no percent", () => {
    expect(parseBadblocksPercent("Testing with pattern 0xaa:")).toBeNull()
  })
  it("handles an integer percent", () => {
    expect(parseBadblocksPercent("100% done, 1:00 elapsed")).toBe(100)
  })
})

describe("countBadBlocks", () => {
  it("counts non-empty lines", () => {
    expect(countBadBlocks("12345\n12346\n12347\n")).toBe(3)
  })
  it("ignores blank lines and trailing whitespace", () => {
    expect(countBadBlocks("12345\n\n  \n12346\n")).toBe(2)
  })
  it("returns 0 for empty output", () => {
    expect(countBadBlocks("")).toBe(0)
  })
})

describe("formatSurfaceLog", () => {
  it("labels each section and includes the given content verbatim", () => {
    const log = formatSurfaceLog({
      stdout: "checking devices\n",
      stderr: "  50.00% done, 0:05 elapsed. (0/0/0 errors)",
      badBlocksLog: "12345\n67890\n",
    })

    expect(log).toContain("=== badblocks stdout ===")
    expect(log).toContain("checking devices")
    expect(log).toContain("=== badblocks stderr (progress) ===")
    expect(log).toContain("50.00% done")
    expect(log).toContain("=== bad-block logfile ===")
    expect(log).toContain("12345\n67890")

    // stdout section comes first, stderr second, logfile last.
    expect(log.indexOf("stdout")).toBeLessThan(log.indexOf("stderr"))
    expect(log.indexOf("stderr")).toBeLessThan(log.indexOf("bad-block logfile"))
  })

  it("shows a placeholder for an empty section instead of leaving it blank", () => {
    const log = formatSurfaceLog({ stdout: "", stderr: "   \n", badBlocksLog: "" })

    expect(log).toContain("=== badblocks stdout ===\n(empty)")
    expect(log).toContain("=== badblocks stderr (progress) ===\n(empty)")
    expect(log).toContain("=== bad-block logfile ===\n(empty)")
  })
})

describe("badblocksPhaseCount", () => {
  it("is 8 for a destructive -w run (4 patterns, each written then verified)", () => {
    expect(badblocksPhaseCount("write")).toBe(8)
  })
  it("is 1 for a non-destructive read-only run", () => {
    expect(badblocksPhaseCount("read-only")).toBe(1)
  })
})

describe("BadblocksProgressTracker", () => {
  it("passes a single-phase (read-only) percent straight through", () => {
    const t = new BadblocksProgressTracker(1)
    expect(t.update(0)).toBe(0)
    expect(t.update(37.5)).toBeCloseTo(37.5)
    expect(t.update(100)).toBe(100)
  })

  it("maps an 8-phase destructive run onto a monotonic 0-100% — a per-phase reset advances one phase", () => {
    const t = new BadblocksProgressTracker(8)
    // phase 1: 0 -> 100 maps to 0 -> 12.5
    expect(t.update(0)).toBeCloseTo(0)
    expect(t.update(50)).toBeCloseTo(6.25)
    expect(t.update(100)).toBeCloseTo(12.5)
    // phase 2 starts: the percent resets to ~0, overall holds at 12.5 then climbs to 25
    expect(t.update(0)).toBeCloseTo(12.5)
    expect(t.update(100)).toBeCloseTo(25)
    // phases 3..8: each reset advances another 12.5, finishing at 100
    for (let phase = 3; phase <= 8; phase++) {
      t.update(0)
      expect(t.update(100)).toBeCloseTo(phase * 12.5)
    }
  })

  it("never runs backwards across a full destructive run's percent stream", () => {
    const t = new BadblocksProgressTracker(8)
    let prev = -1
    for (let phase = 0; phase < 8; phase++) {
      for (const p of [0, 20, 40, 60, 80, 100]) {
        const overall = t.update(p)
        expect(overall).toBeGreaterThanOrEqual(prev)
        expect(overall).toBeLessThanOrEqual(100)
        prev = overall
      }
    }
    expect(prev).toBeCloseTo(100)
  })

  it("caps the phase count so a stray reset past the last phase can't exceed 100%", () => {
    const t = new BadblocksProgressTracker(8)
    for (let phase = 0; phase < 8; phase++) {
      t.update(0)
      t.update(100)
    }
    expect(t.update(0)).toBeLessThanOrEqual(100)
    expect(t.update(100)).toBe(100)
  })
})
