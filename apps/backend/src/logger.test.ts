import { describe, it, expect, afterEach } from "vitest"
import { createLogger, logFormat, silentLogger } from "./logger"

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

describe("logFormat", () => {
  it("defaults to pretty, so `docker logs` is readable by a person", () => {
    delete process.env.LOG_FORMAT
    expect(logFormat()).toBe("pretty")
  })

  it("switches to JSON when asked, for log shipping", () => {
    process.env.LOG_FORMAT = "json"
    expect(logFormat()).toBe("json")
  })

  it("falls back to pretty for an unrecognized value rather than refusing to boot", () => {
    process.env.LOG_FORMAT = "rainbows"
    expect(logFormat()).toBe("pretty")
  })

  it("builds a working logger in either format", () => {
    process.env.LOG_FORMAT = "json"
    expect(createLogger().level).toBe("info")
    process.env.LOG_FORMAT = "pretty"
    expect(createLogger().level).toBe("info")
  })
})
