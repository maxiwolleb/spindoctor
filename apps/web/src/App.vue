<script setup lang="ts">
import { useConsoleStore } from "./stores/useConsoleStore"

interface NavItem {
  label: string
  to: string
}

const navItems: NavItem[] = [
  { label: "Dashboard", to: "/" },
  { label: "Settings", to: "/settings" },
  { label: "Audit", to: "/audit" },
]

// The dashboard (or any other view) owns connectEvents()/disconnectEvents()
// on mount/unmount; this shell just reads the shared store's `connected` flag
// so the indicator reflects whichever view's live SSE connection is active.
const store = useConsoleStore()
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
          :class="store.connected ? 'connection-dot--live' : 'connection-dot--dead'"
          :title="store.connected ? 'Connected' : 'Disconnected'"
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
