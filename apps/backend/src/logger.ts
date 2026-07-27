import pino, { type Logger } from "pino"

export type { Logger }

/** Levels pino accepts. A typo in `LOG_LEVEL` must not stop the daemon from
 * booting, so anything else falls back to `info`. */
const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const

function levelFromEnv(): string {
  const level = process.env.LOG_LEVEL
  return level && (LEVELS as readonly string[]).includes(level) ? level : "info"
}

/**
 * Whether to render human-readable colored lines or newline-delimited JSON.
 *
 * Pretty is the default, including in the container: spindoctor is a
 * self-hosted tool whose logs are read by a person running `docker logs`, not
 * usually by a collector. `LOG_FORMAT=json` switches to JSON for anyone shipping
 * them to Loki/ELK, and any unrecognized value falls back to pretty rather than
 * failing to boot.
 */
export function logFormat(): "pretty" | "json" {
  return process.env.LOG_FORMAT === "json" ? "json" : "pretty"
}

/**
 * The process-wide logger.
 *
 * `colorize` is forced on: `docker logs` is not a TTY, so pino-pretty would
 * otherwise strip the colors exactly where they were wanted. Docker passes ANSI
 * escapes through untouched. `singleLine` keeps one event per line so structured
 * context (`runId`, `driveSerial`, `stage`) stays easy to grep instead of being
 * pretty-printed across several lines.
 */
export function createLogger(): Logger {
  const level = levelFromEnv()
  if (logFormat() === "json") return pino({ level })

  try {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          translateTime: "yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
    })
  } catch {
    // pino-pretty unavailable for any reason: plain JSON beats crashing on boot.
    return pino({ level })
  }
}

/** A logger that emits nothing — the default for tests and for any caller that
 * would rather not wire one up. */
export function silentLogger(): Logger {
  return pino({ level: "silent" })
}
