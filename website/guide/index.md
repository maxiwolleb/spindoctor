# What is spindoctor

spindoctor is a self-hosted tool for qualifying used and refurbished hard
drives before you trust them with data. Buying a batch of pulled
enterprise drives, inheriting a stack of old disks, or just not sure a
drive is still healthy — spindoctor gives you a repeatable, unattended way
to find out, driven entirely from a live web console.

## The problem

A drive that mounts fine and passes a quick SMART check can still be on
its way out. Reallocated sectors, pending sectors that haven't been
reallocated yet, marginal cabling, and SSD/NVMe wear don't always show up
until the drive is actually put under load. Manually running
`smartctl`/`badblocks` per drive, watching progress, and deciding
PASS/WARN/FAIL by eye doesn't scale past a drive or two, and it's easy to
get the judgment call wrong or forget a step.

## The approach: test, then grade

spindoctor runs a fixed health regime per drive:

1. **SMART_BEFORE** — a SMART snapshot before anything else happens.
2. **SELFTEST_LONG** — the drive's own firmware long self-test.
3. **SURFACE** — a full-surface scan (destructive `badblocks -w`, or a
   read-only pass) that exercises every sector.
4. **SMART_AFTER** — a second SMART snapshot.
5. **VERDICT** — the before/after diff, the self-test result, and the
   surface result are evaluated against configurable thresholds into a
   strict **PASS / WARN / FAIL**, with structured reasons attached.

Everything is driven and observed from a web UI fed by a live event
stream, so you can attach a batch of drives, kick off tests, and watch
SMART snapshots, self-test progress, and surface-scan status update live,
per drive — without babysitting a terminal.

The destructive surface scan is what makes the grading trustworthy: it's
also what makes this tool dangerous to point at the wrong disk. Read
[Safety](/guide/safety) before you attach anything you care about.

## Where to go next

- [Install & run](/guide/install) — get spindoctor running via Docker or
  in local dev.
- [How it works](/guide/how-it-works) — the regime, the exact verdict
  thresholds, and auto-mode.
- [Safety](/guide/safety) — the guards, and what they do and don't protect
  you from.
- [Configuration](/guide/configuration) — environment variables and UI
  settings.
- [Architecture](/guide/architecture) — how the codebase is put together.
