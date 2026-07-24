# Safety

## ⚠️ This tool is destructive

The surface stage of a destructive test run runs `badblocks -w` — a
write-pattern scan that writes and verifies every sector of the drive.
**It irrecoverably wipes all data on the drive under test.** There is no
undo. Only point spindoctor's destructive mode at drives whose data you
do not need.

A read-only scan (`badblocks -n`) is available as an alternative when you
want to exercise a drive's surface without destroying its contents, but
the full regime — and the strongest signal — comes from the destructive
path.

## Always-on guards

These checks run for every destructive start — manual or auto-mode — and
cannot be bypassed from the UI:

- **Mounted drives are never eligible.** A drive that is currently
  mounted is refused.
- **The system disk is never eligible.** The host's own boot/system disk
  is refused outright.
- **Drives with no serial number are refused.** A drive spindoctor can't
  key by serial is refused rather than risking mis-identifying it later.
- **The protected-serial list is always honored.** Any serial you add to
  the protect list in Settings is refused, including in auto-mode.

These same checks are enforced twice: once in the browser UI (so an
ineligible drive is visibly blocked before you even try), and again,
independently, on the server for every `POST /api/runs` — so they hold
even if a client bypasses the UI.

## The pre-write safety re-check

A destructive run's safety check runs once when the run starts — but the
long self-test that runs before the surface stage can take hours, during
which a drive could be unmounted and remounted, added to the protect
list, or could vanish entirely. So immediately before the destructive
`badblocks -w` write actually begins, the drive is **re-resolved and
re-checked** against the same guards, never trusting the snapshot the run
started with. If the drive is no longer eligible (or no longer present),
the write is refused and the run fails safely instead of proceeding on
stale information.

## Typed-serial confirmation

Starting a **destructive** run manually requires typing the drive's exact
serial number into a confirmation field in the UI before the "Wipe &
test" button is enabled. The same requirement is enforced again by the
API: a `POST /api/runs` for a destructive mode without a matching
`confirm` field is rejected.

## Auto-mode acknowledgment

Auto-mode cannot be turned on silently. The toggle in Settings stays
disabled until you check an explicit acknowledgment box — *"I understand
auto-mode will destructively wipe any newly attached, eligible drive."*
Unchecking the box always forces the toggle back off; it can never be
saved on while unacknowledged.

![Settings: thresholds, concurrency, protected drives, auto-mode](/screenshots/settings.png)

## No web-UI authentication in v1

The web UI and API have **no authentication** in this version. It is
built to be run on a trusted LAN — do not expose it directly to the
internet. Combined with the guards above, this means anyone who can reach
the UI/API can start a destructive run against any eligible, non-protected
drive attached to the host; network-level access control is your
responsibility.

## What these guards don't do

They reduce risk, they don't eliminate it. Nothing here protects a drive
that was never told about the guard — most importantly, **you** decide
which physical drives get passed through to the container in the first
place (see [device passthrough](/guide/install#device-passthrough)).
spindoctor cannot warn you about a drive it was never told to protect.
Double-check `lsblk` on the host before you pass any device through.
