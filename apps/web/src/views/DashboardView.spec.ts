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

    expect(startTest).toHaveBeenCalledWith({
      serial: "SERA1234",
      mode: "read-only",
      confirm: undefined,
      forceFullRegime: undefined,
    })
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

  // Issue #104: `store.abort` had no call site anywhere in the UI, so a
  // destructive wipe could only be stopped with a direct API call.
  it("stops the run when DriveTable emits stop", async () => {
    const store = stubStore()
    const abort = vi.spyOn(store, "abort").mockResolvedValue()
    const { wrapper } = mountDashboard()
    await flushPromises()

    await wrapper.findComponent(DriveTable).vm.$emit("stop", 42)
    await flushPromises()

    expect(abort).toHaveBeenCalledWith(42)
  })

  it("surfaces the reason when a stop fails, instead of looking like a no-op", async () => {
    const store = stubStore()
    // What a 409 looks like: the run finished between the row rendering and the
    // click. `abort` used to swallow this entirely.
    vi.spyOn(store, "abort").mockRejectedValue(new Error("run 42 has already finished (DONE)"))
    const { wrapper } = mountDashboard()
    await flushPromises()

    await wrapper.findComponent(DriveTable).vm.$emit("stop", 42)
    await flushPromises()

    expect(wrapper.text()).toContain("already finished")
  })

  // A failed drive refresh left the table showing "No drives detected. Attach a
  // drive and it'll appear here." — a reassuring empty state standing in for a
  // load error, because nothing rendered `store.error`.
  it("renders a background load failure and tells the table to say so", async () => {
    const store = stubStore()
    store.error = "GET /api/drives failed: 502 Bad Gateway"
    const { wrapper } = mountDashboard()
    await flushPromises()

    expect(wrapper.text()).toContain("502 Bad Gateway")
    expect(wrapper.findComponent(DriveTable).props("loadFailed")).toBe(true)
  })

  it("does not claim a load failure when drives did load", async () => {
    const store = stubStore()
    store.error = "something transient"
    store.drives = [
      {
        serial: "SERA1234",
        model: "M",
        sizeBytes: 1,
        type: "HDD",
        transport: "SATA",
        present: true,
        mounted: false,
        isSystemDisk: false,
        protected: false,
        latestRun: null,
      },
    ]
    const { wrapper } = mountDashboard()
    await flushPromises()

    expect(wrapper.findComponent(DriveTable).props("loadFailed")).toBe(false)
  })

  it("prefers the action error over the background one, so they can't stack up", async () => {
    const store = stubStore()
    store.error = "background refresh problem"
    vi.spyOn(store, "abort").mockRejectedValue(new Error("stop failed loudly"))
    const { wrapper } = mountDashboard()
    await flushPromises()

    await wrapper.findComponent(DriveTable).vm.$emit("stop", 1)
    await flushPromises()

    expect(wrapper.text()).toContain("stop failed loudly")
    expect(wrapper.text()).not.toContain("background refresh problem")
  })
})
