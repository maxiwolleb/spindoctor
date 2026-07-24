<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"
import { useRouter } from "vue-router"
import { useConsoleStore } from "../stores/useConsoleStore"
import DriveTable from "../components/DriveTable.vue"

const store = useConsoleStore()
const router = useRouter()

/** Task 4 replaces this with the real StartTestDialog; wiring the handler
 * end-to-end now, with a visible placeholder, so the dashboard's "Start
 * test" action does something rather than silently going nowhere. */
const startRequestedFor = ref<string | null>(null)

onMounted(() => {
  store.refreshDrives()
  store.connectEvents()
})

onUnmounted(() => {
  store.disconnectEvents()
})

function onStart(serial: string): void {
  startRequestedFor.value = serial
}

function onOpen(serial: string): void {
  router.push(`/drives/${serial}`)
}
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-4">Dashboard</h1>

    <v-alert
      v-if="startRequestedFor"
      type="info"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="startRequestedFor = null"
    >
      Start-test dialog for {{ startRequestedFor }} lands in a later task.
    </v-alert>

    <DriveTable :drives="store.drives" :live-by-drive="store.liveByDrive" @start="onStart" @open="onOpen" />
  </div>
</template>
