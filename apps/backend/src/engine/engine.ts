import { EventEmitter } from "node:events"
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
import {
  addStage,
  appendAudit,
  createRun,
  getConfig,
  saveSnapshot,
  updateRun,
  updateStage,
  upsertDrive,
} from "../db/repositories"
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
  /** Run ids that have reached a terminal DB status (DONE/FAILED/ABORTED).
   * Never pruned: once a run is terminal it must stay that way forever, so
   * `abortRun` needs to keep no-op'ing for that id even long after the
   * controller itself has been cleaned up. */
  private readonly terminalRuns = new Set<number>()

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
    const drives = await this.deviceApi.listDevices()
    const drive = drives.find((d) => d.serial === serial)
    if (!drive) throw new DriveNotFoundError(serial)

    if (mode === "destructive") {
      const decision = checkDestructiveAllowed(drive, { protectList: this.#protectList() })
      if (!decision.allowed) {
        appendAudit(this.db, { action: "DESTRUCTIVE_DENIED", driveSerial: serial, detail: decision.code })
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
    // risk.
    void this.#execute(runId, drive, mode, controller)

    return runId
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
        this.#emitRunUpdate({ runId, status: "FAILED" })
      } catch {
        // Truly last resort (e.g. the DB itself is broken): swallow rather
        // than crash the process from a background task.
      }
    } finally {
      release()
      this.controllers.delete(runId)
    }
  }

  async #run(runId: number, drive: DiscoveredDrive, mode: RegimeMode, controller: AbortController): Promise<void> {
    updateRun(this.db, runId, { status: "RUNNING" })
    const state: RunState = { surface: null }
    // Device paths are transient, so this is reassigned whenever a stage
    // re-resolves the drive (SURFACE's destructive re-check, SMART_AFTER's
    // fresh by-serial lookup) — every later stage, including VERDICT, uses
    // whatever is current at the time it runs.
    let currentDrive = drive

    for (const { stage, surfaceMode } of regimeStages(mode)) {
      if (controller.signal.aborted) {
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, { status: "ABORTED", finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "ABORTED", currentStage: stage })
        return
      }

      const stageId = addStage(this.db, { runId, stage, status: "RUNNING" })
      this.#emitRunUpdate({ runId, status: "RUNNING", currentStage: stage })

      try {
        currentDrive = await this.#runStage(runId, stage, stageId, surfaceMode, currentDrive, state, controller)
      } catch (err) {
        updateStage(this.db, stageId, { status: "FAILED" })
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, { status: "FAILED", error: String(err), finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "FAILED" })
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
        updateStage(this.db, stageId, { status: "ABORTED" })
        this.terminalRuns.add(runId)
        updateRun(this.db, runId, { status: "ABORTED", currentStage: stage, finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "ABORTED", currentStage: stage })
        return
      }

      // Idempotent: SURFACE already persists its own terminal status (see
      // #runSurfaceStage) before this point, so that a listener reacting to
      // an ABORTED run:update event never observes a stale RUNNING stage
      // row. This call is a harmless no-op re-write for it and the normal
      // completion path for every other non-VERDICT stage.
      updateStage(this.db, stageId, { status: "DONE", progress: 100 })
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
      case "SELFTEST_LONG":
        state.selfTest = await this.#runSelfTestStage(runId, drive.devicePath, controller)
        return drive
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
    devicePath: string,
    controller: AbortController,
  ): Promise<SelfTestResult> {
    await this.deviceApi.startLongSelfTest(devicePath)
    let result: SelfTestResult = { status: "UNKNOWN" }

    while (!controller.signal.aborted) {
      const progress = await this.deviceApi.pollSelfTest(devicePath)
      const percent = progress.percentRemaining == null ? 0 : 100 - progress.percentRemaining
      this.#emitStageProgress({ runId, stage: "SELFTEST_LONG", percent })

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
      (percent) => this.#emitStageProgress({ runId, stage: "SURFACE", percent }),
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
    updateStage(this.db, stageId, { status: "DONE", progress: 100 })
    updateRun(this.db, runId, {
      status: "DONE",
      verdict,
      reasons,
      currentStage: "VERDICT",
      finishedAt: new Date(),
    })
    this.#emitRunUpdate({ runId, status: "DONE", verdict })
  }

  #emitRunUpdate(payload: RunUpdateEvent): void {
    this.emit("run:update", payload)
  }

  #emitStageProgress(payload: StageProgressEvent): void {
    this.emit("stage:progress", payload)
  }
}
