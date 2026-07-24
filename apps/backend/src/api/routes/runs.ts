import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { CreateRunRequest, RegimeMode, RunView, StageName, StageView } from "@spindoctor/shared"
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

/** ISO-8601 string for a nullable persisted `Date`, or `null` — never leaks a
 * raw `Date` onto the wire (see `RunView`/`StageView` doc comments). */
function isoOrNull(d: Date | null): string | null {
  return d instanceof Date ? d.toISOString() : d
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
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    createdAt: row.createdAt.toISOString(),
  }
}

function toStageView(row: StageRow): StageView {
  return {
    id: row.id,
    runId: row.runId,
    stage: row.stage as StageName,
    status: row.status,
    progress: row.progress,
    logPath: row.logPath,
    metrics: row.metrics,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  }
}

/** All persisted stage rows for a run, oldest first, mapped to the wire-honest `StageView`. */
function listStageRows(db: Db, runId: number): StageView[] {
  return db
    .select()
    .from(stageResults)
    .where(eq(stageResults.runId, runId))
    .orderBy(stageResults.id)
    .all()
    .map(toStageView)
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
          return { error: `no run found with id "${request.params.id}"`, code: "RUN_NOT_FOUND" }
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
          return { error: `no run found with id "${request.params.id}"`, code: "RUN_NOT_FOUND" }
        }
        engine.abortRun(id)
        reply.code(202)
        return { ok: true }
      },
    )
  }
}
