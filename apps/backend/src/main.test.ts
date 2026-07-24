import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDb } from "./db/client"
import * as repo from "./db/repositories"
import { FakeDeviceApi } from "./device/fakeDeviceApi"
import { TestEngine } from "./engine/engine"
import { buildApp } from "./api/app"
import { createServer } from "./main"

describe("buildApp static serving", () => {
  it("serves the API and has no static route when webRoot is omitted", async () => {
    const db = createDb(":memory:").db
    repo.ensureConfig(db)
    const deviceApi = new FakeDeviceApi({ drives: [] })
    const engine = new TestEngine({ db, deviceApi })
    const app = buildApp({ db, deviceApi, engine })

    const res = await app.inject({ method: "GET", url: "/api/drives" })
    expect(res.statusCode).toBe(200)

    await app.close()
  })

  it("does not crash when webRoot is set but the directory does not exist", async () => {
    const db = createDb(":memory:").db
    repo.ensureConfig(db)
    const deviceApi = new FakeDeviceApi({ drives: [] })
    const engine = new TestEngine({ db, deviceApi })
    const app = buildApp({ db, deviceApi, engine, webRoot: "/no/such/spindoctor-web-dir" })

    const res = await app.inject({ method: "GET", url: "/api/drives" })
    expect(res.statusCode).toBe(200)

    await app.close()
  })

  it("serves index.html for a non-api GET (SPA fallback) but returns JSON 404 for unmatched /api routes", async () => {
    const webRoot = mkdtempSync(path.join(tmpdir(), "spindoctor-web-"))
    writeFileSync(path.join(webRoot, "index.html"), "<html>spa-shell</html>")

    const db = createDb(":memory:").db
    repo.ensureConfig(db)
    const deviceApi = new FakeDeviceApi({ drives: [] })
    const engine = new TestEngine({ db, deviceApi })
    const app = buildApp({ db, deviceApi, engine, webRoot })

    const spaRes = await app.inject({ method: "GET", url: "/some/client/route" })
    expect(spaRes.statusCode).toBe(200)
    expect(spaRes.body).toContain("spa-shell")

    const apiRes = await app.inject({ method: "GET", url: "/api/does-not-exist" })
    expect(apiRes.statusCode).toBe(404)
    expect(apiRes.json()).toMatchObject({ error: expect.any(String) })

    await app.close()
    rmSync(webRoot, { recursive: true, force: true })
  })
})

describe("createServer", () => {
  it("constructs without throwing and wires the API end-to-end", async () => {
    const server = createServer({ dbPath: ":memory:", deviceApi: new FakeDeviceApi({ drives: [] }) })

    const res = await server.app.inject({ method: "GET", url: "/api/drives" })
    expect(res.statusCode).toBe(200)

    await server.stop()
  })

  it("runs reconcile() on an empty db without throwing (boot sequence, no listen)", async () => {
    const server = createServer({ dbPath: ":memory:", deviceApi: new FakeDeviceApi({ drives: [] }) })

    await expect(server.engine.reconcile()).resolves.toBeUndefined()

    await server.stop()
  })

  it("boots with no web build present and still serves settings", async () => {
    const server = createServer({
      dbPath: ":memory:",
      deviceApi: new FakeDeviceApi({ drives: [] }),
      webRoot: "/no/such/spindoctor-web-dir",
    })

    const res = await server.app.inject({ method: "GET", url: "/api/settings" })
    expect(res.statusCode).toBe(200)

    await server.stop()
  })
})
