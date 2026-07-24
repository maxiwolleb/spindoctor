import { describe, it, expect } from "vitest"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { FakeDeviceApi } from "./fakeDeviceApi"

const d: DiscoveredDrive = {
  devicePath: "/dev/sda", serial: "S1", wwn: null, model: "M", sizeBytes: 1,
  type: "HDD", transport: "SATA", mounted: false, isSystemDisk: false,
}

describe("FakeDeviceApi", () => {
  it("returns seeded drives and smart data, and records self-test starts", async () => {
    const api = new FakeDeviceApi({ drives: [d], smartByPath: { "/dev/sda": { ok: 1 } } })
    expect(await api.listDevices()).toEqual([d])
    expect(await api.readSmartRaw("/dev/sda")).toEqual({ ok: 1 })
    await api.startLongSelfTest("/dev/sda")
    expect(api.started).toEqual(["/dev/sda"])
  })
  it("throws for unknown SMART path", async () => {
    const api = new FakeDeviceApi()
    await expect(api.readSmartRaw("/dev/x")).rejects.toThrow(/no SMART data/)
  })
})

describe("FakeDeviceApi.runSurfaceTest", () => {
  it("drives onProgress through the default plan and resolves completed", async () => {
    const api = new FakeDeviceApi()
    const percents: number[] = []
    const result = await api.runSurfaceTest(
      "/dev/sda",
      "destructive",
      (p) => percents.push(p),
      new AbortController().signal,
    )
    expect(percents).toEqual([25, 50, 75, 100])
    expect(result).toEqual({ mode: "write", badBlocks: 0, completed: true })
  })

  it("resolves completed:false when the signal is already aborted", async () => {
    const api = new FakeDeviceApi()
    const controller = new AbortController()
    controller.abort()
    const percents: number[] = []
    const result = await api.runSurfaceTest(
      "/dev/sda",
      "read-only",
      (p) => percents.push(p),
      controller.signal,
    )
    expect(percents).toEqual([])
    expect(result).toEqual({ mode: "read-only", badBlocks: 0, completed: false })
  })

  it("resolves completed:false when aborted mid-plan", async () => {
    const api = new FakeDeviceApi()
    const controller = new AbortController()
    const percents: number[] = []
    const result = await api.runSurfaceTest(
      "/dev/sda",
      "destructive",
      (p) => {
        percents.push(p)
        if (p === 25) controller.abort()
      },
      controller.signal,
    )
    expect(percents).toEqual([25])
    expect(result).toEqual({ mode: "write", badBlocks: 0, completed: false })
  })

  it("resolves a custom result when the plan finishes uninterrupted", async () => {
    const api = new FakeDeviceApi({
      surface: { plan: [50, 100], result: { mode: "read-only", badBlocks: 3, completed: true } },
    })
    const percents: number[] = []
    const result = await api.runSurfaceTest(
      "/dev/sdb",
      "read-only",
      (p) => percents.push(p),
      new AbortController().signal,
    )
    expect(percents).toEqual([50, 100])
    expect(result).toEqual({ mode: "read-only", badBlocks: 3, completed: true })
  })

  it("records calls in surfaceCalls", async () => {
    const api = new FakeDeviceApi()
    await api.runSurfaceTest("/dev/sdb", "read-only", () => {}, new AbortController().signal)
    await api.runSurfaceTest("/dev/sda", "destructive", () => {}, new AbortController().signal)
    expect(api.surfaceCalls).toEqual([
      { devicePath: "/dev/sdb", mode: "read-only" },
      { devicePath: "/dev/sda", mode: "destructive" },
    ])
  })
})
