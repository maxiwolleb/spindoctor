import { describe, it, expect, beforeEach } from "vitest"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { declaredSelfTestMinutes, DECLARED_SELFTEST_MINUTES_KEY } from "./selfTestDuration"

/** A SAS capture whose self-test log is empty — the shape smartctl returns for a
 * drive that has never run one. Note the absence of
 * `scsi_extended_self_test_seconds`: smartctl omits it in this state even though
 * the firmware does publish a duration. Reduced from a real ST8000NM0075. */
const sasEmptyLog = {
  device: { protocol: "SCSI", type: "scsi" },
  serial_number: "ZA18T7WL0000R804M2GT",
  smart_status: { passed: false },
}

/** The same drive after one entry exists in its self-test log. */
const sasWithLog = {
  ...sasEmptyLog,
  scsi_self_test_0: { code: { value: 2 }, result: { value: 1 } },
  scsi_extended_self_test_seconds: 47220,
}

describe("declaredSelfTestMinutes", () => {
  let db: Db
  let runId: number

  beforeEach(() => {
    db = createDb(":memory:").db
    repo.upsertDrive(db, {
      devicePath: "/dev/sdb",
      serial: "ZA18T7WL0000R804M2GT",
      wwn: null,
      model: "ST8000NM0075",
      sizeBytes: 8_001_563_222_016,
      type: "HDD",
      transport: "SAS",
      mounted: false,
      isSystemDisk: false,
    })
    runId = repo.createRun(db, {
      driveSerial: "ZA18T7WL0000R804M2GT",
      regime: { mode: "destructive", stages: [] },
    })
  })

  it("falls back to the baseline capture when nothing has been recovered", () => {
    repo.saveSnapshot(db, { runId, phase: "before", raw: sasWithLog, keyMetrics: {} as never })

    expect(declaredSelfTestMinutes(db, runId)).toBe(787) // 47220s
  })

  it("is null when the baseline saw no duration and nothing was recovered", () => {
    // This is the bug's visible symptom: the first run on a drive whose self-test
    // log is empty reported no ETA for a 13-hour stage.
    repo.saveSnapshot(db, { runId, phase: "before", raw: sasEmptyLog, keyMetrics: {} as never })

    expect(declaredSelfTestMinutes(db, runId)).toBeNull()
  })

  it("prefers a recovered duration over the baseline, so every reader agrees", () => {
    // The engine re-reads after starting the routine (which creates the log
    // entry) and stashes the answer in the regime. Both the REST route and the
    // SSE bridge otherwise re-derive from the baseline — the read that lacked it.
    repo.saveSnapshot(db, { runId, phase: "before", raw: sasEmptyLog, keyMetrics: {} as never })
    repo.updateRun(db, runId, {
      regime: { mode: "destructive", stages: [], [DECLARED_SELFTEST_MINUTES_KEY]: 787 },
    })

    expect(declaredSelfTestMinutes(db, runId)).toBe(787)
  })

  it("ignores a nonsensical recovered value rather than reporting it", () => {
    repo.saveSnapshot(db, { runId, phase: "before", raw: sasWithLog, keyMetrics: {} as never })
    for (const bad of [0, -5, Number.NaN, "787", null]) {
      repo.updateRun(db, runId, {
        regime: { mode: "destructive", [DECLARED_SELFTEST_MINUTES_KEY]: bad },
      })
      expect(declaredSelfTestMinutes(db, runId)).toBe(787)
    }
  })

  it("survives a regime that is not an object", () => {
    // The column is `notNull`, so the realistic corruption is a JSON scalar
    // rather than SQL NULL.
    repo.saveSnapshot(db, { runId, phase: "before", raw: sasWithLog, keyMetrics: {} as never })
    for (const regime of ["nope", 42, []]) {
      repo.updateRun(db, runId, { regime })
      expect(declaredSelfTestMinutes(db, runId)).toBe(787)
    }
  })
})
