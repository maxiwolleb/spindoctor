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
    })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>()).toEqual(body)
  })

  it("updates thresholds when given a full valid object", async () => {
    const app = build()
    const newThresholds = { reallocatedWarnMax: 5, ssdPercentageUsedWarn: 70, ssdPercentageUsedFail: 90 }
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
    const res = await app.inject({ method: "PUT", url: "/api/settings", payload: { concurrency: 0 } })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: "BAD_REQUEST" })

    const follow = await app.inject({ method: "GET", url: "/api/settings" })
    expect(follow.json<SettingsView>()).toEqual({
      thresholds: DEFAULT_THRESHOLDS,
      concurrency: 4,
      autoModeEnabled: false,
      protectList: [],
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
