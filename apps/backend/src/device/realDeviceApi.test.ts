import { describe, it, expect, vi } from "vitest"
import pino from "pino"
import type { CommandRunner } from "./runner"
import { RealDeviceApi, isProcessAlive } from "./realDeviceApi"
import { checkRunAllowed } from "../safety/guards"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ChildProcess } from "node:child_process"

const emulatorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "__testhelpers__",
  "fake-badblocks.mjs",
)
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

// Issue #83: `mounted`/`isSystemDisk` come from `lsblk`, which reports only the
// calling process's mount namespace. Inside the container — the deployment this
// project ships as — the host's `/` and `/boot` are not mounted, so no host drive
// reported a mountpoint and both guards were structurally unable to fire, for the
// host's own system disk included. `listDevices` now also asks the kernel, which
// answers the same in any namespace.
//
// In the lsblk fixture: sda is mounted (/mnt/data), nvme0n1 is the system disk
// (/ + /boot/efi), and sdb (ZFL9AB) is the clean drive — so sdb is the one that
// isolates the new behavior from what lsblk already caught.
describe("RealDeviceApi kernel claim probe (#83)", () => {
  const CLEAN_SERIAL = "ZFL9AB"

  const runner = () =>
    fakeRunner({
      lsblk: { stdout: JSON.stringify(lsblk) },
      "smartctl --scan": { stdout: JSON.stringify(scan) },
    })

  const rejectWith = (code: string) => async () => {
    const err = new Error(code) as NodeJS.ErrnoException
    err.code = code
    throw err
  }

  it("marks every discovered drive with the probe result", async () => {
    const api = new RealDeviceApi(runner(), { exclusiveOpener: async () => {} })

    const drives = await api.listDevices()

    expect(drives).toHaveLength(3)
    expect(drives.every((d) => d.claim === "free")).toBe(true)
  })

  it("refuses a drive the kernel says is busy even though lsblk shows no mountpoint", async () => {
    const api = new RealDeviceApi(runner(), { exclusiveOpener: rejectWith("EBUSY") })

    const clean = (await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)

    // Precisely the container's view of a mounted host drive: nothing visible in
    // the mount table, but the kernel refuses exclusive access.
    expect(clean).toMatchObject({ mounted: false, isSystemDisk: false, claim: "claimed" })
    expect(checkRunAllowed(clean!, { protectList: [] })).toMatchObject({
      allowed: false,
      code: "IN_USE",
    })
  })

  it("probes each discovered drive by its own device path", async () => {
    const probed: string[] = []
    const api = new RealDeviceApi(runner(), {
      exclusiveOpener: async (path) => void probed.push(path),
    })

    const drives = await api.listDevices()

    expect(probed.sort()).toEqual(drives.map((d) => d.devicePath).sort())
  })

  it("leaves an unknown claim non-blocking rather than refusing everything", async () => {
    const api = new RealDeviceApi(runner(), { exclusiveOpener: rejectWith("EACCES") })

    const clean = (await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)

    expect(clean?.claim).toBe("unknown")
    // Denying on unknown would leave the tool unable to test anything wherever
    // the probe is unavailable. The unknown is logged and surfaced instead.
    expect(checkRunAllowed(clean!, { protectList: [] })).toEqual({ allowed: true })
  })

  it("warns once per device when the probe cannot answer, not on every poll", async () => {
    const lines: string[] = []
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) })
    const api = new RealDeviceApi(runner(), {
      logger,
      exclusiveOpener: rejectWith("EACCES"),
    })

    await api.listDevices()
    await api.listDevices()
    await api.listDevices()

    // Three discovered drives, one warning each — `listDevices` runs on every
    // auto-mode poll.
    expect(lines.filter((l) => l.includes("could not determine whether"))).toHaveLength(3)
  })

  it("says nothing about drives whose claim it could establish", async () => {
    const lines: string[] = []
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) })
    const api = new RealDeviceApi(runner(), { logger, exclusiveOpener: async () => {} })

    await api.listDevices()

    expect(lines.filter((l) => l.includes("could not determine whether"))).toHaveLength(0)
  })
  it("does not probe a drive spindoctor is itself testing", async () => {
    // The probe holds an exclusive claim for a few microseconds, and real
    // badblocks takes its own O_EXCL probe when it starts `-w` — if they
    // coincide badblocks refuses, which since #84 fails the whole run and throws
    // away the hours of self-test before it.
    const probed: string[] = []
    const api = new RealDeviceApi(runner(), {
      exclusiveOpener: async (path) => void probed.push(path),
      isDriveUnderTest: (serial) => serial === CLEAN_SERIAL,
    })

    const drives = await api.listDevices()

    const underTest = drives.find((d) => d.serial === CLEAN_SERIAL)
    expect(probed).not.toContain(underTest!.devicePath)
    // Reported unknown rather than free: while we hold it, the probe could only
    // tell us about ourselves.
    expect(underTest?.claim).toBe("unknown")
    // Every other drive is still probed.
    expect(probed.length).toBe(drives.length - 1)
    expect(drives.filter((d) => d.serial !== CLEAN_SERIAL).every((d) => d.claim === "free")).toBe(
      true,
    )
  })

  it("does not warn about an unknown claim for a drive it deliberately skipped", async () => {
    const lines: string[] = []
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) })
    const api = new RealDeviceApi(runner(), {
      logger,
      exclusiveOpener: async () => {},
      isDriveUnderTest: () => true,
    })

    await api.listDevices()

    // Not being able to check is worth saying; choosing not to check is not.
    expect(lines.filter((l) => l.includes("could not determine whether"))).toHaveLength(0)
  })
})

