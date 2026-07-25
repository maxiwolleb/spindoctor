<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue"
import type { SettingsView as SettingsDto } from "@spindoctor/shared"
import { useConsoleStore } from "../stores/useConsoleStore"

const store = useConsoleStore()

const loading = ref(true)

/** Local form state, seeded from `store.settings` once loaded. Kept as
 * plain fields (rather than binding straight to `store.settings`) so an
 * edit-then-cancel-navigation doesn't mutate the store before Save. */
const form = reactive({
  reallocatedWarnMax: 0,
  ssdPercentageUsedWarn: 0,
  ssdPercentageUsedFail: 0,
  concurrency: 1,
  autoModeEnabled: false,
})

const protectList = ref<string[]>([])
const newSerial = ref("")

/** Gates the auto-mode switch: it starts unlocked only if the server already
 * reports auto-mode on (someone already acknowledged it previously), and is
 * otherwise locked until the user checks the box. Unchecking always forces
 * the switch back off — the toggle can never sit "on" while unacknowledged. */
const autoModeAck = ref(false)

const validationError = ref<string | null>(null)
const snackbar = reactive<{ show: boolean; text: string; color: "success" | "error" }>({
  show: false,
  text: "",
  color: "success",
})

watch(autoModeAck, (checked) => {
  if (!checked) form.autoModeEnabled = false
})

async function load(): Promise<void> {
  loading.value = true
  await store.refreshSettings()
  const settings = store.settings
  if (settings) {
    form.reallocatedWarnMax = settings.thresholds.reallocatedWarnMax
    form.ssdPercentageUsedWarn = settings.thresholds.ssdPercentageUsedWarn
    form.ssdPercentageUsedFail = settings.thresholds.ssdPercentageUsedFail
    form.concurrency = settings.concurrency
    form.autoModeEnabled = settings.autoModeEnabled
    protectList.value = [...settings.protectList]
    autoModeAck.value = settings.autoModeEnabled
  }
  loading.value = false
}

onMounted(load)

function addSerial(): void {
  const value = newSerial.value.trim()
  if (!value) return
  if (!protectList.value.includes(value)) protectList.value.push(value)
  newSerial.value = ""
}

function removeSerial(serial: string): void {
  protectList.value = protectList.value.filter((s) => s !== serial)
}

/** Mirrors the backend's own `validatePatch` (see
 * `apps/backend/src/api/routes/settings.ts`) so an invalid value is
 * rejected here, before a round-trip, rather than only on the server's 400. */
function validate(): string | null {
  const thresholdFields: Array<[string, number]> = [
    ["Reallocated sectors — warn above", form.reallocatedWarnMax],
    ["SSD/NVMe wear % — warn at", form.ssdPercentageUsedWarn],
    ["SSD/NVMe wear % — fail at", form.ssdPercentageUsedFail],
  ]
  for (const [label, value] of thresholdFields) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `${label} must be a number.`
    }
  }

  if (
    typeof form.concurrency !== "number" ||
    !Number.isFinite(form.concurrency) ||
    !Number.isInteger(form.concurrency) ||
    form.concurrency < 1
  ) {
    return "Concurrency must be a whole number of at least 1."
  }

  if (!protectList.value.every((serial) => typeof serial === "string")) {
    return "Protect-list entries must be text."
  }

  return null
}

async function onSave(): Promise<void> {
  const problem = validate()
  if (problem) {
    validationError.value = problem
    return
  }
  validationError.value = null

  // Redundant, refactor-resistant invariant: even if the `:disabled` binding
  // or the `watch(autoModeAck, …)` above were ever broken/removed, the save
  // path itself can never send `autoModeEnabled: true` while unacknowledged.
  if (!autoModeAck.value) form.autoModeEnabled = false

  const patch: Partial<SettingsDto> = {
    thresholds: {
      reallocatedWarnMax: form.reallocatedWarnMax,
      ssdPercentageUsedWarn: form.ssdPercentageUsedWarn,
      ssdPercentageUsedFail: form.ssdPercentageUsedFail,
    },
    concurrency: form.concurrency,
    autoModeEnabled: form.autoModeEnabled,
    protectList: [...protectList.value],
  }

  try {
    await store.saveSettings(patch)
    snackbar.color = "success"
    snackbar.text = "Settings saved."
    snackbar.show = true
  } catch (err) {
    snackbar.color = "error"
    snackbar.text = err instanceof Error ? err.message : String(err)
    snackbar.show = true
  }
}
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-4">Settings</h1>

    <div v-if="loading" class="text-medium-emphasis">Loading settings…</div>

    <template v-else>
      <v-alert v-if="validationError" type="error" variant="tonal" density="compact" class="mb-4">
        {{ validationError }}
      </v-alert>

      <h2 class="text-subtitle-1 mb-2">Grading thresholds</h2>
      <div class="d-flex ga-4 flex-wrap mb-6">
        <v-text-field
          id="reallocated-warn-max"
          v-model.number="form.reallocatedWarnMax"
          type="number"
          label="Reallocated sectors — warn above"
          density="comfortable"
          hide-details
          style="max-width: 280px"
        />
        <v-text-field
          id="ssd-wear-warn"
          v-model.number="form.ssdPercentageUsedWarn"
          type="number"
          label="SSD/NVMe wear % — warn at"
          density="comfortable"
          hide-details
          style="max-width: 280px"
        />
        <v-text-field
          id="ssd-wear-fail"
          v-model.number="form.ssdPercentageUsedFail"
          type="number"
          label="SSD/NVMe wear % — fail at"
          density="comfortable"
          hide-details
          style="max-width: 280px"
        />
      </div>

      <h2 class="text-subtitle-1 mb-2">Concurrency</h2>
      <v-text-field
        id="concurrency"
        v-model.number="form.concurrency"
        type="number"
        min="1"
        label="Simultaneous test slots"
        density="comfortable"
        hide-details
        style="max-width: 280px"
        class="mb-6"
      />

      <h2 class="text-subtitle-1 mb-2">Protected drives</h2>
      <p class="text-medium-emphasis mb-2">
        Serials listed here are never eligible for destructive testing, even in auto-mode.
      </p>
      <div class="d-flex ga-2 flex-wrap mb-3">
        <v-chip
          v-for="serial in protectList"
          :key="serial"
          closable
          class="mono"
          @click:close="removeSerial(serial)"
        >
          {{ serial }}
        </v-chip>
        <span v-if="protectList.length === 0" class="text-medium-emphasis"
          >No protected drives.</span
        >
      </div>
      <div class="d-flex ga-2 align-center mb-6" style="max-width: 360px">
        <v-text-field
          id="new-protected-serial"
          v-model="newSerial"
          class="mono"
          label="Add protected serial"
          density="comfortable"
          hide-details
          @keydown.enter.prevent="addSerial"
        />
        <v-btn variant="tonal" @click="addSerial">Add</v-btn>
      </div>

      <h2 class="text-subtitle-1 mb-2">Auto-mode</h2>
      <v-checkbox
        id="auto-mode-ack"
        v-model="autoModeAck"
        density="comfortable"
        hide-details
        label="I understand auto-mode will destructively wipe any newly attached, eligible drive."
      />
      <v-switch
        id="auto-mode-toggle"
        v-model="form.autoModeEnabled"
        :disabled="!autoModeAck"
        color="primary"
        density="comfortable"
        hide-details
        label="Automatically test newly attached drives"
        class="mb-6"
      />

      <v-btn color="primary" variant="flat" @click="onSave">Save settings</v-btn>

      <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="4000">
        {{ snackbar.text }}
      </v-snackbar>
    </template>
  </div>
</template>
