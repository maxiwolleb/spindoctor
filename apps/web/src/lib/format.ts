import type { Verdict } from "@spindoctor/shared"

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/** Decimal (SI) byte formatting — matches drive-marketing sizes (a "4 TB"
 * drive reports `sizeBytes` around 4_000_787_030_016, i.e. 4.0 * 1000^4). */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  if (n < 1000) return `${Math.round(n)} B`

  let value = n
  let unitIndex = 0
  while (value >= 1000 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1000
    unitIndex++
  }
  // unitIndex is always in range (bounded by the loop condition above); the
  // fallback only appeases noUncheckedIndexedAccess.
  const unit = BYTE_UNITS[unitIndex] ?? "TB"
  return `${value.toFixed(1)} ${unit}`
}

/** Verdict → Vuetify color name. `null` covers "no run yet" / "not graded". */
export function verdictColor(v: Verdict | null): "success" | "warning" | "error" | "secondary" {
  switch (v) {
    case "PASS":
      return "success"
    case "WARN":
      return "warning"
    case "FAIL":
      return "error"
    default:
      return "secondary"
  }
}

export function verdictLabel(v: Verdict | null): string {
  switch (v) {
    case "PASS":
      return "Pass"
    case "WARN":
      return "Warn"
    case "FAIL":
      return "Fail"
    default:
      return "—"
  }
}

const STAGE_LABELS: Record<string, string> = {
  SMART_BEFORE: "SMART (before)",
  SELFTEST_LONG: "Self-test",
  SURFACE: "Surface scan",
  SMART_AFTER: "SMART (after)",
  VERDICT: "Verdict",
}

/** Human label for a `StageName`. Falls back to the raw value for anything
 * unrecognized rather than hiding it — an unmapped stage should be visible,
 * not silently swallowed. */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage
}

/** `RunStatus` → Vuetify color name, following the same palette as
 * `verdictColor` (idle/pending → secondary, running → primary). */
export function runStatusColor(status: string): "primary" | "secondary" | "success" | "warning" | "error" {
  switch (status) {
    case "PENDING":
      return "secondary"
    case "RUNNING":
      return "primary"
    case "DONE":
      return "success"
    case "FAILED":
      return "error"
    case "ABORTED":
      return "warning"
    default:
      return "secondary"
  }
}
