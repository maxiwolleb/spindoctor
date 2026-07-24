import type { EventEmitter } from "node:events"
import type { RunUpdateEvent, StageProgressEvent } from "@spindoctor/shared"

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
