import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { SettingsView, Thresholds } from "@spindoctor/shared"
import type { Db } from "../../db/client"
import { getConfig, updateConfig, type ConfigRow, type ConfigUpdate } from "../../db/repositories"

export interface SettingsRouteDeps {
  db: Db
}

const THRESHOLD_KEYS = [
  "reallocatedWarnMax",
  "ssdPercentageUsedWarn",
  "ssdPercentageUsedFail",
] as const

function toSettingsView(row: ConfigRow): SettingsView {
  const protectList = row.protectList
  return {
    thresholds: row.thresholds as Thresholds,
    concurrency: row.concurrency,
    autoModeEnabled: row.autoModeEnabled,
    protectList: Array.isArray(protectList) ? (protectList as string[]) : [],
    skipCondemnedDrives: row.skipCondemnedDrives,
  }
}

function isValidThresholds(value: unknown): value is Thresholds {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== THRESHOLD_KEYS.length) return false
  return THRESHOLD_KEYS.every((key) => typeof obj[key] === "number" && Number.isFinite(obj[key]))
}

/**
 * Validates a partial `SettingsView` patch. Returns the validated `ConfigUpdate`
 * subset on success, or an error message describing the first invalid field.
 */
function validatePatch(body: unknown): { patch: Partial<ConfigUpdate> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "body must be an object" }
  }
  const input = body as Record<string, unknown>
  const patch: Partial<ConfigUpdate> = {}

  if ("thresholds" in input) {
    if (!isValidThresholds(input.thresholds)) {
      return {
        error:
          "thresholds must be an object of finite numbers with keys: " + THRESHOLD_KEYS.join(", "),
      }
    }
    patch.thresholds = input.thresholds
  }

  if ("concurrency" in input) {
    const c = input.concurrency
    if (typeof c !== "number" || !Number.isFinite(c) || !Number.isInteger(c) || c < 1) {
      return { error: "concurrency must be an integer >= 1" }
    }
    patch.concurrency = c
  }

  if ("autoModeEnabled" in input) {
    if (typeof input.autoModeEnabled !== "boolean") {
      return { error: "autoModeEnabled must be a boolean" }
    }
    patch.autoModeEnabled = input.autoModeEnabled
  }

  if ("skipCondemnedDrives" in input) {
    if (typeof input.skipCondemnedDrives !== "boolean") {
      return { error: "skipCondemnedDrives must be a boolean" }
    }
    patch.skipCondemnedDrives = input.skipCondemnedDrives
  }

  if ("protectList" in input) {
    const list = input.protectList
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string")) {
      return { error: "protectList must be a string[]" }
    }
    patch.protectList = list
  }

  return { patch }
}

export function settingsRoutes(deps: SettingsRouteDeps): FastifyPluginAsync {
  const { db } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/settings", async (): Promise<SettingsView> => {
      return toSettingsView(getConfig(db))
    })

    fastify.put("/settings", async (request: FastifyRequest<{ Body: unknown }>, reply) => {
      const result = validatePatch(request.body)
      if ("error" in result) {
        reply.code(400)
        return { error: result.error, code: "BAD_REQUEST" }
      }

      const updated = updateConfig(db, result.patch)
      return toSettingsView(updated)
    })
  }
}
