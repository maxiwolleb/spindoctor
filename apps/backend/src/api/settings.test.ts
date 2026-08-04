import { describe, it, expect, beforeEach } from "vitest"
import { DEFAULT_THRESHOLDS, type SettingsView } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import type { AuditRow } from "../db/repositories"
import { FakeDeviceApi } from "../device/fakeDeviceApi"
import { TestEngine } from "../engine/engine"
import { buildApp } from "./app"

let db: Db

beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

function build() {
  const deviceApi = new FakeDeviceApi({})
  const engine = new TestEngine({ db, deviceApi })
  return buildApp({ db, deviceApi, engine })
}

describe("GET /api/settings", () => {
  it("returns seeded defaults", async () => {
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/settings" })
    expect(res.statusCode).toBe(200)
    const body = res.json<SettingsView>()
    expect(body).toEqual({
      thresholds: DEFAULT_THRESHOLDS,
      concurrency: 4,
      autoModeEnabled: false,
      protectList: [],
      skipCondemnedDrives: true,
      diagnosticsEnabled: false,
      diagnosticsIncludeSerials: false,
    })
  })
})

describe("PUT /api/settings", () => {
  it("updates a subset and persists it, leaving thresholds unchanged", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { concurrency: 2, autoModeEnabled: true, protectList: ["X"] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<SettingsView>()
    expect(body).toEqual({
      thresholds: DEFAULT_THRESHOLDS,
      concurrency: 2,
      autoModeEnabled: true,
      protectList: ["X"],
      skipCondemnedDrives: true,
      diagnosticsEnabled: false,
      diagnosticsIncludeSerials: false,
    })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>()).toEqual(body)
  })

  it("updates thresholds when given a full valid object", async () => {
    const app = build()
    const newThresholds = {
      reallocatedWarnMax: 5,
      commandTimeoutWarnMax: 50,
      ssdPercentageUsedWarn: 70,
      ssdPercentageUsedFail: 90,
    }
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { thresholds: newThresholds },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<SettingsView>().thresholds).toEqual(newThresholds)
  })

  it("400s on concurrency:0, persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { concurrency: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>()).toEqual({
      thresholds: DEFAULT_THRESHOLDS,
      concurrency: 4,
      autoModeEnabled: false,
      protectList: [],
      skipCondemnedDrives: true,
      diagnosticsEnabled: false,
      diagnosticsIncludeSerials: false,
    })
  })

  it("400s on a non-numeric threshold field, persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { thresholds: { reallocatedWarnMax: "bad" } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().thresholds).toEqual(DEFAULT_THRESHOLDS)
  })

  it("400s on a non-string-array protectList, persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { protectList: [1, 2] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().protectList).toEqual([])
  })

  // Issue #88: entries were stored verbatim and compared with exact equality, so
  // this exact request returned 200, echoed the entries back, listed them in
  // Settings as protected — and protected nothing.
  it("stores protect-list entries trimmed and upper-cased", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { protectList: ["  zjv2geq70000c909m0j0  ", "ok1"] },
    })

    expect(res.statusCode).toBe(200)
    // Echoed back canonical, so what Settings shows is what the guard matches.
    expect(res.json<SettingsView>().protectList).toEqual(["ZJV2GEQ70000C909M0J0", "OK1"])

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().protectList).toEqual(["ZJV2GEQ70000C909M0J0", "OK1"])
  })

  it("drops blank entries and collapses ones that differ only in case or spacing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { protectList: ["OK1", " ok1 ", "", "   ", "OK2"] },
    })

    expect(res.json<SettingsView>().protectList).toEqual(["OK1", "OK2"])
  })

  it("keeps an entry that matches no discovered drive", async () => {
    // Pre-registering a serial before attaching the drive is a legitimate and
    // safety-positive workflow, so an unmatched entry is never rejected.
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { protectList: ["NOT-ATTACHED-YET"] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<SettingsView>().protectList).toEqual(["NOT-ATTACHED-YET"])
  })

  it("400s on a non-boolean autoModeEnabled, persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { autoModeEnabled: "yes" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().autoModeEnabled).toBe(false)
  })

  it("turns the condemned-drive early exit off (#49)", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { skipCondemnedDrives: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<SettingsView>().skipCondemnedDrives).toBe(false)

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().skipCondemnedDrives).toBe(false)
  })

  it("400s on a non-boolean skipCondemnedDrives, persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { skipCondemnedDrives: "no" },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().skipCondemnedDrives).toBe(true)
  })

  it("400s on a non-finite concurrency (e.g. Infinity via non-integer), persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { concurrency: 1.5 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().concurrency).toBe(4)
  })

  // #54: a config stored before commandTimeoutWarnMax existed reads back with
  // the current default filled in, rather than grading counters against
  // undefined — which is silently false for every drive.
  it("fills in a threshold missing from a config that predates it", async () => {
    repo.updateConfig(db, {
      thresholds: {
        reallocatedWarnMax: 10,
        ssdPercentageUsedWarn: 80,
        ssdPercentageUsedFail: 100,
      } as never,
    })
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/settings" })

    expect(res.json<SettingsView>().thresholds).toEqual({
      reallocatedWarnMax: 10,
      commandTimeoutWarnMax: DEFAULT_THRESHOLDS.commandTimeoutWarnMax,
      ssdPercentageUsedWarn: 80,
      ssdPercentageUsedFail: 100,
    })
  })

  it("400s on an incomplete thresholds object (missing keys), persisting nothing", async () => {
    const app = build()
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { thresholds: { reallocatedWarnMax: 5 } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>().thresholds).toEqual(DEFAULT_THRESHOLDS)
  })
})

describe("GET /api/audit", () => {
  beforeEach(() => {
    repo.appendAudit(db, { action: "FIRST", detail: "one" })
    repo.appendAudit(db, { action: "SECOND", detail: "two" })
    repo.appendAudit(db, { action: "THIRD", detail: "three" })
  })

  it("returns rows newest-first", async () => {
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/audit" })
    expect(res.statusCode).toBe(200)
    const body = res.json<AuditRow[]>()
    expect(body).toHaveLength(3)
    expect(body.map((r) => r.action)).toEqual(["THIRD", "SECOND", "FIRST"])
  })

  it("respects ?limit=", async () => {
    const app = build()
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=1" })
    expect(res.statusCode).toBe(200)
    const body = res.json<AuditRow[]>()
    expect(body).toHaveLength(1)
    expect(body[0]?.action).toBe("THIRD")
  })
})
