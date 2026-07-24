import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"
import vuetify from "vite-plugin-vuetify"

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    server: {
      // Vuetify ships per-component CSS side-effect imports (via the
      // autoImport transform). Vitest externalizes node_modules by default,
      // which hands those raw .css imports to Node's loader instead of
      // Vite's — inlining vuetify routes them through Vite's CSS handling.
      deps: { inline: ["vuetify"] },
    },
  },
})
