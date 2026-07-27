import { describe, expect, it, vi } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import App from "./App.vue"
import { vuetify } from "./plugins/vuetify"
import { setConsoleDeps, useConsoleStore } from "./stores/useConsoleStore"
import type { RealtimeConnection } from "./api/realtime"
import type { ApiClient } from "./api/client"
import DashboardView from "./views/DashboardView.vue"
import SettingsView from "./views/SettingsView.vue"
import AuditView from "./views/AuditView.vue"
import DriveDetailView from "./views/DriveDetailView.vue"

function noopRealtime(): RealtimeConnection {
  return {
    onConnect: () => {},
    onDisconnect: () => {},
    onRunUpdate: () => {},
    onStageProgress: () => {},
    close: () => {},
  }
}

function routes() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: DashboardView },
      { path: "/settings", component: SettingsView },
      { path: "/audit", component: AuditView },
      { path: "/drives/:serial", component: DriveDetailView, props: true },
    ],
  })
}

function stubDeps(): void {
  setConsoleDeps({
    api: { getDrives: vi.fn().mockResolvedValue([]) } as unknown as ApiClient,
    realtimeFactory: noopRealtime,
  })
}

/** Proves the Vuetify + jsdom mount harness works: a real Vuetify instance
 * (the app's dark `spindoctor` theme), a memory router, and Pinia all mount
 * together without throwing, and the shell's nav + product name render. */
describe("App shell", () => {
  it("renders the product name and the three nav labels", async () => {
    // The default route mounts DashboardView, which drives the console store
    // for real (refreshDrives) — this smoke test only cares about the shell, so
    // it injects fakes rather than hitting a real fetch/socket that jsdom
    // doesn't provide.
    stubDeps()

    const router = routes()
    const wrapper = mount(App, { global: { plugins: [vuetify, createPinia(), router] } })
    await router.isReady()

    const text = wrapper.text()
    expect(text).toContain("spindoctor")
    expect(text).toContain("Dashboard")
    expect(text).toContain("Settings")
    expect(text).toContain("Audit")
  })

  // The shell owns the connection so every route shares it. Previously the
  // dashboard owned it, so any other route had no subscription and the
  // indicator below read "Disconnected" against a healthy backend (#21).
  it("opens the live connection on mount and closes it on unmount", async () => {
    stubDeps()
    const pinia = createPinia()
    // Activate the store before mounting so the spies are in place for the
    // shell's own onMounted hook.
    setActivePinia(pinia)
    const store = useConsoleStore()
    const connect = vi.spyOn(store, "connectEvents")
    const disconnect = vi.spyOn(store, "disconnectEvents")

    const router = routes()
    const wrapper = mount(App, { global: { plugins: [vuetify, pinia, router] } })
    await router.isReady()

    expect(connect).toHaveBeenCalledTimes(1)
    expect(disconnect).not.toHaveBeenCalled()

    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it("shows the connection indicator as live on every route, not just the dashboard", async () => {
    stubDeps()
    const pinia = createPinia()
    const router = routes()

    const wrapper = mount(App, { global: { plugins: [vuetify, pinia, router] } })
    await router.isReady()

    const store = useConsoleStore()
    store.connected = true
    await router.push("/drives/SERA")
    await wrapper.vm.$nextTick()

    const dot = wrapper.find(".connection-dot")
    expect(dot.classes()).toContain("connection-dot--live")
    expect(dot.classes()).not.toContain("connection-dot--dead")
  })
})
