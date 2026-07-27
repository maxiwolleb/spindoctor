import fs from "node:fs"
import { DEFAULT_THRESHOLDS } from "@spindoctor/shared"
import { parseSmartMetrics } from "./device/smartParser"
import { evaluateVerdict } from "./verdict/evaluate"
import { condemnedByBaseline } from "./verdict/baselineGate"

const raw = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"))
const m = parseSmartMetrics(raw)
console.log("metrics:", { commandTimeouts: m.commandTimeouts, spinRetryCount: m.spinRetryCount, reallocatedSectors: m.reallocatedSectors, percentageUsed: m.percentageUsed, health: m.smartHealthPassed })
const r = evaluateVerdict({ before: m, after: m, deviceType: "HDD", selfTest: { status: "PASSED" }, surface: null, thresholds: DEFAULT_THRESHOLDS })
console.log("verdict:", r.verdict, r.reasons.map((x) => `${x.code}(${x.severity})`))
console.log("gate would fire:", condemnedByBaseline({ before: m, deviceType: "HDD", thresholds: DEFAULT_THRESHOLDS }).map((x) => x.code))
