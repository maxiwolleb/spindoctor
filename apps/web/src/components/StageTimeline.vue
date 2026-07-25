<script setup lang="ts">
import type { StageView } from "@spindoctor/shared"
import { runStatusColor, stageLabel, stageStatusLabel } from "../lib/format"

// The array's order IS the pipeline order (stages are persisted and listed
// oldest-first — see `listStageRows` in the backend's runs route), so a
// plain ordered list is the right shape here, unlike elsewhere in the app.
defineProps<{
  stages: StageView[]
}>()
</script>

<template>
  <ol class="stage-timeline">
    <li v-for="(stage, index) in stages" :key="stage.id" class="stage-timeline__item">
      <span
        class="stage-timeline__marker"
        :class="`stage-timeline__marker--${runStatusColor(stage.status)}`"
      >
        {{ index + 1 }}
      </span>
      <div class="stage-timeline__body">
        <div class="stage-timeline__row">
          <span class="stage-timeline__label">{{ stageLabel(stage.stage) }}</span>
          <span class="text-medium-emphasis">{{ stageStatusLabel(stage.status) }}</span>
        </div>
        <v-progress-linear
          v-if="stage.status === 'RUNNING'"
          :model-value="stage.progress"
          color="primary"
          height="4"
          class="mb-1"
        />
        <span class="mono text-caption text-medium-emphasis">{{ stage.progress }}%</span>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.stage-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.stage-timeline__item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

.stage-timeline__item:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
  border-bottom: none;
}

.stage-timeline__marker {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
}

.stage-timeline__marker--success {
  background: rgb(var(--v-theme-success));
  color: rgb(var(--v-theme-on-success));
}

.stage-timeline__marker--warning {
  background: rgb(var(--v-theme-warning));
  color: rgb(var(--v-theme-on-warning));
}

.stage-timeline__marker--error {
  background: rgb(var(--v-theme-error));
  color: rgb(var(--v-theme-on-error));
}

.stage-timeline__marker--primary {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
}

.stage-timeline__marker--secondary {
  background: rgb(var(--v-theme-secondary));
  color: rgb(var(--v-theme-on-secondary));
}

.stage-timeline__body {
  flex: 1;
  min-width: 0;
}

.stage-timeline__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.stage-timeline__label {
  font-weight: 500;
}
</style>
