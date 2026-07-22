# AGENTS.md — working in this repository

Guidance for coding agents (and humans) contributing to demake.
This file is the canonical project-memory file; `CLAUDE.md` is a one-line import
shim so Claude Code reads the same instructions. Keep all guidance here — never
add content to `CLAUDE.md` directly.

## What this is

A tool that converts any image into hardware-compliant art — and displayable
code — for 8/16-bit-era consoles and handhelds up to the Nintendo DS. The full
design lives in [`docs/`](docs/README.md); the milestone plan is
[`docs/13-roadmap.md`](docs/13-roadmap.md). **Current status: Phase 0** — the
repo is scaffolded (workspace, tooling, CI) with a hello-world core and a stub
CLI; the conversion engine lands in Phase 1+.

## Layout map

```
packages/core/   @demake/core — the engine (zero platform deps; ESM; ships types)
packages/cli/    demake — thin CLI over core; re-exports core for scripting
tools/eslint-rules/  custom ESLint rules: platform-purity + determinism
docs/            the design plan; source of truth for decisions
```

Packages not yet created (web, desktop, cli-spec, rom-harness, toolchains,
testdata) arrive in later phases per doc 02.

## Golden commands

```sh
pnpm install       # install workspace deps (Node >= 20, pnpm pinned via packageManager)
pnpm build         # typecheck + build all packages (tsc project references)
pnpm test          # Vitest unit suite
pnpm lint          # ESLint (incl. custom core rules) + Prettier check
pnpm lint:fix      # autofix ESLint + Prettier
pnpm changeset     # add a changeset for a user-visible change
pnpm cli -- --help # run the built CLI from source (build first)
```

## Iron rules

- **`core` stays platform-pure**: no `fs`/`Buffer`/DOM, no Node built-ins.
  I/O lives at the edges (CLI/web/desktop). Lint enforces (doc 02).
- **`core` stays deterministic**: no wall clock (`Date.now`, `new Date`), no
  `Math.random`, and no `Math.*` transcendentals — use the in-house math
  kernels once they exist. Lint enforces (doc 02 §Determinism).
- **Output-byte changes** require re-baselined goldens **+ a `minor` changeset +
  a release-note line, all in the same PR** (doc 09 §Stability). Patch releases
  never change output bytes.
- **`cli-spec` will be the only place flags are defined** (doc 05); generated
  man pages are never hand-edited (neither exists yet — Phase 1).
- **`CLAUDE.md` stays a pure `@AGENTS.md` import** (CI-checked, doc 12).
- **Commands named in this file must exist as `package.json` scripts** (CI
  staleness check, doc 12) — update both together.

## How to add a console (once the engine exists)

Two files plus fixtures (doc 02 §Extensibility):

1. `packages/core/src/consoles/<id>.ts` — a declarative `ConsoleSpec`.
2. `packages/core/src/codegen/<family>.ts` — native data + display source.
3. `rom-harness/<id>/` + a toolchain Dockerfile + golden fixtures — the console
   is only "supported" when its emulator screenshot test passes (doc 10).

## Testing truths

- `pnpm test` runs the Vitest unit suite locally with no Docker (< 2 min target).
- The emulator-based end-to-end suite (`pnpm test:e2e`, doc 10) needs Docker and
  arrives in Phase 2.
- CLI tests exercise both the pure `run()` function and the spawned built binary;
  the binary test skips when `dist` is absent, so run `pnpm build` first to
  include it (CI always does).

## Gotchas

- NES attribute cells are 16×16, not 8×8 — a load-bearing detail for the fitter.
- DAC models are tested artifacts: they decide pixel-perfect emulator comparisons.
- The PNG encoder must stay deterministic (no libpng drift) once it exists.
- Source imports use explicit `.js` extensions (NodeNext ESM); Vitest resolves
  them to `.ts` via the workspace alias.

## Commit rules

- **No AI attribution of any kind in commits**: no `Co-Authored-By` trailers, no
  `Generated with` lines, no session links, no model names — in commit messages,
  PR titles/bodies, or code comments.
- **Never name other repositories or prior personal projects anywhere in this
  repository** — not in commit messages, docs, code, comments, or fixtures.
  This includes the earlier project this tool's design originated from: refer
  to it only generically (the docs use "the predecessor tools"). No project
  names, no links to it.
- Write commit messages about the change itself: imperative subject ≤ 72 chars,
  body explaining what and why (Conventional Commits).
- Develop on the designated feature branch; never push to `main` directly.

## Documentation rules

- `docs/` is the source of truth for design. If you change a decision, update
  every doc that states it (they cross-reference each other by number).
- Keep this file current: any workflow or convention you introduce that an agent
  needs on day one gets a line here, in the same PR.
