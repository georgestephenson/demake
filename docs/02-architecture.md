# 02 — Architecture

## Language decision: TypeScript core, everywhere

The web requirement ("runs the same tool in your local browser") makes the decision:
the conversion engine must run in the browser without a server. The realistic options
were:

| Option | Verdict |
|--------|---------|
| **TypeScript core** shared by Node CLI + browser | ✅ Chosen. One codebase, one behavior, native npm package, easiest contribution surface. |
| Rust core → native CLI + WASM for web | Best raw performance, but two build pipelines, harder contribution, and npm/browser interop friction. Kept as a *targeted optimization escape hatch*: individual hot kernels (k-means inner loop, error diffusion) may later be ported to Rust/WASM behind the same TS interface if profiling demands it. Not in v1. |
| Python core (like the original tools) + Pyodide for web | Pyodide is a ~10MB+ runtime download and CLI distribution of Python tools is notoriously painful. Rejected. |

Performance note: our images are tiny (≤ 512×512 out, sources typically ≤ 4K). Even
naive TS handles this in well under a second; optimized TS (typed arrays throughout,
no per-pixel object allocation) is plenty. See doc 04 §Performance.

## Monorepo layout

pnpm workspaces + a single TypeScript project-references build. One repo, one CI.

```
demake/          # repo
├── docs/                    # This plan, then living design docs
├── packages/
│   ├── core/                # @demake/core — the engine (zero Node/DOM deps)
│   │   ├── src/
│   │   │   ├── image/       # decode/encode, pixel buffers, color spaces
│   │   │   ├── pipeline/    # scaling, quantization, palette fitting, dithering
│   │   │   ├── consoles/    # one declarative spec file per console
│   │   │   ├── codegen/     # one backend per console family (asm/C/binary emit)
│   │   │   └── index.ts     # public API (doc 09)
│   │   └── test/
│   ├── cli/                 # demake — thin wrapper over core (doc 05)
│   │   ├── src/
│   │   └── man/             # generated roff, checked in per release
│   ├── demotic/             # @demake/demotic — the game language (docs 14, 15)
│   │   ├── src/
│   │   │   ├── lang/        # lex → parse → flat statement AST
│   │   │   ├── compile.ts   # AST + console profile → resolved Program tables
│   │   │   ├── sim.ts       # reference interpreter — the semantic definition
│   │   │   ├── testing/     # .test.dmt: parse + run assertions on every console
│   │   │   ├── codegen/     # the console backend: SM83 assembler, analysis, emitters (doc 14)
│   │   │   ├── rom/         # the built-in tile bank and the trace readers
│   │   │   └── demakefile/  # the build manifest: parse, resolve, emit (doc 15)
│   │   └── test/
│   ├── dmg/                 # @demake/dmg — our Game Boy core: the conformance harness
│   │                        #   (doc 10) and the web app's in-page player (doc 07)
│   ├── chip/                # @demake/chip — every sound chip as a register-driven model,
│   │                        #   plus the deterministic mixer/resampler (doc 16)
│   ├── audio/               # @demake/audio — the music + sound demakers (docs 16, 17, 18)
│   ├── web/                 # Vite app → GitHub Pages (doc 07)
│   ├── desktop/             # Tauri app, bundles CLI as sidecar (doc 08)
│   └── cli-spec/            # single-source-of-truth command spec → --help, man, docs, JSON schema
├── testdata/
│   ├── sources/             # HD many-color reference images (see doc 10)
│   └── golden/              # expected outputs per console per version
├── rom-harness/             # per-console minimal "display this image" ROM projects (doc 06/10)
├── toolchains/              # Dockerfiles for assemblers/compilers + emulators (doc 10)
├── .github/workflows/       # CI (doc 11)
├── CLAUDE.md  AGENTS.md  README.md  CONTRIBUTING.md  SECURITY.md  LICENSE
└── package.json  pnpm-workspace.yaml  tsconfig.json
```

### Dependency rules (enforced by lint)

- `core` depends on **nothing platform-specific**: no `fs`, no `Buffer`-only APIs, no
  DOM. All I/O happens at the edges (CLI/web/desktop pass `Uint8Array`s in and out).
- `demotic` depends on `core` (console specs, `prep` for art) and on nothing
  platform-specific — the same two lint rules apply, because its reference
  interpreter is the semantic specification a console runtime must match
  bit-for-bit (doc 14). **Nothing in `core` may depend on `demotic`**: the image
  engine stands alone, and the language is the layer above it.
- `dmg` depends on **nothing at all**, and is platform-pure on the same terms as
  `core`. It is an emulator, not conversion logic, and the direction of the
  dependency is what keeps that honest: `demotic` uses it in tests, `web` uses it
  to play a ROM, and neither ships a second implementation of anything. Nothing
  depends on it at run time except the page's cartridge pane.
- `chip` depends on **nothing at all**, on exactly `dmg`'s terms and for the same
  reason: it is a hardware model, not conversion logic. It is the one place a
  sound chip is implemented, so `dmg`'s APU, the audio pipeline's preview and the
  web app's player are the same synthesis rather than three that agree by
  coincidence (doc 16 §Packages).
- `audio` depends on `core` (console specs, math kernels, PRNG) and on `chip`,
  and on nothing platform-specific — its judge and its chip models decide what a
  user hears, so the same determinism rules apply, and more strictly: audio DSP
  reaches for transcendentals constantly and every one of them must come from the
  in-house kernels (doc 16 §Determinism engineering). **Nothing in `core` may
  depend on `audio` or `chip`**; `core` holds the `AudioSpec` *data* and no audio
  code.
