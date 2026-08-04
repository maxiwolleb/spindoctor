<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import type { SettingsView as SettingsDto } from "@spindoctor/shared"
import { useConsoleStore } from "../stores/useConsoleStore"

const store = useConsoleStore()

const loading = ref(true)

/** Local form state, seeded from `store.settings` once loaded. Kept as
 * plain fields (rather than binding straight to `store.settings`) so an
 * edit-then-cancel-navigation doesn't mutate the store before Save. */
const form = reactive({
  reallocatedWarnMax: 0,
  commandTimeoutWarnMax: 0,
  ssdPercentageUsedWarn: 0,
  ssdPercentageUsedFail: 0,
  concurrency: 1,
  autoModeEnabled: false,
  skipCondemnedDrives: true,
  diagnosticsEnabled: false,
  diagnosticsIncludeSerials: false,
})

const protectList = ref<string[]>([])
const newSerial = ref("")

/** Gates the auto-mode switch: it starts unlocked only if the server already
 * reports auto-mode on (someone already acknowledged it previously), and is
 * otherwise locked until the user checks the box. Unchecking always forces
 * the switch back off — the toggle can never sit "on" while unacknowledged. */
const autoModeAck = ref(false)

/** The bundle route 404s unless the server-side flag is on, so the button follows
 * what has actually been saved rather than the unsaved form state. */
const savedDiagnosticsEnabled = computed<boolean>(() => store.settings?.diagnosticsEnabled === true)
const diagnosticsBundleUrl = "/api/diagnostics/bundle"

/** Why the settings could not be read, captured at load time rather than read
 * from the store's shared `error` field, which a later action overwrites. */
const loadError = ref<string | null>(null)

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
  loadError.value = null
  // Settings first, and its outcome captured before anything else runs: the store
  // keeps one shared `error` field, so a later successful action (the drive
  // refresh below) clears it and the reason this page is empty would be lost.
  await store.refreshSettings()
  if (store.settings === null) loadError.value = store.error ?? "unknown error"
  // Drives too: the protect list is checked against what spindoctor can
  // currently see, and this view is reachable directly, without the dashboard
  // having populated the store first.
  await store.refreshDrives()
  const settings = store.settings
  if (settings) {
    form.reallocatedWarnMax = settings.thresholds.reallocatedWarnMax
    form.commandTimeoutWarnMax = settings.thresholds.commandTimeoutWarnMax
    form.ssdPercentageUsedWarn = settings.thresholds.ssdPercentageUsedWarn
    form.ssdPercentageUsedFail = settings.thresholds.ssdPercentageUsedFail
    form.concurrency = settings.concurrency
    form.autoModeEnabled = settings.autoModeEnabled
    form.skipCondemnedDrives = settings.skipCondemnedDrives
    form.diagnosticsEnabled = settings.diagnosticsEnabled
    form.diagnosticsIncludeSerials = settings.diagnosticsIncludeSerials
    protectList.value = [...settings.protectList]
    autoModeAck.value = settings.autoModeEnabled
  }
  loading.value = false
}

/**
 * True when the settings could not be loaded, so the form must not be shown.
 *
 * `refreshSettings` swallows its error into `store.error`, which left `loading`
 * false and `store.settings` null — and the form then rendered its declared
 * initial values, every threshold reading `0`. Those are not the defaults (4 /
 * 100 / 80 / 100), so an operator who hit one failed GET saw a normal-looking
 * page and could Save it: `ssdPercentageUsedFail: 0` makes every SSD and NVMe
 * FAIL, silently and permanently. A page that cannot show the real settings must
 * not offer to overwrite them.
 */
const loadFailed = computed<boolean>(() => !loading.value && store.settings === null)

onMounted(load)

/** Canonical form for comparison, matching the backend's `normalizeSerial`
 * (`apps/backend/src/safety/guards.ts`). Entries are stored canonical, so this
 * only has to normalize what the operator just typed. */
function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase()
}

function addSerial(): void {
  const value = normalizeSerial(newSerial.value)
  if (!value) return
  if (!protectList.value.includes(value)) protectList.value.push(value)
  newSerial.value = ""
}

function removeSerial(serial: string): void {
  protectList.value = protectList.value.filter((s) => s !== serial)
}

/**
 * Protected serials that match no drive spindoctor can currently see.
 *
 * Not an error — pre-registering a serial before attaching the drive is a
 * legitimate, safety-positive workflow — but worth surfacing, because a typo
 * looks exactly like a correct entry otherwise, and this is the guard that stops
 * the wrong drive being wiped (issue #88).
 */
const unmatchedSerials = computed(() => {
  const known = new Set(store.drives.map((d) => normalizeSerial(d.serial)))
  // Nothing discovered yet (still loading, or no drives attached) would flag
  // every entry, which is noise rather than a warning.
  if (known.size === 0) return []
  return protectList.value.filter((serial) => !known.has(normalizeSerial(serial)))
})

function isUnmatched(serial: string): boolean {
  return unmatchedSerials.value.includes(serial)
}

