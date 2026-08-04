import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify"
import type { DriveType, DriveView, Transport, Verdict } from "@spindoctor/shared"
import type { Db } from "../../db/client"
import type { DriveRow } from "../../db/repositories"
import { getConfig, getDrive, listDrives, listRuns, upsertDrive } from "../../db/repositories"
import type { DeviceApi } from "../../device/deviceApi"
import type { TestEngine } from "../../engine/engine"
import { isProtected } from "../../safety/guards"

export interface DrivesRouteDeps {
  db: Db
  deviceApi: DeviceApi
  engine: TestEngine
}

interface RuntimeFlags {
  present: boolean
  mounted: boolean
  isSystemDisk: boolean
}

const ABSENT: RuntimeFlags = { present: false, mounted: false, isSystemDisk: false }

/** Newest run for a drive (by highest id), mapped to the `DriveView.latestRun` shape. */
function latestRunFor(db: Db, serial: string): DriveView["latestRun"] {
  const runs = listRuns(db, { driveSerial: serial })
  if (runs.length === 0) return null
  const newest = runs.reduce((a, b) => (b.id > a.id ? b : a))
  return {
    id: newest.id,
    status: newest.status,
    verdict: (newest.verdict as Verdict | null) ?? null,
    currentStage: newest.currentStage ?? null,
  }
}

/** The protect list as the safety guard sees it. */
function protectList(db: Db): string[] {
  const stored = getConfig(db).protectList
  return Array.isArray(stored) ? (stored as string[]) : []
}

function toDriveView(db: Db, row: DriveRow, flags: RuntimeFlags, protect: string[]): DriveView {
  return {
    serial: row.serial,
    model: row.model,
    sizeBytes: row.sizeBytes,
    type: row.type as DriveType,
    transport: row.transport as Transport,
    present: flags.present,
    mounted: flags.mounted,
    isSystemDisk: flags.isSystemDisk,
    // Read from the protect list, the same source `checkRunAllowed` consults —
    // not the `protected` column, which nothing ever wrote (`setProtected` had no
    // callers). A drive the engine was correctly refusing came back
    // `"protected": false`, so the chip, the start dialog and the engine
    // disagreed, and a mistyped list entry looked exactly like a working one
    // (issue #88).
    protected: isProtected(row.serial, protect),
    latestRun: latestRunFor(db, row.serial),
  }
}

export function drivesRoutes(deps: DrivesRouteDeps): FastifyPluginAsync {
  const { db, deviceApi } = deps

  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/drives", async (): Promise<DriveView[]> => {
      const discovered = await deviceApi.listDevices()
      const flagsBySerial = new Map<string, RuntimeFlags>()
      for (const d of discovered) {
        upsertDrive(db, d)
        flagsBySerial.set(d.serial, {
          present: true,
          mounted: d.mounted,
          isSystemDisk: d.isSystemDisk,
        })
      }

      const protect = protectList(db)
      return listDrives(db).map((row) =>
        toDriveView(db, row, flagsBySerial.get(row.serial) ?? ABSENT, protect),
      )
    })

    fastify.get(
      "/drives/:serial",
      async (request: FastifyRequest<{ Params: { serial: string } }>, reply) => {
        const { serial } = request.params
        const discovered = await deviceApi.listDevices()
        const match = discovered.find((d) => d.serial === serial)
        if (match) upsertDrive(db, match)

        const row = getDrive(db, serial)
        if (!row) {
          reply.code(404)
          return { error: `no drive found with serial "${serial}"`, code: "DRIVE_NOT_FOUND" }
        }

        const flags: RuntimeFlags = match
          ? { present: true, mounted: match.mounted, isSystemDisk: match.isSystemDisk }
          : ABSENT
        const drive = toDriveView(db, row, flags, protectList(db))
        const runs = listRuns(db, { driveSerial: serial })
        return { drive, runs }
      },
    )
  }
}