- `cli` = argument parsing + file I/O + process conventions + calls into `core`.
- `web` = UI + Web Worker hosting `core`.
- `desktop` = UI shell + sidecar invocation of the built `cli` binary. It contains
  **no conversion logic at all** — that's what guarantees GUI/CLI parity.

## The core engine: data flow

```
            ┌────────────── prep ───────────────┐   ┌──────────── gen ────────────┐
 input      │                                   │   │                             │
 bytes ──► decode ──► normalize ──► scale ──► fit ──► CompliantImage ──► codegen ──► source/binary/ROM
 (any fmt)  │  RGBA float, linear/Oklab         │   │  (pixels + palettes +       │
            └───────────────────────────────────┘   │   tile map + console spec)  │
                                                    └─────────────────────────────┘
```

The central internal type is `CompliantImage`: indexed pixels, the fitted
sub-palettes, the per-tile (or per-attribute-cell) palette assignment, and the
console spec it satisfies. It has two serializations:

1. **PNG** — the human-facing output of `prep` (indexed PNG where possible). A
   compliant PNG is *self-sufficient*: `gen` can re-derive full compliance from
   pixels alone via the exact-path detector (as `gen-portraits.py` does).
2. **Sidecar JSON** (`--emit-manifest`) — palettes, assignments, and provenance
   (tool version, options, source hash), so `gen` can skip re-fitting and downstream
   tools/agents can introspect results.

## Image codecs and determinism

Decoding must be **identical** on Node and browser — we cannot use the browser's
`<canvas>` decoder (JPEG decoding varies across engines) or platform-native
libraries (sharp). Therefore:

- **PNG**: pure-TS decode/encode (lossless, so any correct decoder is identical;
  we still ship one implementation to control ancillary-chunk and bit-depth
  handling). We write our own encoder to control palette ordering and to emit
  properly indexed PNGs.
- **SVG**: our own rasteriser, for the same reason and a stronger one — a host
  rasteriser antialiases how it likes, so two engines disagree in the low bits of
  every edge pixel. The subset is shapes, paths, gradients and strokes; curves
  flatten at a fixed subdivision count rather than an adaptive tolerance, because
  an adaptive one compares a float against a threshold and can subdivide
  differently on either side of a 1-ulp difference. Anything outside the subset
  fails by name rather than rendering as nothing.
- **JPEG / WebP / GIF / BMP**: pinned WASM codecs (the jSquash/Squoosh codec builds)
  used identically on both platforms. WASM is bit-deterministic by spec.
- **Audio (MP3 / AAC / Vorbis / Opus)**: pinned WASM decoders on the same
  reasoning; WAV/AIFF/FLAC are integer formats and get pure-TS codecs. Resampling
  is ours, never the platform's — a browser `AudioContext` resamples on its own
  terms, which is the audio form of the `<canvas>` decoder trap (doc 16 §The
  render contract).
- All randomized algorithms (k-means init, annealing) use a seeded PRNG
  (PCG32/xoshiro, our implementation) with a fixed default seed; `--seed` overrides.
- **Floating-point discipline**: IEEE-754 basic ops (+, −, ×, ÷, sqrt) are
  bit-exact across engines, but `Math.pow/exp/log/cbrt/sin…` are *not* — JS engines
  ship different transcendental implementations. The Oklab transform needs `cbrt`,
  gamma needs `pow`. The core therefore ships its own deterministic math kernels
  for every transcendental it uses (correctly-rounded or fixed-polynomial
  implementations), and the lint rules ban `Math.*` transcendentals in `core`
  alongside `Math.random`/`Date.now`. Without this, "byte-identical across
  browsers" is a lie at the 1-ulp level that k-means then amplifies into different
  palettes.

Determinism is enforced by CI: the same conversion runs on Node (Linux/macOS/
Windows) and in headless Chromium + Firefox, and outputs must be byte-identical
(doc 10 §Determinism tests).

## Extensibility model

Adding a console = adding two files and fixtures:

1. `core/src/consoles/<id>.ts` — a declarative `ConsoleSpec` (doc 03 defines the
   schema): resolutions, master palette / DAC model, tile geometry, sub-palette
   shape, attribute granularity, VRAM/tile budgets, sprite-vs-bg capabilities.
   The *generic* pipeline consumes this; consoles do not get custom quantizers
   unless the spec genuinely can't express a constraint (e.g. Atari 2600
   per-scanline kernels get a dedicated strategy hook, doc 04 §Special cases).
2. `core/src/codegen/<family>.ts` — emits native data + display source (doc 06).
3. `rom-harness/<id>/` + toolchain Dockerfile + golden fixtures → the console is
   only "supported" when its emulator screenshot test passes (doc 10).

This is the load-bearing design idea carried over from the predecessor tools: *the
constraint model is data, the optimizer is generic.* `prep-portraits.py` hard-coded
"3 palettes × 4 colors, 7×7 tiles of 8×8, RGB555"; here that is one `ConsoleSpec`
instance among thirty.

## Distribution map

| Surface | Artifact | Channel |
|---------|----------|---------|
| Library | `@demake/core` (ESM + types) | npm |
| CLI | `demake` (bin wrapper on npm) | npm (`npm i -g`, `npx demake`) |
| CLI | standalone single-file binaries (Node SEA or Bun compile), linux-x64/arm64, macos-x64/arm64, windows-x64 | GitHub Releases; Homebrew tap later |
| Web | static site | GitHub Pages via Actions |
| Desktop | Tauri bundles (.dmg, .msi/.exe, .AppImage/.deb) with CLI sidecar | GitHub Releases |

All five artifacts are built from the same tagged commit by the release workflow
(doc 11) and embed the same version string.
