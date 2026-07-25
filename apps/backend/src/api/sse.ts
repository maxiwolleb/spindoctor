import type { EventEmitter } from "node:events"
import { and, desc, eq } from "drizzle-orm"
import type {
  RunStatus,
  RunUpdateEvent,
  StageName,
  StageProgressEvent,
  Verdict,
} from "@spindoctor/shared"
import type { Db } from "../db/client"
import { listRuns } from "../db/repositories"
import { stageResults } from "../db/schema"

/** Formats a single Server-Sent Events frame: `event: <name>\ndata: <json>\n\n`. */
export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Wires an engine's `run:update`/`stage:progress` events to `write`, each
 * formatted as an SSE frame. Returns an unsubscribe function that removes
 * exactly the two listeners this call attached, leaving any other listeners
 * on the emitter untouched.
 */
export function subscribeEngine(engine: EventEmitter, write: (frame: string) => void): () => void {
  const onRunUpdate = (payload: RunUpdateEvent): void => {
    write(formatSse("run:update", payload))
  }
  const onStageProgress = (payload: StageProgressEvent): void => {
    write(formatSse("stage:progress", payload))
  }

  engine.on("run:update", onRunUpdate)
  engine.on("stage:progress", onStageProgress)

  return () => {
    engine.off("run:update", onRunUpdate)
    engine.off("stage:progress", onStageProgress)
  }
}

/**
 * SSE frames replaying the current state of every RUNNING run — one
 * `run:update`, plus (for its current stage) one `stage:progress` with the
 * persisted percent. Sent to a client the moment it connects so a fresh page
 * load / reconnect hydrates its live view immediately, instead of showing an
 * empty progress bar until the next engine event (which can be a poll interval
 * away). The store already handles these two frame types, so no client change
 * is needed.
 */
export function snapshotFrames(db: Db): string[] {
  const frames: string[] = []
  for (const run of listRuns(db)) {
    if (run.status !== "RUNNING") continue

    frames.push(
      formatSse("run:update", {
        runId: run.id,
        driveSerial: run.driveSerial,
        status: run.status as RunStatus,
        currentStage: (run.currentStage as StageName | null) ?? undefined,
        verdict: (run.verdict as Verdict | null) ?? undefined,
      } satisfies RunUpdateEvent),
    )

    if (!run.currentStage) continue
    const stageRow = db
      .select()
      .from(stageResults)
      .where(and(eq(stageResults.runId, run.id), eq(stageResults.stage, run.currentStage)))
      .orderBy(desc(stageResults.id))
      .get()
    if (stageRow) {
      frames.push(
        formatSse("stage:progress", {
          runId: run.id,
          driveSerial: run.driveSerial,
          stage: run.currentStage as StageName,
          percent: stageRow.progress ?? 0,
          startedAt: stageRow.startedAt ? stageRow.startedAt.toISOString() : null,
        } satisfies StageProgressEvent),
      )
    }
  }
  return frames
}
