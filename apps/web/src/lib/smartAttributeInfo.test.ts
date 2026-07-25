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
