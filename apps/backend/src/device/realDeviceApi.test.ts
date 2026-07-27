import { describe, it, expect } from "vitest"
import type { CommandRunner } from "./runner"
import { RealDeviceApi } from "./realDeviceApi"
import lsblk from "./__fixtures__/lsblk.json"
import scan from "./__fixtures__/smartctl-scan.json"
import ataHealthy from "./__fixtures__/ata-healthy.json"
import ataSelfTestProgress from "./__fixtures__/ata-selftest-progress.json"

function fakeRunner(map: Record<string, { stdout: string; code?: number }>): CommandRunner {
  return {
    async run(cmd, args) {
      const key = [cmd, ...args].join(" ")
      const hit = Object.entries(map).find(([k]) => key.includes(k))
      if (!hit) throw new Error(`unexpected command: ${key}`)
      return { stdout: hit[1].stdout, stderr: "", code: hit[1].code ?? 0 }
    },
  }
}

describe("RealDeviceApi", () => {
  it("lists devices by combining lsblk and scan", async () => {
    const api = new RealDeviceApi(
      fakeRunner({
        lsblk: { stdout: JSON.stringify(lsblk) },
        "smartctl --scan": { stdout: JSON.stringify(scan) },
      }),
    )
    const drives = await api.listDevices()
    expect(drives.map((d) => d.serial).sort()).toEqual(["S4EWNX0M", "WD-WCC7K1", "ZFL9AB"])
  })

  // The lsblk fixture contains a serial-less disk (sdc), which discovery drops.
  // listDevices runs on every auto-mode poll, so the warning has to be logged
  // once per device+reason and not on every cycle.
  it("warns once per ignored device, not on every poll", async () => {
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (msg: unknown) => void warnings.push(String(msg))
    try {
      const api = new RealDeviceApi(
        fakeRunner({
          lsblk: { stdout: JSON.stringify(lsblk) },
          "smartctl --scan": { stdout: JSON.stringify(scan) },
        }),
      )
      await api.listDevices()
      await api.listDevices()
      await api.listDevices()
    } finally {
      console.warn = warn
    }

    expect(warnings.filter((w) => w.includes("/dev/sdc"))).toHaveLength(1)
    expect(warnings[0]).toMatch(/no serial/)
    expect(warnings[0]).toMatch(/udev/)
  })

  it("parses SMART even when smartctl exits non-zero (bitmask)", async () => {
    const api = new RealDeviceApi(
      fakeRunner({ "smartctl -x": { stdout: JSON.stringify(ataHealthy), code: 4 } }),
    )
    const raw = (await api.readSmartRaw("/dev/sda")) as { model_name: string }
    expect(raw.model_name).toBe("WDC WD40EFRX-68N32N0")
  })

  it("starts a long self-test with the right args", async () => {
    const calls: string[] = []
    const runner: CommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(" "))
        return { stdout: "", stderr: "", code: 0 }
      },
    }
    await new RealDeviceApi(runner).startLongSelfTest("/dev/sda")
    expect(calls[0]).toBe("smartctl -t long /dev/sda")
  })

  it("aborts a running self-test with smartctl -X", async () => {
    const calls: string[] = []
    const runner: CommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(" "))
        return { stdout: "", stderr: "", code: 0 }
      },
    }
    await new RealDeviceApi(runner).abortSelfTest("/dev/sda")
    expect(calls[0]).toBe("smartctl -X /dev/sda")
  })

  it("reports a self-test in progress", async () => {
    const api = new RealDeviceApi(
      fakeRunner({ "smartctl -x": { stdout: JSON.stringify(ataSelfTestProgress) } }),
    )
    const progress = await api.pollSelfTest("/dev/sda")
    expect(progress).toEqual({ running: true, percentRemaining: 60, result: null })
  })

  it("reports a finished self-test result", async () => {
    const api = new RealDeviceApi(
      fakeRunner({ "smartctl -x": { stdout: JSON.stringify(ataHealthy) } }),
    )
    const progress = await api.pollSelfTest("/dev/sda")
    expect(progress).toEqual({
      running: false,
      percentRemaining: null,
      result: { status: "PASSED" },
    })
  })
})
