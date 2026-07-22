# 12 — Repository Standards & Developer Practices

## Top-level files

| File | Contents |
|---|---|
| `README.md` | The shop window: one-paragraph pitch, animated demo GIF (source → GBC/NES/MD side-by-side), install matrix (npm / binaries / web / desktop), 5 copy-paste examples, console support table (auto-generated from ConsoleSpecs — CI-checked, never stale), links into `docs/`. Badges: CI, npm version, Pages. |
| `AGENTS.md` | See below — the agent-onboarding contract for *developing this repo*. The canonical project-memory file, following the cross-tool agents.md standard so Codex, Cursor, etc. read it natively. |
| `CLAUDE.md` | A one-line shim containing only `@AGENTS.md`. Claude Code reads `CLAUDE.md` (not `AGENTS.md`) but supports imports, so this makes every tool consume the identical instructions with zero duplication. Never holds content of its own; a CI check enforces it stays a pure import. |
| `docs/agent-guide.md` | The contract for *using the installed tool* (doc 05): commands, JSON schemas, error codes, examples. Generated from `cli-spec`; mirrored by `retroart help --agents`. |
| `CONTRIBUTING.md` | Dev setup (pnpm, Node 20, optional Docker for E2E), test commands, changeset requirement, "adding a console" walkthrough (the doc-02 two-files-plus-fixtures recipe, step by step), PR checklist. |
| `SECURITY.md` | Private reporting via GitHub advisories; supported-versions table. |
| `CODE_OF_CONDUCT.md` | Contributor Covenant. |
| `LICENSE` | MIT (already present). |
| `.github/` | PR template (checklist: tests, changeset, goldens rationale if bytes changed), issue forms (bug: needs `--json` output + input image + version; console-request form), CODEOWNERS. |

## AGENTS.md — contents specification

Written for an agent landing in the repo cold; kept under ~150 lines; updated in the
same PR as any workflow it describes (CI has a staleness check: commands named in
AGENTS.md must exist in package.json scripts).

1. **What this is** — two sentences + pointer to `docs/README.md`.
2. **Layout map** — the doc-02 tree, one line per package.
3. **Golden commands** — `pnpm i`, `pnpm build`, `pnpm test`, `pnpm test:e2e gbc`,
   `pnpm lint:fix`, `pnpm changeset`, how to run one fixture through the CLI from
   source (`pnpm cli -- prep …`).
4. **Iron rules** — core stays platform-pure (lint enforces); determinism (no
   wall-clock/random; seeded PRNG only); output-byte changes require golden
   re-baseline + changeset `minor` + release-note line; `cli-spec` is the only
   place flags are defined; never hand-edit generated man pages.
5. **How to add a console** — condensed recipe with file paths.
6. **Testing truths** — what runs locally vs needs Docker; where CI artifacts land;
   the doc-10 E2E triage table.
7. **Gotchas** — NES attribute cells are 16×16 not 8×8; DAC models are load-bearing
   in tests; PNG encoder must stay deterministic (no libpng drift).
8. **Commit rules** — no AI attribution of any kind (no `Co-Authored-By`, generator
   lines, session links, or model names) in commit messages, PR bodies, or code
   comments; no references to other repositories or prior personal projects in
   commit messages (design provenance belongs in `docs/`); imperative
   Conventional-Commits subjects about the change itself.

## Engineering conventions

- **TypeScript strict** everything (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`); ESM only; no `any` in `core` public surface.
- **Formatting/linting**: prettier + eslint flat config; import ordering; the two
  custom rules (platform-purity, determinism) live in `tools/eslint-rules/`.
- **Commits/PRs**: Conventional Commits (feeds changelog grouping); small PRs; every
  behavior change lands with its tests; every output-byte change lands with its
  re-baselined goldens **in the same PR** so review sees before/after images
  (goldens are PNGs — GitHub renders the diff visually).
- **Comments** explain hardware constraints ("MD CRAM write during active display
  causes dots — harness uploads in vblank"), not code mechanics; each ConsoleSpec
  cites primary sources (doc 03 schema `docs.sources`).
- **Dependencies**: minimal and vetted; core's runtime deps target ~zero (codecs are
  vendored WASM with pinned hashes); anything else needs a written justification in
  the PR.
- **Docs are living**: `docs/` evolves from this plan into current-state design
  docs; a doc that contradicts code is a bug; ADRs (`docs/adr/NNN-*.md`) record
  decisions that change plan-era choices, starting with ADR-001 "TypeScript core"
  (imported from doc 02).
