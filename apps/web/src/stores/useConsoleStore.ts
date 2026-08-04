import { defineStore } from "pinia"
import { reactive, ref } from "vue"
import type {
  DriveView,
  RunStatus,
  RunUpdateEvent,
  SettingsView,
  StageProgressEvent,
  Verdict,
  CreateRunRequest,
} from "@spindoctor/shared"
import { createApiClient } from "../api/client"
import type { ApiClient } from "../api/client"
import { createRealtimeConnection } from "../api/realtime"
import type { RealtimeConnection } from "../api/realtime"

/** Live progress for one drive's in-flight run, keyed by `driveSerial`. */
export interface LiveProgress {
  runId: number
  stage: string
  percent: number
  status: string
  verdict: Verdict | null
  /** The current stage's start time (ISO string), threaded from
   * `StageProgressEvent.startedAt` — the signal an ETA estimate (issue #15)
   * extrapolates from. `null` until the stage's first `stage:progress` frame
   * arrives, same lag `percent` already has. */
  startedAt: string | null
  /** How long the drive itself says the current stage takes, in minutes — see
   * `StageProgressEvent.declaredTotalMinutes`. The dashboard's activity cell has
   * no stage rows to read, so this frame is its only source for the self-test
   * ETA (issue #61). `null` for every stage but SELFTEST_LONG. */
  declaredTotalMinutes: number | null
}

export interface ConsoleDeps {
  api: ApiClient
  realtimeFactory: () => RealtimeConnection
}

function defaultDeps(): ConsoleDeps {
  return {
    api: createApiClient(),
    realtimeFactory: createRealtimeConnection,
  }
}

let deps: ConsoleDeps = defaultDeps()

/**
 * Overrides the store's collaborators (API client + realtime connection).
 * This is the store's only seam for dependency injection: production code
 * never calls it (so it always gets the real API client and a real Socket.IO
 * connection), while tests call it with fakes before exercising the store.
 * Actions read `deps.*` at call time rather than capturing it, so overriding
 * after a store instance already exists still takes effect.
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

  let connection: RealtimeConnection | null = null

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

  /** Persists a settings patch and adopts the server's response as the new
   * `settings` (the backend echoes back the full merged row, so this stays
   * in sync even if the patch was partial). Like `startTest`, rethrows so a
   * `SettingsView` can show the failure inline (e.g. a validation 400)
   * instead of relying on the caller to poll `error`. */
  async function saveSettings(patch: Partial<SettingsView>): Promise<void> {
    try {
      settings.value = await deps.api.putSettings(patch)
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
      throw err
    }
  }

  /** Starts a run and refreshes the drive list so the new `latestRun` shows
   * up. Unlike the other actions, errors are rethrown (in addition to being
   * recorded in `error`) so a `StartTestDialog` can show the failure inline
   * instead of relying on the caller to poll store state. */
  async function startTest(request: CreateRunRequest): Promise<void> {
    try {
      await deps.api.createRun(request)
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
      throw err
    }
    await refreshDrives()
  }

  /**
   * Stops a run, then refreshes the drive list so the row reflects it.
   *
   * Rethrows, like `startTest` and `saveSettings`. It used to swallow, which made
   * it the one action whose failure was invisible — a 409 for a run that had
   * already finished, or a network error, both looked exactly like a successful
   * stop (issue #104).
   */
  async function abort(runId: number): Promise<void> {
    try {
      await deps.api.abortRun(runId)
      error.value = null
    } catch (err) {
      error.value = messageOf(err)
      throw err
    }
    await refreshDrives()
  }

  function handleStageProgress(payload: StageProgressEvent): void {
    const existing = liveByDrive[payload.driveSerial]
    liveByDrive[payload.driveSerial] = {
      runId: payload.runId,
      stage: payload.stage,
      percent: payload.percent,
      status: existing?.status ?? "RUNNING",
      verdict: existing?.verdict ?? null,
      startedAt: payload.startedAt,
      declaredTotalMinutes: payload.declaredTotalMinutes,
    }
  }

  function handleRunUpdate(payload: RunUpdateEvent): void {
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
    const stage = payload.currentStage ?? existing?.stage ?? ""
    // A genuine stage transition invalidates any percent/startedAt carried
    // from the *previous* stage — showing 0%/no ETA until the new stage's
    // own stage:progress frame arrives is safer than showing stale numbers
    // under the new stage's name. The declared duration goes with them: it
    // described the self-test, not the surface scan that follows it (#61).
    const stageChanged = stage !== existing?.stage
    liveByDrive[payload.driveSerial] = {
      runId: payload.runId,
      stage,
      percent: stageChanged ? 0 : (existing?.percent ?? 0),
      status: payload.status,
      verdict,
      startedAt: stageChanged ? null : (existing?.startedAt ?? null),
      declaredTotalMinutes: stageChanged ? null : (existing?.declaredTotalMinutes ?? null),
    }
  }

  function connectEvents(): void {
    // Idempotent: a re-mount (or any accidental double-call) tears down any
    // existing connection first, so we never leak a socket or double-register
    // its listeners.
    disconnectEvents()

    const conn = deps.realtimeFactory()

    // `connect` fires again after every successful reconnect, and the server
    // replays in-flight run state on each connection, so the indicator and the
    // live view both heal on their own.
    conn.onConnect(() => {
      connected.value = true
      error.value = null
    })
    conn.onDisconnect(() => {
      connected.value = false
    })
    conn.onStageProgress(handleStageProgress)
    conn.onRunUpdate(handleRunUpdate)

    connection = conn
  }

  function disconnectEvents(): void {
    connection?.close()
    connection = null
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
    saveSettings,
    startTest,
    abort,
    connectEvents,
    disconnectEvents,
  }
})
