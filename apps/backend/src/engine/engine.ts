import { EventEmitter } from "node:events"
import { and, desc, eq } from "drizzle-orm"
import type {
  DiscoveredDrive,
  RegimeMode,
  RunUpdateEvent,
  SelfTestResult,
  SmartKeyMetrics,
  StageName,
  StageProgressEvent,
  SurfaceResult,
  Thresholds,
} from "@spindoctor/shared"
import type { Db } from "../db/client"
import type { DeviceApi } from "../device/deviceApi"
import { parseSmartMetrics } from "../device/smartParser"
import { evaluateVerdict } from "../verdict/evaluate"
import { checkDestructiveAllowed } from "../safety/guards"
import { smartSnapshots, stageResults } from "../db/schema"
import {
  addStage,
  appendAudit,
  createRun,
  getConfig,
  listRuns,
  saveSnapshot,
  updateRun,
  updateStage,
  upsertDrive,
} from "../db/repositories"
import type { RunRow, StageRow } from "../db/repositories"
import { Semaphore } from "./semaphore"
import { regimeStages } from "./regime"

export class DriveNotFoundError extends Error {
  constructor(serial: string) {
    super(`no drive found with serial "${serial}"`)
    this.name = "DriveNotFoundError"
  }
}

export class SafetyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "SafetyError"
    this.code = code
  }
}

/** Thrown when a drive vanishes between stages — device paths are transient,
 * so any stage that needs to touch the device after a long-running
 * intermediate stage (self-test, surface write) must re-resolve by serial
 * rather than trust an earlier snapshot, and fail closed if it's gone. */
export class DriveGoneError extends Error {
  constructor(serial: string) {
    super(`drive with serial "${serial}" is no longer present (DRIVE_GONE)`)
    this.name = "DriveGoneError"
  }
}

/** Thrown by `startRun` when the target drive already has an active run in
 * this process (dispatched either via `startRun` or a `reconcile()` resume).
 * Prevents two concurrent runs — most critically two concurrent destructive
 * `badblocks -w` writers — against the same physical drive. */
export class RunInProgressError extends Error {
  readonly serial: string
  constructor(serial: string) {
    super(`drive with serial "${serial}" already has an active run`)
    this.name = "RunInProgressError"
    this.serial = serial
  }
}

export interface TestEngineDeps {
  db: Db
  deviceApi: DeviceApi
  sleep?: (ms: number) => Promise<void>
  selfTestPollIntervalMs?: number
  concurrency?: number
}

/** Mutable per-run accumulator threaded through stage execution. */
interface RunState {
  before?: SmartKeyMetrics
  after?: SmartKeyMetrics
  selfTest?: SelfTestResult
  surface: SurfaceResult | null
}

/**
 * Resume instructions threaded from `reconcile()`/`#reconcileRun` into
 * `#run`, so a startup-interrupted run continues through the exact same
 * stage-execution loop a fresh run uses instead of a parallel code path.
 */
interface ResumeInfo {
  /** Index into `regimeStages(mode)` to start the loop at. */
  fromIndex: number
  /** Pre-populated with the outcomes of every stage strictly before `fromIndex`. */
  state: RunState
  /** Set only when resuming a SELFTEST_LONG stage by polling: the existing
   * RUNNING stage row to keep updating instead of inserting a new one. */
  reuseStageId?: number
  /** Set only when resuming a SELFTEST_LONG stage by polling: the firmware
   * test itself kept running across the restart, so don't call
   * `startLongSelfTest` again. */
  skipSelfTestStart?: boolean
}

/**
 * Orchestrates a single drive through the health regime (SMART -> long
 * self-test -> surface scan -> SMART -> verdict), persisting every
 * transition and emitting progress events. Stage execution runs
 * fire-and-forget behind a semaphore so callers can bound concurrency
 * across many drives without blocking `startRun`.
 */