// The container has no way to work out which disk the host booted from, so the
// operator can name it. Serial-based refusal survives namespace differences,
// device renumbering and reboots.
describe("RealDeviceApi operator-declared system disks (#83)", () => {
  const CLEAN_SERIAL = "ZFL9AB"

  const apiWithSerials = (systemDiskSerials?: string) =>
    new RealDeviceApi(
      fakeRunner({
        lsblk: { stdout: JSON.stringify(lsblk) },
        "smartctl --scan": { stdout: JSON.stringify(scan) },
      }),
      {
        exclusiveOpener: async () => {},
        ...(systemDiskSerials !== undefined ? { systemDiskSerials } : {}),
      },
    )

  it("marks a named serial as the system disk and refuses it", async () => {
    const drives = await apiWithSerials(CLEAN_SERIAL).listDevices()

    const named = drives.find((d) => d.serial === CLEAN_SERIAL)
    expect(named?.isSystemDisk).toBe(true)
    expect(checkRunAllowed(named!, { protectList: [] })).toMatchObject({
      allowed: false,
      code: "SYSTEM_DISK",
    })
  })

  it("leaves drives it does not name alone", async () => {
    const drives = await apiWithSerials(CLEAN_SERIAL).listDevices()

    // sda is mounted per the fixture but is not a system disk, and naming
    // another drive must not change that.
    expect(drives.find((d) => d.serial === "WD-WCC7K1")?.isSystemDisk).toBe(false)
  })

  it("ignores spacing, case and empty entries", async () => {
    const drives = await apiWithSerials(` ${CLEAN_SERIAL.toLowerCase()} ,, `).listDevices()

    expect(drives.find((d) => d.serial === CLEAN_SERIAL)?.isSystemDisk).toBe(true)
  })

  it("reads the environment variable when no explicit value is given", async () => {
    vi.stubEnv("SPINDOCTOR_SYSTEM_DISK_SERIALS", CLEAN_SERIAL)
    try {
      // No `systemDiskSerials` option at all: this is the production path, where
      // the value comes from the deployment's environment.
      const drives = await apiWithSerials(undefined).listDevices()
      expect(drives.find((d) => d.serial === CLEAN_SERIAL)?.isSystemDisk).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("marks nothing when the environment variable is unset", async () => {
    vi.stubEnv("SPINDOCTOR_SYSTEM_DISK_SERIALS", "")
    try {
      const drives = await apiWithSerials(undefined).listDevices()
      expect(drives.find((d) => d.serial === CLEAN_SERIAL)?.isSystemDisk).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("accepts several serials at once", async () => {
    const drives = await apiWithSerials(`${CLEAN_SERIAL},WD-WCC7K1`).listDevices()

    expect(
      drives
        .filter((d) => d.isSystemDisk)
        .map((d) => d.serial)
        .sort(),
    ).toEqual(["S4EWNX0M", "WD-WCC7K1", "ZFL9AB"]) // S4EWNX0M is already one via lsblk
  })

  it("marks nothing extra when unset or empty", async () => {
    for (const serials of [undefined, "", "  ,  "]) {
      const drives = await apiWithSerials(serials).listDevices()
      expect(drives.find((d) => d.serial === CLEAN_SERIAL)?.isSystemDisk).toBe(false)
      // Only the one lsblk itself identified, on the host-side view.
      expect(drives.filter((d) => d.isSystemDisk).map((d) => d.serial)).toEqual(["S4EWNX0M"])
    }
  })
})

// Issue #105: #86's abandon deadline settles the stage so a run cannot wedge, but
// the badblocks it gave up on may still be writing. An exclusive-open probe
// cannot see that — badblocks holds its working fd O_RDWR without O_EXCL — so
// once the run ended the drive read back `free` and the next start wrote the same
// platters underneath the first one.
describe("RealDeviceApi abandoned writers (#105)", () => {
  const CLEAN_SERIAL = "ZFL9AB"
  const CLEAN_PATH = "/dev/sdb"

  const runner = () =>
    fakeRunner({
      lsblk: { stdout: JSON.stringify(lsblk) },
      "smartctl --scan": { stdout: JSON.stringify(scan) },
    })

  /** Drives an abort through to the abandon deadline: nothing is actually
   * killed, so the child outlives every signal and has to be given up on. */
  async function abandonAChild(api: RealDeviceApi, child: { current?: ChildProcess }) {
    const controller = new AbortController()
    await api.runSurfaceTest(
      CLEAN_PATH,
      500_107_862_016,
      "destructive",
      () => controller.abort(),
      controller.signal,
    )
    return child.current
  }

  function apiWith(opts: Partial<ConstructorParameters<typeof RealDeviceApi>[1]> = {}) {
    const held: { current?: ChildProcess } = {}
    const api = new RealDeviceApi(runner(), {
      logDir: tmpdir(),
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--hang"],
      // Swallows the signals, so the child survives to the abandon deadline.
      killer: (c) => {
        held.current = c
      },
      surfaceKillGraceMs: 30,
      surfaceAbandonMs: 120,
      exclusiveOpener: async () => {},
      ...opts,
    })
    return { api, held }
  }

  it("reports the device as claimed while the abandoned process is alive", async () => {
    const { api, held } = apiWith({ processAlive: () => true })

    await abandonAChild(api, held)
    const drives = await api.listDevices()

    const drive = drives.find((d) => d.serial === CLEAN_SERIAL)
    expect(drive?.claim).toBe("claimed")
    // And the guard refuses it, which is the whole point.
    expect(checkRunAllowed(drive!, { protectList: [] })).toMatchObject({
      allowed: false,
      code: "IN_USE",
    })
    // Other drives are unaffected — this is per-device, not a global halt.
    expect(drives.filter((d) => d.claim === "claimed")).toHaveLength(1)

    held.current?.kill("SIGKILL")
  }, 10000)

  it("frees the device again once that process has gone, without a restart", async () => {
    let alive = true
    const { api, held } = apiWith({ processAlive: () => alive })

    await abandonAChild(api, held)
    expect((await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)?.claim).toBe("claimed")

    alive = false
    const after = (await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)

    expect(after?.claim).toBe("free")
    expect(checkRunAllowed(after!, { protectList: [] })).toEqual({ allowed: true })

    held.current?.kill("SIGKILL")
  }, 10000)

  it("quarantines nothing when the surface run ends normally", async () => {
    const api = new RealDeviceApi(runner(), {
      logDir: tmpdir(),
      surfaceCommand: process.execPath,
      surfaceArgsPrefix: (logfile) => [emulatorPath, "--log", logfile, "--bad", "0"],
      exclusiveOpener: async () => {},
      // Would keep any recorded entry alive, so a false positive shows up here.
      processAlive: () => true,
    })

    const result = await api.runSurfaceTest(
      CLEAN_PATH,
      500_107_862_016,
      "destructive",
      () => {},
      new AbortController().signal,
    )

    expect(result.completed).toBe(true)
    expect((await api.listDevices()).every((d) => d.claim === "free")).toBe(true)
  }, 10000)

  it("clears the quarantine if the child exits after being given up on", async () => {
    // The abandon deadline fires, then the process dies of its own accord and
    // Node delivers `close`. That is a confirmed exit, so the drive is ours.
    const { api, held } = apiWith({ processAlive: () => true })

    const child = await abandonAChild(api, held)
    expect((await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)?.claim).toBe("claimed")

    child?.kill("SIGKILL")
    await new Promise((resolve) => child?.once("close", resolve))

    expect((await api.listDevices()).find((d) => d.serial === CLEAN_SERIAL)?.claim).toBe("free")
  }, 10000)
})

describe("isProcessAlive", () => {
  it("is true for this very process", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it("is true for a process we exist alongside but may not signal", () => {
    // pid 1 is init: present, and cannot be signalled by an unprivileged process, which
    // raises EPERM rather than ESRCH. Reading that as "gone" would release a
    // drive still being written to, so only ESRCH counts as dead.
    expect(isProcessAlive(1)).toBe(true)
  })

  it("is false for a pid that does not exist", () => {
    // Far above /proc/sys/kernel/pid_max on any normal system.
    expect(isProcessAlive(0x7ffffff0)).toBe(false)
  })
})
