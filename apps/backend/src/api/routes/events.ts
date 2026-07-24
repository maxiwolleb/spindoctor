import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { TestEngine } from "../../engine/engine"
import { subscribeEngine } from "../sse"

export interface EventsRouteDeps {
  engine: TestEngine
}

const HEARTBEAT_INTERVAL_MS = 15_000

/** SSE stream of the engine's live `run:update`/`stage:progress` events. */
export function eventsRoutes(deps: EventsRouteDeps): FastifyPluginAsync {
  const { engine } = deps

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

      const unsub = subscribeEngine(engine, (frame) => reply.raw.write(frame))

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