export class TestEngine extends EventEmitter {
  private readonly db: Db
  private readonly deviceApi: DeviceApi
  private readonly sleep: (ms: number) => Promise<void>
  private readonly selfTestPollIntervalMs: number
  private readonly semaphore: Semaphore
  private readonly controllers = new Map<number, AbortController>()
  /** Drive serials reserved by a run in this process (via `startRun` or a
   * `reconcile()` resume). `startRun` reserves synchronously at the very top
   * of the method — before its first `await` — so two near-simultaneous
   * calls for the same brand-new serial can't both pass the check during the
   * `listDevices()`/safety-check await gap; a rejected `startRun` releases
   * its reservation itself (see its `catch`), while a dispatched one hands
   * ownership to `#execute`'s `finally` (which clears it there instead).
   * `reconcile()` still reserves synchronously alongside `controllers.set(...)`
   * and clears it in `#reconcileRun`'s own `finally`. Either way a serial is
   * "active" for exactly as long as its run is dispatched in this process —
   * the guard that stops two concurrent runs (e.g. a boot-time `reconcile()`
   * resume racing an `AutoModePoller` enqueue, or two racing `startRun`
   * calls) from both driving a destructive `badblocks -w` against the same
   * physical drive. */
  readonly #activeSerials = new Set<string>()
  /** Run ids that have reached a terminal DB status (DONE/FAILED/ABORTED).
   * Never pruned: once a run is terminal it must stay that way forever, so
   * `abortRun` needs to keep no-op'ing for that id even long after the
   * controller itself has been cleaned up. */
  private readonly terminalRuns = new Set<number>()
  /** Last whole-percent value persisted per stage id, so #emitStageProgress
   * only writes the stage row when the rounded percent actually changes —
   * bounding DB writes on fast progress streams like badblocks. */
  readonly #lastStageProgress = new Map<number, number>()
  /** Cap on SURFACE-stage restarts via reconcile() before giving up on a run. */
  private static readonly MAX_RESTARTS = 3

  constructor(deps: TestEngineDeps) {
    super()
    this.db = deps.db
    this.deviceApi = deps.deviceApi
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.selfTestPollIntervalMs = deps.selfTestPollIntervalMs ?? 60_000
    this.semaphore = new Semaphore(deps.concurrency ?? getConfig(deps.db).concurrency)
  }

