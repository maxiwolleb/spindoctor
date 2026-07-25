import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { Db } from "../../db/client"
import type { TestEngine } from "../../engine/engine"
import { snapshotFrames, subscribeEngine } from "../sse"

export interface EventsRouteDeps {
  db: Db
  engine: TestEngine
}

const HEARTBEAT_INTERVAL_MS = 15_000

/** SSE stream of the engine's live `run:update`/`stage:progress` events. */
export function eventsRoutes(deps: EventsRouteDeps): FastifyPluginAsync {
  const { db, engine } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/events", (request, reply) => {
      // Take over the raw response ourselves: this is a long-lived stream,
      // not a single JSON body, so Fastify must not try to serialize/end it.
      reply.hijack()

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      reply.raw.write(": connected\n\n")

      // Subscribe before snapshotting so no event fired mid-read is missed; a
      // duplicate frame is harmless (the store re-applies the same value).
      const unsub = subscribeEngine(engine, (frame) => reply.raw.write(frame))
      for (const frame of snapshotFrames(db)) reply.raw.write(frame)

      const heartbeat = setInterval(() => {
        reply.raw.write(": ping\n\n")
      }, HEARTBEAT_INTERVAL_MS)

      request.raw.on("close", () => {
        clearInterval(heartbeat)
        unsub()
        reply.raw.end()
      })
    })
  }
}
