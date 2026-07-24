import Fastify, { type FastifyInstance } from "fastify"
import type { Db } from "../db/client"
import type { DeviceApi } from "../device/deviceApi"
import type { TestEngine } from "../engine/engine"
import { drivesRoutes } from "./routes/drives"
import { runsRoutes } from "./routes/runs"

export interface AppDeps {
  db: Db
  deviceApi: DeviceApi
  engine: TestEngine
}

/** Builds the Fastify instance with all `/api` routes registered. Does not `.listen()`. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify()
  void app.register(drivesRoutes(deps), { prefix: "/api" })
  void app.register(runsRoutes(deps), { prefix: "/api" })
  return app
}
