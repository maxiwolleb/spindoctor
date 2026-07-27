<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import type { DriveView, RunView } from "@spindoctor/shared"
import { ApiError, createApiClient } from "../api/client"
import type { RunDetail } from "../api/client"
import { humanBytes, modeLabel } from "../lib/format"
import { useConsoleStore } from "../stores/useConsoleStore"
import VerdictBadge from "../components/VerdictBadge.vue"
import SmartDiffTable from "../components/SmartDiffTable.vue"
import VerdictReasons from "../components/VerdictReasons.vue"
import SmartAttributesTable from "../components/SmartAttributesTable.vue"
import StageTimeline from "../components/StageTimeline.vue"
import RunProgress from "../components/RunProgress.vue"

const props = defineProps<{ serial: string }>()

const api = createApiClient()
const store = useConsoleStore()

/**
 * This drive's in-flight run, straight off the shared live connection the app
 * shell holds open. Before #21 this page fetched once and never updated, so a
 * run's stage and percent sat frozen at whatever they were when the page
 * loaded.
 */
const live = computed(() => store.liveForDrive(props.serial))

const drive = ref<DriveView | null>(null)
const runs = ref<RunView[]>([])
const latestRunDetail = ref<RunDetail | null>(null)
const loading = ref(true)
const notFound = ref(false)
const error = ref<string | null>(null)
const runDetailError = ref<string | null>(null)

/** Which snapshot the full-attribute table shows. Defaults to "after" (the
 * post-test state) once a run loads, unless only "before" was captured (e.g.
 * a run still in progress) — see `load()`. */
const attributePhase = ref<"before" | "after">("after")

const attributesForPhase = computed(
  () => latestRunDetail.value?.attributes?.[attributePhase.value] ?? [],
)

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
      // Prefer the post-test snapshot; fall back to "before" for a run
      // that's still in progress (or skipped the after-side capture) so the
      // table shows something instead of defaulting to an empty phase.
      attributePhase.value = latestRunDetail.value.attributes?.after?.length ? "after" : "before"
    } catch (err) {
      // The drive header + run history already loaded fine; don't blank the
      // whole page over a run-detail hiccup, just note it inline.
      runDetailError.value = messageOf(err)
    }
  }

  loading.value = false
}

/**
 * The fetched stage rows with the live percent overlaid onto whichever stage is
 * currently running, so the timeline advances instead of showing the percent
 * from page-load time. Only the matching run's stages are touched, and only
 * rows that already exist — a stage the backend hasn't persisted yet is picked
 * up by the reload below rather than invented here.
 */
const stagesForTimeline = computed(() => {
  const stages = latestRunDetail.value?.stages ?? []
  const l = live.value
  if (!l || l.runId !== latestRunDetail.value?.run.id) return stages
  return stages.map((stage) =>
    stage.stage === l.stage ? { ...stage, status: "RUNNING", progress: l.percent } : stage,
  )
})

/** Stage names already reloaded for, so a transition triggers exactly one
 * reload even if several events arrive for the same stage. */
const reloadedStages = new Set<string>()

// A stage transition adds a row (and finalizes the previous one), so pull the
// authoritative detail rather than guessing at the new row's shape.
watch(
  () => live.value?.stage,
  (stage) => {
    if (!stage || reloadedStages.has(stage)) return
    const known = latestRunDetail.value?.stages.some((s) => s.stage === stage)
    if (known) return
    reloadedStages.add(stage)
    void load()
  },
)

// The live entry is dropped the moment a run goes terminal, which is also when
// everything on this page changes at once — verdict, after-SMART, captured logs
// — so reload it all.
watch(live, (now, before) => {
  if (before && !now) {
    reloadedStages.clear()
    void load()
  }
})

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

      <!-- Live activity for an in-flight run: the same bar the dashboard row
           shows, so this page stops being a stale snapshot mid-run. -->
      <div v-if="live" class="mb-6" data-test="live-activity">
        <h2 class="text-subtitle-1 mb-2">Live activity</h2>
        <RunProgress :live="live" />
      </div>

      <template v-if="latestRunDetail">
        <!-- Why the verdict says what it says. Load-bearing for a run the
             baseline gate cut short (issue #49): without it, a FAIL reached in
             seconds with three skipped stages has no visible explanation. -->
        <template v-if="latestRunDetail.run.verdict">
          <h2 class="text-subtitle-1 mb-2">Why this verdict</h2>
          <VerdictReasons :reasons="latestRunDetail.run.reasons" class="mb-6" />
        </template>

        <h2 class="text-subtitle-1 mb-2">Latest run — SMART diff</h2>
        <SmartDiffTable
          :before="latestRunDetail.snapshots.before"
          :after="latestRunDetail.snapshots.after"
          class="mb-6"
        />

        <div class="d-flex align-center justify-space-between mb-2 flex-wrap ga-2">
          <div class="d-flex align-center ga-4">
            <h2 class="text-subtitle-1 ma-0">SMART attributes</h2>
            <v-btn-toggle v-model="attributePhase" mandatory density="compact" color="primary">
              <v-btn value="before" size="small">Before</v-btn>
              <v-btn value="after" size="small">After</v-btn>
            </v-btn-toggle>
          </div>
          <v-btn
            :href="api.getRunSmartUrl(latestRunDetail.run.id)"
            download
            variant="tonal"
            size="small"
            color="primary"
          >
            Download raw SMART
          </v-btn>
        </div>
        <SmartAttributesTable :attributes="attributesForPhase" class="mb-6" />

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
        <StageTimeline :stages="stagesForTimeline" class="mb-6" />
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
