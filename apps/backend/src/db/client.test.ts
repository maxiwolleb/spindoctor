import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, afterEach } from "vitest"
import { createDb } from "./client"

const dirname = path.dirname(fileURLToPath(import.meta.url))

describe("createDb", () => {
  it("creates all tables in a fresh in-memory database", () => {
    const { sqlite } = createDb(":memory:")
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)
    for (const t of ["drives", "test_runs", "stage_results", "smart_snapshots", "config", "audit_log"]) {
      expect(names).toContain(t)
    }
    sqlite.close()
  })

  describe("SPINDOCTOR_MIGRATIONS_DIR override", () => {
    afterEach(() => {
      delete process.env.SPINDOCTOR_MIGRATIONS_DIR
    })

    it("still creates all tables when pointed at the real drizzle dir", () => {
      process.env.SPINDOCTOR_MIGRATIONS_DIR = path.join(dirname, "..", "..", "drizzle")
      const { sqlite } = createDb(":memory:")
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
      const names = rows.map((r) => r.name)
      for (const t of ["drives", "test_runs", "stage_results", "smart_snapshots", "config", "audit_log"]) {
        expect(names).toContain(t)
      }
      sqlite.close()
    })
  })

  it("enforces foreign keys", () => {
    const { sqlite } = createDb(":memory:")
    expect(() =>
      sqlite.prepare("INSERT INTO test_runs (drive_serial, regime, status, created_at) VALUES ('nope','[]','PENDING',0)").run(),
    ).toThrow(/FOREIGN KEY/i)
    sqlite.close()
  })
})
