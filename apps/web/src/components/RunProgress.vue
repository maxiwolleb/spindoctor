<script setup lang="ts">
import { computed } from "vue"
import { stageLabel } from "../lib/format"

/** The store's `LiveProgress` carries more fields (`runId`, `verdict`) than
 * this component reads; a wider object is fine to pass in, so the prop only
 * declares what's actually used here. */
export interface RunProgressLive {
  stage: string
  percent: number
  status: string
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
</script>

<template>
  <div
    v-if="variant && live"
    class="run-progress"
    :class="{ 'run-progress--signature': variant === 'signature' }"
  >
    <v-progress-linear :model-value="live.percent" color="primary" height="6" rounded class="run-progress__bar" />
    <span class="run-progress__label text-caption text-medium-emphasis">{{ stageLabel(live.stage) }}</span>
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

/* The signature "write-head" sweep: a soft highlight band that travels
   across the bar continuously while the surface scan is in flight —
   visually distinct from the plain determinate bar used elsewhere. */
.run-progress--signature .run-progress__bar::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(78, 161, 255, 0.55), transparent);
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
