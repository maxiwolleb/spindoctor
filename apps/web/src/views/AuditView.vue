<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { createApiClient, type AuditEntry } from "../api/client"

const api = createApiClient()

const rawEntries = ref<AuditEntry[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Sorted defensively rather than trusted as-is: `GET /api/audit` already
// returns newest-first, but the view owns its own display order so a future
// backend change (or a test double) can't silently flip the table.
const entries = computed<AuditEntry[]>(() =>
  [...rawEntries.value].sort((a, b) => {
    const byTime = new Date(b.ts).getTime() - new Date(a.ts).getTime()
    return byTime !== 0 ? byTime : b.id - a.id
  }),
)

/** Human-readable timestamp — falls back to the raw ISO string for an
 * unparseable value rather than rendering "Invalid Date". */
function formatWhen(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    rawEntries.value = await api.getAudit()
  } catch (err) {
    error.value = messageOf(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-4">Audit</h1>

    <div v-if="loading" class="text-medium-emphasis">Loading audit log…</div>

    <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}</v-alert>

    <p v-else-if="entries.length === 0" class="text-medium-emphasis">No activity yet.</p>

    <v-table v-else density="comfortable">
      <thead>
        <tr>
          <th>When</th>
          <th>Action</th>
          <th>Drive</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.id">
          <td class="mono">{{ formatWhen(entry.ts) }}</td>
          <td>{{ entry.action }}</td>
          <td class="mono">{{ entry.driveSerial ?? "—" }}</td>
          <td>{{ entry.detail ?? "—" }}</td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>
