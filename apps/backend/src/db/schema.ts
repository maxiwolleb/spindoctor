import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const drives = sqliteTable("drives", {
  serial: text("serial").primaryKey(),
  wwn: text("wwn"),
  model: text("model").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  type: text("type").notNull(),
  transport: text("transport").notNull(),
  firstSeen: integer("first_seen", { mode: "timestamp_ms" }).notNull(),
  lastSeen: integer("last_seen", { mode: "timestamp_ms" }).notNull(),
  protectedFlag: integer("protected", { mode: "boolean" }).notNull().default(false),
})

export const testRuns = sqliteTable("test_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  driveSerial: text("drive_serial")
    .notNull()
    .references(() => drives.serial),
  regime: text("regime", { mode: "json" }).notNull(),
  status: text("status").notNull(),
  verdict: text("verdict"),
  reasons: text("reasons", { mode: "json" }),
  currentStage: text("current_stage"),
  restartCount: integer("restart_count").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

export const stageResults = sqliteTable("stage_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id")
    .notNull()
    .references(() => testRuns.id),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  logPath: text("log_path"),
  log: text("log"),
  metrics: text("metrics", { mode: "json" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
})

export const smartSnapshots = sqliteTable("smart_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id")
    .notNull()
    .references(() => testRuns.id),
  phase: text("phase").notNull(),
  raw: text("raw", { mode: "json" }).notNull(),
  keyMetrics: text("key_metrics", { mode: "json" }).notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
})

export const config = sqliteTable("config", {
  id: integer("id").primaryKey(),
  thresholds: text("thresholds", { mode: "json" }).notNull(),
  concurrency: integer("concurrency").notNull().default(4),
  autoModeEnabled: integer("auto_mode_enabled", { mode: "boolean" }).notNull().default(false),
  protectList: text("protect_list", { mode: "json" }).notNull(),
  /** Cut a run short at the verdict when the baseline SMART read already
   * condemns the drive, instead of spending ~90 min of self-test and hours of
   * destructive surface write to reach the same FAIL (issue #49). On by
   * default: the alternative wastes most of a day per drive. A run started with
   * `forceFullRegime` overrides this per run — the destructive pass is also a
   * wipe, and wiping a dying drive before disposal is a real reason to want it. */
  skipCondemnedDrives: integer("skip_condemned_drives", { mode: "boolean" })
    .notNull()
    .default(true),
})

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
  action: text("action").notNull(),
  driveSerial: text("drive_serial"),
  detail: text("detail"),
})
