import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import { resolveThresholds } from "@spindoctor/shared"
import type {
  CreateRunRequest,
  RegimeMode,
  RunView,
  SmartAttributeRow,
  SmartKeyMetrics,
  StageName,
  StageView,
  Thresholds,
} from "@spindoctor/shared"
import type { Db } from "../../db/client"
import { getConfig, getRun, getSnapshotRaws, getSnapshots, listRuns } from "../../db/repositories"
import type { RunRow, StageRow } from "../../db/repositories"
import { stageResults } from "../../db/schema"
import type { DeviceApi } from "../../device/deviceApi"
import { parseLongSelfTestMinutes, parseSmartAttributes } from "../../device/smartParser"
import {
  DriveNotFoundError,
  RunInProgressError,
  SafetyError,
  type TestEngine,
} from "../../engine/engine"

export interface RunsRouteDeps {
  db: Db
  deviceApi: DeviceApi
  engine: TestEngine
}

/** Run statuses past which there is nothing left to abort. */
const TERMINAL_RUN_STATUSES = new Set(["DONE", "FAILED", "ABORTED"])

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

function toStageView(row: StageRow, declaredTotalMinutes: number | null): StageView {
  return {
    id: row.id,
    runId: row.runId,
    stage: row.stage as StageName,
    status: row.status,
    progress: row.progress,
    logPath: row.logPath,
    log: row.log,
    metrics: row.metrics,
    declaredTotalMinutes,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
  }
}

/** All persisted stage rows for a run, oldest first, mapped to the wire-honest `StageView`. */
function listStageRows(db: Db, runId: number): StageView[] {
  // Read from the run's baseline SMART capture, once per run rather than per
  // row: the drive's declared self-test duration is a property of the drive, and
  // the stage row's own `metrics` column holds the routine's result, written
  // only when the routine ends — far too late for an ETA (issue #61).
  const selfTestMinutes = parseLongSelfTestMinutes(getSnapshotRaws(db, runId).before)
  return db
    .select()
    .from(stageResults)
    .where(eq(stageResults.runId, runId))
    .orderBy(stageResults.id)
    .all()
    .map((row) => toStageView(row, row.stage === "SELFTEST_LONG" ? selfTestMinutes : null))
}

/** Concatenates every stage's captured log into one plain-text document for
 * the `GET /api/runs/:id/log` download — oldest stage first, each under its
 * own header, so a stage with no captured log (most SMART/VERDICT stages
 * currently don't produce raw tool text) still shows up rather than being
 * silently skipped. */
function buildRunLogText(stages: StageView[]): string {
  return stages
    .map(
      (s) => `===== ${s.stage} (${s.status}) =====\n${s.log ?? "(no log captured for this stage)"}`,
    )
    .join("\n\n")
}

/** The full before/after SMART attribute tables for a run (issue #14) —
 * parsed from the stored raw smartctl JSON against the currently-configured
 * thresholds, so a row's flag agrees with the run's own verdict reasons.
 * `[]` for a phase that hasn't been captured yet, same "not there" convention
 * as `snapshots.before`/`snapshots.after`. */
function buildAttributesView(
  db: Db,
  runId: number,
  thresholds: Thresholds,
): { before: SmartAttributeRow[]; after: SmartAttributeRow[] } {
  const raws = getSnapshotRaws(db, runId)
  return {
    before: raws.before != null ? parseSmartAttributes(raws.before, thresholds) : [],
    after: raws.after != null ? parseSmartAttributes(raws.after, thresholds) : [],
  }
}

export function runsRoutes(deps: RunsRouteDeps): FastifyPluginAsync {
  const { db, engine } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.post(
      "/runs",
      async (request: FastifyRequest<{ Body: Partial<CreateRunRequest> }>, reply) => {
        const { serial, mode, confirm, forceFullRegime } = request.body ?? {}

        if (
          typeof serial !== "string" ||
          serial.length === 0 ||
          (mode !== "destructive" && mode !== "read-only")
        ) {
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
          const runId = await engine.startRun({
            serial,
            mode,
            forceFullRegime: forceFullRegime === true,
          })
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

    fastify.get("/runs/:id", async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const id = Number(request.params.id)
      const row = Number.isFinite(id) ? getRun(db, id) : undefined
      if (!row) {
        reply.code(404)
        return { error: `no run found with id "${request.params.id}"`, code: "RUN_NOT_FOUND" }
      }
      const snapshots: { before: SmartKeyMetrics | null; after: SmartKeyMetrics | null } =
        getSnapshots(db, id)
      const attributes = buildAttributesView(db, id, resolveThresholds(getConfig(db).thresholds))
      return { run: toRunView(row), stages: listStageRows(db, id), snapshots, attributes }
    })

    fastify.get(
      "/runs/:id/smart",
      async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const id = Number(request.params.id)
        const row = Number.isFinite(id) ? getRun(db, id) : undefined
        if (!row) {
          reply.code(404)
          return { error: `no run found with id "${request.params.id}"`, code: "RUN_NOT_FOUND" }
        }
        const raws = getSnapshotRaws(db, id)
        reply
          .header("Content-Type", "application/json; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="spindoctor-run-${id}-smart.json"`)
        return raws
      },
    )

    fastify.get(
      "/runs/:id/log",
      async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
        const id = Number(request.params.id)
        const row = Number.isFinite(id) ? getRun(db, id) : undefined
        if (!row) {
          reply.code(404)
          return { error: `no run found with id "${request.params.id}"`, code: "RUN_NOT_FOUND" }
        }
        const text = buildRunLogText(listStageRows(db, id))
        reply
          .header("Content-Type", "text/plain; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="spindoctor-run-${id}-log.txt"`)
        return text
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
        // A run that already finished has nothing to abort, and `abortRun` is a
        // no-op for it. Reporting 202 either way left a client unable to tell
        // "abort requested" from "nothing to abort" (issue #90).
        if (TERMINAL_RUN_STATUSES.has(row.status)) {
          reply.code(409)
          return {
            error: `run ${id} has already finished (${row.status})`,
            code: "RUN_NOT_ACTIVE",
          }
        }
        engine.abortRun(id)
        reply.code(202)
        return { ok: true }
      },
    )
  }
}