/** Mirrors the backend's own `validatePatch` (see
 * `apps/backend/src/api/routes/settings.ts`) so an invalid value is
 * rejected here, before a round-trip, rather than only on the server's 400. */
function validate(): string | null {
  const thresholdFields: Array<[string, number]> = [
    ["Reallocated sectors — warn above", form.reallocatedWarnMax],
    ["Command timeouts — warn above", form.commandTimeoutWarnMax],
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
      commandTimeoutWarnMax: form.commandTimeoutWarnMax,
      ssdPercentageUsedWarn: form.ssdPercentageUsedWarn,
      ssdPercentageUsedFail: form.ssdPercentageUsedFail,
    },
    concurrency: form.concurrency,
    autoModeEnabled: form.autoModeEnabled,
    skipCondemnedDrives: form.skipCondemnedDrives,
    diagnosticsEnabled: form.diagnosticsEnabled,
    diagnosticsIncludeSerials: form.diagnosticsIncludeSerials,
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

    <!-- No form at all when the settings could not be read: the fields would
         show their initial zeros, which are not the defaults, and saving them
         would fail every solid-state drive. -->
    <v-alert v-else-if="loadFailed" type="error" variant="tonal" density="compact">
      Could not load settings{{ loadError ? `: ${loadError}` : "." }} Nothing has been changed.
      <div class="mt-2">
        <v-btn size="small" variant="tonal" @click="load">Retry</v-btn>
      </div>
    </v-alert>

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
          id="command-timeout-warn-max"
          v-model.number="form.commandTimeoutWarnMax"
          type="number"
          label="Command timeouts — warn above"
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
          :color="isUnmatched(serial) ? 'warning' : undefined"
          :variant="isUnmatched(serial) ? 'tonal' : undefined"
          @click:close="removeSerial(serial)"
        >
          {{ serial }}
        </v-chip>
        <span v-if="protectList.length === 0" class="text-medium-emphasis"
          >No protected drives.</span
        >
      </div>
      <v-alert
        v-if="unmatchedSerials.length > 0"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-3"
      >
        {{ unmatchedSerials.length }}
        {{ unmatchedSerials.length === 1 ? "serial matches" : "serials match" }} no drive spindoctor
        can currently see. That is expected if the drive isn't attached yet — but check for a typo,
        because an entry that matches nothing protects nothing.
      </v-alert>
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

      <h2 class="text-subtitle-1 mb-2">Already-failed drives</h2>
      <p class="text-medium-emphasis mb-2">
        When a drive's first SMART read already condemns it, no later stage can clear it — so the
        run can stop there instead of spending ~90 minutes on a self-test and hours overwriting a
        disk that has already failed. A single run can still opt out when the write is wanted as a
        wipe.
      </p>
      <v-switch
        id="skip-condemned-toggle"
        v-model="form.skipCondemnedDrives"
        color="primary"
        density="comfortable"
        hide-details
        label="Skip testing drives SMART has already condemned"
        class="mb-6"
      />

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

      <h2 class="text-subtitle-1 mb-2">Diagnostics</h2>
      <p class="text-medium-emphasis mb-2">
        Collects what spindoctor could not explain about the drives it graded — raw SMART payloads,
        the verdicts reached, the tool versions in use, and a report of attributes it has no
        description for or drives it may have mis-typed. Off by default. Nothing is transmitted
        anywhere: this only adds a download you can choose to share.
      </p>
      <v-switch
        id="diagnostics-toggle"
        v-model="form.diagnosticsEnabled"
        color="primary"
        density="comfortable"
        hide-details
        label="Allow exporting a diagnostics bundle"
      />
      <v-switch
        v-if="form.diagnosticsEnabled"
        id="diagnostics-serials-toggle"
        v-model="form.diagnosticsIncludeSerials"
        color="warning"
        density="comfortable"
        hide-details
        label="Include real drive serials instead of per-instance pseudonyms"
      />
      <p
        v-if="form.diagnosticsEnabled"
        class="text-caption text-medium-emphasis ma-0 mb-3"
        style="max-width: 720px"
      >
        Pseudonyms still let findings be tied to one drive and followed across its runs, without the
        bundle being a readable inventory. Model and firmware are always included — they are what
        parser fixes are keyed on.
      </p>
      <!-- Wrapped so it sits on its own line: buttons are inline, so a margin
           on the button alone leaves it crowded against Save. -->
      <div class="mb-6">
        <v-btn
          v-if="savedDiagnosticsEnabled"
          :href="diagnosticsBundleUrl"
          download
          variant="tonal"
          size="small"
          color="primary"
        >
          Download diagnostics bundle
        </v-btn>
        <p v-else class="text-caption text-medium-emphasis ma-0">
          Save settings to enable the download.
        </p>
      </div>

      <v-btn color="primary" variant="flat" @click="onSave">Save settings</v-btn>

      <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="4000">
        {{ snackbar.text }}
      </v-snackbar>
    </template>
  </div>
</template>
