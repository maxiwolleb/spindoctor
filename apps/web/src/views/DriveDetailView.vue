<script setup lang="ts">
import { onMounted, ref } from "vue"
import type { DriveView, RunView } from "@spindoctor/shared"
import { ApiError, createApiClient } from "../api/client"
import type { RunDetail } from "../api/client"
import { humanBytes, modeLabel } from "../lib/format"
import VerdictBadge from "../components/VerdictBadge.vue"
import SmartDiffTable from "../components/SmartDiffTable.vue"
import StageTimeline from "../components/StageTimeline.vue"

const props = defineProps<{ serial: string }>()

const api = createApiClient()

const drive = ref<DriveView | null>(null)
const runs = ref<RunView[]>([])
const latestRunDetail = ref<RunDetail | null>(null)
const loading = ref(true)
const notFound = ref(false)
const error = ref<string | null>(null)
const runDetailError = ref<string | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Human-readable run timestamp — falls back to the raw value for an empty
 * or unparseable `createdAt` rather than rendering "Invalid Date". */
function formatRunDate(createdAt: string): string {
  if (!createdAt) return createdAt
  const d = new Date(createdAt)
  return Number.isNaN(d.getTime()) ? createdAt : d.toLocaleString()
}

async function load(): Promise<void> {
  loading.value = true
  notFound.value = false
  error.value = null
  runDetailError.value = null
  latestRunDetail.value = null

  try {
    const detail = await api.getDrive(props.serial)
    drive.value = detail.drive
    // `GET /api/drives/:serial` already returns runs newest-first (mirrors
    // `listRuns`'s ordering), so the first entry is the latest run.
    runs.value = detail.runs
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound.value = true
    } else {
      error.value = messageOf(err)
    }
    loading.value = false
    return
  }

  const newest = runs.value[0]
  if (newest) {
    try {
      latestRunDetail.value = await api.getRun(newest.id)
    } catch (err) {
      // The drive header + run history already loaded fine; don't blank the
      // whole page over a run-detail hiccup, just note it inline.
      runDetailError.value = messageOf(err)
    }
  }

  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="pa-6">
    <router-link to="/" class="d-inline-block mb-4 text-decoration-none text-info"
      >&larr; Back to dashboard</router-link
    >

    <div v-if="loading" class="text-medium-emphasis">Loading drive…</div>

    <v-alert v-else-if="notFound" type="warning" variant="tonal">
      No drive found with serial "{{ serial }}".
    </v-alert>

    <v-alert v-else-if="error" type="error" variant="tonal">{{ error }}</v-alert>

    <template v-else-if="drive">
      <div class="d-flex align-center ga-4 mb-6 flex-wrap">
        <div>
          <h1 class="text-h5 ma-0">{{ drive.model }}</h1>
          <p class="mono text-medium-emphasis ma-0">
            {{ drive.serial }} · {{ humanBytes(drive.sizeBytes) }}
          </p>
        </div>
        <VerdictBadge :verdict="drive.latestRun?.verdict ?? null" />
      </div>

      <template v-if="latestRunDetail">
        <h2 class="text-subtitle-1 mb-2">Latest run — SMART diff</h2>
        <SmartDiffTable
          :before="latestRunDetail.snapshots.before"
          :after="latestRunDetail.snapshots.after"
          class="mb-6"
        />

        <div class="d-flex align-center justify-space-between mb-2">
          <h2 class="text-subtitle-1 ma-0">Stage timeline</h2>
          <v-btn
            :href="api.getRunLogUrl(latestRunDetail.run.id)"
            download
            variant="tonal"
            size="small"
            color="primary"
          >
            Download log
          </v-btn>
        </div>
        <StageTimeline :stages="latestRunDetail.stages" class="mb-6" />
      </template>
      <v-alert
        v-else-if="runDetailError"
        type="error"
        variant="tonal"
        density="compact"
        class="mb-6"
      >
        {{ runDetailError }}
      </v-alert>
      <p v-else class="text-medium-emphasis">No test runs yet for this drive.</p>

      <h2 class="text-subtitle-1 mb-2">Run history</h2>
      <v-list v-if="runs.length" density="compact" class="bg-transparent">
        <v-list-item v-for="run in runs" :key="run.id">
          <div class="d-flex align-center ga-4">
            <span class="mono">{{ formatRunDate(run.createdAt) }}</span>
            <span>{{ modeLabel(run.mode) }}</span>
            <!-- VerdictBadge already renders verdictLabel(run.verdict) internally
                 (chip text, or the "—" fallback span for a null verdict). -->
            <VerdictBadge :verdict="run.verdict" />
          </div>
        </v-list-item>
      </v-list>
      <p v-else class="text-medium-emphasis">No runs recorded.</p>
    </template>
  </div>
</template>
