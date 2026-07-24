import type { RegimeMode, StageName } from "@spindoctor/shared"

interface RegimeStage {
  stage: StageName
  surfaceMode?: RegimeMode
}

/**
 * Returns the ordered list of stages for a test regime.
 * The SURFACE stage carries the mode (destructive or read-only).
 */
export function regimeStages(mode: RegimeMode): RegimeStage[] {
  return [
    { stage: "SMART_BEFORE" },
    { stage: "SELFTEST_LONG" },
    { stage: "SURFACE", surfaceMode: mode },
    { stage: "SMART_AFTER" },
    { stage: "VERDICT" },
  ]
}
