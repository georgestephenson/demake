# 11 — CI & Release Pipelines (GitHub Actions)

## Workflows

### `ci.yml` — every PR and push to `main`

| Job | What | Notes |
|---|---|---|
| `changes` | which gates this change can break (see §Affected-only gates) | no install, no build; ~10 s |
| `lint` | eslint (incl. custom rules: no `Math.random`/`Date.now`/platform APIs in core), prettier check, typecheck (project references), `cli-spec` regeneration diff check | fast-fail; **never gated** |
| `test-unit` | Vitest unit + property + golden suites, coverage upload | matrix: ubuntu/macos/windows × Node 20/22 |
| `test-browser` | Playwright: web build determinism + functional | **one job per engine**: Chromium/Firefox/WebKit, ubuntu |
| `web-quality` | the doc-07 JS budget, then Lighthouse over the built site | ubuntu; shares one `build:web` |
| `test-e2e` | Doc-10 emulator suite over every proven console (`pnpm test:rom-e2e`) | ubuntu, source-built assemblers + libretro cores, cached |
| `gate` | the one required check: every job that ran must have passed | `if: always()`; a skipped job is a pass |
| `bench` | benchmark action vs. baseline | regression >25% fails |
| `build-artifacts` | build core/cli/web + smoke (`demake --version`, `prep` one fixture) | artifacts retained for the PR |
| `docs` | man page lint, docs-site build, link check | |

Full-corpus determinism + all-tier E2E run **nightly** (`nightly.yml`) rather than
per-PR (keeps PR CI < ~15 min); nightly failures open an issue automatically.

**The three engines are three jobs, not three Playwright projects.** Run inside
one job they were sequential — five and a half minutes, which was the entire
run's critical path while every other job had been finished for three. Sharding
does not weaken the doc-07 parity contract at all: every engine still runs every
spec, and `DEMAKE_BROWSERS` was already the supported way to name one.

**`test-e2e` runs only the `*.e2e.test.ts` suites.** It used to run `pnpm test`,
which re-ran the whole unit suite on the same runner image `test-unit` had
already run it on. No test outside a `*.e2e.test.ts` behaves differently for
having an assembler on `PATH`, so the second run proved nothing the first had
not.

### Affected-only gates

`tools/ci/affected.mjs` decides which of `test-unit`, `test-browser`,
`web-quality` and `test-e2e` a change can possibly break, and the rest are
skipped. Three things make that safe to rely on:

- **The graph is read, not written down.** Changed files map to packages, and
  the set is closed over its *dependents* using the `workspace:*` entries in the
  packages' own manifests (devDependencies included — `@demake/dmg` is only ever
  a test dependency of `@demake/demotic`, and can still turn that suite red).
  Giving a package a new dependency widens the gate on its own, the same reason
  `codegen/registry.ts` is the one list that says which consoles build. A
  hand-maintained `paths:` list is exactly what this must not become.
- **It fails open.** A path the script has never heard of, an unreadable
  manifest, a git that cannot answer — every one of those runs everything. Only
  paths *explicitly* classified as inert (`docs/`, `.changeset/`, the root
  Markdown) can turn a gate off, so a new top-level directory is loud rather
  than silent. Root configs, the lockfile and `.github/workflows/**` are not
  inert and never will be.
- **`main` is never gated.** A push passes no base ref, so every gate runs. The
  PR is what gets fast; the branch releases are cut from stays fully proven.

It is deliberately coarse. A package is affected if *any* file under it changed,
and a job is on or off as a whole — the unit suite is never narrowed to a subset
of its files, because `vitest.config.ts` aliases every `@demake/*` specifier to
source, so a test can import a package its own manifest does not declare.
File-level selection would rest on a graph that is not the real one; asking only
whether a package is in the closure cannot be wrong for that reason.

Be honest about what it buys, because it is not the wall clock: of the twelve
merges before it was written, eleven touched `@demake/web` or something it
depends on — and it depends on every package but the CLI — so eleven would have
run every gate anyway. What it saves is runner minutes on the narrow changes
(a CLI-only fix, a harness tweak, docs), and it keeps that saving as the graph
loosens. The wall clock came from sharding the browser job.

Because which jobs run is now a CI decision, branch protection requires the
single `gate` check rather than a list of job names that would need editing
whenever the matrix changes. GitHub counts a skipped job as a pass; `gate`
counts anything that is neither `success` nor `skipped` as a failure.

### `toolchains.yml` — weekly + on `toolchains/**` change

Builds the per-family Docker images (assemblers, compilers, emulators — all version-
pinned), pushes to GHCR by digest, and opens a PR bumping the digests consumed by CI
and `--rom-builder docker`. Emulator/toolchain upgrades are therefore ordinary
reviewed PRs that must pass the whole E2E suite.

License compliance: these images redistribute GPL/LGPL emulators and toolchains, so
each image embeds the license texts and exact source URLs/commits for every included
tool, and the Dockerfiles build-from-source where a project's license requires
source availability. A `LICENSES.md` per image is generated at build time; nothing
with a no-redistribution clause ships in an image (such tools stay local-install
only, detected via `PATH`).

### `pages.yml` — deploy web app

On push to `main` affecting `packages/{web,core}`: build → deploy to GitHub Pages
(environment `github-pages`, official actions). `main` is always live; releases tag
what Pages already serves.

### `release.yml` — tag-driven, fully automated

Versioning via **Changesets**: every user-visible PR adds a changeset; a bot PR
("Version Packages") accumulates them; merging it tags `vX.Y.Z` and triggers:

1. **Verify**: full CI including all-tier E2E on the tag.
2. **npm**: publish `@demake/core` + `demake` with `--provenance` (OIDC trusted
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
  throughout; `tools/ci/affected.mjs` so PR jobs run only the gates the change
  can break (§Affected-only gates).
