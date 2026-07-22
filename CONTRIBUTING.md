# Contributing to demake

Thanks for helping build demake. This is a Phase 0 stub and will grow as the
implementation lands; the authoritative, always-current contributor contract is
[`AGENTS.md`](AGENTS.md).

## Setup

- **Node** ≥ 20 (CI tests Node 20 and 22).
- **pnpm** — the version is pinned via `packageManager` in `package.json`; run
  `corepack enable` and pnpm will match it automatically.

```sh
pnpm install
pnpm build      # tsc project-references build
pnpm test       # Vitest
pnpm lint       # ESLint + Prettier check
```

Docker is only needed later, for the emulator-based end-to-end suite
(`pnpm test:e2e`, arriving in Phase 2 — doc 10).

## Iron rules

- **`core` is platform-pure and deterministic.** No `fs`/`Buffer`/DOM and no
  wall-clock, `Math.random`, or `Math.*` transcendentals in `packages/core`
  (doc 02). Custom ESLint rules enforce this — `pnpm lint` will tell you.
- **Conventional Commits.** Imperative subject ≤ 72 chars, describing the change
  itself.
- **No AI attribution** anywhere — no `Co-Authored-By`, generator lines, session
  links, or model names in commits, PR bodies, or code comments.
- **No naming of other repositories or prior personal projects** (design
  provenance belongs in `docs/`, described generically).
- **Every user-visible change ships a changeset** (`pnpm changeset`) and its
  tests in the same PR. Output-byte changes also re-baseline goldens in the same
  PR (doc 09 §Stability).

## Pull requests

- Branch off `main`; never push to `main` directly.
- Make sure `pnpm build`, `pnpm lint`, and `pnpm test` are green.
- Fill in the PR checklist (tests, changeset).

## Adding a console

The two-files-plus-fixtures recipe (a `ConsoleSpec` plus a codegen backend, then
harness fixtures) is documented in [`docs/02-architecture.md`](docs/02-architecture.md)
§Extensibility and will be expanded here once the engine exists.

## Security

Please report vulnerabilities privately — see [`SECURITY.md`](SECURITY.md).
