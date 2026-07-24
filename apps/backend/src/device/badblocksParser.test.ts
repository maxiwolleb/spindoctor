import { describe, it, expect } from "vitest"
import { parseBadblocksPercent, countBadBlocks } from "./badblocksParser"

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
