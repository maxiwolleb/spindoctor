import type {
  CreateRunRequest,
  DriveView,
  RunView,
  SettingsView,
  SmartKeyMetrics,
  StageView,
} from "@spindoctor/shared"

/** Wire shape of `GET /api/audit`. Not part of `@spindoctor/shared` because
 * it mirrors a DB row rather than an engine-crossing DTO; `ts` arrives as an
 * ISO-8601 string (JSON has no Date type), same wire-honesty rule the shared
 * DTOs follow for their own timestamp fields. */
export interface AuditEntry {
  id: number
  ts: string
  action: string
  driveSerial: string | null
  detail: string | null
}

export interface DriveDetail {
  drive: DriveView
  runs: RunView[]
}

export interface RunDetail {
  run: RunView
  stages: StageView[]
  /** Before/after SMART key metrics for the run, `null` for a phase not yet
   * captured (still running, or a regime that skips one side). */
  snapshots: { before: SmartKeyMetrics | null; after: SmartKeyMetrics | null }
}

interface ErrorBody {
  error?: string
  code?: string
}

/** Thrown for any non-2xx response. Mirrors the backend's uniform
 * `{error, code}` error shape (see `apps/backend/src/api/app.ts`). */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ErrorBody
    throw new ApiError(
      res.status,
      body.code ?? "UNKNOWN",
      body.error ?? `request failed with status ${res.status}`,
    )
  }
  return (await res.json()) as T
}

function jsonBody(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** Typed client over the Phase-4 `/api` surface. `baseUrl` defaults to ""
 * (same-origin, relative paths) so it works both behind the Vite dev proxy
 * and the backend's own static serving in production. */
export function createApiClient(baseUrl = "") {
  return {
    getDrives: (): Promise<DriveView[]> => request(`${baseUrl}/api/drives`),

    getDrive: (serial: string): Promise<DriveDetail> =>
      request(`${baseUrl}/api/drives/${encodeURIComponent(serial)}`),

    createRun: (body: CreateRunRequest): Promise<{ runId: number }> =>
      request(`${baseUrl}/api/runs`, jsonBody("POST", body)),

    listRuns: (serial?: string): Promise<RunView[]> =>
      request(`${baseUrl}/api/runs${serial ? `?serial=${encodeURIComponent(serial)}` : ""}`),

    getRun: (id: number): Promise<RunDetail> => request(`${baseUrl}/api/runs/${id}`),

    /** URL for the plain-text, per-stage log download (`GET
     * /api/runs/:id/log`) — a direct link/`<a download>` target, not a
     * fetch-and-parse call like the rest of this client. */
    getRunLogUrl: (id: number): string => `${baseUrl}/api/runs/${id}/log`,

    abortRun: (id: number): Promise<{ ok: boolean }> =>
      request(`${baseUrl}/api/runs/${id}/abort`, { method: "POST" }),

    getSettings: (): Promise<SettingsView> => request(`${baseUrl}/api/settings`),

    putSettings: (patch: Partial<SettingsView>): Promise<SettingsView> =>
      request(`${baseUrl}/api/settings`, jsonBody("PUT", patch)),

    getAudit: (limit?: number): Promise<AuditEntry[]> =>
      request(`${baseUrl}/api/audit${limit !== undefined ? `?limit=${limit}` : ""}`),
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
