import { describe, it, expect } from "vitest"
import { parseBadblocksPercent, countBadBlocks, formatSurfaceLog } from "./badblocksParser"

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
