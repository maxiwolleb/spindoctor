<script setup lang="ts">
import { computed } from "vue"
import type { NumericSmartMetricKey, SmartKeyMetrics } from "@spindoctor/shared"

const props = defineProps<{
  before: SmartKeyMetrics | null
  after: SmartKeyMetrics | null
}>()

interface MetricDef {
  key: NumericSmartMetricKey
  label: string
  /** Mirrors the verdict evaluator's growth/threshold checks
   * (apps/backend/src/verdict/evaluate.ts): for these metrics a rise from
   * before to after is a genuine health regression worth flagging. Power-on
   * hours and temperature are informational only — they're expected to move
   * around during a test and aren't graded, so growth there is never
   * "worse". */
  worseIsHigher: boolean
}

const METRICS: MetricDef[] = [
  { key: "reallocatedSectors", label: "Reallocated sectors", worseIsHigher: true },
  { key: "currentPending", label: "Current pending sectors", worseIsHigher: true },
  { key: "offlineUncorrectable", label: "Offline uncorrectable", worseIsHigher: true },
  { key: "reportedUncorrect", label: "Reported uncorrect", worseIsHigher: true },
  // SAS/SCSI only — null (and so rendered "—") on ATA/NVMe, same as the NVMe
  // rows are on a spinning ATA disk.
  { key: "grownDefects", label: "Grown defects (SAS)", worseIsHigher: true },
  { key: "linkErrors", label: "Link errors (SAS)", worseIsHigher: true },
  { key: "spinRetryCount", label: "Spin retries", worseIsHigher: true },
  { key: "commandTimeouts", label: "Command timeouts", worseIsHigher: true },
  { key: "crcErrors", label: "CRC errors", worseIsHigher: true },
  { key: "powerOnHours", label: "Power-on hours", worseIsHigher: false },
  { key: "percentageUsed", label: "Percentage used", worseIsHigher: true },
  { key: "mediaErrors", label: "Media errors", worseIsHigher: true },
  { key: "temperatureC", label: "Temperature (°C)", worseIsHigher: false },
]

interface Row {
  key: string
  label: string
  before: string
  after: string
  delta: string
  worse: boolean
}

function fmt(v: number | null): string {
  return v == null ? "—" : String(v)
}

function fmtDelta(before: number | null, after: number | null): string {
  if (before == null || after == null) return "—"
  const d = after - before
  if (d === 0) return "0"
  return d > 0 ? `+${d}` : `${d}`
}

const rows = computed<Row[]>(() =>
  METRICS.map((m) => {
    const b = props.before?.[m.key] ?? null
    const a = props.after?.[m.key] ?? null
    return {
      key: m.key,
      label: m.label,
      before: fmt(b),
      after: fmt(a),
      delta: fmtDelta(b, a),
      worse: m.worseIsHigher && b != null && a != null && a > b,
    }
  }),
)
</script>

<template>
  <table class="mono smart-diff-table">
    <thead>
      <tr>
        <th>Metric</th>
        <th>Before</th>
        <th>After</th>
        <th>Δ</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.key">
        <td>{{ row.label }}</td>
        <td>{{ row.before }}</td>
        <td>{{ row.after }}</td>
        <td :class="{ 'smart-diff-table__delta--worse': row.worse }">{{ row.delta }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.smart-diff-table {
  width: 100%;
  border-collapse: collapse;
}

.smart-diff-table th,
.smart-diff-table td {
  text-align: left;
  padding: 6px 16px 6px 0;
  border-bottom: 1px solid var(--border);
}

.smart-diff-table th {
  color: var(--muted);
  font-weight: 500;
}

.smart-diff-table__delta--worse {
  color: rgb(var(--v-theme-error));
  font-weight: 600;
}
</style>
