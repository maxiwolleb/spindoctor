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
      <template #prepend>
        <img src="/logo-mark.svg" alt="" width="28" height="28" class="brand-mark ml-2" />
      </template>
      <v-app-bar-title>
        <span class="brand-wordmark mono">
          <span class="on-surface">spin</span><span class="brand-wordmark__doctor">doctor</span>
        </span>
      </v-app-bar-title>
      <template #append>
        <span
          class="connection-dot mr-4"
          :class="store.connected ? 'connection-dot--live glow' : 'connection-dot--dead'"
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
.brand-mark {
  display: block;
}

/* Wordmark lockup: JetBrains Mono, lowercase, "spin" in on-surface text +
   "doctor" in phosphor — never re-spaced or recolored beyond this. */
.brand-wordmark {
  font-size: 1.05rem;
  letter-spacing: 0.4px;
  font-weight: 500;
}

.brand-wordmark__doctor {
  color: var(--phosphor);
}

.connection-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

/* Live connection is the signal: phosphor + a soft glow. Static elements
   (the dead/disconnected state) never glow. */
.connection-dot--live {
  background: var(--phosphor);
}

.connection-dot--dead {
  background: var(--muted);
}
</style>
