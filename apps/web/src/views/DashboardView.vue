<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRouter } from "vue-router"
import type { RegimeMode } from "@spindoctor/shared"
import { useConsoleStore } from "../stores/useConsoleStore"
import DriveTable from "../components/DriveTable.vue"
import StartTestDialog from "../components/StartTestDialog.vue"

const store = useConsoleStore()
const router = useRouter()

const dialogSerial = ref<string | null>(null)
const dialogOpen = ref(false)
const startError = ref<string | null>(null)

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

async function onSubmitStart(payload: {
  serial: string
  mode: RegimeMode
  confirm?: string
}): Promise<void> {
  startError.value = null
  try {
    await store.startTest(payload.serial, payload.mode, payload.confirm)
  } catch (err) {
    // store.startTest already rethrows the ApiError (or whatever the client
    // threw) after recording it — surface its message directly (covers a
    // safety-guard 403 or a confirmation-mismatch 409/400 alike).
    startError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-4">Dashboard</h1>

    <v-alert
      v-if="startError"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="startError = null"
    >
      {{ startError }}
    </v-alert>

    <DriveTable
      :drives="store.drives"
      :live-by-drive="store.liveByDrive"
      @start="onStart"
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
