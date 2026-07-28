<script setup lang="ts">
import { computed } from "vue"
import { stageLabel } from "../lib/format"
import { computeEta, formatRemaining } from "../lib/eta"

/** The store's `LiveProgress` carries more fields (`runId`, `verdict`) than
 * this component reads; a wider object is fine to pass in, so the prop only
 * declares what's actually used here. */
export interface RunProgressLive {
  stage: string
  percent: number
  status: string
  /** The current stage's start time, ISO string — see `LiveProgress.startedAt`.
   * Optional because a few tests/callers only care about the stage/percent
   * bar itself; `undefined` is treated exactly like `null` (no ETA yet). */
  startedAt?: string | null
  /** Minutes the drive itself declares for the current stage — see
   * `LiveProgress.declaredTotalMinutes`. Optional on the same terms as
   * `startedAt`; absent means "extrapolate as before". */
  declaredTotalMinutes?: number | null
}

const props = defineProps<{
  live?: RunProgressLive | null
}>()

type Variant = "signature" | "plain"

/** `SURFACE` gets the signature sweeping write-head treatment (the
 * destructive badblocks pass is the slow, high-stakes stage — worth a
 * distinct visual signature); `SELFTEST_LONG` gets a plain determinate bar.
 * Every other stage (or no live progress at all) renders nothing: those
 * stages are effectively instantaneous from the UI's point of view. */
const variant = computed<Variant | null>(() => {
  if (!props.live) return null
  if (props.live.stage === "SURFACE") return "signature"
  if (props.live.stage === "SELFTEST_LONG") return "plain"
  return null
})

/** Remaining-time estimate for the dashboard's compact activity cell (issue
 * #15) — just the "~Xh Ym left" half of the full line the stage timeline
 * shows; the wall-clock half isn't worth the extra width in a table row.
 * `null` while there's no live stage at all; "estimating…" once there is one
 * but `computeEta` doesn't have enough signal yet (missing `startedAt`, or
 * progress still too low to extrapolate from — neither of which applies to a
 * stage whose duration the drive declares, see `computeEta`). */
const etaLabel = computed<string | null>(() => {
  if (!props.live) return null
  const startedAtMs = props.live.startedAt ? new Date(props.live.startedAt).getTime() : null
  const eta = computeEta(
    startedAtMs,
    props.live.percent,
    Date.now(),
    props.live.declaredTotalMinutes,
  )
  return eta ? formatRemaining(eta.remainingMs) : "estimating…"
})
</script>

<template>
  <div
    v-if="variant && live"
    class="run-progress"
    :class="{ 'run-progress--signature': variant === 'signature' }"
  >
    <v-progress-linear
      :model-value="live.percent"
      color="primary"
      height="6"
      class="run-progress__bar"
    />
    <div class="run-progress__meta text-caption text-medium-emphasis">
      <span class="run-progress__label">{{ stageLabel(live.stage) }}</span>
      <span v-if="etaLabel" class="run-progress__eta">· {{ etaLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.run-progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 140px;
}

.run-progress__bar {
  position: relative;
  overflow: hidden;
}

.run-progress__meta {
  display: flex;
  gap: 4px;
  white-space: nowrap;
}

/* Live signal glow — static (not animated), so it stays on even under
   prefers-reduced-motion; only the sweep below is motion. */
.run-progress--signature .run-progress__bar {
  box-shadow: 0 0 6px rgba(56, 245, 162, 0.5);
}

/* The signature "write-head" sweep: a soft highlight band that travels
   across the bar continuously while the surface scan is in flight —
   visually distinct from the plain determinate bar used elsewhere. */
.run-progress--signature .run-progress__bar::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(var(--v-theme-primary), 0.55), transparent);
  transform: translateX(-100%);
  animation: run-progress-sweep 1.6s linear infinite;
  pointer-events: none;
}

@keyframes run-progress-sweep {
  to {
    transform: translateX(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .run-progress--signature .run-progress__bar::after {
    animation: none;
  }
}
</style>
