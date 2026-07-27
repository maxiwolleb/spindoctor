import { describe, it, expect, afterEach } from "vitest"
import { createLogger, silentLogger } from "./logger"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("createLogger", () => {
  it("defaults to info", () => {
    delete process.env.LOG_LEVEL
    expect(createLogger().level).toBe("info")
  })

  it("honours LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "debug"
    expect(createLogger().level).toBe("debug")
  })

  it("falls back to info for a level pino would reject, rather than throwing on boot", () => {
    // A typo in an env var must not stop the daemon from starting.
    process.env.LOG_LEVEL = "chatty"
    expect(createLogger().level).toBe("info")
  })

  it("can be silenced, which is what tests use", () => {
    expect(silentLogger().level).toBe("silent")
  })
})
