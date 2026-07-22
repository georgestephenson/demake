# 04 — Conversion Pipeline (`prep`)

This is the heart of the product: any image → the best image the target hardware can
display. It generalizes the predecessor `prep-portraits.py` pipeline (denoise → majority
downscale → constrained palette fit → RGB snap) with modern color science and a
constraint-driven optimizer. Every stage is deterministic (seeded) and individually
overridable from the CLI; defaults are chosen automatically from source analysis.

```
decode → analyze → geometry (crop/scale) → global quantize (master palette / lattice)
       → layout fit (sub-palettes × tiles/cells/scanlines) → dither+remap
       → tile-budget enforcement → DAC snap → encode (+manifest)
```

## Stage 0 — Decode & normalize

- Decode to RGBA float32, un-premultiplied. Alpha handling: composite over a
  configurable matte (`--background '#000'`, default: checker-detect → black), or map
  to the console's transparent index when the layout has one (`--keep-transparency`).
- Color-manage: honor embedded ICC/gAMA where present, convert to linear-light sRGB.
  All resampling and averaging happens in **linear light**; all perceptual distance
  happens in **Oklab** (see §Color distance).

## Stage 1 — Source analysis (drives defaults)

Cheap statistics decide the default strategy; every decision is printed with
`--verbose` and overridable:

- **Pixel-art detector**: unique-color count, edge-alignment autocorrelation
  (detects upscaled pixel art and its scale factor), gradient histogram. Result:
  `art` vs `photo` profile.
