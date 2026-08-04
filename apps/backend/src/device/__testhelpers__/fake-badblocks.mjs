// Emulates `badblocks -s -o <logfile> <dev>` closely enough to exercise the
// surface-test runner in tests, without touching a real disk or the real
// `badblocks` binary:
//   - prints "% done" progress to stderr in the same shape badblocks does
//   - optionally writes N fake bad-block LBAs to the `--log` file
//   - optionally prints a fixed line to stdout (badblocks itself rarely
//     writes to stdout, but the runner captures it regardless)
//   - optionally never finishes, so tests can exercise abort/kill
//   - optionally emits several 0-100% phases (like real `badblocks -w`, which
//     resets its percentage per pattern write/verify) via --phases
//   - optionally fails the way real badblocks does when the device is too large
//     for its 32-bit block numbers (--fail-start): an error on stderr and a
//     non-zero exit, with no progress and no logfile, all before any I/O
//   - optionally runs to completion but exits non-zero (--exit-code), to tell a
//     scan that started and then failed apart from one that never started
//
// Usage: node fake-badblocks.mjs --log <path> [--bad <n>] [--stdout <text>] [--hang]
//          [--phases <n>] [--fail-start] [--exit-code <n>]
import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const logPath = args[args.indexOf("--log") + 1]
const bad = args.includes("--bad") ? Number(args[args.indexOf("--bad") + 1]) : 0
const stdoutText = args.includes("--stdout") ? args[args.indexOf("--stdout") + 1] : undefined
const hang = args.includes("--hang")
// Number of 0-100% phases to emit before finishing (real `badblocks -w` cycles
// through several — write + verify per pattern); a single pass by default.
const phases = args.includes("--phases") ? Number(args[args.indexOf("--phases") + 1]) : 1
const exitCode = args.includes("--exit-code") ? Number(args[args.indexOf("--exit-code") + 1]) : 0

if (stdoutText) process.stdout.write(`${stdoutText}\n`)

// Verbatim shape of what real badblocks prints when the device needs more than
// 32 bits of block numbers (issue #84) — no progress, no logfile, exit 1.
if (args.includes("--fail-start")) {
  process.stderr.write(
    "badblocks: Value too large for defined data type invalid end block (11718885376): must be 32-bit value\n",
  )
  process.exit(1)
}

let phase = 0
let pct = 0
const tick = () => {
  pct += 25
  process.stderr.write(`\r  ${pct.toFixed(2)}% done, 0:0${pct / 25} elapsed. (0/0/0 errors)`)
  if (pct >= 100) {
    if (hang) {
      // Never finish — the percentage just keeps climbing — so abort/kill
      // tests have a process that won't exit on its own.
      setTimeout(tick, 10)
      return
    }
    phase += 1
    if (phase >= phases) {
      if (logPath) {
        const lines = Array.from({ length: bad }, (_, i) => String(1000 + i))
        writeFileSync(logPath, lines.join("\n") + (bad > 0 ? "\n" : ""))
      }
      process.exit(exitCode)
    }
    pct = 0 // reset for the next phase, as real badblocks does
  }
  setTimeout(tick, 10)
}
setTimeout(tick, 10)
