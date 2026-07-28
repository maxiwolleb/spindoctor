import type { FastifyInstance, FastifyPluginAsync } from "fastify"
import type { Db } from "../../db/client"
import { getConfig } from "../../db/repositories"
import { probeEnvironment } from "../../diagnostics/environment"
import { buildBundle, serializeBundle } from "../../diagnostics/bundle"
import type { CommandRunner } from "../../device/runner"

export interface DiagnosticsRouteDeps {
  db: Db
  runner: CommandRunner
  spindoctorVersion?: string | null
}

/**
 * `GET /api/diagnostics/bundle` — everything an offline reader needs to audit
 * spindoctor's own judgement, as one gzipped JSON download.
 *
 * Nothing is transmitted anywhere: the operator downloads a file and decides
 * whether to share it. The route 404s unless `diagnosticsEnabled` is on, so an
 * instance that never opts in has no such endpoint to find.
 */
export function diagnosticsRoutes(deps: DiagnosticsRouteDeps): FastifyPluginAsync {
  const { db, runner } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/diagnostics/bundle", async (_request, reply) => {
      if (!getConfig(db).diagnosticsEnabled) {
        reply.code(404)
        return { error: "diagnostics collection is disabled", code: "DIAGNOSTICS_DISABLED" }
      }

      const environment = await probeEnvironment(runner)
      const bundle = buildBundle({
        db,
        environment,
        spindoctorVersion: deps.spindoctorVersion ?? null,
      })
      const body = serializeBundle(bundle)
      const stamp = bundle.generatedAt.replace(/[:.]/g, "-")

      reply
        .code(200)
        .header("content-type", "application/gzip")
        .header(
          "content-disposition",
          `attachment; filename="spindoctor-diagnostics-${bundle.instanceRef}-${stamp}.json.gz"`,
        )
      return reply.send(body)
    })
  }
}
