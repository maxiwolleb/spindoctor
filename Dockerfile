# syntax=docker/dockerfile:1

# ---- build stage --------------------------------------------------------
# Builds the web SPA and produces a self-contained backend deploy dir via
# `pnpm deploy`. The backend is never bundled — it ships as source and runs
# under tsx in production too, so this stage just needs to assemble the
# right files + a production node_modules, not compile anything backend-side.
FROM node:22-bookworm-slim AS build

# Pin the exact pnpm version used to build/verify this image so the deploy
# behavior below (which differs across pnpm major versions) stays stable
# regardless of whatever corepack would otherwise fetch as "latest".
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

WORKDIR /src

# Bring in the whole workspace; .dockerignore keeps node_modules, dist,
# local-only tooling/docs, test files, and runtime data out of this context.
COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @spindoctor/web build

# pnpm 10 refuses to deploy from a workspace using injected-dependency links
# by default; --legacy falls back to the copy-based deploy implementation,
# which is what actually produces a runnable, self-contained backend dir
# here (src/, drizzle/, and a node_modules with @spindoctor/shared + tsx +
# better-sqlite3 resolved into it).
RUN pnpm --filter @spindoctor/backend deploy --prod --legacy /app

# ---- runtime stage -------------------------------------------------------
# Debian-slim + the CLI tools the device layer shells out to
# (smartctl, badblocks/e2fsprogs, nvme-cli, hdparm, lsblk via util-linux).
FROM node:22-bookworm-slim AS runtime

# smartmontools comes from bookworm-backports, not bookworm. Bookworm ships
# 7.3 (Feb 2022), which predates NVMe self-test support — `smartctl -t long`
# against an NVMe drive there exits 0 having done nothing at all, so the
# self-test stage "succeeded", polled an empty log, and every NVMe run ended
# WARN ("self-test did not complete") and could never PASS. 7.4 runs NVMe
# self-tests, and says "Self-tests not supported" when a controller genuinely
# lacks the command. Everything else stays on bookworm.
RUN echo "deb http://deb.debian.org/debian bookworm-backports main" \
      > /etc/apt/sources.list.d/backports.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends -t bookworm-backports \
    smartmontools \
  && apt-get install -y --no-install-recommends \
    e2fsprogs \
    nvme-cli \
    hdparm \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Self-contained backend (src/ + drizzle/ + prod node_modules) from the
# build stage's `pnpm deploy` output.
COPY --from=build /app /app
# Built SPA, served as static files + SPA-fallback by the backend itself.
COPY --from=build /src/apps/web/dist /app/web

# The released version, passed in by the Release workflow (`--build-arg`). The
# backend reads SPINDOCTOR_VERSION so a diagnostics bundle can be tied to the
# code that produced it (#70); unset, every bundle reported a null version.
# Defaults to "dev" for a local `docker build`, which is the honest answer there.
ARG SPINDOCTOR_VERSION=dev

ENV NODE_ENV=production \
    SPINDOCTOR_DB=/data/spindoctor.sqlite \
    SPINDOCTOR_WEB_ROOT=/app/web \
    SPINDOCTOR_VERSION=${SPINDOCTOR_VERSION} \
    PORT=8080

# SPINDOCTOR_MIGRATIONS_DIR is intentionally left unset: the deploy dir keeps
# drizzle/ as a sibling of src/, exactly the layout src/db/client.ts already
# resolves by default (../../drizzle from src/db).

EXPOSE 8080
VOLUME /data

# Runs as root: smartctl/badblocks/hdparm need raw block-device access, which
# in turn requires the operator to run the container with --device and/or
# --cap-add (or --privileged) for the specific disks under test — see
# docker-compose.yml. There is no meaningful non-root story here without
# also granting those same device capabilities, so this doesn't drop
# privilege inside the container.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
