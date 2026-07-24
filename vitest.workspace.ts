import { defineWorkspace } from "vitest/config"

// Each package keeps its own vitest/vite config (or the plain defaults) —
// apps/web needs jsdom + the Vue/Vuetify plugins for its tests, apps/backend
// and packages/shared are plain Node and stay on the existing defaults.
export default defineWorkspace(["apps/*", "packages/*"])
