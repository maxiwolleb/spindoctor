import { describe, expect, it } from "vitest"
import type { SmartAttributeRow } from "@spindoctor/shared"
import { describeAttribute } from "./smartAttributeInfo"

const row = (over: Partial<SmartAttributeRow> = {}): SmartAttributeRow => ({
  id: 5,
  name: "Reallocated_Sector_Ct",
  value: 100,
  worst: 100,
  thresh: 10,
  rawValue: 0,
  rawString: null,
  health: "ok",
  ...over,
})

describe("describeAttribute", () => {
  it("looks up a known ATA attribute by name", () => {
    const info = describeAttribute(row())
    expect(info.label).toBe("Reallocated sectors")
    expect(info.description).toContain("retired after finding them bad")
  })

  it("falls back to the id table when the drive reports a non-standard name for a known id", () => {
    const info = describeAttribute(row({ id: 197, name: "Vendor_Weird_Name_197" }))
    expect(info.label).toBe("Current pending sectors")
  })

  it("falls back to a generic message for a totally unrecognized ATA attribute", () => {
    const info = describeAttribute(row({ id: 250, name: "Some_Unknown_Attribute" }))
    expect(info.label).toBe("Some_Unknown_Attribute")
    expect(info.description).toContain("no plain-language explanation yet")
  })

  it("looks up a known NVMe field by name", () => {
    const info = describeAttribute(
      row({ id: null, name: "media_errors", value: null, worst: null, thresh: null, rawValue: 0 }),
    )
    expect(info.label).toBe("Media errors")
    expect(info.description).toContain("data was actually lost or corrupted")
  })

  it("falls back to a generic message for an unrecognized NVMe field", () => {
    const info = describeAttribute(
      row({
        id: null,
        name: "some_new_field",
        value: null,
        worst: null,
        thresh: null,
        rawValue: 1,
      }),
    )
    expect(info.label).toBe("some_new_field")
    expect(info.description).toContain("no plain-language explanation yet")
  })
})

// Issue #54: SAS/SCSI rows carry the same plain-language treatment ATA and NVMe
// already had — and several of these counters are routinely huge on a healthy
// drive, so the description has to say so or the number reads as damage.
describe("describeAttribute (SAS/SCSI)", () => {
  const scsiRow = (name: string, rawValue: number | null = 0): SmartAttributeRow => ({
    id: null,
    name,
    value: null,
    worst: null,
    thresh: null,
    rawValue,
    rawString: null,
    health: "ok",
  })

  it("describes the drive's own self-assessment as the authoritative SAS signal", () => {
    const info = describeAttribute(scsiRow("scsi_smart_status", null))
    expect(info.label).toBe("Drive self-assessment")
    expect(info.description).toContain("authoritative")
  })

  it("explains that a large grown-defect count is not by itself a failure", () => {
    const info = describeAttribute(scsiRow("scsi_grown_defect_list", 7827))
    expect(info.label).toBe("Grown defects")
    expect(info.description).toContain("thousands")
  })

  it("explains that millions of corrected read errors are normal", () => {
    const info = describeAttribute(scsiRow("read_total_errors_corrected", 19650581))
    expect(info.description).toContain("normal")
  })

  it("points link counters at the cabling rather than the drive", () => {
    expect(describeAttribute(scsiRow("sas_invalid_dword_count", 255)).description).toContain(
      "cable",
    )
    expect(
      describeAttribute(scsiRow("sas_loss_of_dword_synchronization_count", 6)).description,
    ).toContain("cabling")
  })

  it("has a description for every row the SAS parser can emit", () => {
    const emitted = [
      "scsi_smart_status",
      "scsi_grown_defect_list",
      "read_total_uncorrected_errors",
      "write_total_uncorrected_errors",
      "verify_total_uncorrected_errors",
      "read_errors_corrected_by_rereads_rewrites",
      "write_errors_corrected_by_rereads_rewrites",
      "verify_errors_corrected_by_rereads_rewrites",
      "read_total_errors_corrected",
      "write_total_errors_corrected",
      "verify_total_errors_corrected",
      "sas_invalid_dword_count",
      "sas_loss_of_dword_synchronization_count",
      "sas_running_disparity_error_count",
      "sas_phy_reset_problem_count",
      "power_on_hours",
      "temperature_celsius",
    ]
    for (const name of emitted) {
      const info = describeAttribute(scsiRow(name))
      expect(info.label, name).not.toBe(name)
      expect(info.description, name).not.toContain("no plain-language explanation yet")
    }
  })
})
