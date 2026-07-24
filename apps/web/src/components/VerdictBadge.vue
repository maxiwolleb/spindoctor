<script setup lang="ts">
import type { Verdict } from "@spindoctor/shared"
import { verdictColor, verdictLabel } from "../lib/format"

defineProps<{
  verdict: Verdict | null
}>()
</script>

<template>
  <v-chip v-if="verdict" :color="verdictColor(verdict)" variant="flat" size="small" label>
    {{ verdictLabel(verdict) }}
  </v-chip>
  <span v-else class="text-medium-emphasis">{{ verdictLabel(verdict) }}</span>
</template>