- `art` profile → nearest/majority scaling, no dither by default (matches
  `prep-portraits.py`'s philosophy: never invent blend colors), master-palette
  denoise pass first (median-cut+k-means to ≤N colors to collapse anti-aliasing —
  the predecessor Step 1, kept as-is).
- `photo` profile → Lanczos3-in-linear downscale, error-diffusion dither by default.

## Stage 2 — Geometry

- **Explicit size** (`--size WxH`): scale to fit exactly (policy: `--fit
  contain|cover|stretch|pad`, default `contain` with padding color/transparent).
- **No size given** (the specified default behavior):
  1. If source dimensions are displayable on the console (≤ max res, satisfies any
     width-granularity rules), keep them 1:1.
  2. Otherwise scale down to the **largest displayable size preserving aspect
     ratio**, rounding to the console's tile granularity (e.g. multiples of 8),
     never upscaling.
- **Pixel aspect ratio**: `--par auto` compensates for non-square hardware pixels
  (e.g. 320×224 MD on a 4:3 CRT) so the image looks right on real hardware;
  `--par square` (default) does naive square-pixel math. Both are exact and
  documented — CRT-correctness is a user choice, not magic.
- Downscale kernels: `majority` (per-block modal color, mean-nearest tiebreak — the
  predecessor method, default for `art` at integer ratios), `lanczos3`, `mitchell`,
  `box`, `nearest`. Non-integer `art` downscales get content-aware two-step:
  nearest to the detected original pixel grid, then majority.

## Stage 3 — Global color quantization

Target: an intermediate "working palette" of the *total* colors the layout could
ever show (e.g. GBC bg: up to 32; NES: up to 13; MD: up to 61; SNES mode 3: 256).

- **RGB-lattice consoles** (GBC/SNES/MD/GG/…): weighted k-means in Oklab, initialized
  by Wu's quantizer (better than plain median cut; median cut kept as `--quantizer
  mediancut` for parity with the original tools). Cluster centers are constrained to
  the hardware lattice at every iteration (snap-to-RGB555/333/444 inside the loop,
  not after — avoids post-hoc drift, the same reason `prep-portraits.py` snaps then
  remaps).
- **Fixed-master consoles** (NES/TMS/2600/7800): k-medoids over the master palette —
  centers *are* master entries by construction. Perceptual distance uses the
  console's DAC model (NES NTSC decode, TMS levels) so we match what the screen
  shows, not the naive RGB triplets.
- Importance weighting: saliency map (contrast + center-prior, cheap) multiplies
  pixel weights so faces/subjects keep color fidelity over backgrounds;
  `--no-saliency` disables.

## Stage 4 — Layout fitting (the hard part)

The constrained assignment problem: partition working colors into the console's
sub-palette structure and assign each attribute cell one sub-palette.

Generic tiled solver (GBC, NES, SNES m1, MD, PCE, WSC, NGPC, GBA m0…):

1. Build per-cell color histograms in Oklab (cell = attribute granularity: 8×8 tile
   on GBC/MD, **16×16 block on NES** — this is why cell ≠ tile in the model).
2. **Init**: k-means the cells (feature = histogram signature) into `P` groups;
   median-cut each group to `K` colors (this is `gen-portraits.py`'s lossy path,
   used as the seed).
3. **Alternating refinement** (the `prep-portraits.py` core, generalized):
   assign each cell to the palette minimizing its remap error → refit each palette
   by weighted k-means over its assigned cells' pixels (lattice-constrained) →
   repeat to convergence.
4. **Restarts + perturbation**: `R` deterministic restarts (default 8, `--effort`
   scales it) with jittered inits; keep the min-error result. `--effort max` adds a
   simulated-annealing pass that moves single colors between palettes and re-splits
   the worst cell cluster — this is the main quality lever over the original tools.
5. Shared-color rules from the spec are honored inside the fit: NES's single shared
   backdrop color is chosen globally (most-used dark/background candidate) before
   per-palette fitting; transparent index 0 on MD/SMS/GBC-obj reserves a slot.
6. **Index-order post-pass**: within each palette, order colors dark→light (the
   `gen-portraits.py` DMG-coherence trick, generalized: stable cross-palette
   luminance ordering helps consoles with shared-index semantics and makes
   deterministic diffs readable).

Mode selection: when a console has several modes (SNES 1/3/7, GBA 0/4/3, ANTIC),
`--mode auto` runs the cheap seed fit for each candidate, scores perceptual error +
budget feasibility, and picks; `--mode <name>` forces.

## Stage 5 — Dithering & remap

- Remap each pixel through its cell's palette; error metric = Oklab ΔE (with the
  original tools' channel-weighted RGB kept as `--metric wrgb` for reproducing old
  outputs).
- Dither options: `none` (art default), `bayer2|4|8` (ordered, retro-authentic),
  `floyd-steinberg` serpentine (photo default), `atkinson`, `riemersma`; strength
  0–100. Error diffusion is **cell-aware**: error never diffuses across a palette
  boundary into a cell that can't represent it (prevents the classic smearing
  artifact at attribute edges).

## Stage 6 — Tile-budget enforcement

For consoles with unique-tile limits (NES 256; MD/SNES VRAM; GB banks): count unique
tiles after remap; if over budget, iteratively merge the closest tile pair
(perceptual distance on decoded tiles, flip-aware where hardware supports H/V flip —
MD/SNES/GBC do, NES BG does not) and re-point the map, until within budget. Report
the merge count in the manifest; `--strict` errors instead of merging.

## Stage 7 — DAC snap & encode

- Final palette values snapped to hardware lattice (already true by construction)
  and *previewed* through the DAC model (GBC LCD curve — the CGB expansion the
  original tool used —, NES NTSC decode, MD 3-bit DAC ramp). Output PNG stores
  **DAC-decoded sRGB** by default (looks right everywhere) with the raw hardware
  values in the manifest; `--raw-colors` stores naive expansion instead. The choice
  is recorded, and doc 10's emulator comparison consumes the same DAC model.
- Encode indexed PNG (bit depth = smallest that fits), palettes ordered as fitted;
  optional `--emit-manifest out.json`.

## Special-case strategies (non-tiled layouts)

- **TMS9918 Graphics II (SG-1000/Coleco/MSX-family)**: per-8×1 row pair-coloring.
  Dedicated solver: for each 8×1 strip choose the 2 master colors minimizing strip
  error (exhaustive over 15×14 pairs — trivial), with an optional smoothness prior
  between vertically adjacent strips.
- **Atari 2600**: target = a chosen display kernel, each modeled as a spec:
  `playfield40` (40×192, 1 fg+1 bg color per line, mirrored/asymmetric),
  `sprite48` (48×~192, 1 color per line, the "six-digit" kernel). Solver: per
  scanline, optimal 1–2 color selection + thresholding; vertical color coherence
  prior to avoid stripe flicker. Honest about results: this is the console where
  "largest feasible image" does the heavy lifting.
- **Atari 7800 display lists / Lynx & GBA/DS framebuffers / per-scanline palette
  reloads**: framebuffer paths reduce to Stages 3+5 with per-scanline palette
  scheduling as an optional enhancement (`--scanline-palettes`), solved greedily
  scanline-by-scanline with a palette-change budget.
- **Mono ramps (DMG, Virtual Boy, WS, Pokémon Mini…)**: luminance mapping with
  auto-contrast (percentile stretch), gamma-correct 4-level (or 2-level) split,
  optional dither; ramp rendered through the platform tint (green LCD, red LED)
  for preview.

## Color distance — one section because it decides quality

- Working space **Oklab** (cheap, perceptually uniform, well-behaved for k-means
  means). ΔE = weighted Euclidean in Oklab with L-weight slightly >1 for `art`
  profile (protects contrast/edges) — calibrated in Phase 2 against a small human-
  judged fixture set, then frozen.
- All distances computed on **DAC-decoded** colors so "what the hardware shows" is
  what we optimize.
- The predecessor weighted-RGB metric (R2/G4/B3) is retained as `--metric wrgb` for
  byte-reproducing legacy outputs in tests.

## Performance targets

- 4K photo → any Tier 1 console, default effort: **< 1 s** in Node on a laptop,
  < 3 s in-browser (worker). `--effort max`: < 15 s.
- Implementation rules: `Float32Array`/`Uint8Array` throughout, histograms not
  per-pixel loops where possible, no allocation inside inner loops, benchmarks in CI
  (doc 11) with regression thresholds.

## Prior art to beat (and steal from)

Benchmarked against during Phase 2, quality-fixture based: ImageMagick `-remap`,
libimagequant/pngquant (global quant quality bar), superfamiconv & Tilemap Studio
(SNES/GB tiling bar), img2gba/grit (GBA bar), and the original predecessor outputs
(which we must match-or-beat on their own portrait corpus — that corpus becomes a
permanent quality fixture).
