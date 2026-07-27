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
 * The process-wide logger.
 *
 * JSON on stdout in production — that is what `docker logs` shows and what a log
 * collector can parse. In development it goes through pino-pretty instead, which
 * is a devDependency: the container sets `NODE_ENV=production`, so the pretty
 * transport is never reached there and its absence from the production
 * `node_modules` doesn't matter.
 */
export function createLogger(): Logger {
  const level = levelFromEnv()
  if (process.env.NODE_ENV === "production") return pino({ level })

  try {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
      },
    })
  } catch {
    // pino-pretty missing (e.g. a production install with NODE_ENV unset):
    // plain JSON is a fine fallback and beats crashing on startup.
    return pino({ level })
  }
}

/** A logger that emits nothing — the default for tests and for any caller that
 * would rather not wire one up. */
export function silentLogger(): Logger {
  return pino({ level: "silent" })
}
