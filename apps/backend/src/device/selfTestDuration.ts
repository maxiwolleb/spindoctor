import type { Db } from "../db/client"
import { getRun, getSnapshotRaws } from "../db/repositories"
import { parseLongSelfTestMinutes } from "./smartParser"

/** Where `#recoverDeclaredSelfTestMinutes` stashes a duration the baseline
 * capture could not see. Lives in the run's `regime` JSON so it survives a
 * container restart, alongside `forceFullRegime`. */
export const DECLARED_SELFTEST_MINUTES_KEY = "declaredSelfTestMinutes"

/**
 * The self-test duration to show for a run: the figure recovered after the
 * routine was started if there is one, otherwise the baseline capture's.
 *
 * Both readers (`GET /api/runs/:id` and the SSE bridge) have to agree with the
 * progress events the engine emits, so the preference order lives here rather
 * than being written out twice.
 *
 * Why a recovered figure can exist at all: smartctl omits
 * `scsi_extended_self_test_seconds` while a SAS drive's self-test log is empty,
 * so a drive that has never been tested declares nothing to the baseline read
 * even though its firmware does publish a duration. Verified on a SAS
 * ST8000NM0075 — `null` on the run that started its first self-test, then 787
 * (= 47220 s) on the next run, from the same unchanged drive.
 */
export function declaredSelfTestMinutes(db: Db, runId: number): number | null {
  const regime = getRun(db, runId)?.regime
  if (regime !== null && typeof regime === "object") {
    const recovered = (regime as Record<string, unknown>)[DECLARED_SELFTEST_MINUTES_KEY]
    if (typeof recovered === "number" && Number.isFinite(recovered) && recovered > 0) {
      return recovered
    }
  }
  return parseLongSelfTestMinutes(getSnapshotRaws(db, runId).before)
}
