import { describe, it, expect, beforeEach } from "vitest"
import type { DiscoveredDrive, RegimeMode } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { FakeDeviceApi } from "../device/fakeDeviceApi"
import { AutoModePoller } from "./autoMode"

const drive = (over: Partial<DiscoveredDrive> = {}): DiscoveredDrive => ({
  devicePath: "/dev/sda",
  serial: "CLEAN1",
  wwn: null,
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  mounted: false,
  isSystemDisk: false,
  ...over,
})

/** Records every startRun call instead of actually executing a regime — the
 * poller only needs to know a run was enqueued for a given serial/mode. */
class EngineSpy {
  readonly calls: { serial: string; mode: RegimeMode }[] = []
  #nextId = 1
  /** Serials this spy reports as already active (Fix 1's isDriveActive
   * guard); overridden per-test where needed, false for everything by
   * default. */
  #activeSerials = new Set<string>()

  async startRun(input: { serial: string; mode: RegimeMode }): Promise<number> {
    this.calls.push(input)
    return this.#nextId++
  }

  isDriveActive(serial: string): boolean {
    return this.#activeSerials.has(serial)
  }

  /** Test helper: makes isDriveActive report true for this serial. */
  markActive(serial: string): void {
    this.#activeSerials.add(serial)
  }
}

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

/**
 * Drains the microtask queue a fixed number of times so promise chains
 * spanning multiple `await` boundaries (loop -> pollOnce-wrapper -> pollOnce)
 * have a chance to settle. Deterministic — no timers/wall-clock involved — a
 * few spare iterations beyond what's strictly needed are harmless no-ops.
 */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

describe("AutoModePoller.pollOnce", () => {
  it("upserts every discovered drive but enqueues none when auto-mode is off", async () => {
    const clean = drive({ serial: "CLEAN1" })
    const mounted = drive({ serial: "MOUNTED1", devicePath: "/dev/sdb", mounted: true })
    const api = new FakeDeviceApi({ drives: [clean, mounted] })
    const engine = new EngineSpy()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    await poller.pollOnce()

    expect(repo.listDrives(db)).toHaveLength(2)
    expect(engine.calls).toEqual([])
  })

  it("enqueues only the eligible drive when auto-mode is on, skipping a mounted/system one, and does not re-enqueue on a later poll", async () => {
    const clean = drive({ serial: "CLEAN1" })
    const mounted = drive({ serial: "MOUNTED1", devicePath: "/dev/sdb", mounted: true })
    const api = new FakeDeviceApi({ drives: [clean, mounted] })
    const engine = new EngineSpy()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    repo.updateConfig(db, { autoModeEnabled: true })

    await poller.pollOnce()

    expect(repo.listDrives(db)).toHaveLength(2)
    expect(engine.calls).toEqual([{ serial: "CLEAN1", mode: "destructive" }])

    const audit = repo.listAudit(db)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: "AUTO_ENQUEUE", driveSerial: "CLEAN1" })

    // Second poll: the clean drive is already enqueued, so it must not fire again.
    await poller.pollOnce()

    expect(engine.calls).toHaveLength(1)
    expect(repo.listAudit(db)).toHaveLength(1)
  })

  it("never enqueues a drive on the protect list", async () => {
    const protectedDrive = drive({ serial: "PROTECTED1" })
    const api = new FakeDeviceApi({ drives: [protectedDrive] })
    const engine = new EngineSpy()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    repo.updateConfig(db, { autoModeEnabled: true, protectList: ["PROTECTED1"] })

    await poller.pollOnce()

    expect(repo.listDrives(db)).toHaveLength(1)
    expect(engine.calls).toEqual([])
    expect(repo.listAudit(db)).toHaveLength(0)
  })

  it("does not call startRun for a drive the engine reports as already active (Fix 1 belt-and-suspenders)", async () => {
    const clean = drive({ serial: "CLEAN1" })
    const api = new FakeDeviceApi({ drives: [clean] })
    const engine = new EngineSpy()
    // Simulates the drive already having an active run in this process via
    // a different path (e.g. a boot-time reconcile() resume) that this
    // poller's own #enqueued set was never told about.
    engine.markActive("CLEAN1")
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    repo.updateConfig(db, { autoModeEnabled: true })

    await poller.pollOnce()

    expect(repo.listDrives(db)).toHaveLength(1)
    expect(engine.calls).toEqual([])
    expect(repo.listAudit(db)).toHaveLength(0)
  })

  it("does not reject when listDevices() throws (e.g. missing smartctl/lsblk), so the poll loop survives a discovery failure", async () => {
    class FailingDeviceApi extends FakeDeviceApi {
      override async listDevices(): Promise<DiscoveredDrive[]> {
        throw new Error("smartctl: command not found")
      }
    }
    const api = new FailingDeviceApi()
    const engine = new EngineSpy()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    await expect(poller.pollOnce()).resolves.toBeUndefined()

    expect(repo.listDrives(db)).toHaveLength(0)
    expect(engine.calls).toEqual([])
  })

  it("isolates a per-drive startRun failure so other drives still get enqueued and the failing one isn't marked enqueued", async () => {
    const clean = drive({ serial: "CLEAN1" })
    const other = drive({ serial: "CLEAN2", devicePath: "/dev/sdc" })
    const api = new FakeDeviceApi({ drives: [clean, other] })

    class FlakyEngine extends EngineSpy {
      override async startRun(input: { serial: string; mode: RegimeMode }): Promise<number> {
        if (input.serial === "CLEAN1") throw new Error("race: drive became unsafe")
        return super.startRun(input)
      }
    }
    const engine = new FlakyEngine()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    repo.updateConfig(db, { autoModeEnabled: true })

    await expect(poller.pollOnce()).resolves.toBeUndefined()

    expect(engine.calls).toEqual([{ serial: "CLEAN2", mode: "destructive" }])
    expect(repo.listAudit(db).map((a) => a.driveSerial)).toEqual(["CLEAN2"])
  })
})

