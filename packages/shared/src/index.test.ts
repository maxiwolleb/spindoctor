import { describe, it, expect } from "vitest"
import { SPINDOCTOR } from "./index"

describe("scaffold", () => {
  it("exposes the package sentinel", () => {
    expect(SPINDOCTOR).toBe("spindoctor")
  })
})
