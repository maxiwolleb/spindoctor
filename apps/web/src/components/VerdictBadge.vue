<script setup lang="ts">
import { computed } from "vue"
import type { Verdict } from "@spindoctor/shared"
import { verdictColor, verdictLabel } from "../lib/format"

const props = defineProps<{
  verdict: Verdict | null
}>()

// PASS reads as a *state*, not just green text: a solid phosphor pill with
// dark text. WARN/FAIL stay tonal pills — only PASS is unmistakably solid.
const variant = computed(() => (props.verdict === "PASS" ? "flat" : "tonal"))
</script>

<template>
  <v-chip
    v-if="verdict"
    :color="verdictColor(verdict)"
    :variant="variant"
    :class="{ 'verdict-badge--pass': verdict === 'PASS' }"
    size="small"
    label
  >
    {{ verdictLabel(verdict) }}
  </v-chip>
  <span v-else class="text-medium-emphasis">{{ verdictLabel(verdict) }}</span>
</template>

<style scoped>
/* Vuetify picks readable on-success text for a flat chip already, but the
   brand spec pins an exact dark text color for the solid PASS pill. */
.verdict-badge--pass {
  color: #052015 !important;
}
</style>
