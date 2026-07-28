import { describe, it, expect, beforeEach } from "vitest"
import { gunzipSync } from "node:zlib"
import type { DiscoveredDrive } from "@spindoctor/shared"
import { createDb, type Db } from "../db/client"
import * as repo from "../db/repositories"
import { buildBundle, ensureDiagnosticsSalt, serializeBundle } from "./bundle"
import type { RunEnvironment } from "./environment"
import nvmeUsbBridgeReal from "../device/__fixtures__/nvme-usb-bridge-real.json"

const SERIAL = "S2V0FW86"
const env: RunEnvironment = {
  smartctlVersion: "7.4",
  e2fsprogsVersion: "1.47.0",
  kernel: "7.0.0-28-generic",
}

const drive = (over: Partial<DiscoveredDrive> = {}): DiscoveredDrive => ({
  devicePath: "/dev/sda",
  serial: SERIAL,
  wwn: null,
  model: "ST9500423AS",
  sizeBytes: 500_107_862_016,
  type: "HDD",
  transport: "USB",
  mounted: false,
  isSystemDisk: false,
  ...over,
})

let db: Db
beforeEach(() => {
  db = createDb(":memory:").db
  repo.ensureConfig(db)
})

/** A completed run with both snapshots, which is what a bundle is mostly made of. */
function seedRun(over: { serial?: string; raw?: unknown } = {}): number {
  const serial = over.serial ?? SERIAL
  repo.upsertDrive(db, drive({ serial }))
  const runId = repo.createRun(db, {
    driveSerial: serial,
    regime: { mode: "destructive", stages: [] },
  })
  repo.updateRun(db, runId, { status: "DONE", verdict: "PASS", reasons: [] })
  const raw = over.raw ?? { device: { protocol: "ATA", type: "sat" }, rotation_rate: 7200 }
  for (const phase of ["before", "after"] as const) {
    repo.saveSnapshot(db, { runId, phase, raw, keyMetrics: {} as never })
  }
  return runId
}

const build = () => buildBundle({ db, environment: env, now: new Date("2026-07-28T09:00:00Z") })

