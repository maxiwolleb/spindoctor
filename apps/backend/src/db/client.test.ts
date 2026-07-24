import { describe, it, expect } from "vitest"
import { createDb } from "./client"

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

  it("enforces foreign keys", () => {
    const { sqlite } = createDb(":memory:")
    expect(() =>
      sqlite.prepare("INSERT INTO test_runs (drive_serial, regime, status, created_at) VALUES ('nope','[]','PENDING',0)").run(),
    ).toThrow(/FOREIGN KEY/i)
    sqlite.close()
  })
})