describe("AutoModePoller.start/stop", () => {
  it("polls on the injected sleep interval until stopped, without using real timers", async () => {
    const clean = drive({ serial: "CLEAN1" })
    const api = new FakeDeviceApi({ drives: [clean] })
    const engine = new EngineSpy()

    const sleepCalls: number[] = []
    let resolveSleep: (() => void) | undefined
    const sleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      return new Promise((resolve) => {
        resolveSleep = resolve
      })
    }

    const poller = new AutoModePoller({ db, deviceApi: api, engine, intervalMs: 1234, sleep })

    poller.start()
    // Let the first pollOnce() (and its subsequent sleep call) land.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(repo.listDrives(db)).toHaveLength(1)
    expect(sleepCalls).toEqual([1234])

    await poller.stop()
    resolveSleep?.()
    await Promise.resolve()
    await Promise.resolve()

    // Loop must not schedule a second sleep once stopped.
    expect(sleepCalls).toEqual([1234])
  })

  it("keeps the running loop alive (and never produces an unhandled rejection) after pollOnce() throws", async () => {
    // Overrides the public pollOnce() that #loop() drives, rather than
    // faking listDevices()/getConfig() failures individually, so this test
    // proves the *loop-level* guard (Fix 1) — the backstop that catches ANY
    // pollOnce() rejection, not just the listDevices() one pollOnce() already
    // guards internally.
    class FlakyPoller extends AutoModePoller {
      calls = 0
      override async pollOnce(): Promise<void> {
        this.calls++
        if (this.calls === 1) {
          throw new Error("boom: simulated pollOnce failure")
        }
      }
    }

    const api = new FakeDeviceApi({ drives: [] })
    const engine = new EngineSpy()

    const sleepCalls: number[] = []
    let resolveSleep: (() => void) | undefined
    const sleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      return new Promise((resolve) => {
        resolveSleep = resolve
      })
    }

    const poller = new FlakyPoller({ db, deviceApi: api, engine, intervalMs: 10, sleep })

    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (err: unknown): void => {
      unhandledRejections.push(err)
    }
    process.on("unhandledRejection", onUnhandledRejection)

    try {
      poller.start()
      await flushMicrotasks()

      // The first, throwing cycle ran and the loop parked on its sleep call
      // — proof the throw was caught inside #loop rather than escaping it.
      expect(poller.calls).toBe(1)
      expect(sleepCalls).toEqual([10])

      resolveSleep?.()
      await flushMicrotasks()

      // A second, succeeding cycle followed the throw: the loop survived.
      expect(poller.calls).toBe(2)
      expect(sleepCalls).toEqual([10, 10])

      await flushMicrotasks()
      expect(unhandledRejections).toEqual([])
    } finally {
      resolveSleep?.()
      await poller.stop()
      process.off("unhandledRejection", onUnhandledRejection)
    }
  })

  it("stop() awaits an in-flight pollOnce() cycle before resolving, instead of racing it", async () => {
    const api = new FakeDeviceApi({ drives: [] })
    const engine = new EngineSpy()

    let pollOnceStarted = false
    let releasePollOnce: (() => void) | undefined

    class SlowPoller extends AutoModePoller {
      override async pollOnce(): Promise<void> {
        pollOnceStarted = true
        await new Promise<void>((resolve) => {
          releasePollOnce = resolve
        })
      }
    }

    const sleepCalls: number[] = []
    const sleep = (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      return new Promise(() => {
        // Never resolves; stop() is expected to interrupt the loop before it
        // would be reached (the in-flight cycle hasn't finished yet).
      })
    }

    const poller = new SlowPoller({ db, deviceApi: api, engine, intervalMs: 10, sleep })

    poller.start()
    await flushMicrotasks()
    expect(pollOnceStarted).toBe(true)

    let stopResolved = false
    const stopPromise = poller.stop().then(() => {
      stopResolved = true
    })

    await flushMicrotasks()
    // Must not resolve while the in-flight cycle is still pending — this is
    // the race main.ts's stop() depends on being closed (db closed under a
    // mid-cycle poll).
    expect(stopResolved).toBe(false)
    expect(sleepCalls).toEqual([])

    releasePollOnce?.()
    await stopPromise

    expect(stopResolved).toBe(true)
  })

  it("stop() resolves cleanly when called on an idle poller (never started)", async () => {
    const api = new FakeDeviceApi({ drives: [] })
    const engine = new EngineSpy()
    const poller = new AutoModePoller({ db, deviceApi: api, engine })

    await expect(poller.stop()).resolves.toBeUndefined()
  })
})
