<script setup lang="ts">
import { computed, ref, watch } from "vue"
import type { DriveView, RegimeMode } from "@spindoctor/shared"

const props = defineProps<{
  drive: DriveView
  modelValue: boolean
}>()

const emit = defineEmits<{
  submit: [
    payload: { serial: string; mode: RegimeMode; confirm?: string; forceFullRegime?: boolean },
  ]
  "update:modelValue": [boolean]
}>()

const mode = ref<RegimeMode>("read-only")
const confirmInput = ref("")
/** Opt out of the early exit on an already-condemned drive (issue #49) — for
 * the operator who wants the destructive pass as a *wipe* before disposal, not
 * as a test. Destructive-only: there is no wipe to want on a read-only scan. */
const forceFullRegime = ref(false)

// Reset to the safe default every time the dialog is (re)opened, rather than
// carrying over whatever was left over from a previous drive/attempt.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      mode.value = "read-only"
      confirmInput.value = ""
      forceFullRegime.value = false
    }
  },
)

/**
 * The always-on safety guards, mirroring the backend's own gate
 * (`apps/backend/src/safety/guards.ts`) so an ineligible drive is visibly
 * blocked rather than silently rejected after the fact.
 *
 * These block **every** mode, not just the destructive one: the engine has run
 * the guards for read-only runs as well since issue #85, so telling the operator
 * that only "destructive testing is blocked" both understated the guard and
 * advertised a read-only scan that the server would refuse with a 403.
 *
 * The specific reason is named rather than listing all of them at once — on the
 * one screen where the operator decides whether to wipe a drive, "which of these
 * is it?" is the whole question.
 */
const blockedReason = computed<string | null>(() => {
  const drive = props.drive
  if (drive.isSystemDisk) return "This is the system disk — spindoctor will not test it."
  if (drive.mounted) return "This drive is mounted — unmount it before testing."
  if (drive.claim === "claimed") {
    return "Something on this host is using this drive (the kernel refused exclusive access) — spindoctor will not test it."
  }
  if (drive.protected) {
    return "This drive is on the protected list — remove it in Settings if you really mean to test it."
  }
  return null
})

/** Not a refusal: the drive is testable, but spindoctor could not establish
 * whether anything else is using it, so it says so instead of implying the
 * check passed (issue #83). */
const claimUnknown = computed<boolean>(() => props.drive.claim === "unknown")

const blocked = computed<boolean>(() => blockedReason.value !== null)

const confirmMatches = computed<boolean>(
  () => confirmInput.value.length > 0 && confirmInput.value === props.drive.serial,
)

const canSubmit = computed<boolean>(() => {
  // A blocked drive blocks both modes, and a destructive run additionally needs
  // the typed serial.
  if (blocked.value) return false
  return mode.value === "destructive" ? confirmMatches.value : true
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
    forceFullRegime: mode.value === "destructive" ? forceFullRegime.value : undefined,
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

        <v-alert
          v-else-if="claimUnknown"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-test="claim-unknown"
        >
          spindoctor could not check whether anything else is using this drive. That check is what
          protects a mounted host disk from inside a container — confirm the drive is not in use
          before wiping it.
        </v-alert>

        <v-radio-group v-model="mode" density="comfortable" hide-details class="mb-2">
          <v-radio
            label="Full destructive test — wipes the drive"
            value="destructive"
            :disabled="blocked"
          />
          <v-radio label="Read-only scan — reads every sector, writes none" value="read-only" />
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

        <!-- A switch rather than a checkbox, to match the Settings toggle this
             overrides — and because Vuetify's checkbox glyph needs an icon font
             the app doesn't ship, so a checkbox here would have no visible box
             (tracked separately). -->
        <v-switch
          v-if="mode === 'destructive'"
          v-model="forceFullRegime"
          color="error"
          density="comfortable"
          hide-details
          class="mt-2"
          data-test="force-full-regime"
          label="Wipe even if SMART already condemns the drive"
        />
        <p v-if="mode === 'destructive'" class="text-caption text-medium-emphasis ma-0">
          By default a drive its own SMART data already condemns goes straight to a FAIL verdict
          instead of spending hours being written to. Turn this on to overwrite it anyway.
        </p>
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
