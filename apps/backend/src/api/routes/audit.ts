import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { Db } from "../../db/client"
import { listAudit, type AuditRow } from "../../db/repositories"

export interface AuditRouteDeps {
  db: Db
}

const DEFAULT_LIMIT = 200

/** Parses `?limit=` defensively: falls back to the default for anything not a positive integer. */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_LIMIT
  return n
}

export function auditRoutes(deps: AuditRouteDeps): FastifyPluginAsync {
  const { db } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get(
      "/audit",
      async (request: FastifyRequest<{ Querystring: { limit?: string } }>): Promise<AuditRow[]> => {
        const limit = parseLimit(request.query.limit)
        return listAudit(db).slice(0, limit)
      },
    )
  }
}
