import { describe, it, expect } from "vitest"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import { analyzeGaps, type GapInput } from "./gaps"
import ataHealthy from "../device/__fixtures__/ata-healthy.json"
import nvmeUsbBridgeReal from "../device/__fixtures__/nvme-usb-bridge-real.json"
import sasImpendingFailure from "../device/__fixtures__/sas-impending-failure.json"
import sasUncorrectedErrors from "../device/__fixtures__/sas-uncorrected-errors.json"

function input(over: Partial<GapInput> = {}): GapInput {
  return {
    runId: 1,
    driveRef: "ref-1",
    model: "WDC WD40EFRX",
    transport: "SATA",
    discoveredType: "HDD",
    verdict: "PASS",
    reasons: [],
    before: ataHealthy,
    after: ataHealthy,
    ...over,
  }
}

const analyze = (runs: GapInput[]) => analyzeGaps(runs, DEFAULT_THRESHOLDS)

describe("analyzeGaps", () => {
  it("reports nothing for a healthy ATA drive we fully understand", () => {
    const g = analyze([input()])
    expect(g.unexplainedAttributes).toEqual([])
    expect(g.typeDisagreements).toEqual([])
    expect(g.selfTestUnsupported).toEqual([])
    expect(g.verdictDisagreements).toEqual([])
    expect(g.thresholdProximity).toEqual([])
  })

  // The bridged-NVMe case (#64, #65): discovery trusts lsblk's rotational flag,
  // which a USB bridge need not pass through, and the controller implements no
  // self-test. Both were invisible until real hardware showed up.
  describe("the real USB-bridged NVMe", () => {
    const bridged = input({
      driveRef: "ref-nvme",
      model: "E2M2 64GB",
      transport: "USB",
      discoveredType: "HDD", // what lsblk reports for this enclosure
      before: nvmeUsbBridgeReal,
      after: nvmeUsbBridgeReal,
    })

    it("reports the type disagreement, with both sides named", () => {
      const g = analyze([bridged])
      expect(g.typeDisagreements).toEqual([
        {
          driveRef: "ref-nvme",
          model: "E2M2 64GB",
          transport: "USB",
          discovered: "HDD",
          fromSmart: "NVMe",
        },
      ])
    })

    it("reports that its self-test cannot run", () => {
      expect(analyze([bridged]).selfTestUnsupported).toEqual([
        { driveRef: "ref-nvme", model: "E2M2 64GB" },
      ])
    })

    it("names a drive once however many runs it appears in", () => {
      const g = analyze([bridged, { ...bridged, runId: 2 }, { ...bridged, runId: 3 }])
      expect(g.selfTestUnsupported).toHaveLength(1)
    })
  })

  // The HGST drives in the audit batch: firmware reported OK while carrying 158
  // uncorrected read errors. Our rules failed them, which is the case where
  // disagreeing with the drive is the whole point.
  it("reports a drive we fail that calls itself healthy, with the rules that did it", () => {
    const g = analyze([
      input({
        runId: 7,
        driveRef: "ref-sas",
        model: "HGST HUH721212AL5200",
        transport: "SAS",
        before: sasUncorrectedErrors,
        after: sasUncorrectedErrors,
        verdict: "FAIL",
        reasons: [
          { code: "REPORTED_UNCORRECT", severity: "fail", message: "..." },
          { code: "GROWN_DEFECTS_PRESENT", severity: "warn", message: "..." },
        ],
      }),
    ])

    expect(g.verdictDisagreements).toEqual([
      {
        runId: 7,
        driveRef: "ref-sas",
        model: "HGST HUH721212AL5200",
        verdict: "FAIL",
        driveSaysHealthy: true,
        // warn-severity reasons are excluded: they did not drive the FAIL.
        reasonCodes: ["REPORTED_UNCORRECT"],
      },
    ])
  })

  it("reports the other direction too — a drive calling itself failing that we passed", () => {
    const g = analyze([
      input({
        driveRef: "ref-sas2",
        transport: "SAS",
        before: sasImpendingFailure,
        after: sasImpendingFailure,
        verdict: "WARN",
        reasons: [],
      }),
    ])
    expect(g.verdictDisagreements).toHaveLength(1)
    expect(g.verdictDisagreements[0]).toMatchObject({ verdict: "WARN", driveSaysHealthy: false })
  })

  it("stays quiet when we and the drive agree", () => {
    const agreeing = analyze([
      input({ before: sasImpendingFailure, after: sasImpendingFailure, verdict: "FAIL" }),
    ])
    expect(agreeing.verdictDisagreements).toEqual([])
  })

  it("says nothing about a run that never reached a verdict", () => {
    expect(analyze([input({ verdict: null })]).verdictDisagreements).toEqual([])
  })

  describe("unexplained attributes", () => {
    const withAttrs = (table: unknown[]) => ({
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 7200,
      ata_smart_attributes: { table },
    })

    it("reports an attribute the description map has no text for", () => {
      const g = analyze([
        input({
          before: withAttrs([
            { id: 250, name: "Read_Error_Retry_Rate", value: 100, raw: { value: 0 } },
          ]),
          after: null,
        }),
      ])
      expect(g.unexplainedAttributes).toEqual([
        { id: 250, name: "Read_Error_Retry_Rate", model: "WDC WD40EFRX", seen: 1 },
      ])
    })

    it("stays quiet about attributes it can explain", () => {
      const g = analyze([
        input({
          before: withAttrs([
            { id: 5, name: "Reallocated_Sector_Ct", value: 100, raw: { value: 0 } },
          ]),
          after: null,
        }),
      ])
      expect(g.unexplainedAttributes).toEqual([])
    })

    // One drive with an odd name is a curiosity; twenty is a gap worth filling,
    // so the count is what ranks the list.
    it("counts sightings and puts the most common first", () => {
      const rare = withAttrs([{ id: 251, name: "Rare_One", value: 100, raw: { value: 0 } }])
      const common = withAttrs([{ id: 252, name: "Common_One", value: 100, raw: { value: 0 } }])
      const g = analyze([
        input({ before: rare, after: null }),
        input({ before: common, after: null }),
        input({ before: common, after: null }),
        input({ before: common, after: null }),
      ])
      expect(g.unexplainedAttributes.map((a) => [a.name, a.seen])).toEqual([
        ["Common_One", 3],
        ["Rare_One", 1],
      ])
    })
  })

  describe("unread payload fields", () => {
    it("reports a key no parser reads", () => {
      const g = analyze([
        input({
          before: { device: { protocol: "ATA" }, vendor_specific_health_blob: { anything: 1 } },
          after: null,
        }),
      ])
      expect(g.unreadFields).toEqual([
        { path: "vendor_specific_health_blob", model: "WDC WD40EFRX", seen: 1 },
      ])
    })

    it("stays quiet about the keys the parsers consume", () => {
      expect(analyze([input({ after: null })]).unreadFields).toEqual([])
    })

    it("stays quiet about the numbered per-port and per-entry keys", () => {
      const g = analyze([input({ before: sasImpendingFailure, after: null })])
      const paths = g.unreadFields.map((f) => f.path)
      expect(paths.filter((p) => p.startsWith("scsi_sas_port_"))).toEqual([])
      expect(paths.filter((p) => p.startsWith("scsi_self_test_"))).toEqual([])
    })

    // The regression that matters: this key existing but being unread is exactly
    // what #65 was, and it should show up here rather than after a hardware run.
    it("would have surfaced the NVMe capability field before we knew to look", () => {
      const withoutSupport = { ...(nvmeUsbBridgeReal as Record<string, unknown>) }
      const g = analyze([input({ before: withoutSupport, after: null })])
      // It is a known key now, so it must NOT be reported — the assertion pins
      // that the registry is what decides, not the parser happening to read it.
      expect(g.unreadFields.map((f) => f.path)).not.toContain("nvme_optional_admin_commands")
    })
  })

  describe("threshold proximity", () => {
    const withRealloc = (raw: number) => ({
      device: { protocol: "ATA", type: "sat" },
      rotation_rate: 7200,
      ata_smart_attributes: {
        table: [{ id: 5, name: "Reallocated_Sector_Ct", value: 100, raw: { value: raw } }],
      },
    })

    it("flags a count sitting near the limit that decides it", () => {
      const g = analyze([input({ before: withRealloc(3), after: withRealloc(3) })])
      expect(g.thresholdProximity).toEqual([
        {
          driveRef: "ref-1",
          model: "WDC WD40EFRX",
          metric: "reallocatedSectors",
          value: 3,
          threshold: DEFAULT_THRESHOLDS.reallocatedWarnMax,
          thresholdName: "reallocatedWarnMax",
        },
      ])
    })

    it("ignores a clean drive and one far past the limit", () => {
      expect(
        analyze([input({ before: withRealloc(0), after: withRealloc(0) })]).thresholdProximity,
      ).toEqual([])
      expect(
        analyze([input({ before: withRealloc(500), after: withRealloc(500) })]).thresholdProximity,
      ).toEqual([])
    })
  })

  it("reads the after-snapshot when there is one, and the before when there isn't", () => {
    // A run cut short by the #49 gate has no after-snapshot at all.
    expect(() => analyze([input({ after: null })])).not.toThrow()
  })

  it("survives a payload that is not an object at all", () => {
    for (const junk of [null, "nope", 42, []]) {
      expect(() => analyze([input({ before: junk, after: junk })])).not.toThrow()
    }
  })
})
