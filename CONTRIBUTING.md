# Contributing

Thanks for considering a contribution to spindoctor.

## Project layout

spindoctor is a pnpm workspace monorepo:

- `apps/backend` — Fastify + TypeScript backend (REST + live events, SQLite via
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
pnpm lint                             # eslint
pnpm format                           # prettier, writes in place
pnpm spellcheck                       # cspell
pnpm --filter @spindoctor/web build   # production SPA build
```

The device layer (`smartctl`, `badblocks`, `lsblk`, …) is fully mockable in
tests via `DeviceApi` — never run destructive commands against real disks
in tests or CI.

## Before opening a pull request

- [ ] `pnpm test` passes.
- [ ] `pnpm -r typecheck` passes.
- [ ] `pnpm lint`, `pnpm format:check` and `pnpm spellcheck` pass — CI runs all
      three and they block the merge.
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
      (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`, …).
- [ ] No secrets, credentials, or local paths in the diff.

### Spell-check

`pnpm spellcheck` blocks the merge, so a change that introduces a new piece of
domain vocabulary will fail CI until the word is declared. That is deliberate:
in this codebase a misspelled SMART attribute, `lsblk` JSON key or `smartctl`
flag is a functional bug, not a style nit. Adding the word is a one-line change
to `cspell.json`:

- Real vocabulary used across the project → the top-level `words` array,
  lowercase (case variants match automatically).
- Strings that only make sense in test data, like a drive model or serial from
  a fixture → the `overrides` entry scoped to test files, so the exemption stays
  where it is justified instead of being whitelisted repo-wide.

## Commit style

Use Conventional Commits, e.g.:

```
fix(engine): resume interrupted self-test on reconcile
feat(web): add protected-serial removal to settings
docs: clarify auto-mode acknowledgment requirement
```

Keep commits focused — one logical change per commit.

## Documentation

The docs site lives in `website/` (VitePress) and is built with
`pnpm --filter @spindoctor/website docs:build`. It deploys to **GitHub
Pages**: the `Docs` workflow (`.github/workflows/docs.yml`) builds the site
on every push to `main` — with `DOCS_BASE=/spindoctor/` so links resolve
under the project path — and publishes it at
`https://maxiwolleb.github.io/spindoctor/`. Pages must be set to build from
GitHub Actions (repo Settings → Pages → Build and deployment → Source:
GitHub Actions).

## Safety-sensitive changes

Anything touching `apps/backend/src/safety/`, the auto-mode poller, or the
destructive-run confirmation path is safety-sensitive: these guards exist to
stop the tool from wiping the wrong drive. Please explain the reasoning
behind any change there in the PR description, and do not weaken a guard
without discussing it first in an issue.
