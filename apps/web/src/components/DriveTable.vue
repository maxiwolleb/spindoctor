<script setup lang="ts">
import type { DriveView } from "@spindoctor/shared"
import { humanBytes, verdictColor } from "../lib/format"
import RunProgress from "./RunProgress.vue"
// The store's live type rather than RunProgress's presentational one: this table
// needs the run id to offer a Stop button, which RunProgressLive has no reason to
// carry. LiveProgress is a superset, so it still satisfies RunProgress's prop.
import type { LiveProgress } from "../stores/useConsoleStore"
import VerdictBadge from "./VerdictBadge.vue"

const props = defineProps<{
  drives: DriveView[]
  liveByDrive: Record<string, LiveProgress>
  /** Set when the drive list failed to load, so an empty table says so rather
   * than claiming no drives are attached. */
  loadFailed?: boolean
}>()

const emit = defineEmits<{
  start: [serial: string]
  stop: [runId: number]
  open: [serial: string]
}>()

const headers = [
  { title: "", key: "status", sortable: false, width: 40 },
  { title: "Model", key: "model" },
  { title: "Serial", key: "serial" },
  { title: "Size", key: "sizeBytes" },
  { title: "Type", key: "type" },
  { title: "Flags", key: "flags", sortable: false },
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

/**
 * The id of a run the engine still owns for this drive, or null.
 *
 * Both sources matter. `latestRun` covers a run this client started or loaded,
 * but the store only writes it back on *terminal* events — a run started by
 * auto-mode or another tab arrives purely as live progress. Reading only
 * `latestRun` therefore left the row showing a progress bar with the Start button
 * still enabled, so clicking it returned a 409, and gave the Stop button nothing
 * to stop (issue #104).
 */
function activeRunId(drive: DriveView): number | null {
  const live = props.liveByDrive[drive.serial]
  if (live) return live.runId
  const latest = drive.latestRun
  if (latest && (latest.status === "RUNNING" || latest.status === "PENDING")) return latest.id
  return null
}

/** A drive with no device node behind it can't be tested — `startRun` 404s. */
function startDisabled(drive: DriveView): boolean {
  return activeRunId(drive) !== null || !drive.present
}

/** Makes each data row keyboard-openable, not just clickable: focusable via
 * Tab, and Enter/Space triggers the same `open` emit as a row click. Without
 * this, the "Open" affordance would be mouse-only. */
function rowProps({ item }: { item: DriveView }): Record<string, unknown> {
  return {
    tabindex: 0,
    role: "button",
    "aria-label": `Open ${item.model} ${item.serial}`,
    onKeydown: (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      emit("open", item.serial)
    },
  }
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
    :row-props="rowProps"
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

    <template #item.flags="{ item }">
      <div class="d-flex ga-1 flex-wrap">
        <v-chip v-if="!item.present" size="x-small" color="secondary" variant="tonal"
          >Absent</v-chip
        >
        <v-chip v-if="item.mounted" size="x-small" color="warning" variant="tonal">Mounted</v-chip>
        <v-chip v-if="item.isSystemDisk" size="x-small" color="error" variant="tonal"
          >System</v-chip
        >
        <!-- Something holds the device: a mounted filesystem in any namespace, an
             LVM/md member, swap, another container. Inside the container this is
             the flag that fires where "Mounted" cannot (issue #83). -->
        <v-chip v-if="item.claim === 'claimed'" size="x-small" color="warning" variant="tonal"
          >In use</v-chip
        >
        <!-- Not a refusal, but not a clean bill of health either: saying nothing
             here would read as "checked, nothing using it". -->
        <v-chip
          v-else-if="item.claim === 'unknown'"
          size="x-small"
          color="secondary"
          variant="tonal"
          >Use unknown</v-chip
        >
        <v-chip v-if="item.protected" size="x-small" color="secondary" variant="tonal"
          >Protected</v-chip
        >
      </div>
    </template>

    <template #item.activity="{ item }">
      <RunProgress :live="liveByDrive[item.serial] ?? null" />
    </template>

    <template #item.verdict="{ item }">
      <VerdictBadge :verdict="item.latestRun?.verdict ?? null" />
    </template>

    <template #item.actions="{ item }">
      <!-- Stop replaces Start while a run is in flight rather than sitting beside
           it: the only action that makes sense for a drive already being tested is
           stopping it, and a destructive wipe must be stoppable from the same
           screen that started it (issue #104). -->
      <v-btn
        v-if="activeRunId(item) !== null"
        size="small"
        color="error"
        variant="tonal"
        @click.stop="emit('stop', activeRunId(item) as number)"
      >
        Stop
      </v-btn>
      <v-btn
        v-else
        size="small"
        color="primary"
        variant="tonal"
        :disabled="startDisabled(item)"
        @click.stop="onStartClick(item.serial)"
      >
        Start test
      </v-btn>
    </template>

    <template #no-data>
      <!-- An empty table after a failed load must not read as "nothing attached":
           that reassuring sentence stood in for a load error (issue #104). -->
      <p v-if="loadFailed" class="text-medium-emphasis pa-4 ma-0">
        Drives could not be loaded — see the error above.
      </p>
      <p v-else class="text-medium-emphasis pa-4 ma-0">
        No drives detected. Attach a drive and it'll appear here.
      </p>
    </template>
  </v-data-table>
</template>

<style scoped>
:deep(tr.v-data-table__tr) {
  cursor: pointer;
}

:deep(tr.v-data-table__tr:focus-visible) {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}

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
