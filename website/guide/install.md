# Install & run

## Docker Compose (recommended)

A full example ships in the repo as [`docker-compose.yml`](https://github.com/maxiwolleb/spindoctor/blob/main/docker-compose.yml):

```yaml
services:
  spindoctor:
    image: ghcr.io/maxiwolleb/spindoctor:latest
    # Uncomment to build from a local checkout instead of pulling the image:
    # build: .
    ports:
      - "8080:8080"
    volumes:
      # App database (SQLite) lives here; back this up like you would any
      # other stateful volume.
      - ./data:/data
    restart: unless-stopped

    # Device passthrough — REQUIRED for real SMART/badblocks/hdparm access,
    # OFF by default so a plain `docker compose up` never touches host disks.
    #
    # ⚠️ DESTRUCTIVE: any drive you pass through here (or grant raw access
    # to via privileged/cap_add) can be WIPED by this tool's badblocks -w
    # stage. Only enable this for disks you intend to test-to-destruction.
    #
    # Pick ONE:
    # privileged: true
    # # — or, narrower —
    # cap_add:
    #   - SYS_RAWIO
    #   - SYS_ADMIN
    #
    # Either way, list the exact drives to pass through (check with `lsblk`
    # first — replace /dev/sdX with the real device path on the host):
    # devices:
    #   - "/dev/sdX:/dev/sdX"
```

Bring it up:

```
docker compose up -d
```

Then open `http://localhost:8080`.

Without the device-passthrough block uncommented, the UI comes up and the
dashboard works, but drive discovery will not see any real disks — that's
intentional, so a plain `docker compose up` never touches host block
devices by accident.

### Device passthrough

To actually discover and test physical drives, uncomment the
device-passthrough block and:

1. Run `lsblk` on the **host** first to identify the exact device paths
   (`/dev/sdX`, `/dev/sdY`, …) of the drives you intend to test.
2. Choose either `privileged: true` (broadest, simplest, most dangerous —
   full device access) or the narrower `cap_add: [SYS_RAWIO, SYS_ADMIN]`
   (just the raw-I/O + admin capabilities `smartctl`/`badblocks`/`hdparm`
   need).
3. List those exact drives under `devices:` — do not omit it. Without a
   `devices:` list, `privileged: true` alone still hands the container
   every block device on the host, including the one the host itself
   boots from.

Only pass through disks you intend to test to destruction. Never pass
through a disk holding data you want to keep, and never the host's own
system/boot disk.

## Local development

Requires **Node ≥ 22** and pnpm ≥ 9 (the repo is developed against pnpm
10).

```
pnpm install
pnpm dev                              # backend + web, both in watch mode
```

Other useful workspace scripts:

```
pnpm test                             # vitest, whole workspace
pnpm -r typecheck                     # typecheck every package
pnpm --filter @spindoctor/web build   # production SPA build
```

The backend runs under `tsx` (not a bundler) in both development and
production — see [Architecture](/guide/architecture) for why.
