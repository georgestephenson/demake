# 11 — CI & Release Pipelines (GitHub Actions)

## Workflows

### `ci.yml` — every PR and push to `main`

| Job | What | Notes |
|---|---|---|
| `changes` | which gates this change can break (see §Affected-only gates) | no install, no build; ~10 s |
| `lint` | eslint (incl. custom rules: no `Math.random`/`Date.now`/platform APIs in core), prettier check, typecheck (project references), `cli-spec` regeneration diff check | fast-fail; **never gated** |
| `test-unit` | Vitest unit + property + golden suites, coverage upload | **4 shards**; Node 22 × ubuntu on a PR, Node 22/24 × ubuntu/macos/windows on `main` (see §The unit matrix) |
| `test-browser` | Playwright: web build determinism + functional | **one job per engine × 2 shards**: Chromium/Firefox/WebKit, ubuntu |
| `web-quality` | the doc-07 JS budget, then Lighthouse over the built site | ubuntu; shares one `build:web` |
| `test-e2e` | Doc-10 emulator suite over every proven console (`pnpm test:rom-e2e`) | ubuntu, source-built assemblers + libretro cores, cached |
| `gate` | the one required check: every job that ran must have passed | `if: always()`; a skipped job is a pass |
| `bench` | benchmark action vs. baseline | regression >25% fails |
| `build-artifacts` | build core/cli/web + smoke (`demake --version`, `prep` one fixture) | artifacts retained for the PR |
| `docs` | man page lint, docs-site build, link check | |

Full-corpus determinism + all-tier E2E run **nightly** (`nightly.yml`) rather than
per-PR; nightly failures open an issue automatically. A PR's own target is
**under ten minutes**, which is what the shard counts above are set to hold: it
was 20m 47s when the unit suite ran as one job, and the two longest things on the
board are now a shard of that suite and a shard of Firefox.

**The three engines are three jobs, not three Playwright projects.** Run inside
one job they were sequential — five and a half minutes, which was the entire
run's critical path while every other job had been finished for three. Sharding
does not weaken the doc-07 parity contract at all: every engine still runs every
spec, and `DEMAKE_BROWSERS` was already the supported way to name one.

**And two shards per engine**, which is what that job needed once the unit suite
stopped being the critical path: Firefox alone was 14m 36s of a 20m 47s run,
WebKit 11m 49s, Chromium 8m 06s. Playwright shards *tests* rather than files when
`fullyParallel` is set, and `determinism.spec.ts` is a test per console with a
backend — a dozen cases of roughly equal cost, which is the shape a shard divides
best. Unlike the unit suite there is no long single file to floor it, so what
limits the count here is the browser install each shard repeats.

**`test-e2e` runs only the `*.e2e.test.ts` suites.** It used to run `pnpm test`,
which re-ran the whole unit suite on the same runner image `test-unit` had
already run it on. No test outside a `*.e2e.test.ts` behaves differently for
having an assembler on `PATH`, so the second run proved nothing the first had
not.

### The unit matrix

**Node 22 and 24, not 20 and 22.** Node 20 reached end-of-life on 2026-04-30, so
half the matrix was proving an unsupported runtime while the current active LTS
was untested. The floor in every `engines` field moved to `>=22` in the same
change, because a matrix that does not test a version is not a version the
project supports.

**Three operating systems on `main`, one on a pull request.** The same split
`affected.mjs` already runs on, for the same reason: the PR is what gets fast and
the branch releases are cut from stays fully proven. What macOS and Windows catch
is path handling and line endings at the edges — real, and still caught on the
merge to `main` before anything ships. What they cost on a PR is the whole run,
because Windows is the slowest runner and this is the longest job on it.

**Node 22 on a pull request, both versions on `main`.** The operating-system
split's argument applied to the other axis: what the second runtime catches is a
change in its own behaviour under code that is otherwise identical, which is a
`main` concern rather than a per-commit one. It does not shorten a run — the two
jobs were always parallel — it halves what the longest job on the board costs to
run.

**And the run is only ever as long as the slowest single test file**, which is
worth knowing before optimising anything else here. Vitest schedules a *file* to
a worker, so one long file pins one core and idles the rest: `audio.test.ts` was
777 s of an 836 s suite until it was split per console (`_audio-battery.ts`), and
`parallel.test.ts` 454 s until the same (`_fanout.ts`). Neither split changed a
single assertion. If this job is slow again, look for the file that is minutes
long before reaching for a matrix dimension or a shard count.

### Sharding

That split is also what made sharding worth anything, and the note here used to
say the opposite — correctly, at the time. `--shard` distributes *files*, so it
cannot help a suite whose floor is one of them, and this suite's floor was
`audio.test.ts` at 777 s of 836. Split per console, the floor is a few minutes
and the total is what dominates: measured at **45 core-minutes over 4 runner
cores**, which is 20m 04s of a 20m 47s run and every other job finished long
before it.

So the unit job runs **four shards**. Two things are worth knowing before
changing that number:

- **The split is by SHA-1 of each file's path, so it is arbitrary rather than
  balanced.** The shards do not take equal times and the job costs whatever the
  slowest one does. Modelled on measured per-file durations, four shards came out
  9.4 / 4.1 / 20.3 / 11.3 core-minutes — better than one shard by a factor of two
  even at that spread, and it re-randomises whenever a file is added or renamed.
- **Every shard pays the setup again** — checkout, install, `pnpm build` — which
  is about 55 s. Past four, that starts to dominate what is left of the tail.

The suite also **shares demade art between its worker processes** for the length
of one run, which is a different attack on the same cost: a test file is a
process, so the same fixture was being fitted from scratch in each of the twenty-odd
files that build one, measured at a fifth of all the conversion time a run spends.
`packages/demotic/test/_art-store.ts` is that store; doc 10 §The conversion store
covers why it cannot be wrong quietly and which battery has to opt out of it.

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
