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
