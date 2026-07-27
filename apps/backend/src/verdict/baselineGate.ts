import type { DriveType, Reason, SmartKeyMetrics, Thresholds } from "@spindoctor/shared"
import { evaluateVerdict } from "./evaluate"

export interface BaselineGateInput {
  /** The `SMART_BEFORE` snapshot — the only evidence available this early. */
  before: SmartKeyMetrics
  deviceType: DriveType
  thresholds: Thresholds
}

/**
 * Decides, from the baseline SMART read alone, whether a drive is already
 * condemned — i.e. whether a fail-severity reason is on the table before the
 * long self-test and the (hours-long, destructive) surface pass have run at all.
 * Returns those reasons, or `[]` for a drive that still deserves the full
 * regime. Issue #49.
 *
 * Implemented by asking the real evaluator rather than restating its rules, so
 * the gate can never disagree with the verdict it is anticipating and the
 * thresholds keep living in exactly one place. Passing the same snapshot as both
 * `before` and `after` is what makes that sound:
 *
 *  - every growth rule needs `after > before`, so none can fire;
 *  - `selfTest: SKIPPED` and `surface: null` contribute no fail-severity reason;
 *
 * which leaves precisely the rules that grade a single snapshot on its own —
 * `SMART_HEALTH_FAILED`, the hard uncorrectable counters, `REALLOCATED_HIGH`,
 * `WEAR_EXHAUSTED`, `MEDIA_ERRORS`. Filtering to `fail` then guarantees the
 * property this gate lives or dies by: a drive carrying only warnings (stable
 * reallocated sectors, high-but-stable SAS grown defects, link or CRC errors)
 * is never condemned here and still earns the whole regime.
 */
export function condemnedByBaseline(input: BaselineGateInput): Reason[] {
  const { reasons } = evaluateVerdict({
    before: input.before,
    after: input.before,
    deviceType: input.deviceType,
    selfTest: { status: "SKIPPED" },
    surface: null,
    thresholds: input.thresholds,
  })
  return reasons.filter((r) => r.severity === "fail")
}
