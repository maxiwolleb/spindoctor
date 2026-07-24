import type { RegimeMode } from "@spindoctor/shared"
import type { Db } from "../db/client"
import type { DeviceApi } from "../device/deviceApi"
import { appendAudit, getConfig, upsertDrive } from "../db/repositories"
import { checkDestructiveAllowed } from "../safety/guards"

/**
 * The only slice of TestEngine the poller needs. Kept as a small structural
 * interface (not the concrete class) so tests can hand it a spy instead of a
 * real engine.
 */
export interface AutoModeEngine {
  startRun(input: { serial: string; mode: RegimeMode }): Promise<number>
}

export interface AutoModePollerDeps {
  db: Db
  deviceApi: DeviceApi
  engine: AutoModeEngine
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
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
  /**
   * Serials already enqueued for a destructive run, tracked in-memory for
   * this process's lifetime so a drive isn't re-enqueued on every poll.
   * A drive denied by the safety guard is deliberately NOT added here, so
   * if it later becomes eligible (unmounted, taken off the protect list) a
   * future poll can still pick it up.
   */
  readonly #enqueued = new Set<string>()
  #running = false

  constructor(deps: AutoModePollerDeps) {
    this.#db = deps.db
    this.#deviceApi = deps.deviceApi
    this.#engine = deps.engine
    this.#intervalMs = deps.intervalMs ?? 30_000
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async pollOnce(): Promise<void> {
    const drives = await this.#deviceApi.listDevices()
    for (const d of drives) {
      upsertDrive(this.#db, d)
    }

    const cfg = getConfig(this.#db)
    if (!cfg.autoModeEnabled) return

    const protectList = Array.isArray(cfg.protectList) ? (cfg.protectList as string[]) : []

    for (const drive of drives) {
      if (this.#enqueued.has(drive.serial)) continue

      const decision = checkDestructiveAllowed(drive, { protectList })
      if (!decision.allowed) continue

      try {
        await this.#engine.startRun({ serial: drive.serial, mode: "destructive" })
        appendAudit(this.#db, { action: "AUTO_ENQUEUE", driveSerial: drive.serial })
        this.#enqueued.add(drive.serial)
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

  /** Stops the poll loop after its current `sleep` resolves. */
  stop(): void {
    this.#running = false
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      await this.pollOnce()
      await this.#sleep(this.#intervalMs)
    }
  }
}
