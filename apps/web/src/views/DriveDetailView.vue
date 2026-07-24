<script setup lang="ts">
// Real drive detail (SMART before/after diff, stage timeline, run history)
// lands in a later task.
defineProps<{ serial: string }>()
</script>

<template>
  <div class="pa-6">
    <h1 class="text-h5 mb-2">Drive {{ serial }}</h1>
    <p class="text-medium-emphasis">Drive detail lands in a later task.</p>
  </div>
</template>
