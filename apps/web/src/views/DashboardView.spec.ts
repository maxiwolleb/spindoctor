import { describe, expect, it, vi, beforeEach } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import { vuetify } from "../plugins/vuetify"
import { useConsoleStore } from "../stores/useConsoleStore"
import DriveTable from "../components/DriveTable.vue"
import DashboardView from "./DashboardView.vue"

function mountDashboard() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: DashboardView },
      { path: "/drives/:serial", component: { template: "<div>detail</div>" } },
    ],
  })

  return { wrapper: mount(DashboardView, { global: { plugins: [vuetify, router] } }), router }
}

describe("DashboardView", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("refreshes drives and connects live events on mount, and disconnects on unmount", async () => {
    const store = useConsoleStore()
    const refreshDrives = vi.spyOn(store, "refreshDrives").mockResolvedValue()
    const connectEvents = vi.spyOn(store, "connectEvents").mockImplementation(() => {})
    const disconnectEvents = vi.spyOn(store, "disconnectEvents").mockImplementation(() => {})

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    expect(refreshDrives).toHaveBeenCalledTimes(1)
    expect(connectEvents).toHaveBeenCalledTimes(1)
    expect(disconnectEvents).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(disconnectEvents).toHaveBeenCalledTimes(1)
  })

  it("navigates to the drive-detail route when DriveTable emits open", async () => {
    const store = useConsoleStore()
    vi.spyOn(store, "refreshDrives").mockResolvedValue()
    vi.spyOn(store, "connectEvents").mockImplementation(() => {})
    vi.spyOn(store, "disconnectEvents").mockImplementation(() => {})

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("open", "SERA1234")
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe("/drives/SERA1234")
  })

  it("wires the start handler: emitting start surfaces the requested serial", async () => {
    const store = useConsoleStore()
    vi.spyOn(store, "refreshDrives").mockResolvedValue()
    vi.spyOn(store, "connectEvents").mockImplementation(() => {})
    vi.spyOn(store, "disconnectEvents").mockImplementation(() => {})

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("start", "SERA1234")

    expect(wrapper.text()).toContain("SERA1234")
  })
})
