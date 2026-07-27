import type { DiscoveredDrive, RegimeMode } from "@spindoctor/shared"
import type { Db } from "../db/client"
import type { DeviceApi } from "../device/deviceApi"
import { appendAudit, getConfig, upsertDrive } from "../db/repositories"
import { silentLogger, type Logger } from "../logger"
import { checkDestructiveAllowed } from "../safety/guards"

/**
 * The only slice of TestEngine the poller needs. Kept as a small structural
 * interface (not the concrete class) so tests can hand it a spy instead of a
 * real engine.
 */
export interface AutoModeEngine {
  startRun(input: { serial: string; mode: RegimeMode }): Promise<number>
  /** True while `serial` already has a run active in this process (via
   * `startRun` or a `reconcile()` resume) — consulted so the poller doesn't
   * enqueue a second destructive run against a drive a boot-time reconcile
   * is already driving. */
  isDriveActive(serial: string): boolean
}

export interface AutoModePollerDeps {
  db: Db
  deviceApi: DeviceApi
  engine: AutoModeEngine
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Structured logger; silent by default so tests stay quiet. */
  logger?: Logger
}

/**
 * Polls discovery on an interval. Every poll upserts whatever drives are
 * currently attached regardless of auto-mode state, so the drive inventory
 * stays live even while auto-mode is off. Only when auto-mode is enabled
 * does it enqueue destructive runs — one per newly-eligible drive, gated by
 * the same safety guard destructive starts always go through.
 */
export class AutoModePoller {
  readonly #db: Db
  readonly #deviceApi: DeviceApi
  readonly #engine: AutoModeEngine
  readonly #intervalMs: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #log: Logger
  /**
   * Serials already enqueued for a destructive run, tracked in-memory for
   * this process's lifetime so a drive isn't re-enqueued on every poll.
   * A drive denied by the safety guard is deliberately NOT added here, so
   * if it later becomes eligible (unmounted, taken off the protect list) a
   * future poll can still pick it up.
   */
  readonly #enqueued = new Set<string>()
  #running = false
  /**
   * The in-flight poll cycle (wrapped so it can never reject — see
   * `#runPollCycle`), tracked so `stop()` can await the currently-executing
   * cycle instead of returning while a poll is still mid-DB-call. `null`
   * whenever no cycle is in flight (including the whole time the loop is
   * parked in `#sleep`).
   */
  #current: Promise<void> | null = null

  constructor(deps: AutoModePollerDeps) {
    this.#db = deps.db
    this.#deviceApi = deps.deviceApi
    this.#engine = deps.engine
    this.#intervalMs = deps.intervalMs ?? 30_000
    this.#log = deps.logger ?? silentLogger()
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async pollOnce(): Promise<void> {
    let drives: DiscoveredDrive[]
    try {
      drives = await this.#deviceApi.listDevices()
    } catch {
      // Discovery is best-effort on every poll: a transient failure (a
      // missing/misbehaving CLI tool, a permission error, a drive vanishing
      // mid-scan) must not take down the poll loop — and with it the whole
      // process, since #loop's fire-and-forget dispatch has nothing above it
      // to catch a rejection. Skip this cycle; the next poll retries.
      return
    }
    for (const d of drives) {
      upsertDrive(this.#db, d)
    }

    const cfg = getConfig(this.#db)
    if (!cfg.autoModeEnabled) return

    const protectList = Array.isArray(cfg.protectList) ? (cfg.protectList as string[]) : []

    for (const drive of drives) {
      if (this.#enqueued.has(drive.serial)) continue
      // Belt-and-suspenders alongside #enqueued: catches a drive with a run
      // already active in this process via a different path (e.g. a
      // boot-time reconcile() resume) that this poller was never told
      // about directly.
      if (this.#engine.isDriveActive(drive.serial)) continue

      const decision = checkDestructiveAllowed(drive, { protectList })
      if (!decision.allowed) continue

      try {
        await this.#engine.startRun({ serial: drive.serial, mode: "destructive" })
        // Marked immediately on success — before appendAudit — so an audit
        // write failure can't leave the drive un-enqueued and get it
        // re-enqueued (and a second run started) on the next poll.
        this.#enqueued.add(drive.serial)
        appendAudit(this.#db, { action: "AUTO_ENQUEUE", driveSerial: drive.serial })
        this.#log.info({ driveSerial: drive.serial }, "auto-mode enqueued a destructive run")
      } catch {
        // Per-drive isolation: e.g. a race where the drive became unsafe (or
        // vanished) between the check above and startRun actually resolving
        // it. One failure must not abort the rest of the poll, and the
        // drive is deliberately left out of `#enqueued` so a later poll can
        // retry it.
      }
    }
  }

  /** Starts the poll loop, driven by the injected `sleep` — never real timers. */
  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#loop()
  }

  /**
   * Stops the poll loop and awaits the currently-executing cycle (if any)
   * before resolving, so a caller (e.g. server shutdown) that closes the
   * db/app right after `stop()` resolves can't race an in-flight poll that's
   * still mid-DB-call. Does not wait out an in-progress `sleep` — once
   * `#running` flips false the loop exits at the top of its next iteration
   * without starting another cycle.
   */
  async stop(): Promise<void> {
    this.#running = false
    if (this.#current) {
      await this.#current
    }
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const cycle = this.#runPollCycle()
      this.#current = cycle
      await cycle
      this.#current = null
      // Stop was requested mid-cycle: exit now rather than sleeping first.
      if (!this.#running) break
      await this.#sleep(this.#intervalMs)
    }
  }

  /**
   * Runs one `pollOnce()`, converting any rejection into a single log line.
   * `#loop()` is dispatched fire-and-forget (`void this.#loop()`) with
   * nothing above it to `.catch()`, so without this guard ANY throw from
   * `pollOnce()` — not just the `listDevices()` failure it already guards
   * internally — becomes an unhandled rejection that crashes the whole
   * process (e.g. `getConfig()` or the `upsertDrive`/`startRun` loop
   * throwing). This is the crash backstop on top of that inner guard;
   * `pollOnce()` itself still rejects as normal for direct callers.
   */
  async #runPollCycle(): Promise<void> {
    try {
      await this.pollOnce()
    } catch (err) {
      this.#log.error({ err }, "auto-mode poll cycle failed")
    }
  }
}
