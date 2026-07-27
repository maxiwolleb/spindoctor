<script setup lang="ts">
import { computed } from "vue"
import type { Reason, Severity } from "@spindoctor/shared"
import { severityColor, severityLabel } from "../lib/format"

const props = defineProps<{
  reasons: Reason[]
}>()

/** Severity order for display: what condemned the drive first, notes last.
 * A run can carry a dozen reasons, and the operator's question is always
 * "why did this fail", not "what else did you notice". */
const SEVERITY_RANK: Record<Severity, number> = { fail: 0, warn: 1, info: 2 }

const sorted = computed<Reason[]>(() =>
  [...props.reasons].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
)
</script>

<template>
  <ul v-if="sorted.length" class="verdict-reasons">
    <li v-for="reason in sorted" :key="reason.code" class="verdict-reasons__item">
      <v-chip
        :color="severityColor(reason.severity)"
        variant="tonal"
        size="small"
        label
        class="verdict-reasons__severity"
      >
        {{ severityLabel(reason.severity) }}
      </v-chip>
      <span class="verdict-reasons__message">{{ reason.message }}</span>
      <code class="mono verdict-reasons__code">{{ reason.code }}</code>
    </li>
  </ul>
  <p v-else class="text-medium-emphasis">
    Nothing to report — no thresholds crossed and no errors found.
  </p>
</template>

<style scoped>
.verdict-reasons {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.verdict-reasons__item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.verdict-reasons__severity {
  flex-shrink: 0;
  /* Fixed width so the messages line up into a readable column instead of
     stepping in and out with the chip text. */
  min-width: 72px;
  justify-content: center;
}

.verdict-reasons__message {
  flex: 1;
  min-width: 0;
}

.verdict-reasons__code {
  font-size: 11px;
  color: var(--muted);
}
</style>
