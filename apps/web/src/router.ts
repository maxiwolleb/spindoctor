import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router"
import DashboardView from "./views/DashboardView.vue"
import DriveDetailView from "./views/DriveDetailView.vue"
import SettingsView from "./views/SettingsView.vue"
import AuditView from "./views/AuditView.vue"

const routes: RouteRecordRaw[] = [
  { path: "/", name: "dashboard", component: DashboardView },
  { path: "/settings", name: "settings", component: SettingsView },
  { path: "/audit", name: "audit", component: AuditView },
  { path: "/drives/:serial", name: "drive-detail", component: DriveDetailView, props: true },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
