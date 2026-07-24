import { describe, it, expect } from "vitest"
import { execFileRunner } from "./runner"

describe("execFileRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await execFileRunner.run(process.execPath, ["-e", "process.stdout.write('hi')"])
    expect(r.stdout).toBe("hi")
    expect(r.code).toBe(0)
  })
  it("reports a non-zero exit code without throwing", async () => {
    const r = await execFileRunner.run(process.execPath, ["-e", "process.exit(3)"])
    expect(r.code).toBe(3)
  })
})
