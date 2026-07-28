import type { EventEmitter } from "node:events"
import type { Server as HttpServer } from "node:http"
import { and, desc, eq } from "drizzle-orm"
import { Server as IoServer } from "socket.io"
import type {
  RunStatus,
  RunUpdateEvent,
  StageName,
  StageProgressEvent,
  Verdict,
} from "@spindoctor/shared"
import type { Db } from "../db/client"
import { getSnapshotRaws, listRuns } from "../db/repositories"
import { stageResults } from "../db/schema"
import { parseLongSelfTestMinutes } from "../device/smartParser"

/** The two event names the browser listens for. */
export type RealtimeEventName = "run:update" | "stage:progress"

/** A realtime event and its payload, kept as data so it can be replayed,
 * asserted on, and emitted without knowing the transport. */
export type RealtimeEvent =
  | { name: "run:update"; payload: RunUpdateEvent }
  | { name: "stage:progress"; payload: StageProgressEvent }

/**
 * Bridges an engine's `run:update`/`stage:progress` events to `emit`. Returns
 * an unsubscribe that removes exactly the two listeners this call attached,
 * leaving any other listeners on the emitter untouched.
 */
export function subscribeEngine(
  engine: EventEmitter,
  emit: (name: RealtimeEventName, payload: RunUpdateEvent | StageProgressEvent) => void,
): () => void {
  const onRunUpdate = (payload: RunUpdateEvent): void => emit("run:update", payload)
  const onStageProgress = (payload: StageProgressEvent): void => emit("stage:progress", payload)

  engine.on("run:update", onRunUpdate)
  engine.on("stage:progress", onStageProgress)

  return () => {
    engine.off("run:update", onRunUpdate)
    engine.off("stage:progress", onStageProgress)
  }
}

/**
 * The self-test duration the drive declared for a run, or `null` for any other
 * stage — see `StageProgressEvent.declaredTotalMinutes`.
 *
 * Re-derived from the run's captured baseline SMART rather than copied into the
 * stage row: the drive's figure is a property of the drive, and the stage's
 * `metrics` column holds the routine's *result*, which isn't written until the
 * routine ends — hours after the ETA needs this (issue #61).
 */
function declaredSelfTestMinutes(db: Db, runId: number, stage: StageName): number | null {
  if (stage !== "SELFTEST_LONG") return null
  return parseLongSelfTestMinutes(getSnapshotRaws(db, runId).before)
}

/**
 * The current state of every RUNNING run — one `run:update`, plus (for its
 * current stage) one `stage:progress` carrying the persisted percent. Sent to a
 * client the moment it connects so a fresh page load, a route change, or a
 * reconnect hydrates immediately instead of showing an empty progress bar until
 * the next engine event, which can be a whole poll interval away.
 */
export function snapshotEvents(db: Db): RealtimeEvent[] {
  const events: RealtimeEvent[] = []
  for (const run of listRuns(db)) {
    if (run.status !== "RUNNING") continue

    events.push({
      name: "run:update",
      payload: {
        runId: run.id,
        driveSerial: run.driveSerial,
        status: run.status as RunStatus,
        currentStage: (run.currentStage as StageName | null) ?? undefined,
        verdict: (run.verdict as Verdict | null) ?? undefined,
      },
    })

    if (!run.currentStage) continue
    const stageRow = db
      .select()
      .from(stageResults)
      .where(and(eq(stageResults.runId, run.id), eq(stageResults.stage, run.currentStage)))
      .orderBy(desc(stageResults.id))
      .get()
    if (!stageRow) continue

    events.push({
      name: "stage:progress",
      payload: {
        runId: run.id,
        driveSerial: run.driveSerial,
        stage: run.currentStage as StageName,
        percent: stageRow.progress ?? 0,
        startedAt: stageRow.startedAt ? stageRow.startedAt.toISOString() : null,
        declaredTotalMinutes: declaredSelfTestMinutes(db, run.id, run.currentStage as StageName),
      },
    })
  }
  return events
}

export interface RealtimeDeps {
  /** The HTTP server to attach to — Fastify's `app.server`. Socket.IO handles
   * only its own path and delegates everything else to the existing request
   * listener, so the REST routes and the SPA fallback are untouched. */
  httpServer: HttpServer
  db: Db
  engine: EventEmitter
}

export interface Realtime {
  io: IoServer
  /** Detaches the engine listeners and closes the Socket.IO server (which
   * disconnects any client still attached). */
  close(): Promise<void>
}

/**
 * Attaches the Socket.IO server that pushes live run state to the UI.
 *
 * The engine is subscribed **once** and events are broadcast with `io.emit`,
 * rather than attaching a listener per connection: fan-out is Socket.IO's job,
 * and a per-socket subscription would grow listeners with every open tab and
 * eventually trip Node's max-listeners warning. Each connection gets only the
 * snapshot replay, which is per-client by nature.
 */
export function attachRealtime(deps: RealtimeDeps): Realtime {
  const { httpServer, db, engine } = deps

  const io = new IoServer(httpServer, {
    // The client is bundled with the SPA, so don't serve socket.io.js as well.
    serveClient: false,
  })

  const unsubscribe = subscribeEngine(engine, (name, payload) => {
    io.emit(name, payload)
  })

  io.on("connection", (socket) => {
    for (const event of snapshotEvents(db)) socket.emit(event.name, event.payload)
  })

  return {
    io,
    async close(): Promise<void> {
      unsubscribe()
      await new Promise<void>((resolve) => io.close(() => resolve()))
    },
  }
}
