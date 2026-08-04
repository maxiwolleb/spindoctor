<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRouter } from "vue-router"
import type { CreateRunRequest } from "@spindoctor/shared"
import { useConsoleStore } from "../stores/useConsoleStore"
import DriveTable from "../components/DriveTable.vue"
import StartTestDialog from "../components/StartTestDialog.vue"

const store = useConsoleStore()
const router = useRouter()

const dialogSerial = ref<string | null>(null)
const dialogOpen = ref(false)
/** Failure of an action the operator just took (start or stop), shown inline. */
const actionError = ref<string | null>(null)

const dialogDrive = computed(() =>
  dialogSerial.value ? (store.driveBySerial(dialogSerial.value) ?? null) : null,
)

// The live connection belongs to the app shell (see App.vue) so every route
// gets it — this view only needs the drive list.
onMounted(() => {
  store.refreshDrives()
})

function onStart(serial: string): void {
  dialogSerial.value = serial
  dialogOpen.value = true
}

function onOpen(serial: string): void {
  router.push(`/drives/${serial}`)
}

async function onSubmitStart(payload: CreateRunRequest): Promise<void> {
  actionError.value = null
  try {
    await store.startTest(payload)
  } catch (err) {
    // store.startTest already rethrows the ApiError (or whatever the client
    // threw) after recording it — surface its message directly (covers a
    // safety-guard 403 or a confirmation-mismatch 409/400 alike).
    actionError.value = err instanceof Error ? err.message : String(err)
  }
}

async function onStop(runId: number): Promise<void> {
  actionError.value = null
  try {
    await store.abort(runId)
  } catch (err) {
    // A 409 lands here when the run finished between the row rendering and the
    // click — worth saying so rather than looking like a no-op.
    actionError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-4">Dashboard</h1>

    <v-alert
      v-if="actionError"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="actionError = null"
    >
      {{ actionError }}
    </v-alert>

    <!-- Background failures — a drive refresh that didn't come back — as opposed
         to a request the operator just made. Nothing rendered `store.error`
         before, so a failed load simply showed an empty table (issue #104). -->
    <v-alert
      v-if="store.error && !actionError"
      type="warning"
      variant="tonal"
      density="compact"
      class="mb-4"
      data-test="store-error"
    >
      {{ store.error }}
    </v-alert>

    <DriveTable
      :drives="store.drives"
      :live-by-drive="store.liveByDrive"
      :load-failed="store.error !== null && store.drives.length === 0"
      @start="onStart"
      @stop="onStop"
      @open="onOpen"
    />

    <StartTestDialog
      v-if="dialogDrive"
      v-model="dialogOpen"
      :drive="dialogDrive"
      @submit="onSubmitStart"
    />
  </div>
</template>
