import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { CreateRunRequest, RegimeMode, RunView } from "@spindoctor/shared"
import type { Db } from "../../db/client"
import { getRun, listRuns } from "../../db/repositories"
import type { RunRow, StageRow } from "../../db/repositories"
import { stageResults } from "../../db/schema"
import type { DeviceApi } from "../../device/deviceApi"
import { DriveNotFoundError, RunInProgressError, SafetyError, type TestEngine } from "../../engine/engine"

export interface RunsRouteDeps {
  db: Db
  deviceApi: DeviceApi
  engine: TestEngine
}

function toRunView(row: RunRow): RunView {
  const regime = row.regime as { mode: RegimeMode }
  return {
    id: row.id,
    driveSerial: row.driveSerial,
    mode: regime.mode,
    status: row.status as RunView["status"],
    verdict: (row.verdict as RunView["verdict"]) ?? null,
    reasons: (row.reasons as RunView["reasons"]) ?? [],
    currentStage: (row.currentStage as RunView["currentStage"]) ?? null,
    restartCount: row.restartCount,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  }
}

/** All persisted stage rows for a run, oldest first. */
function listStageRows(db: Db, runId: number): StageRow[] {
  return db.select().from(stageResults).where(eq(stageResults.runId, runId)).orderBy(stageResults.id).all()
}

export function runsRoutes(deps: RunsRouteDeps): FastifyPluginAsync {
  const { db, engine } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.post(
      "/runs",
      async (request: FastifyRequest<{ Body: Partial<CreateRunRequest> }>, reply) => {
        const { serial, mode, confirm } = request.body ?? {}

        if (typeof serial !== "string" || serial.length === 0 || (mode !== "destructive" && mode !== "read-only")) {
          reply.code(400)
          return {
            error: 'serial (non-empty string) and mode ("destructive"|"read-only") are required',
            code: "BAD_REQUEST",
          }
        }

        if (mode === "destructive" && confirm !== serial) {
          reply.code(400)
          return { error: "confirmation required: type the drive serial", code: "CONFIRM_REQUIRED" }
        }

        try {
          const runId = await engine.startRun({ serial, mode })
          reply.code(201)
          return { runId }
        } catch (err) {
          if (err instanceof SafetyError) {
            reply.code(403)
            return { error: err.message, code: err.code }
          }
          if (err instanceof RunInProgressError) {
            reply.code(409)
            return { error: err.message, code: "RUN_IN_PROGRESS" }
          }
          if (err instanceof DriveNotFoundError) {
            reply.code(404)
            return { error: err.message, code: "DRIVE_NOT_FOUND" }
          }
          throw err
        }
      },
    )

    fastify.get(
      "/runs",
      async (request: FastifyRequest<{ Querystring: { serial?: string } }>): Promise<RunView[]> => {
        const { serial } = request.query
        return listRuns(db, serial ? { driveSerial: serial } : undefined).map(toRunView)
      },
    )

    fastify.get(
      "/runs/:id",
      async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const id = Number(request.params.id)
        const row = Number.isFinite(id) ? getRun(db, id) : undefined
        if (!row) {
          reply.code(404)
          return { error: `no run found with id "${request.params.id}"` }
        }
        return { run: toRunView(row), stages: listStageRows(db, id) }
      },
    )

    fastify.post(
      "/runs/:id/abort",
      async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const id = Number(request.params.id)
        const row = Number.isFinite(id) ? getRun(db, id) : undefined
        if (!row) {
          reply.code(404)
          return { error: `no run found with id "${request.params.id}"` }
        }
        engine.abortRun(id)
        reply.code(202)
        return { ok: true }
      },
    )
  }
}
