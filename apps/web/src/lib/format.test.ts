import { describe, expect, it } from "vitest"
import type { Verdict } from "@spindoctor/shared"
import { humanBytes, modeLabel, runStatusColor, stageLabel, stageStatusLabel, verdictColor, verdictLabel } from "./format"

describe("humanBytes", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [999, "999 B"],
    [1000, "1.0 KB"],
    [1500, "1.5 KB"],
    [999_000, "999.0 KB"],
    [1_000_000, "1.0 MB"],
    [1_500_000, "1.5 MB"],
    [1_000_000_000, "1.0 GB"],
    [1_000_000_000_000, "1.0 TB"],
    [4_000_787_030_016, "4.0 TB"],
  ]

  it.each(cases)("formats %i bytes as %s", (input, expected) => {
    expect(humanBytes(input)).toBe(expected)
  })

  it("clamps negative input to 0 B", () => {
    expect(humanBytes(-5)).toBe("0 B")
  })
})

describe("verdictColor", () => {
  const cases: Array<[Verdict | null, string]> = [
    ["PASS", "success"],
    ["WARN", "warning"],
    ["FAIL", "error"],
    [null, "secondary"],
  ]

  it.each(cases)("maps %s to %s", (verdict, color) => {
    expect(verdictColor(verdict)).toBe(color)
  })
})

describe("verdictLabel", () => {
  const cases: Array<[Verdict | null, string]> = [
    ["PASS", "Pass"],
    ["WARN", "Warn"],
    ["FAIL", "Fail"],
    [null, "—"],
  ]

  it.each(cases)("labels %s as %s", (verdict, label) => {
    expect(verdictLabel(verdict)).toBe(label)
  })
})

describe("stageLabel", () => {
  const cases: Array<[string, string]> = [
    ["SMART_BEFORE", "SMART (before)"],
    ["SELFTEST_LONG", "Self-test"],
    ["SURFACE", "Surface scan"],
    ["SMART_AFTER", "SMART (after)"],
    ["VERDICT", "Verdict"],
    ["SOME_UNKNOWN_STAGE", "SOME_UNKNOWN_STAGE"],
  ]

  it.each(cases)("labels %s as %s", (stage, label) => {
    expect(stageLabel(stage)).toBe(label)
  })
})

describe("modeLabel", () => {
  const cases: Array<[string, string]> = [
    ["destructive", "Full destructive test"],
    ["read-only", "Read-only scan"],
    ["something-else", "something-else"],
  ]

  it.each(cases)("labels %s as %s", (mode, label) => {
    expect(modeLabel(mode)).toBe(label)
  })
})

describe("runStatusColor", () => {
  const cases: Array<[string, string]> = [
    ["PENDING", "secondary"],
    ["RUNNING", "primary"],
    ["DONE", "success"],
    ["FAILED", "error"],
    ["ABORTED", "warning"],
    ["SOMETHING_ELSE", "secondary"],
  ]

  it.each(cases)("maps %s to %s", (status, color) => {
    expect(runStatusColor(status)).toBe(color)
  })
})

describe("stageStatusLabel", () => {
  const cases: Array<[string, string]> = [
    ["PENDING", "Pending"],
    ["RUNNING", "Running"],
    ["DONE", "Done"],
    ["FAILED", "Failed"],
    ["ABORTED", "Aborted"],
    ["INTERRUPTED", "Interrupted"],
    ["SOME_UNKNOWN_STATUS", "SOME_UNKNOWN_STATUS"],
  ]

  it.each(cases)("labels %s as %s", (status, label) => {
    expect(stageStatusLabel(status)).toBe(label)
  })
})
