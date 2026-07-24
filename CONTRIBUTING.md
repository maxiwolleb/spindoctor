# Contributing

Thanks for considering a contribution to spindoctor.

## Project layout

spindoctor is a pnpm workspace monorepo:

- `apps/backend` — Fastify + TypeScript backend (REST + SSE, SQLite via
  Drizzle).
- `apps/web` — Vue 3 + Vuetify frontend, built with Vite.
- `packages/shared` — wire types shared by both sides (source-only, no
  build step — resolved directly from `.ts`).

## Dev setup

Requires Node ≥ 22 and pnpm ≥ 9.

```
pnpm install
pnpm dev   # runs the backend and the web app together, both in watch mode
```

Useful commands while working on a change:

```
pnpm test                             # vitest, whole workspace
pnpm -r typecheck                     # typecheck every package
pnpm --filter @spindoctor/web build   # production SPA build
```

The device layer (`smartctl`, `badblocks`, `lsblk`, …) is fully mockable in
tests via `DeviceApi` — never run destructive commands against real disks
in tests or CI.

## Before opening a pull request

- [ ] `pnpm test` passes.
- [ ] `pnpm -r typecheck` passes.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, …).
- [ ] No secrets, credentials, or local paths in the diff.

## Commit style

Use Conventional Commits, e.g.:

```
fix(engine): resume interrupted self-test on reconcile
feat(web): add protected-serial removal to settings
docs: clarify auto-mode acknowledgment requirement
```

Keep commits focused — one logical change per commit.

## Safety-sensitive changes

Anything touching `apps/backend/src/safety/`, the auto-mode poller, or the
destructive-run confirmation path is safety-sensitive: these guards exist to
stop the tool from wiping the wrong drive. Please explain the reasoning
behind any change there in the PR description, and do not weaken a guard
without discussing it first in an issue.
