<script setup lang="ts">
import type { DriveView } from "@spindoctor/shared"
import { humanBytes, verdictColor } from "../lib/format"
import RunProgress from "./RunProgress.vue"
import type { RunProgressLive } from "./RunProgress.vue"
import VerdictBadge from "./VerdictBadge.vue"

const props = defineProps<{
  drives: DriveView[]
  liveByDrive: Record<string, RunProgressLive>
}>()

const emit = defineEmits<{
  start: [serial: string]
  open: [serial: string]
}>()

const headers = [
  { title: "", key: "status", sortable: false, width: 40 },
  { title: "Model", key: "model" },
  { title: "Serial", key: "serial" },
  { title: "Size", key: "sizeBytes" },
  { title: "Type", key: "type" },
  { title: "Health", key: "health", sortable: false },
  { title: "Activity", key: "activity", sortable: false },
  { title: "Verdict", key: "verdict", sortable: false },
  { title: "", key: "actions", sortable: false, align: "end" as const },
]

/** Status-dot color: a live run in flight always wins (running takes
 * precedence visually over a stale verdict from the last run); otherwise
 * falls back to the last verdict, or secondary for "no run yet". */
function dotColor(drive: DriveView): string {
  if (props.liveByDrive[drive.serial]) return "primary"
  return verdictColor(drive.latestRun?.verdict ?? null)
}

function onRowClick(_event: Event, row: { item: DriveView }): void {
  emit("open", row.item.serial)
}

function onStartClick(serial: string): void {
  emit("start", serial)
}
</script>

<template>
  <v-data-table
    :headers="headers"
    :items="drives"
    item-value="serial"
    density="comfortable"
    :items-per-page="-1"
    hide-default-footer
    @click:row="onRowClick"
  >
    <template #item.status="{ item }">
      <span class="status-dot" :class="`status-dot--${dotColor(item)}`" />
    </template>

    <template #item.serial="{ item }">
      <span class="mono">{{ item.serial }}</span>
    </template>

    <template #item.sizeBytes="{ item }">
      <span class="mono">{{ humanBytes(item.sizeBytes) }}</span>
    </template>

    <template #item.health="{ item }">
      <div class="d-flex ga-1 flex-wrap">
        <v-chip v-if="!item.present" size="x-small" color="secondary" variant="tonal">Absent</v-chip>
        <v-chip v-if="item.mounted" size="x-small" color="warning" variant="tonal">Mounted</v-chip>
        <v-chip v-if="item.isSystemDisk" size="x-small" color="error" variant="tonal">System</v-chip>
        <v-chip v-if="item.protected" size="x-small" color="secondary" variant="tonal">Protected</v-chip>
      </div>
    </template>

    <template #item.activity="{ item }">
      <RunProgress :live="liveByDrive[item.serial] ?? null" />
    </template>

    <template #item.verdict="{ item }">
      <VerdictBadge :verdict="item.latestRun?.verdict ?? null" />
    </template>

    <template #item.actions="{ item }">
      <v-btn size="small" color="primary" variant="tonal" @click.stop="onStartClick(item.serial)">
        Start test
      </v-btn>
    </template>

    <template #no-data>
      <p class="text-medium-emphasis pa-4 ma-0">No drives detected. Attach a drive and it'll appear here.</p>
    </template>
  </v-data-table>
</template>

<style scoped>
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot--primary {
  background: rgb(var(--v-theme-primary));
}

.status-dot--success {
  background: rgb(var(--v-theme-success));
}

.status-dot--warning {
  background: rgb(var(--v-theme-warning));
}

.status-dot--error {
  background: rgb(var(--v-theme-error));
}

.status-dot--secondary {
  background: rgb(var(--v-theme-secondary));
}
</style>
