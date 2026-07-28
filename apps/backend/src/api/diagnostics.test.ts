import { describe, it, expect, beforeEach } from "vitest"
import { gunzipSync } from "node:zlib"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { FakeDeviceApi } from "../device/fakeDeviceApi"
import { TestEngine } from "../engine/engine"
import type { CommandRunner } from "../device/runner"
import { buildApp } from "./app"

const d: DiscoveredDrive = {
  devicePath: "/dev/sda",
  serial: "S2V0FW86",
  wwn: null,
  model: "ST9500423AS",
  sizeBytes: 500_107_862_016,
  type: "HDD",
  transport: "USB",
  mounted: false,
  isSystemDisk: false,
}

/** Stands in for the CLI tools so the route never shells out in a test. */
const runner: CommandRunner = {
  async run(cmd) {
    if (cmd === "smartctl") {
      return { stdout: "smartctl 7.4 2023-08-01 r5530 [x86_64-linux]\n", stderr: "", code: 0 }
    }
    return { stdout: "", stderr: "dumpe2fs 1.47.0 (5-Feb-2023)\n", code: 1 }
  },
}

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

function build() {
  const deviceApi = new FakeDeviceApi({ drives: [d] })
  return buildApp({
    db,
    deviceApi,
    engine: new TestEngine({ db, deviceApi }),
    runner,
    spindoctorVersion: "abc1234",
  })
}

describe("GET /api/diagnostics/bundle", () => {
  // Opt-in means opt-in: an instance that never turned this on has no such
  // endpoint to find, rather than one that returns an empty bundle.
  it("404s while diagnostics are disabled, which is the default", async () => {
    const res = await build().inject({ method: "GET", url: "/api/diagnostics/bundle" })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ code: "DIAGNOSTICS_DISABLED" })
  })

  it("serves a gzipped bundle once enabled", async () => {
    repo.updateConfig(db, { diagnosticsEnabled: true })
    repo.upsertDrive(db, d)

    const res = await build().inject({ method: "GET", url: "/api/diagnostics/bundle" })

    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toBe("application/gzip")
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename=".*\.json\.gz"/)

    const bundle = JSON.parse(gunzipSync(res.rawPayload).toString("utf8"))
    expect(bundle.schemaVersion).toBe(1)
    expect(bundle.drives).toHaveLength(1)
    // Probed through the injected runner rather than the real tools.
    expect(bundle.environment).toMatchObject({
      smartctlVersion: "7.4",
      e2fsprogsVersion: "1.47.0",
      spindoctorVersion: "abc1234",
    })
  })

  it("names the file after the instance, not the machine", async () => {
    repo.updateConfig(db, { diagnosticsEnabled: true })
    const res = await build().inject({ method: "GET", url: "/api/diagnostics/bundle" })
    const bundle = JSON.parse(gunzipSync(res.rawPayload).toString("utf8"))
    expect(res.headers["content-disposition"]).toContain(bundle.instanceRef)
  })

  it("keeps serials out of the download by default", async () => {
    repo.updateConfig(db, { diagnosticsEnabled: true })
    repo.upsertDrive(db, d)
    const res = await build().inject({ method: "GET", url: "/api/diagnostics/bundle" })
    expect(gunzipSync(res.rawPayload).toString("utf8")).not.toContain(d.serial)
  })
})
