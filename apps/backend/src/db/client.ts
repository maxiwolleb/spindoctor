import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import * as schema from "./schema"

export type Db = BetterSQLite3Database<typeof schema>

export function createDb(dbPath: string): { db: Db; sqlite: Database.Database } {
  const migrationsFolder =
    process.env.SPINDOCTOR_MIGRATIONS_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle")
  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return { db, sqlite }
}
