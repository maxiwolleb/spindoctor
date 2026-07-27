import fs from "node:fs"
import path from "node:path"
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify"
import fastifyStatic from "@fastify/static"
import type { Db } from "../db/client"
import { silentLogger, type Logger } from "../logger"
import type { DeviceApi } from "../device/deviceApi"
import type { TestEngine } from "../engine/engine"
import { auditRoutes } from "./routes/audit"
import { drivesRoutes } from "./routes/drives"
import { runsRoutes } from "./routes/runs"
import { settingsRoutes } from "./routes/settings"

export interface AppDeps {
  db: Db
  deviceApi: DeviceApi
  engine: TestEngine
  /**
   * Directory containing the built frontend (e.g. `apps/web/dist`). Static
   * serving + the SPA fallback are registered only when this is set AND the
   * directory exists on disk, so tests and pre-web-build checkouts still
   * boot the API cleanly with no static route at all.
   */
  webRoot?: string
  /** Structured logger. Given to Fastify so request/response and its own
   * lifecycle lines share one destination with the engine's. */
  logger?: Logger
}

/** Builds the Fastify instance with all `/api` routes registered. Does not `.listen()`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: (deps.logger ?? silentLogger()) as FastifyBaseLogger,
  })
  void app.register(drivesRoutes(deps), { prefix: "/api" })
  void app.register(runsRoutes(deps), { prefix: "/api" })
  void app.register(settingsRoutes(deps), { prefix: "/api" })
  void app.register(auditRoutes(deps), { prefix: "/api" })

  // Catch-all for any error a route handler doesn't already turn into its own
  // coded JSON body (e.g. an unexpected throw from deviceApi.listDevices()).
  // Without this, Fastify's default handler leaks its own
  // `{statusCode, error, message}` shape instead of this API's uniform
  // `{error, code}` one. Routes that already reply with a coded error
  // (400/403/404/409 — see runs.ts/drives.ts/settings.ts) never throw, so
  // they're untouched by this; this only fires for the truly-uncaught case.
  app.setErrorHandler((err: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = err.statusCode ?? 500
    reply.code(statusCode).send({ error: err.message, code: "INTERNAL" })
  })

  if (deps.webRoot && fs.existsSync(deps.webRoot)) {
    const webRoot = path.resolve(deps.webRoot)
    void app.register(fastifyStatic, { root: webRoot })

    // SPA fallback: any non-/api GET that didn't match a static file (or an
    // API route) gets index.html so client-side routing works on a hard
    // refresh/deep link. API 404s must stay JSON, never fall through to HTML.
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        return reply.sendFile("index.html", webRoot)
      }
      return reply.code(404).send({ error: `route not found: ${request.method} ${request.url}` })
    })
  }

  return app
}
