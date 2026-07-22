---
"@demake/core": minor
"demake": minor
---

Phase 1 — engine spine and the first consoles (Game Boy Color + Game Boy).

The conversion engine is now real. Highlights:

- **Deterministic foundation**: in-house math kernels (exp/log/pow/cbrt/sin built
  from basic IEEE-754 ops), a seeded PCG32 PRNG, sRGB↔linear↔Oklab color science,
  and hardware-lattice snapping — everything byte-reproducible across engines.
- **Image layer**: a pure-TypeScript PNG codec (full inflate + deterministic
  stored-block deflate, decode/encode) and DAC models (CGB LCD curve, DMG green
  ramp). JPEG/WebP/GIF/BMP report a typed "unsupported yet" error pending WASM
  codecs.
- **Consoles**: the `ConsoleSpec` schema plus `gbc` and `dmg` specs, with primary
  hardware-source citations and a registry with alias resolution.
- **Pipeline (`prep`)**: stages 0–7 for tiled RGB-lattice consoles — normalize,
  analyze, geometry (majority/box/lanczos3/nearest), Oklab k-means quantization,
  the alternating-refinement layout fitter with deterministic restarts,
  cell-aware dithering, tile-budget enforcement, and DAC-decoded encode — run as
  a deterministic tournament scored by a multi-metric judge. A dedicated mono
  path handles the DMG.
- **`inspect` + `judge`**: an independent compliance oracle and the tournament's
  own fidelity scorer, both public API and CLI surfaces.
- **CLI**: `prep`, `inspect`, and `consoles` wired to the engine, driven by the
  new `@demake/cli-spec` single-source-of-truth (parser + `--help` + generated
  man pages), with UNIX-compliant stdin/stdout, `--json`, exit codes, and atomic
  writes.

This is the initial engine output; being a minor per the output-stability policy
(doc 09), later algorithm changes that alter output bytes bump the minor again.
