# 11 — CI & Release Pipelines (GitHub Actions)

## Workflows

### `ci.yml` — every PR and push to `main`

| Job | What | Notes |
|---|---|---|
| `lint` | eslint (incl. custom rules: no `Math.random`/`Date.now`/platform APIs in core), prettier check, typecheck (project references), `cli-spec` regeneration diff check | fast-fail |
| `test-unit` | Vitest unit + property + golden suites, coverage upload | matrix: ubuntu/macos/windows × Node 20/22 |
| `test-browser` | Playwright: web build determinism + functional | Chromium/Firefox/WebKit, ubuntu |
| `test-e2e-rom` | Doc-10 emulator suite, **Tier-1 consoles**, flagship fixture | ubuntu, pulls pinned `retroart-tc-*` images; ~parallel per console via matrix |
| `bench` | benchmark action vs. baseline | regression >25% fails |
| `build-artifacts` | build core/cli/web + smoke (`retroart --version`, `prep` one fixture) | artifacts retained for the PR |
| `docs` | man page lint, docs-site build, link check | |

Full-corpus determinism + all-tier E2E run **nightly** (`nightly.yml`) rather than
per-PR (keeps PR CI < ~15 min); nightly failures open an issue automatically.

### `toolchains.yml` — weekly + on `toolchains/**` change

Builds the per-family Docker images (assemblers, compilers, emulators — all version-
pinned), pushes to GHCR by digest, and opens a PR bumping the digests consumed by CI
and `--rom-builder docker`. Emulator/toolchain upgrades are therefore ordinary
reviewed PRs that must pass the whole E2E suite.

### `pages.yml` — deploy web app

On push to `main` affecting `packages/{web,core}`: build → deploy to GitHub Pages
(environment `github-pages`, official actions). `main` is always live; releases tag
what Pages already serves.

### `release.yml` — tag-driven, fully automated

Versioning via **Changesets**: every user-visible PR adds a changeset; a bot PR
("Version Packages") accumulates them; merging it tags `vX.Y.Z` and triggers:

1. **Verify**: full CI including all-tier E2E on the tag.
2. **npm**: publish `@retroart/core` + `retroart` with `--provenance` (OIDC trusted
   publishing, no long-lived npm token).
3. **Binaries**: Node SEA builds for linux-x64/arm64, darwin-x64/arm64, win-x64;
   SHA256SUMS; SLSA provenance attestation (`actions/attest-build-provenance`).
4. **Desktop**: Tauri builds on the 3-OS matrix, signed/notarized (secrets), updater
   manifest published.
5. **GitHub Release**: generated notes from changesets + all artifacts.
6. **Man/docs**: versioned docs site deploy; man pages included in npm package and
   binary tarballs.
7. Post-1.0: Homebrew tap + Scoop manifest bump PRs, automated.

Semver policy (restated from doc 09): patch = no output-byte changes; minor = may
change output bytes (release-noted, goldens re-baselined in the same PR); major =
CLI/API breaking. `1.0.0` ships when doc 01's success criteria are all green.

## Repo protections & hygiene

- `main` protected: PR + required checks + linear history; CODEOWNERS (`docs/`,
  `core/consoles/`, `toolchains/` get focused review).
- Dependabot/Renovate for npm + Actions + Docker digests, weekly, auto-merge for
  dev-deps patch bumps (CI gates everything anyway).
- Actions pinned by SHA; least-privilege `permissions:` per workflow; no
  `pull_request_target` foot-guns; fork PRs run without secrets (signing skipped).
- Concurrency groups cancel superseded PR runs; pnpm + Docker layer caching
  throughout; Turborepo/`pnpm --filter` so PR jobs build only affected packages.
