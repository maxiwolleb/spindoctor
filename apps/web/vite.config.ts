import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import vuetify from "vite-plugin-vuetify"

// Dev server proxies the whole /api surface (including the /api/events SSE
// stream) to the Phase-4 backend so the web app can be developed against a
// locally running server without CORS or a second origin.
export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        // Keep the upgrade path open for a future websocket use and long-lived
        // SSE responses (/api/events): no proxy-side buffering/timeout that
        // would cut off a streaming response.
        ws: true,
      },
    },
  },
})
