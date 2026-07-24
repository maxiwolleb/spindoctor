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

  async startRun(input: { serial: string; mode: RegimeMode }): Promise<number> {
    this.calls.push(input)
    return this.#nextId++
  }
}

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

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

    poller.stop()
    resolveSleep?.()
    await Promise.resolve()
    await Promise.resolve()

    // Loop must not schedule a second sleep once stopped.
    expect(sleepCalls).toEqual([1234])
  })
})
