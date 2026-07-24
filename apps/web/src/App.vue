<script setup lang="ts">
import { ref } from "vue"

interface NavItem {
  label: string
  to: string
}

const navItems: NavItem[] = [
  { label: "Dashboard", to: "/" },
  { label: "Settings", to: "/settings" },
  { label: "Audit", to: "/audit" },
]

// Wired to the console store's live SSE connection in a later task.
const connected = ref(false)
</script>

<template>
  <v-app>
    <v-navigation-drawer permanent>
      <v-list nav density="compact">
        <v-list-item v-for="item in navItems" :key="item.to" :to="item.to" :title="item.label" />
      </v-list>
    </v-navigation-drawer>

    <v-app-bar flat density="comfortable" border>
      <v-app-bar-title>spindoctor</v-app-bar-title>
      <template #append>
        <span
          class="connection-dot mr-4"
          :class="connected ? 'connection-dot--live' : 'connection-dot--dead'"
          :title="connected ? 'Connected' : 'Disconnected'"
        />
      </template>
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.connection-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.connection-dot--live {
  background: rgb(var(--v-theme-success));
}

.connection-dot--dead {
  background: var(--muted);
}
</style>
