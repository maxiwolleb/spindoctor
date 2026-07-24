// Emulates `badblocks -s -o <logfile> <dev>` closely enough to exercise the
// surface-test runner in tests, without touching a real disk or the real
// `badblocks` binary:
//   - prints "% done" progress to stderr in the same shape badblocks does
//   - optionally writes N fake bad-block LBAs to the `--log` file
//   - optionally never finishes, so tests can exercise abort/kill
//
// Usage: node fake-badblocks.mjs --log <path> [--bad <n>] [--hang]
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const logPath = args[args.indexOf("--log") + 1]
const bad = args.includes("--bad") ? Number(args[args.indexOf("--bad") + 1]) : 0
const hang = args.includes("--hang")

let pct = 0
const tick = () => {
  pct += 25
  process.stderr.write(`\r  ${pct.toFixed(2)}% done, 0:0${pct / 25} elapsed. (0/0/0 errors)`)
  if (pct >= 100 && !hang) {
    if (logPath) {
      const lines = Array.from({ length: bad }, (_, i) => String(1000 + i))
      writeFileSync(logPath, lines.join("\n") + (bad > 0 ? "\n" : ""))
    }
    process.exit(0)
  } else {
    setTimeout(tick, 10)
  }
}
setTimeout(tick, 10)
