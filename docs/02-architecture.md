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
retro-game-art-maker/
├── docs/                    # This plan, then living design docs
├── packages/
│   ├── core/                # @retroart/core — the engine (zero Node/DOM deps)
│   │   ├── src/
│   │   │   ├── image/       # decode/encode, pixel buffers, color spaces
│   │   │   ├── pipeline/    # scaling, quantization, palette fitting, dithering
│   │   │   ├── consoles/    # one declarative spec file per console
│   │   │   ├── codegen/     # one backend per console family (asm/C/binary emit)
│   │   │   └── index.ts     # public API (doc 09)
│   │   └── test/
│   ├── cli/                 # retroart — thin wrapper over core (doc 05)
│   │   ├── src/
│   │   └── man/             # generated roff, checked in per release
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
- **JPEG / WebP / GIF / BMP**: pinned WASM codecs (the jSquash/Squoosh codec builds)
  used identically on both platforms. WASM is bit-deterministic by spec.
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
| Library | `@retroart/core` (ESM + types) | npm |
| CLI | `retroart` (bin wrapper on npm) | npm (`npm i -g`, `npx retroart`) |
| CLI | standalone single-file binaries (Node SEA or Bun compile), linux-x64/arm64, macos-x64/arm64, windows-x64 | GitHub Releases; Homebrew tap later |
| Web | static site | GitHub Pages via Actions |
| Desktop | Tauri bundles (.dmg, .msi/.exe, .AppImage/.deb) with CLI sidecar | GitHub Releases |

All five artifacts are built from the same tagged commit by the release workflow
(doc 11) and embed the same version string.
