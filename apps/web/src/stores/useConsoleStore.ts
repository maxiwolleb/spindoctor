import { defineStore } from "pinia"
import { reactive, ref } from "vue"
import type {
  DriveView,
  RunStatus,
  RunUpdateEvent,
  SettingsView,
  StageProgressEvent,
  Verdict,
  RegimeMode,
} from "@spindoctor/shared"
import { createApiClient } from "../api/client"
import type { ApiClient } from "../api/client"

/** Live progress for one drive's in-flight run, keyed by `driveSerial`. */
export interface LiveProgress {
  runId: number
  stage: string
  percent: number
  status: string
  verdict: Verdict | null
}

/** The subset of `EventSource` the store actually uses. Narrower than the
 * DOM type so a test double doesn't have to implement the full interface
 * (readyState, onmessage, etc.) — a real `EventSource` satisfies this
 * structurally, so the default factory below needs no cast. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
}

export interface ConsoleDeps {
  api: ApiClient
  eventSourceFactory: (url: string) => EventSourceLike
}

function defaultDeps(): ConsoleDeps {
  return {
    api: createApiClient(),
    eventSourceFactory: (url) => new EventSource(url),
  }
}

let deps: ConsoleDeps = defaultDeps()

/**
 * Overrides the store's collaborators (API client + `EventSource`
 * constructor). This is the store's only seam for dependency injection:
 * production code never calls it (so it always gets the real API client and
 * `EventSource`), while tests call it with fakes before exercising the
 * store. Actions read `deps.*` at call time rather than capturing it, so
 * overriding after a store instance already exists still takes effect.
 *
 * Pass a partial object to override just one collaborator; call with no
 * arguments to restore both defaults (useful in test teardown).
 */
export function setConsoleDeps(overrides?: Partial<ConsoleDeps>): void {
  deps = overrides ? { ...deps, ...overrides } : defaultDeps()
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["DONE", "FAILED", "ABORTED"])

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const useConsoleStore = defineStore("console", () => {
  const drives = ref<DriveView[]>([])
  const settings = ref<SettingsView | null>(null)
  const liveByDrive = reactive<Record<string, LiveProgress>>({})
  const connected = ref(false)
  const error = ref<string | null>(null)

  let source: EventSourceLike | null = null

  function driveBySerial(serial: string): DriveView | undefined {
    return drives.value.find((d) => d.serial === serial)
  }

  function liveForDrive(serial: string): LiveProgress | undefined {
    return liveByDrive[serial]
  }

  async function refreshDrives(): Promise<void> {
    try {
      drives.value = await deps.api.getDrives()
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
    }
  }

  async function refreshSettings(): Promise<void> {
    try {
      settings.value = await deps.api.getSettings()
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
    }
  }

  /** Starts a run and refreshes the drive list so the new `latestRun` shows
   * up. Unlike the other actions, errors are rethrown (in addition to being
   * recorded in `error`) so a `StartTestDialog` can show the failure inline
   * instead of relying on the caller to poll store state. */
  async function startTest(serial: string, mode: RegimeMode, confirm?: string): Promise<void> {
    try {
      await deps.api.createRun({ serial, mode, confirm })
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
      throw err
    }
    await refreshDrives()
  }

  async function abort(runId: number): Promise<void> {
    try {
      await deps.api.abortRun(runId)
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
    }
  }

  function handleStageProgress(event: MessageEvent): void {
    const payload = JSON.parse(event.data as string) as StageProgressEvent
    const existing = liveByDrive[payload.driveSerial]
    liveByDrive[payload.driveSerial] = {
      runId: payload.runId,
      stage: payload.stage,
      percent: payload.percent,
      status: existing?.status ?? "RUNNING",
      verdict: existing?.verdict ?? null,
    }
  }

  function handleRunUpdate(event: MessageEvent): void {
    const payload = JSON.parse(event.data as string) as RunUpdateEvent
    const verdict = payload.verdict ?? null

    if (TERMINAL_STATUSES.has(payload.status)) {
      const drive = driveBySerial(payload.driveSerial)
      if (drive) {
        drive.latestRun = {
          id: payload.runId,
          status: payload.status,
          verdict,
          currentStage: payload.currentStage ?? null,
        }
      }
      // Terminal: the drive row should show the verdict, not a stale
      // progress bar, so drop any live entry for this drive.
      delete liveByDrive[payload.driveSerial]
      return
    }

    const existing = liveByDrive[payload.driveSerial]
    liveByDrive[payload.driveSerial] = {
      runId: payload.runId,
      stage: payload.currentStage ?? existing?.stage ?? "",
      percent: existing?.percent ?? 0,
      status: payload.status,
      verdict,
    }
  }

  function connectEvents(): void {
    // Idempotent: a re-mount (or any accidental double-call) tears down any
    // existing connection first, so we never leak a stale EventSource or
    // double-register its listeners.
    disconnectEvents()

    const es = deps.eventSourceFactory("/api/events")

    es.addEventListener("open", () => {
      connected.value = true
      error.value = null
    })
    es.addEventListener("error", () => {
      connected.value = false
    })
    es.addEventListener("stage:progress", handleStageProgress)
    es.addEventListener("run:update", handleRunUpdate)

    source = es
  }

  function disconnectEvents(): void {
    source?.close()
    source = null
    connected.value = false
  }

  return {
    drives,
    settings,
    liveByDrive,
    connected,
    error,
    driveBySerial,
    liveForDrive,
    refreshDrives,
    refreshSettings,
    startTest,
    abort,
    connectEvents,
    disconnectEvents,
  }
})
