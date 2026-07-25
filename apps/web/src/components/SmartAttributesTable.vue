<script setup lang="ts">
import { computed } from "vue"
import type { SmartAttributeRow } from "@spindoctor/shared"
import { attributeHealthColor, attributeHealthLabel } from "../lib/format"
import { describeAttribute } from "../lib/smartAttributeInfo"

const props = defineProps<{
  attributes: SmartAttributeRow[]
}>()

interface Row {
  key: string
  label: string
  description: string
  value: string
  worst: string
  thresh: string
  raw: string
  health: SmartAttributeRow["health"]
}

function fmt(v: number | null): string {
  return v == null ? "—" : String(v)
}

function fmtRaw(row: SmartAttributeRow): string {
  return row.rawString ?? fmt(row.rawValue)
}

const rows = computed<Row[]>(() =>
  props.attributes.map((a) => {
    const info = describeAttribute(a)
    return {
      key: a.id != null ? `id-${a.id}` : `name-${a.name}`,
      label: info.label,
      description: info.description,
      value: fmt(a.value),
      worst: fmt(a.worst),
      thresh: fmt(a.thresh),
      raw: fmtRaw(a),
      health: a.health,
    }
  }),
)
</script>

<template>
  <table v-if="rows.length" class="mono smart-attributes-table">
    <thead>
      <tr>
        <th>Attribute</th>
        <th>Value</th>
        <th>Worst</th>
        <th>Thresh</th>
        <th>Raw</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.key" :class="`smart-attributes-table__row--${row.health}`">
        <td class="smart-attributes-table__attribute">
          <div class="smart-attributes-table__label">{{ row.label }}</div>
          <div class="smart-attributes-table__description">{{ row.description }}</div>
        </td>
        <td>{{ row.value }}</td>
        <td>{{ row.worst }}</td>
        <td>{{ row.thresh }}</td>
        <td>{{ row.raw }}</td>
        <td>
          <v-chip :color="attributeHealthColor(row.health)" variant="tonal" size="small" label>
            {{ attributeHealthLabel(row.health) }}
          </v-chip>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else class="text-medium-emphasis">No SMART attributes available for this snapshot.</p>
</template>

<style scoped>
.smart-attributes-table {
  width: 100%;
  border-collapse: collapse;
}

.smart-attributes-table th,
.smart-attributes-table td {
  text-align: left;
  vertical-align: top;
  padding: 8px 16px 8px 0;
  border-bottom: 1px solid var(--border);
}

.smart-attributes-table th {
  color: var(--muted);
  font-weight: 500;
}

.smart-attributes-table__attribute {
  min-width: 220px;
  max-width: 420px;
}

.smart-attributes-table__label {
  font-weight: 500;
}

.smart-attributes-table__description {
  margin-top: 2px;
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  white-space: normal;
}

/* Row tints match the brand's exact WARN/FAIL hexes at low opacity — a
   healthy ("ok") row stays neutral so the flagged ones stand out. */
.smart-attributes-table__row--warn {
  background: rgba(227, 179, 65, 0.08);
}

.smart-attributes-table__row--fail {
  background: rgba(255, 92, 87, 0.08);
}
</style>