describe("buildBundle", () => {
  it("carries the environment, so a finding can be tied to the tools that produced it", () => {
    seedRun()
    const b = buildBundle({ db, environment: env, spindoctorVersion: "abc1234" })
    expect(b.environment).toEqual({ ...env, spindoctorVersion: "abc1234" })
    expect(b.schemaVersion).toBe(1)
  })

  it("includes the raw payloads verbatim — they are the point of the exercise", () => {
    const runId = seedRun({ raw: nvmeUsbBridgeReal })
    const b = build()
    expect(b.smart[String(runId)]?.before).toEqual(nvmeUsbBridgeReal)
    expect(b.smart[String(runId)]?.after).toEqual(nvmeUsbBridgeReal)
  })

  it("runs the gap analysis over what it collected", () => {
    seedRun({ raw: nvmeUsbBridgeReal })
    // Discovery recorded HDD; the payload says NVMe and reports no self-test.
    const b = build()
    expect(b.gaps.typeDisagreements).toHaveLength(1)
    expect(b.gaps.selfTestUnsupported).toHaveLength(1)
  })

  describe("pseudonymization", () => {
    // The invariant worth pinning rather than trusting: a bundle must not be a
    // readable fleet inventory unless the operator asked for one.
    it("puts no verbatim serial anywhere in the payload", () => {
      seedRun()
      repo.appendAudit(db, { action: "DESTRUCTIVE_START", driveSerial: SERIAL })
      repo.updateConfig(db, { protectList: [SERIAL] })

      const json = JSON.stringify(build())
      expect(json).not.toContain(SERIAL)
    })

    it("excludes the protect list outright, being a list of serials", () => {
      seedRun()
      repo.updateConfig(db, { protectList: [SERIAL, "OTHER1"] })
      expect(JSON.stringify(build())).not.toContain("OTHER1")
      expect(Object.keys(build().config)).not.toContain("protectList")
    })

    it("gives one drive one ref across its runs, so findings can be correlated", () => {
      seedRun()
      seedRun()
      const b = build()
      const refs = new Set(b.runs.map((r) => r.driveRef))
      expect(b.runs).toHaveLength(2)
      expect(refs.size).toBe(1)
      expect(b.drives[0]?.driveRef).toBe([...refs][0])
    })

    it("gives different drives different refs", () => {
      seedRun({ serial: "AAA" })
      seedRun({ serial: "BBB" })
      const refs = new Set(build().drives.map((d) => d.driveRef))
      expect(refs.size).toBe(2)
    })

    it("produces unrelated refs on another instance, so bundles can't be joined", () => {
      seedRun()
      const mine = build().drives[0]?.driveRef

      const other = createDb(":memory:").db
      repo.ensureConfig(other)
      repo.upsertDrive(other, drive())
      const theirs = buildBundle({ db: other, environment: env }).drives[0]?.driveRef

      expect(mine).toBeTruthy()
      expect(theirs).toBeTruthy()
      expect(mine).not.toBe(theirs)
    })

    it("never exports the salt that would reverse the refs", () => {
      seedRun()
      const salt = ensureDiagnosticsSalt(db)
      expect(salt).toHaveLength(64)
      expect(JSON.stringify(build())).not.toContain(salt)
    })

    it("reuses one salt rather than re-rolling it per export", () => {
      expect(ensureDiagnosticsSalt(db)).toBe(ensureDiagnosticsSalt(db))
    })

    it("uses verbatim serials when the operator asks for them", () => {
      seedRun()
      repo.updateConfig(db, { diagnosticsIncludeSerials: true })
      const b = build()
      expect(b.serialsPseudonymized).toBe(false)
      expect(b.drives[0]?.driveRef).toBe(SERIAL)
    })
  })

  describe("log capping", () => {
    it("caps an oversized stage log and records that it did", () => {
      const runId = seedRun()
      const stageId = repo.addStage(db, { runId, stage: "SURFACE", status: "DONE" })
      const huge = "x".repeat(200 * 1024)
      repo.updateStage(db, stageId, { log: huge })

      const b = build()
      const stage = b.runs[0]?.stages.find((s) => s.stage === "SURFACE")
      expect(stage?.log?.length).toBeLessThan(huge.length)
      expect(stage?.log).toContain("truncated")
      // Recorded, so a reader knows what was withheld instead of guessing.
      expect(b.truncations).toEqual([
        { what: `run ${runId} stage SURFACE log`, originalBytes: 200 * 1024 },
      ])
    })

    it("leaves a normal log alone and reports no truncation", () => {
      const runId = seedRun()
      const stageId = repo.addStage(db, { runId, stage: "SURFACE", status: "DONE" })
      repo.updateStage(db, stageId, { log: "short and complete" })

      const b = build()
      expect(b.runs[0]?.stages[0]?.log).toBe("short and complete")
      expect(b.truncations).toEqual([])
    })
  })

  it("builds cleanly with no runs at all", () => {
    const b = build()
    expect(b.runs).toEqual([])
    expect(b.drives).toEqual([])
    expect(b.gaps.unexplainedAttributes).toEqual([])
  })
})

describe("serializeBundle", () => {
  it("round-trips through gzip", () => {
    seedRun()
    const bundle = build()
    const decoded = JSON.parse(gunzipSync(serializeBundle(bundle)).toString("utf8"))
    expect(decoded).toEqual(JSON.parse(JSON.stringify(bundle)))
  })

  it("actually compresses — raw SMART payloads repeat heavily", () => {
    seedRun({ raw: nvmeUsbBridgeReal })
    const bundle = build()
    const raw = Buffer.byteLength(JSON.stringify(bundle, null, 2))
    expect(serializeBundle(bundle).byteLength).toBeLessThan(raw)
  })
})
