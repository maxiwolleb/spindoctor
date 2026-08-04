import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { FastifyInstance } from "fastify"
import { createDb, type Db } from "./db/client"
import { ensureConfig } from "./db/repositories"
import { RealDeviceApi } from "./device/realDeviceApi"
import { execFileRunner } from "./device/runner"
import type { DeviceApi } from "./device/deviceApi"
import { TestEngine } from "./engine/engine"
import { AutoModePoller } from "./engine/autoMode"
import { buildApp } from "./api/app"
import { attachRealtime, type Realtime } from "./api/realtime"
import { createLogger, type Logger } from "./logger"

/** Built frontend location once `apps/web` is built (Phase 5): resolved
 * relative to this module so it works regardless of the process's cwd. Only
 * ever used if the directory actually exists on disk (see `buildApp`). */
const defaultWebRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "web",
  "dist",
)

export interface CreateServerOverrides {
  dbPath?: string
  port?: number
  host?: string
  webRoot?: string
  deviceApi?: DeviceApi
  /** Overridden in tests to keep output quiet; production builds a real one. */
  logger?: Logger
}

export interface Server {
  app: FastifyInstance
  db: Db
  engine: TestEngine
  deviceApi: DeviceApi
  poller: AutoModePoller
  /** Socket.IO server pushing live run state to the UI, attached to `app.server`. */
  realtime: Realtime
  /** Reconciles interrupted runs, starts the auto-mode poller, then binds the port. */
  start(): Promise<void>
  /** Stops the poller, closes the HTTP server, then closes the sqlite handle. */
  stop(): Promise<void>
}

/**
 * Composes the whole backend from env (or `overrides`, for tests) without
 * binding a port — that only happens in `start()`. Kept separate from the
 * top-level entry guard below so tests can construct + inject against the
 * app, or call `engine.reconcile()` directly, without ever opening a socket.
 */
export function createServer(overrides: CreateServerOverrides = {}): Server {
  const dbPath = overrides.dbPath ?? process.env.SPINDOCTOR_DB ?? "./data/spindoctor.sqlite"
  const port = overrides.port ?? Number(process.env.PORT ?? 8080)
  const host = overrides.host ?? process.env.HOST ?? "0.0.0.0"
  const webRoot = overrides.webRoot ?? process.env.SPINDOCTOR_WEB_ROOT ?? defaultWebRoot

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }

  const { db, sqlite } = createDb(dbPath)
  ensureConfig(db)

  const logger = overrides.logger ?? createLogger()
  // The closure below refers to `engine`, declared just after this: the device
  // API is built first, but its claim probe has to skip drives the engine is
  // already testing. Safe because it is only ever called from `listDevices`,
  // long after both exist.
  // Both annotated explicitly: the closure's reference to `engine` would
  // otherwise be a circular inference TypeScript can't resolve.
  const deviceApi: DeviceApi =
    overrides.deviceApi ??
    new RealDeviceApi(execFileRunner, {
      logger,
      isDriveUnderTest: (serial: string): boolean => engine.isDriveActive(serial),
    })
  const engine: TestEngine = new TestEngine({ db, deviceApi, logger })
  // Recorded in a diagnostics bundle so a finding can be tied to the code that
  // produced it. Set at deploy time; null when nobody bothered, which is fine.
  const spindoctorVersion = process.env.SPINDOCTOR_VERSION ?? null
  const app = buildApp({ db, deviceApi, engine, webRoot, logger, spindoctorVersion })
  // Attached to Fastify's raw server: Socket.IO handles only its own path and
  // delegates every other request back, so the REST routes and the SPA
  // fallback are unaffected. Safe before `listen()` — it only adds listeners.
  const realtime = attachRealtime({ httpServer: app.server, db, engine })
  const poller = new AutoModePoller({ db, deviceApi, engine, logger })

  async function start(): Promise<void> {
    await engine.reconcile()
    poller.start()
    await app.listen({ port, host })
    logger.info({ port, host, dbPath, webRoot }, "spindoctor started")
  }

  async function stop(): Promise<void> {
    // Await the poller before closing the app/db: it awaits any in-flight
    // poll cycle, so we can't close the sqlite handle out from under a poll
    // that's still mid-DB-call.
    await poller.stop()
    // Before app.close(): this drops the engine listeners and disconnects any
    // client still attached, so nothing tries to read the DB (snapshot replay)
    // after the sqlite handle below is gone.
    await realtime.close()
    await app.close()
    sqlite.close()
  }

  return { app, db, engine, deviceApi, poller, realtime, start, stop }
}

function isEntryModule(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isEntryModule()) {
  // Last-resort backstop: a stray unhandled rejection anywhere in the
  // process (not just the auto-mode loop, which already guards itself)
  // logs instead of taking the whole daemon down. Installed only here, not
  // at module top-level, so importing this module in tests never touches
  // global process listeners.
  const entryLogger = createLogger()
  process.on("unhandledRejection", (err: unknown) => {
    entryLogger.error({ err }, "unhandled rejection")
  })

  const server = createServer({ logger: entryLogger })

  server.start().catch((err: unknown) => {
    entryLogger.fatal({ err }, "failed to start")
    process.exit(1)
  })

  let shuttingDown = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    entryLogger.info({ signal }, "shutting down")
    server
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        entryLogger.error({ err }, "error during shutdown")
        process.exit(1)
      })
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
