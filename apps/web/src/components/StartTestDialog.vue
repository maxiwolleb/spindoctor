<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { DriveView, RegimeMode } from "@spindoctor/shared"

const props = defineProps<{
  drive: DriveView
  modelValue: boolean
}>()

const emit = defineEmits<{
  submit: [payload: { serial: string; mode: RegimeMode; confirm?: string }]
  "update:modelValue": [boolean]
}>()

const mode = ref<RegimeMode>("read-only")
const confirmInput = ref("")

// Reset to the safe default every time the dialog is (re)opened, rather than
// carrying over whatever was left over from a previous drive/attempt.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      mode.value = "read-only"
      confirmInput.value = ""
    }
  },
)

/** The always-on safety guards (mirrors the backend's own gate): a mounted,
 * system, or protected disk can never be the target of a destructive run, no
 * matter what the UI does — surfaced here so the destructive option is
 * visibly blocked rather than silently rejected after the fact. */
const blockedReason = computed<string | null>(() => {
  if (props.drive.mounted || props.drive.isSystemDisk || props.drive.protected) {
    return "This drive is mounted / is the system disk / is protected — destructive testing is blocked."
  }
  return null
})

const destructiveDisabled = computed<boolean>(() => blockedReason.value !== null)

const confirmMatches = computed<boolean>(
  () => confirmInput.value.length > 0 && confirmInput.value === props.drive.serial,
)

const canSubmit = computed<boolean>(() => {
  if (mode.value === "destructive") return !destructiveDisabled.value && confirmMatches.value
  return true
})

const submitLabel = computed<string>(() =>
  mode.value === "destructive" ? "Wipe & test" : "Start scan",
)

function onDialogUpdate(value: boolean): void {
  emit("update:modelValue", value)
}

function onCancel(): void {
  emit("update:modelValue", false)
}

function onSubmit(): void {
  if (!canSubmit.value) return
  emit("submit", {
    serial: props.drive.serial,
    mode: mode.value,
    confirm: mode.value === "destructive" ? confirmInput.value : undefined,
  })
  emit("update:modelValue", false)
}
</script>

<template>
  <v-dialog
    :model-value="modelValue"
    max-width="480"
    persistent
    @update:model-value="onDialogUpdate"
  >
    <v-card>
      <v-card-title>Start test</v-card-title>
      <v-card-subtitle>
        {{ drive.model }} · <span class="mono">{{ drive.serial }}</span>
      </v-card-subtitle>

      <v-card-text>
        <v-alert v-if="blockedReason" type="warning" variant="tonal" density="compact" class="mb-4">
          {{ blockedReason }}
        </v-alert>

        <v-radio-group v-model="mode" density="comfortable" hide-details class="mb-2">
          <v-radio
            label="Full destructive test — wipes the drive"
            value="destructive"
            :disabled="destructiveDisabled"
          />
          <v-radio label="Read-only scan" value="read-only" />
        </v-radio-group>

        <v-text-field
          v-if="mode === 'destructive'"
          v-model="confirmInput"
          label="Type the drive serial to confirm"
          class="mono"
          density="comfortable"
          hint="Must match the serial above exactly to enable Wipe & test."
          persistent-hint
        />
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="onCancel">Cancel</v-btn>
        <v-btn
          :color="mode === 'destructive' ? 'error' : 'primary'"
          variant="flat"
          :disabled="!canSubmit"
          @click="onSubmit"
        >
          {{ submitLabel }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
