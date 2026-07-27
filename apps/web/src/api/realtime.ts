import { io } from "socket.io-client"
import type { RunUpdateEvent, StageProgressEvent } from "@spindoctor/shared"

/**
 * The live connection to the backend, expressed as exactly the four things the
 * store needs rather than as a Socket.IO type.
 *
 * Keeping socket.io-client behind this seam means the store (and its tests)
 * never depend on the transport: a test double is four methods, and swapping
 * the transport again would touch only this file. Payloads arrive already
 * decoded — Socket.IO handles framing and JSON, unlike the raw SSE frames this
 * replaced.
 */
export interface RealtimeConnection {
  onConnect(listener: () => void): void
  onDisconnect(listener: () => void): void
  onRunUpdate(listener: (payload: RunUpdateEvent) => void): void
  onStageProgress(listener: (payload: StageProgressEvent) => void): void
  /** Closes the connection and stops any reconnection attempts. */
  close(): void
}

/**
 * Connects to the backend's Socket.IO server on the page's own origin.
 *
 * Reconnection is Socket.IO's own concern here — it retries with backoff and
 * re-emits `connect` when it succeeds, and the server replays in-flight run
 * state on every connection, so a dropped link heals without the UI having to
 * refetch anything.
 */
export function createRealtimeConnection(): RealtimeConnection {
  const socket = io({ path: "/socket.io" })

  return {
    onConnect: (listener) => void socket.on("connect", listener),
    onDisconnect: (listener) => void socket.on("disconnect", listener),
    onRunUpdate: (listener) => void socket.on("run:update", listener),
    onStageProgress: (listener) => void socket.on("stage:progress", listener),
    close: () => void socket.disconnect(),
  }
}