  async startRun(input: { serial: string; mode: RegimeMode }): Promise<number> {
    const { serial, mode } = input
    // Reserved synchronously, before any `await`: this is the single guard
    // that prevents two near-simultaneous startRun calls for the same
    // brand-new serial from both passing the check during the
    // listDevices()/safety-check await gap below and dispatching two
    // concurrent runs (most critically two concurrent destructive
    // `badblocks -w`) against the same physical drive. Every early-exit path
    // in the try block below (drive not found, safety denial, any other
    // thrown error) releases this reservation in the catch; on success,
    // ownership transfers to #execute's own `finally` (which clears it),
    // so it must NOT be re-added or removed again here.
    if (this.#activeSerials.has(serial)) throw new RunInProgressError(serial)
    this.#activeSerials.add(serial)

    try {
      const drives = await this.deviceApi.listDevices()
      const drive = drives.find((d) => d.serial === serial)
      if (!drive) throw new DriveNotFoundError(serial)

      if (mode === "destructive") {
        const decision = checkDestructiveAllowed(drive, { protectList: this.#protectList() })
        if (!decision.allowed) {
          appendAudit(this.db, {
            action: "DESTRUCTIVE_DENIED",
            driveSerial: serial,
            detail: decision.code,
          })
          throw new SafetyError(decision.code, decision.reason)
        }
      }

      upsertDrive(this.db, drive)
      const runId = createRun(this.db, {
        driveSerial: serial,
        regime: { mode, stages: regimeStages(mode).map((s) => s.stage) },
      })
      appendAudit(this.db, {
        action: mode === "destructive" ? "DESTRUCTIVE_START" : "READONLY_START",
        driveSerial: serial,
      })

      const controller = new AbortController()
      this.controllers.set(runId, controller)
      // Fire-and-forget: bounded by the semaphore inside #execute. #execute
      // never rejects — it catches its own stage failures and, as a last
      // resort, any unexpected error too — so this has no unhandled-rejection
      // risk. #execute's finally clears #activeSerials for this serial, so
      // the reservation taken at the top of this method is released exactly
      // once, there.
      void this.#execute(runId, drive, mode, controller)

      return runId
    } catch (err) {
      this.#activeSerials.delete(serial)
      throw err
    }
  }

  /** True while `serial` has a run actively dispatched in this process
   * (via `startRun` or a `reconcile()` resume) — i.e. it would be rejected
   * by a fresh `startRun` call right now. */
  isDriveActive(serial: string): boolean {
    return this.#activeSerials.has(serial)
  }

  /**
   * No-ops for a run that has already reached a terminal status (or that
   * has no active controller, e.g. an unknown/already-finished run id).
   * Without this guard, a `run:update` listener that reacts synchronously to
   * a terminal DONE/FAILED/ABORTED event — e.g. Phase 4's SSE bridge and
   * cancel button — could call `abortRun` on an already-settled run and
   * re-trigger the post-stage abort path, corrupting a persisted verdict
   * and emitting a second terminal event.
   */
  abortRun(runId: number): void {
    if (this.terminalRuns.has(runId)) return
    this.controllers.get(runId)?.abort()
  }

  /**
   * Resumes every run left non-terminal (RUNNING/PENDING) by a previous
   * process's death — a container restart, most commonly. Each run is
   * resumed from the first stage its persisted `stage_results` don't show
   * as DONE, reusing the same stage-execution loop (`#run`) a fresh run
   * uses; see `#reconcileRun`/`#planResume` for the per-stage resume rules.
   * Fire-and-forget per run (bounded by the same semaphore as `startRun`),
   * so this resolves once every non-terminal run has been dispatched, not
   * once they've all finished running.
   */
  async reconcile(): Promise<void> {
    const runs = listRuns(this.db).filter((r) => r.status === "RUNNING" || r.status === "PENDING")
    for (const run of runs) {
      // Guard against double-starting a run already being executed in this
      // process — e.g. a run already driven by startRun, or an overlapping
      // reconcile() call. Checked synchronously, together with the
      // controllers.set below, before any await, so nothing can race past
      // this check for the same run id.
      if (this.controllers.has(run.id) || this.terminalRuns.has(run.id)) continue
      // Same-drive guard as startRun's RunInProgressError: don't resume a
      // run whose serial already has another run active in this process
      // (e.g. startRun already dispatched a fresh run for this drive, or an
      // earlier run in this same reconcile() batch already claimed it).
      // Checked synchronously alongside the id-based guard above and the
      // #activeSerials.add below, so nothing can race past it either.
      if (this.#activeSerials.has(run.driveSerial)) continue

      const controller = new AbortController()
      this.controllers.set(run.id, controller)
      this.#activeSerials.add(run.driveSerial)
      // Fire-and-forget, same contract as #execute: never rejects, always
      // leaves the run in a persisted terminal or RUNNING state.
      void this.#reconcileRun(run, controller)
    }
  }

  /** Wraps #run so the fire-and-forget call in startRun can never reject. */
  async #execute(
    runId: number,
    drive: DiscoveredDrive,
    mode: RegimeMode,
    controller: AbortController,
  ): Promise<void> {
    const release = await this.semaphore.acquire()
    try {
      await this.#run(runId, drive, mode, controller)
    } catch (err) {
      // Defense in depth: #run's own loop already turns stage failures into
      // a persisted FAILED run. This only guards run-level bookkeeping
      // (e.g. an unexpected DB error) that would otherwise escape as an
      // unhandled rejection from the fire-and-forget call in startRun.
      this.terminalRuns.add(runId)
      try {
        updateRun(this.db, runId, { status: "FAILED", error: String(err), finishedAt: new Date() })
        this.#emitRunUpdate({ runId, driveSerial: drive.serial, status: "FAILED" })
      } catch {
        // Truly last resort (e.g. the DB itself is broken): swallow rather
        // than crash the process from a background task.
      }
    } finally {
      release()
      this.controllers.delete(runId)
      this.#activeSerials.delete(drive.serial)
    }
  }

  /** Resumes a single interrupted run; wraps #run so reconcile()'s fire-and-forget dispatch can never reject. */
  async #reconcileRun(run: RunRow, controller: AbortController): Promise<void> {
    const runId = run.id
    const release = await this.semaphore.acquire()
    try {
      const regime = run.regime as { mode: RegimeMode }
      const drive = await this.#resolveDriveBySerial(run.driveSerial)
      if (!drive) {
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, { status: "FAILED", error: "DRIVE_GONE", finishedAt: new Date() })
        this.#emitRunUpdate({ runId, driveSerial: run.driveSerial, status: "FAILED" })
        return
      }

      const plan = this.#planResume(run, regime.mode)

      if (plan.tooManyRestarts) {
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, {
          status: "FAILED",
          error: "TOO_MANY_RESTARTS",
          finishedAt: new Date(),
        })
        this.#emitRunUpdate({ runId, driveSerial: drive.serial, status: "FAILED" })
        return
      }

      // SURFACE interrupted mid-write/scan: the old attempt is
      // unsalvageable (badblocks doesn't checkpoint), so it's restarted
      // from scratch — the stale row is relabelled INTERRUPTED (it was
      // neither DONE nor FAILED) and the restart is counted before #run
      // inserts a fresh SURFACE row and re-runs it, destructive safety
      // re-check included (that guard already lives in #runSurfaceStage
      // and fires unconditionally for every destructive SURFACE attempt).
      if (plan.staleSurfaceStageId !== undefined) {
        updateStage(this.db, plan.staleSurfaceStageId, {
          status: "INTERRUPTED",
          finishedAt: new Date(),
        })
        updateRun(this.db, runId, { restartCount: run.restartCount + 1 })
      }

      await this.#run(runId, drive, regime.mode, controller, {
        fromIndex: plan.fromIndex,
        state: plan.state,
        reuseStageId: plan.reuseStageId,
        skipSelfTestStart: plan.skipSelfTestStart,
      })
    } catch (err) {
      // Defense in depth, mirroring #execute: the logic above already turns
      // expected failures (DRIVE_GONE, TOO_MANY_RESTARTS, stage errors via
      // #run) into a persisted FAILED run. This only guards against
      // something unexpected (e.g. a DB error) escaping as an unhandled
      // rejection from the fire-and-forget call in reconcile().
      this.terminalRuns.add(runId)
      try {
        updateRun(this.db, runId, { status: "FAILED", error: String(err), finishedAt: new Date() })
        this.#emitRunUpdate({ runId, driveSerial: run.driveSerial, status: "FAILED" })
      } catch {
        // Truly last resort (e.g. the DB itself is broken): swallow rather
        // than crash the process from a background task.
      }
    } finally {
      release()
      this.controllers.delete(runId)
      this.#activeSerials.delete(run.driveSerial)
    }
  }

  /**
   * Works out where a non-terminal run left off, from its persisted
   * `stage_results`, and what resuming that stage requires:
   *  - SELFTEST_LONG still RUNNING → resume by polling only (the firmware
   *    kept the test running across the restart); reuse the existing row.
   *  - SURFACE still RUNNING → cannot be resumed in place (badblocks
   *    doesn't checkpoint); restart it from scratch, unless `restartCount`
   *    has already hit the cap, in which case give up.
   *  - anything else → just re-run that stage via the normal fresh-row path.
   * Also reconstructs the in-memory `RunState` for every stage strictly
   * before the resume point from smart snapshots and (for SELFTEST_LONG/
   * SURFACE) each stage row's persisted `metrics`, since #run's loop never
   * re-executes those stages on a resumed run.
   */
  #planResume(
    run: RunRow,
    mode: RegimeMode,
  ): {
    fromIndex: number
    state: RunState
    reuseStageId?: number
    skipSelfTestStart?: boolean
    staleSurfaceStageId?: number
    tooManyRestarts?: boolean
  } {
    const stages = regimeStages(mode)
    const stageRows = this.db
      .select()
      .from(stageResults)
      .where(eq(stageResults.runId, run.id))
      .orderBy(stageResults.id)
      .all()

    const latestByStage = new Map<StageName, StageRow>()
    for (const row of stageRows) {
      latestByStage.set(row.stage as StageName, row)
    }

    let resumeIndex = stages.findIndex((s) => latestByStage.get(s.stage)?.status !== "DONE")
    if (resumeIndex === -1) {
      // Defensive fallback: every persisted stage is DONE but the run
      // itself was never marked terminal. Shouldn't happen — VERDICT marks
      // both the stage row and the run DONE in the same synchronous call —
      // but re-running VERDICT is the safe default over a silent no-op.
      resumeIndex = stages.length - 1
    }

    const state: RunState = { surface: null }
    for (let i = 0; i < resumeIndex; i++) {
      const step = stages[i]
      if (!step) continue
      const row = latestByStage.get(step.stage)
      if (!row) continue
      switch (step.stage) {
        case "SMART_BEFORE":
          state.before = this.#loadSnapshot(run.id, "before")
          break
        case "SELFTEST_LONG":
          if (row.metrics) state.selfTest = row.metrics as SelfTestResult
          break
        case "SURFACE":
          if (row.metrics) state.surface = row.metrics as SurfaceResult
          break
        case "SMART_AFTER":
          state.after = this.#loadSnapshot(run.id, "after")
          break
        default:
          break
      }
    }

    const resumeStage = stages[resumeIndex]
    if (!resumeStage) return { fromIndex: resumeIndex, state } // unreachable given the bounds above
    const currentRow = latestByStage.get(resumeStage.stage)

    if (resumeStage.stage === "SELFTEST_LONG" && currentRow?.status === "RUNNING") {
      return { fromIndex: resumeIndex, state, reuseStageId: currentRow.id, skipSelfTestStart: true }
    }

    if (resumeStage.stage === "SURFACE" && currentRow?.status === "RUNNING") {
      if (run.restartCount >= TestEngine.MAX_RESTARTS) {
        return { fromIndex: resumeIndex, state, tooManyRestarts: true }
      }
      return { fromIndex: resumeIndex, state, staleSurfaceStageId: currentRow.id }
    }

    return { fromIndex: resumeIndex, state }
  }

  /** Loads the most recent SMART snapshot for a run/phase, for reconstructing RunState on resume. */
  #loadSnapshot(runId: number, phase: "before" | "after"): SmartKeyMetrics | undefined {
    const row = this.db
      .select()
      .from(smartSnapshots)
      .where(and(eq(smartSnapshots.runId, runId), eq(smartSnapshots.phase, phase)))
      .orderBy(desc(smartSnapshots.id))
      .get()
    return row ? (row.keyMetrics as SmartKeyMetrics) : undefined
  }

  /**
   * Runs the regime stage loop, optionally resuming partway through after a
   * startup reconciliation (see `reconcile()`/`#reconcileRun`). `resume`
   * carries the stage index to start at, a pre-populated `RunState` for
   * every stage that already completed before an interruption, and (for
   * the one case that doesn't get a fresh stage row — SELFTEST_LONG
   * resumed by polling) the existing stage row id to reuse instead of
   * inserting a new one.
   */
  async #run(
    runId: number,
    drive: DiscoveredDrive,
    mode: RegimeMode,
    controller: AbortController,
    resume?: ResumeInfo,
  ): Promise<void> {
    // Stamp the run's start time on its first (fresh) RUNNING transition. A
    // reconcile()-resumed run already started earlier, so it keeps its
    // original startedAt rather than resetting it here.
    updateRun(
      this.db,
      runId,
      resume === undefined ? { status: "RUNNING", startedAt: new Date() } : { status: "RUNNING" },
    )
    const state: RunState = resume?.state ?? { surface: null }
    // Device paths are transient, so this is reassigned whenever a stage
    // re-resolves the drive (SURFACE's destructive re-check, SMART_AFTER's
    // fresh by-serial lookup) — every later stage, including VERDICT, uses
    // whatever is current at the time it runs.
    let currentDrive = drive

    const stages = regimeStages(mode)
    const startIndex = resume?.fromIndex ?? 0

    for (let i = startIndex; i < stages.length; i++) {
      const step = stages[i]
      if (!step) break // unreachable — i stays within [startIndex, stages.length)
      const { stage, surfaceMode } = step

      if (controller.signal.aborted) {
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, {
          status: "ABORTED",
          currentStage: stage,
          finishedAt: new Date(),
        })
        this.#emitRunUpdate({
          runId,
          driveSerial: currentDrive.serial,
          status: "ABORTED",
          currentStage: stage,
        })
        return
      }

      // Only the very first resumed iteration can reuse an existing stage
      // row (SELFTEST_LONG resumed by polling — the row is already RUNNING
      // from before the restart); every other iteration, resumed or not,
      // starts a fresh row exactly as a non-reconciled run does.
      const isFirstResumedIteration = resume !== undefined && i === startIndex
      const stageId =
        isFirstResumedIteration && resume?.reuseStageId !== undefined
          ? resume.reuseStageId
          : addStage(this.db, { runId, stage, status: "RUNNING" })
      const skipSelfTestStart = isFirstResumedIteration && resume?.skipSelfTestStart === true
      // Persisted (not just emitted) so a DB read reflects the live stage —
      // e.g. a process restart mid-stage, or any reader that isn't
      // listening for run:update events, can still see where a RUNNING run
      // currently is.
      updateRun(this.db, runId, { currentStage: stage })
      this.#emitRunUpdate({
        runId,
        driveSerial: currentDrive.serial,
        status: "RUNNING",
        currentStage: stage,
      })

      try {
        currentDrive = await this.#runStage(
          runId,
          stage,
          stageId,
          surfaceMode,
          currentDrive,
          state,
          controller,
          skipSelfTestStart,
        )
      } catch (err) {
        updateStage(this.db, stageId, { status: "FAILED", finishedAt: new Date() })
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, {
          status: "FAILED",
          currentStage: stage,
          error: String(err),
          finishedAt: new Date(),
        })
        this.#emitRunUpdate({ runId, driveSerial: currentDrive.serial, status: "FAILED" })
        return
      }

      // VERDICT already persisted its own terminal DONE status and emitted
      // the terminal run:update *inside* #runVerdictStage — marking the run
      // terminal (see there) before it does, so abortRun() is already a
      // no-op for a listener reacting synchronously to that event. Returning
      // immediately here is belt-and-suspenders: it also means the
      // cooperative-abort check below (meant for stages that can be
      // interrupted mid-flight) never runs for VERDICT, so a DONE run can
      // never be re-labelled ABORTED afterwards.
      if (stage === "VERDICT") return

      // Stages return cooperatively on abort (they don't throw), so check
      // right here — not on the next loop iteration — or the interrupted
      // stage gets mis-recorded DONE and the reported currentStage becomes
      // the *next* stage instead of the one that was actually interrupted.
      if (controller.signal.aborted) {
        updateStage(this.db, stageId, { status: "ABORTED", finishedAt: new Date() })
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, {
          status: "ABORTED",
          currentStage: stage,
          finishedAt: new Date(),
        })
        this.#emitRunUpdate({
          runId,
          driveSerial: currentDrive.serial,
          status: "ABORTED",
          currentStage: stage,
        })
        return
      }

      // Idempotent: SURFACE already persists its own terminal status (see
      // #runSurfaceStage) before this point, so that a listener reacting to
      // an ABORTED run:update event never observes a stale RUNNING stage
      // row. This call is a harmless no-op re-write for it and the normal
      // completion path for every other non-VERDICT stage.
      updateStage(this.db, stageId, { status: "DONE", progress: 100, finishedAt: new Date() })
    }
  }

  /**
   * Runs one stage and returns the drive to use for every subsequent stage.
   * Most stages return `drive` unchanged; SURFACE and SMART_AFTER may
   * re-resolve it (device paths are transient — see the DriveGoneError/
   * #resolveDriveBySerial doc comments) and hand back a fresher snapshot.
   */
  async #runStage(
    runId: number,
    stage: StageName,
    stageId: number,
    surfaceMode: RegimeMode | undefined,
    drive: DiscoveredDrive,
    state: RunState,
    controller: AbortController,
    skipSelfTestStart = false,
  ): Promise<DiscoveredDrive> {
    switch (stage) {
      case "SMART_BEFORE":
        state.before = await this.#runSmartStage(runId, drive.devicePath, "before")
        return drive
      case "SMART_AFTER": {
        // The drive may have sat through a long self-test and/or a
        // destructive surface write since it was last resolved — re-resolve
        // by serial rather than trust a stale/possibly-reused device path.
        const fresh = await this.#resolveDriveBySerial(drive.serial)
        if (!fresh) throw new DriveGoneError(drive.serial)
        state.after = await this.#runSmartStage(runId, fresh.devicePath, "after")
        return fresh
      }
      case "SELFTEST_LONG": {
        const result = await this.#runSelfTestStage(
          runId,
          stageId,
          drive.serial,
          drive.devicePath,
          controller,
          skipSelfTestStart,
        )
        state.selfTest = result
        // Persisted so a later reconcile() (e.g. a run interrupted again at
        // SMART_AFTER/VERDICT) can reconstruct this result from the DONE
        // row's metrics without re-running the self-test.
        updateStage(this.db, stageId, { metrics: result })
        return drive
      }
      case "SURFACE": {
        const result = await this.#runSurfaceStage(runId, stageId, surfaceMode!, drive, controller)
        state.surface = result.surface
        return result.drive
      }
      case "VERDICT":
        this.#runVerdictStage(runId, stageId, drive, state)
        return drive
      default: {
        // Exhaustiveness guard: StageName covers exactly these five stages,
        // so this is unreachable — keeps the return type honest without a
        // non-null assertion if a new stage is ever added without updating
        // this switch.
        const unhandled: never = stage
        throw new Error(`unhandled stage: ${String(unhandled)}`)
      }
    }
  }

  async #runSmartStage(
    runId: number,
    devicePath: string,
    phase: "before" | "after",
  ): Promise<SmartKeyMetrics> {
    const raw = await this.deviceApi.readSmartRaw(devicePath)
    const metrics = parseSmartMetrics(raw)
    saveSnapshot(this.db, { runId, phase, raw, keyMetrics: metrics })
    return metrics
  }

  async #runSelfTestStage(
    runId: number,
    stageId: number,
    driveSerial: string,
    devicePath: string,
    controller: AbortController,
    skipStart = false,
  ): Promise<SelfTestResult> {
    // On a reconcile()-resumed run, the firmware self-test itself kept
    // running across the process restart — only this process's tracking of
    // it was interrupted — so starting it again would restart the timer
    // for no reason. Skip straight to polling in that case.
    if (!skipStart) {
      await this.deviceApi.startLongSelfTest(devicePath)
    }
    let result: SelfTestResult = { status: "UNKNOWN" }

    while (!controller.signal.aborted) {
      const progress = await this.deviceApi.pollSelfTest(devicePath)
      const percent = progress.percentRemaining == null ? 0 : 100 - progress.percentRemaining
      this.#emitStageProgress(stageId, { runId, driveSerial, stage: "SELFTEST_LONG", percent })

      if (!progress.running) {
        result = progress.result ?? { status: "UNKNOWN" }
        break
      }
      if (controller.signal.aborted) break
      await this.sleep(this.selfTestPollIntervalMs)
    }

    return result
  }

  async #runSurfaceStage(
    runId: number,
    stageId: number,
    mode: RegimeMode,
    drive: DiscoveredDrive,
    controller: AbortController,
  ): Promise<{ surface: SurfaceResult; drive: DiscoveredDrive }> {
    let devicePath = drive.devicePath
    let currentDrive = drive

    // TOCTOU guard: startRun's safety check ran before the (possibly
    // hours-long) self-test stage. A drive can become mounted/system/
    // protected — or vanish entirely — in that window, so re-resolve and
    // re-check immediately before the destructive write, never trusting
    // the drive snapshot the run started with. Read-only surface scans
    // don't write anything, so they don't need this.
    if (mode === "destructive") {
      const recheck = await this.#recheckDestructiveSafety(drive.serial)
      if (!recheck.allowed) {
        appendAudit(this.db, {
          action: "DESTRUCTIVE_RECHECK_DENIED",
          driveSerial: drive.serial,
          detail: recheck.code,
        })
        throw new SafetyError(recheck.code, `safety re-check failed: ${recheck.code}`)
      }
      // Device paths are transient — use the freshly-resolved one, not the
      // possibly-stale path captured at startRun time. Thread it forward so
      // later stages (SMART_AFTER's own re-resolve, VERDICT) start from it
      // too instead of falling back to the startRun-time snapshot.
      devicePath = recheck.drive.devicePath
      currentDrive = recheck.drive
    }

    const surfaceResult = await this.deviceApi.runSurfaceTest(
      devicePath,
      mode,
      (percent) =>
        this.#emitStageProgress(stageId, {
          runId,
          driveSerial: currentDrive.serial,
          stage: "SURFACE",
          percent,
        }),
      controller.signal,
    )

    // Persist the bad-block count + completed flag for forensics/reconcile
    // regardless of outcome. #run's post-stage abort check is the single
    // source of truth for the final DONE-vs-ABORTED call and harmlessly
    // re-writes `status` afterwards, so it's fine to set it here too.
    updateStage(this.db, stageId, {
      status: surfaceResult.completed ? "DONE" : "ABORTED",
      progress: 100,
      metrics: surfaceResult,
      finishedAt: new Date(),
    })

    return { surface: surfaceResult, drive: currentDrive }
  }

  /** Re-resolves the drive by serial and re-runs the destructive safety check. */
  async #recheckDestructiveSafety(
    serial: string,
  ): Promise<{ allowed: true; drive: DiscoveredDrive } | { allowed: false; code: string }> {
    const fresh = await this.#resolveDriveBySerial(serial)
    if (!fresh) return { allowed: false, code: "DRIVE_GONE" }

    const decision = checkDestructiveAllowed(fresh, { protectList: this.#protectList() })
    if (!decision.allowed) return { allowed: false, code: decision.code }
    return { allowed: true, drive: fresh }
  }

  /**
   * Re-resolves a drive by serial via a fresh `listDevices()` call. Device
   * paths are transient (a device node can be reassigned or reused across a
   * long-running regime), so any stage that still needs to touch the
   * physical device after a long intermediate stage (self-test, surface
   * write) must re-resolve rather than trust a snapshot captured earlier in
   * the run. Returns `undefined` if the drive is no longer present.
   */
  async #resolveDriveBySerial(serial: string): Promise<DiscoveredDrive | undefined> {
    const drives = await this.deviceApi.listDevices()
    return drives.find((d) => d.serial === serial)
  }

  /** Guards against a malformed config throwing a raw TypeError inside a safety check. */
  #protectList(): string[] {
    const cfg = getConfig(this.db)
    return Array.isArray(cfg.protectList) ? (cfg.protectList as string[]) : []
  }

  #runVerdictStage(runId: number, stageId: number, drive: DiscoveredDrive, state: RunState): void {
    const { before, after, selfTest, surface } = state
    if (!before || !after || !selfTest) {
      // Unreachable given the fixed regime stage order, but keeps this
      // method's typing honest without non-null assertions.
      throw new Error("VERDICT stage reached before SMART/self-test stages completed")
    }

    const { verdict, reasons } = evaluateVerdict({
      before,
      after,
      deviceType: drive.type,
      selfTest,
      surface,
      thresholds: getConfig(this.db).thresholds as Thresholds,
    })

    // Mark the run terminal *before* persisting/emitting DONE: abortRun() is
    // a no-op for a terminal run (see there), so a run:update listener that
    // reacts synchronously to this very event by calling abortRun() can
    // never race a second ABORTED transition underneath it.
    this.terminalRuns.add(runId)

    // Persist the VERDICT stage row as DONE *before* marking the run DONE
    // and emitting the terminal run:update — otherwise a listener reacting
    // to that event could read a stage row that's still RUNNING.
    updateStage(this.db, stageId, { status: "DONE", progress: 100, finishedAt: new Date() })
    updateRun(this.db, runId, {
      status: "DONE",
      verdict,
      reasons,
      currentStage: "VERDICT",
      finishedAt: new Date(),
    })
    this.#emitRunUpdate({ runId, driveSerial: drive.serial, status: "DONE", verdict })
  }

  #emitRunUpdate(payload: RunUpdateEvent): void {
    this.emit("run:update", payload)
  }

  #emitStageProgress(stageId: number, payload: StageProgressEvent): void {
    // Persist the rounded percent so a fresh GET/reconnect reflects live
    // progress instead of 0 until the stage completes. Throttled to
    // whole-percent changes to bound DB writes on fast streams (badblocks).
    const pct = Math.max(0, Math.min(100, Math.round(payload.percent)))
    if (this.#lastStageProgress.get(stageId) !== pct) {
      this.#lastStageProgress.set(stageId, pct)
      updateStage(this.db, stageId, { progress: pct })
    }
    this.emit("stage:progress", payload)
  }
}
