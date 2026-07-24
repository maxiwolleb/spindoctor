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

  abortRun(runId: number): void {
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

    for (const { stage, surfaceMode } of regimeStages(mode)) {
      if (controller.signal.aborted) {
        updateRun(this.db, runId, { status: "ABORTED", finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "ABORTED", currentStage: stage })
        return
      }

      const stageId = addStage(this.db, { runId, stage, status: "RUNNING" })
      this.#emitRunUpdate({ runId, status: "RUNNING", currentStage: stage })

      try {
        await this.#runStage(runId, stage, stageId, surfaceMode, drive, state, controller)
      } catch (err) {
        updateStage(this.db, stageId, { status: "FAILED" })
        updateRun(this.db, runId, { status: "FAILED", error: String(err), finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "FAILED" })
        return
      }

      // Stages return cooperatively on abort (they don't throw), so check
      // right here — not on the next loop iteration — or the interrupted
      // stage gets mis-recorded DONE and the reported currentStage becomes
      // the *next* stage instead of the one that was actually interrupted.
      if (controller.signal.aborted) {
        updateStage(this.db, stageId, { status: "ABORTED" })
        updateRun(this.db, runId, { status: "ABORTED", currentStage: stage, finishedAt: new Date() })
        this.#emitRunUpdate({ runId, status: "ABORTED", currentStage: stage })
        return
      }

      // Idempotent: VERDICT and SURFACE already persist their own terminal
      // status (see #runVerdictStage and #runSurfaceStage) before this
      // point, so that a listener reacting to the terminal run:update event
      // never observes a stale RUNNING stage row. This call is a harmless
      // no-op re-write for them and the normal completion path for every
      // other stage.
      updateStage(this.db, stageId, { status: "DONE", progress: 100 })
    }
  }

  async #runStage(
    runId: number,
    stage: StageName,
    stageId: number,
    surfaceMode: RegimeMode | undefined,
    drive: DiscoveredDrive,
    state: RunState,
    controller: AbortController,
  ): Promise<void> {
    switch (stage) {
      case "SMART_BEFORE":
        state.before = await this.#runSmartStage(runId, drive.devicePath, "before")
        return
      case "SMART_AFTER":
        state.after = await this.#runSmartStage(runId, drive.devicePath, "after")
        return
      case "SELFTEST_LONG":
        state.selfTest = await this.#runSelfTestStage(runId, drive.devicePath, controller)
        return
      case "SURFACE":
        state.surface = await this.#runSurfaceStage(runId, stageId, surfaceMode!, drive, controller)
        return
      case "VERDICT":
        this.#runVerdictStage(runId, stageId, drive, state)
        return
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
  ): Promise<SurfaceResult> {
    let devicePath = drive.devicePath

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
      // possibly-stale path captured at startRun time.
      devicePath = recheck.drive.devicePath
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

    return surfaceResult
  }

  /** Re-resolves the drive by serial and re-runs the destructive safety check. */
  async #recheckDestructiveSafety(
    serial: string,
  ): Promise<{ allowed: true; drive: DiscoveredDrive } | { allowed: false; code: string }> {
    const drives = await this.deviceApi.listDevices()
    const fresh = drives.find((d) => d.serial === serial)
    if (!fresh) return { allowed: false, code: "DRIVE_GONE" }

    const decision = checkDestructiveAllowed(fresh, { protectList: this.#protectList() })
    if (!decision.allowed) return { allowed: false, code: decision.code }
    return { allowed: true, drive: fresh }
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
