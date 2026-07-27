import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { flushPromises, mount, DOMWrapper } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { createMemoryHistory, createRouter } from "vue-router"
import type { DriveView } from "@spindoctor/shared"
import { vuetify } from "../plugins/vuetify"
import { useConsoleStore } from "../stores/useConsoleStore"
import { ApiError } from "../api/client"
import DriveTable from "../components/DriveTable.vue"
import StartTestDialog from "../components/StartTestDialog.vue"
import DashboardView from "./DashboardView.vue"

const drive: DriveView = {
  serial: "SERA1234",
  model: "WDC WD40EFRX",
  sizeBytes: 4_000_787_030_016,
  type: "HDD",
  transport: "SATA",
  present: true,
  mounted: false,
  isSystemDisk: false,
  protected: false,
  latestRun: null,
}

function mountDashboard() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: DashboardView },
      { path: "/drives/:serial", component: { template: "<div>detail</div>" } },
    ],
  })

  return {
    wrapper: mount(DashboardView, {
      global: { plugins: [vuetify, router] },
      attachTo: document.body,
    }),
    router,
  }
}

function stubStore() {
  const store = useConsoleStore()
  vi.spyOn(store, "refreshDrives").mockResolvedValue()
  vi.spyOn(store, "connectEvents").mockImplementation(() => {})
  vi.spyOn(store, "disconnectEvents").mockImplementation(() => {})
  return store
}

describe("DashboardView", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    // StartTestDialog teleports into a shared `.v-overlay-container` under
    // document.body; clear it so a dialog left open by one test can't leak
    // into the next test's DOM queries.
    document.body.innerHTML = ""
  })

  // The live connection is the app shell's (see App.spec.ts): if this view
  // owned it, navigating away from the dashboard would tear the socket down and
  // leave every other route unsubscribed — which is exactly the bug in #21.
  it("refreshes drives on mount and leaves the live connection to the shell", async () => {
    const store = stubStore()

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    expect(store.refreshDrives).toHaveBeenCalledTimes(1)
    expect(store.connectEvents).not.toHaveBeenCalled()

    wrapper.unmount()

    expect(store.disconnectEvents).not.toHaveBeenCalled()
  })

  it("navigates to the drive-detail route when DriveTable emits open", async () => {
    stubStore()

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("open", "SERA1234")
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe("/drives/SERA1234")
  })

  it("opens the start-test dialog for the requested drive when DriveTable emits start", async () => {
    const store = stubStore()
    store.drives = [drive]

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("start", "SERA1234")
    await wrapper.vm.$nextTick()

    const body = new DOMWrapper(document.body)
    expect(body.text()).toContain("WDC WD40EFRX")
    expect(body.text()).toContain("SERA1234")
    expect(body.text()).toContain("Start scan")
  })

  it("calls store.startTest with the dialog's submit payload", async () => {
    const store = stubStore()
    const startTest = vi.spyOn(store, "startTest").mockResolvedValue()
    store.drives = [drive]

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("start", "SERA1234")
    await wrapper.vm.$nextTick()

    await wrapper
      .findComponent(StartTestDialog)
      .vm.$emit("submit", { serial: "SERA1234", mode: "read-only", confirm: undefined })
    await flushPromises()

    expect(startTest).toHaveBeenCalledWith("SERA1234", "read-only", undefined)
  })

  it("shows an error toast surfacing the ApiError message when startTest rejects (e.g. a safety guard)", async () => {
    const store = stubStore()
    vi.spyOn(store, "startTest").mockRejectedValue(
      new ApiError(403, "MOUNTED", "drive is mounted — refusing to wipe"),
    )
    store.drives = [drive]

    const { wrapper, router } = mountDashboard()
    await router.isReady()

    await wrapper.findComponent(DriveTable).vm.$emit("start", "SERA1234")
    await wrapper.vm.$nextTick()

    await wrapper
      .findComponent(StartTestDialog)
      .vm.$emit("submit", { serial: "SERA1234", mode: "destructive", confirm: "SERA1234" })
    await flushPromises()

    expect(wrapper.text()).toContain("drive is mounted — refusing to wipe")
  })
})
