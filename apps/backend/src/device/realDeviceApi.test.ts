import { describe, it, expect } from "vitest"
import pino from "pino"
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
    // A real pino writing into memory, so this exercises the logging path the
    // container actually uses rather than a stubbed console.
    const lines: string[] = []
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) })

    const api = new RealDeviceApi(
      fakeRunner({
        lsblk: { stdout: JSON.stringify(lsblk) },
        "smartctl --scan": { stdout: JSON.stringify(scan) },
      }),
      { logger },
    )
    await api.listDevices()
    await api.listDevices()
    await api.listDevices()

    expect(lines.filter((l) => l.includes("/dev/sdc"))).toHaveLength(1)
    expect(lines[0]).toMatch(/no serial/)
    // No udev hint here: this fixture discovers three drives, so the mount is
    // evidently fine. Whether the hint is appended is covered both ways in
    // discovery.test.ts.
    expect(lines[0]).not.toMatch(/udev/)
    // Structured, not a formatted string — the point of #17.
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ devicePath: "/dev/sdc" })
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

// smartctl exits 0 whether or not it started anything, so the only signal that a
// drive cannot run a self-test is what it printed. Real output from a Realtek
// RTL9210 NVMe enclosure under smartmontools 7.4.
describe("RealDeviceApi.startLongSelfTest support detection", () => {
  function apiWith(stdout: string, stderr = "") {
    const runner: CommandRunner = {
      run: async () => ({ stdout, stderr, code: 0 }),
    }
    return new RealDeviceApi(runner)
  }

  it("reports not started when the drive says self-tests are unsupported", async () => {
    const real = `smartctl 7.4 2023-08-01 r5530 [x86_64-linux] (local build)

Self-tests not supported
`
    expect(await apiWith(real).startLongSelfTest("/dev/sdb")).toBe(false)
  })

  it("matches the singular spelling and other casings too", async () => {
    expect(await apiWith("Self-test not supported").startLongSelfTest("/dev/sdb")).toBe(false)
    expect(await apiWith("SELF-TESTS NOT SUPPORTED").startLongSelfTest("/dev/sdb")).toBe(false)
    expect(await apiWith("self tests not supported").startLongSelfTest("/dev/sdb")).toBe(false)
  })

  it("reads the message from stderr as well as stdout", async () => {
    expect(await apiWith("", "Self-tests not supported").startLongSelfTest("/dev/sdb")).toBe(false)
  })

  it("reports started for the normal ATA response", async () => {
    const ok = `Sending command: "Execute SMART Extended self-test routine immediately in off-line mode".
Drive command "Execute SMART Extended self-test routine immediately in off-line mode" successful.
Testing has begun.
`
    expect(await apiWith(ok).startLongSelfTest("/dev/sda")).toBe(true)
  })
})
