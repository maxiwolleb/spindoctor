import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import App from "./App.vue"
import { vuetify } from "./plugins/vuetify"
import { setConsoleDeps } from "./stores/useConsoleStore"
import type { EventSourceLike } from "./stores/useConsoleStore"
import type { ApiClient } from "./api/client"
import DashboardView from "./views/DashboardView.vue"
import SettingsView from "./views/SettingsView.vue"
import AuditView from "./views/AuditView.vue"
import DriveDetailView from "./views/DriveDetailView.vue"

/** Proves the Vuetify + jsdom mount harness works: a real Vuetify instance
 * (the app's dark `spindoctor` theme), a memory router, and Pinia all mount
 * together without throwing, and the shell's nav + product name render. */
describe("App shell", () => {
  it("renders the product name and the three nav labels", async () => {
    // The default route mounts DashboardView, which drives the console
    // store for real (refreshDrives + connectEvents) — this smoke test only
    // cares about the shell, so it injects fakes rather than hitting a real
    // fetch/EventSource that jsdom doesn't provide.
    const noopEventSource: EventSourceLike = { addEventListener: () => {}, close: () => {} }
    setConsoleDeps({
      api: { getDrives: vi.fn().mockResolvedValue([]) } as unknown as ApiClient,
      eventSourceFactory: () => noopEventSource,
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/", component: DashboardView },
        { path: "/settings", component: SettingsView },
        { path: "/audit", component: AuditView },
        { path: "/drives/:serial", component: DriveDetailView, props: true },
      ],
    })

    const wrapper = mount(App, {
      global: {
        plugins: [vuetify, createPinia(), router],
      },
    })

    await router.isReady()

    const text = wrapper.text()
    expect(text).toContain("spindoctor")
    expect(text).toContain("Dashboard")
    expect(text).toContain("Settings")
    expect(text).toContain("Audit")
  })
})
