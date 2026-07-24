# 04 — Conversion Pipeline (`prep`)

This is the heart of the product: any image → the best image the target hardware can
display. It generalizes the predecessor `prep-portraits.py` pipeline (denoise → majority
downscale → constrained palette fit → RGB snap) with modern color science and a
constraint-driven optimizer.

There is no single algorithm that wins on every (image, console) pair — a majority-
vote downscale that's perfect for pixel art destroys a photo; dithering that rescues
a gradient on the NES ruins flat-color art on the GBC. So the default behavior is a
**tournament**: run several locally-optimal candidate strategies in parallel, score
every output with a multi-metric judge against the source, disqualify anything
invalid or glitchy, and keep the winner. (Where a constraint subproblem *does* have
a globally optimal algorithm — e.g. exhaustive TMS9918 row-pair selection, optimal
per-line color choice on the 2600 — there is exactly one candidate for that
dimension and no tournament is wasted on it.)

```
decode → analyze ─┬─ candidate A ─ (geometry → quantize → fit → dither → budget → DAC) ─┐
                  ├─ candidate B ─ ( … different stage choices … )                      ├─ judge ─ winner → encode (+manifest)
                  └─ candidate N ─ ( … )                                                ┘
```

Every stage and the judge are deterministic (seeded); the candidate set is a pure
function of (source analysis, console, options), so the tournament as a whole is
deterministic too. The stages below are the **stage library** candidates are
composed from; each is individually forcible from the CLI.

## The tournament

**Candidates.** A candidate = a named, complete assignment of stage choices: scale
kernel × quantizer × fitter variant × dither (alg, strength) × video mode × metric
params. Candidates are drawn from a curated portfolio (not the full cross-product):
each entry exists because it wins somewhere, e.g. `art-majority-flat` (majority
scale, no dither, hard palette fit — the predecessor recipe), `photo-lanczos-fs`
(Lanczos, Wu init, serpentine Floyd–Steinberg), `photo-bayer-crt` (ordered dither
tuned for CRT-era look), `gradient-scanline` (per-scanline palette scheduling where
hardware allows), plus console-specific entries (NES: backdrop-dark vs
backdrop-dominant seeding; SNES/GBA: one candidate per plausible video mode).
**Grading is a candidate dimension, not a policy** (§The objective): variants
that apply a bounded pre-quantization grade — L percentile stretch, chroma
boost, optionally a hue-shifted ramp build — enter the portfolio alongside the
ungraded ones, and the grade-aligned judge picks per image. The mono path's
percentile auto-contrast is the long-standing special case of this, now
generalized; on already-economical sources the ungraded candidate keeps winning
by construction (grading gains nothing, absolute metrics prefer untouched), so
round-trip idempotence is preserved without a special case.
Portfolio size scales with `--effort`: `fast` = single analysis-picked candidate
(no tournament), `default` = pruned portfolio (~4–8), `max` = full portfolio plus
annealing refinement of the top finishers.

**Execution.** Two rounds keep cost sane: every candidate runs a cheap seed pass →
judge scores → bottom half pruned → survivors run full refinement (restarts,
annealing) → final judging. Candidates share work via stage-DAG memoization (same
decode/analysis always; same geometry or quantize results reused when choices
coincide). Candidates run on a worker pool (Node `worker_threads` / Web Workers);
scheduling order cannot affect results (pure functions + deterministic final
ranking).

**User control** (doc 05 has the flag table):

- `--strategy auto` — the tournament. Default.
- `--strategy <name>` — run exactly one named candidate, no judging overhead.
- `--strategy list` — enumerate candidates for a console (also in `consoles --json`).
- Explicit stage flags (`--dither`, `--scale`, `--mode`, …) don't disable the
  tournament — they **constrain the portfolio** to candidates matching the pinned
  choice. Pinning every dimension degenerates to a single candidate naturally.

**Reporting.** The tournament is **invisible by default**: the CLI contract stays
one image in, one image out (doc 05), and only the winner is emitted. The
scoreboard — winner, per-candidate scores, per-metric breakdown — appears only
under `--json` / `-v` (and in the web/desktop UI). An agent (or user) can inspect
it and pin `--strategy <winner>` for fast reproducible re-runs.

## The judge

### The objective: perceived equivalence, not per-pixel closeness

The judge's job is to answer "does the output *read* as the original to human
eyes within this console's palette budget?" — **not** "how far did each pixel
move?" Those two objectives agree when the hardware is generous and diverge
hard when it is not, and where they diverge, per-pixel closeness is the wrong
one. This section is a deliberate reversal of the project's original
per-pixel-ΔE framing, made after the Phase-2 eval battery showed metric/eye
inversions (below).

Three principles, in priority order:

1. **Separation beats accuracy.** When N source colors must become K ≪ N, the
   perceived loss is *regions that were distinct becoming indistinguishable* —
   lost boundaries, lost shape, lost depth — not the absolute displacement of
   any pixel. Given the choice between two palette entries that are each
   individually closer to their regions but nearly identical to each other, and
   two entries that are further from their regions but clearly distinct, the
   distinct pair reads better. Every centroid-optimal quantizer picks the first
   pair; period pixel artists always picked the second.
2. **A coherent grade is (nearly) free.** Human vision adapts to bounded,
   globally coherent transforms — a monotone lightness curve, a global chroma
   gain, a smooth lightness-dependent hue drift (the pixel-art "hue shifting"
   doctrine: shadows cooler, highlights warmer). Exaggerating tonal range and
   saturation to spend a tiny palette well is exactly what period artists did,
   and the mono path's percentile auto-contrast has always done it in this very
   pipeline. The judge therefore scores outputs *modulo an allowed grade*:
   a bounded coherent grade costs little; incoherent error (hue swaps, region
   merges, banding, speckle) costs full price. The grade must stay bounded —
   monotone L, limited gain, limited chroma boost, smooth limited hue drift —
   so brand colors and reference-matched art can't silently walk away.
3. **Pressure scales the tradeoff.** How much (1) and (2) matter is a function
   of **palette pressure** — how far the console's affordable color count falls
   short of the source's tonal/chromatic diversity. At high pressure (SMS
   RGB222 from a photo, DMG's 4 shades) the relational metrics dominate and
   absolute ΔE fades to a tie-breaker. At zero pressure (already-compliant or
   authored-economical art) absolute fidelity dominates and grading is
   disallowed — round-trips must stay idempotent. The weights slide with
   pressure; they are not a fixed compromise.

Evidence (Phase-2 eval battery, sheets in `tools/prep-eval/out/`): a bounded
pre-quantization grade (L percentile stretch + chroma boost) produced clearly
better conversions of photographic and gradient-heavy sources on SMS and GBC —
while the per-pixel judge of the time scored them *lowest* of the candidates;
the same grade visibly damaged already-authored pixel art, which is the
zero-pressure case above. Research anchors for this objective: TMQI's
structure-plus-naturalness scoring for tone-mapped HDR (fidelity measured
tolerant of global tone change), the CIE 156 gamut-mapping evaluation
tradition (observers prefer preserved saturation/contrast over minimum ΔE),
SSIM's contrast component (normalized, hence tolerant of coherent contrast
change), and pixel-art ramp doctrine (hue-shifted, contrast-exaggerated ramps
as the craft's standard tool).

Scores each candidate's output against the source. Three parts, in order:

**1. Validity gates (disqualification, not scoring).** The doc-10 compliance oracle
(`inspect`) must pass — palette/cell/budget violations disqualify. Glitch detectors
also disqualify: degenerate palettes (duplicate/unused slots when colors were
dropped), NaN/out-of-lattice values, empty output, attribute-cell tearing (a cell
whose remap error is a statistical outlier vs its neighbors — the classic "one tile
went wrong" artifact), and tile-merge overrun beyond the requested budget. A
disqualified candidate is reported with its reason; if *all* candidates are
disqualified that's an internal error (`E_NO_VALID_CANDIDATE`), never a silent bad
output.

**2. Perceptual metrics.** Computed between the result rendered in the console's
**author space** (see §Color distance) and a fixed reference: the source
downscaled to output dimensions — fixed regardless of the candidate's own
kernel, so no candidate can game the reference. The reference kernel is fixed
*per profile*: `photo` uses Lanczos3 in linear light; `art` uses the blend-free
majority kernel, because a low-pass reference would penalize exactly the
crispness flat art wants (calibrated on the Phase-2 eval battery — AA'd pixel
art judged against a Lanczos reference selects blurry winners). Each metric is
also computed on a σ=0.5px Gaussian-integrated variant of both images ("viewing
distance" pass) so ordered/diffused dither is credited for the color it
simulates, not just penalized as noise.

Metrics come in two groups, per §The objective. **Relational metrics** measure
what the eye reads — separation, structure, ordering — and are invariant (or
asymmetric: loss punished, bounded gain tolerated) under the allowed grade;
they carry the weight at high palette pressure:

| Relational metric | Captures |
|---|---|
| **Grade-aligned Oklab ΔE** (mean + p95) | residual error after fitting the best *allowed grade* (isotonic monotone L curve + single bounded chroma gain + smooth bounded L-dependent hue drift) from reference to output — a coherent exaggeration is nearly free, incoherent color error costs full price |
| **Separation retention** (asymmetric) | for pairs of dominant source region colors: penalize when the output's pair distance *shrinks* (regions merging — the real quantization damage); expansion is free up to the naturalness bound |
| Asymmetric local contrast (SSIM-style c-term) | flattening penalized (σ_out < σ_ref); bounded expansion tolerated |
| Ordering / ramp monotonicity (rank correlation of local L) | shading ramps keep their light-to-dark ordering — invariant to any monotone tone curve by construction |
| Gradient-map correlation (Sobel, L) | edge/silhouette clarity (correlation is scale-invariant, so already grade-tolerant) |
| MS-SSIM (L channel) | structural preservation |
| Phantom-edge rate | dither speckle / fit seams on neighbor pairs the source keeps flat (real edges don't count) |

**Absolute metrics** anchor the output to the source's actual colors and bound
the grade; they dominate at low palette pressure and act as guardrails at high:

| Absolute metric | Captures |
|---|---|
| Raw Oklab ΔE (mean + p95) | plain closeness — the tie-breaker, and the ruler at zero pressure (round-trip idempotence) |
| Chroma-weighted hue error (residual after allowed drift) | hue rotations (blue→teal, yellow→orange) beyond the doctrine-style drift budget |
| Symmetric chroma ratio | gamut retention — washout *and* garish over-saturation |
| **Palette recall** | each dominant source color has a reasonably close match among the colors the output actually uses, in absolute space — brand colors and reference-matched art can't silently walk away |
| Naturalness bounds | L clipping beyond a few percent, chroma gain beyond ~1.6×, grade curves hitting their bounds — the "this stopped being a grade" detectors |

Implementation status: everything above is live except MS-SSIM and the
σ=0.5px viewing-distance pass. The allowed-grade fit currently covers the
monotone L curve + chroma gain; the bounded L-dependent *hue drift* is not yet
fitted (the graded candidates don't build hue-shifted ramps yet, so there is
nothing to forgive) — it lands with the hue-shifted-ramp candidate. The
separation-aware *fitting* term (§Stage 3) is likewise still planned; today
separation is enforced by the judge choosing between candidates.
| Banding index (false-contour detector on smooth ramps) | posterization |
| High-frequency energy ratio | fine detail/text survival |
| **Highlight retention** | detect distinct extreme features in the source (local L/chroma maxima, small area, high local contrast — specular dots, rim light, catchlights); score their *existence and contrast* in the output, area-independent, so losing a 6-pixel highlight costs as much as losing a large region |
| **Outline preservation** | dark contour lines (pixel art's signature) stay connected and stay darkest-in-neighborhood |
| **Ramp coherence** | output palettes organize into clean luminance ramps (monotone L steps, stable hue drift) the way hand-built pixel-art palettes do — a proxy for "reads as deliberately shaded" vs "reads as quantized" |

**3. Aggregation.** Metrics are normalized to [0,1] against fixed anchor values and
combined by **weighted geometric mean** — geometric, so one catastrophic metric
tanks the aggregate and can't be averaged away. Weight sets are per-profile
(`art` weights separation/structure/flatness; `photo` weights ΔE/SSIM/gamut),
per-console-class (mono ramps re-weight to L-only metrics), and — per §The
objective — slide with **palette pressure**: a deterministic scalar computed
from (source color diversity ÷ the layout's affordable distinct colors) that
shifts weight from the absolute group to the relational group as the budget
tightens. DMG-from-photo judges almost entirely on separation, ordering and
structure; GBC round-tripping authored art judges almost entirely on absolute
fidelity. Weights and the pressure curve are calibrated in Phase 2 against the
eval battery (with human eyes on the sheets — `pnpm eval:prep`), then frozen
and versioned; changing them is an output-affecting minor release like any
algorithm change. Ties break deterministically by candidate ID order.

The judge is exposed, not internal: `demake inspect <result> --source <src>
--json` scores any image pair with the same metrics (doc 05), and the library
exports `judge()` (doc 09) — so tests, agents, and users can measure exactly what
the tournament measured.

## Aesthetics is a first-class requirement, not an emergent property

Position statement, because it shapes the whole doc: *minimizing average error is
not the goal; producing output a pixel artist would accept is.* "Looks best" is
hard to define, so the plan attacks it from four directions rather than pretending
one number captures it:

1. **Structural mechanisms** that encode known pixel-art craft directly in the
   pipeline: distinctiveness-weighted quantization + protected seats (highlights,
   outlines, accents survive by construction, not by luck — Stage 3/4), and
   ramp-constrained shading dither (Stage 5). These make aesthetically-correct
   outputs *reachable*; no metric can select a candidate that was never generated.
2. **Aesthetic metrics** in the judge (highlight retention, outline preservation,
   ramp coherence) that measure the qualities artists actually name, alongside the
   information-loss metrics. Weighted geometric aggregation means a candidate that
   nukes the highlights loses even with excellent mean ΔE.
3. **Human-anchored calibration**: judge weights are fit to a human-ranked corpus
   (doc 10) that deliberately over-represents the hard aesthetic cases —
   cel-shaded characters, highlight-heavy sprites, subtle-shading portraits (the
   predecessor corpus is exactly this), alongside photos and flat-color art. The
   metrics serve the human ranking, never the reverse.
4. **Human-in-the-loop escape hatch**: the web/desktop scoreboard previews every
   candidate — when taste and judge disagree, one click picks the other candidate
   and pins its `--strategy`. The judge is a very good default, not an authority.

Post-1.0 research item (decision log, doc 13): a tiny fixed-weight learned
perceptual metric (LPIPS-class, distilled, WASM) as an additional judge input —
attractive because learned metrics track human aesthetic judgment better than
analytic ones, admissible only if it preserves byte-determinism (fixed weights do)
and stays small enough for the browser.

## The stage library

## Stage 0 — Decode & normalize

- Decode to RGBA float32, un-premultiplied. Alpha handling: composite over a
  configurable matte (`--background '#000'`, default: checker-detect → black), or map
  to the console's transparent index when the layout has one (`--keep-transparency`).
- Color-manage: honor embedded ICC/gAMA where present, convert to linear-light sRGB.
  All resampling and averaging happens in **linear light**; all perceptual distance
  happens in **Oklab** (see §Color distance).

## Stage 1 — Source analysis (seeds the portfolio)

Cheap statistics seed the tournament — they select and order the candidate
portfolio (and under `--effort fast`, pick the single candidate). Every decision is
printed with `--verbose` and overridable:

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
  `cover` crops around `--focus` (explicit point, or saliency-driven `auto`).
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
- **Centroid collapse (`art` profile)**: after convergence each centroid is replaced
  by its cluster's highest-weight *actual member color* (lattice-snapped) — the
  predecessor's "keep colours that exist in the art rather than mushy averages". A
  weighted mean of two distinct flat regions is a blend neither region contains;
  collapsing is what keeps flat art flat and saturated. Photos keep the mean
  (smoother ramps), so the flag rides the candidate's profile affinity.
- **Separation-aware fitting (planned, §The objective)**: at high palette pressure
  the fitter's objective gains a repulsion term between palette entries —
  two near-duplicate entries are a wasted slot *and* a merged boundary, so
  entries that centroid-optimality would place almost on top of each other get
  pushed apart. Distinct-but-further beats closer-but-indistinguishable; the
  eye reads separation, not residual ΔE.
- **Fixed-master consoles** (NES/TMS/2600/7800): k-medoids over the master palette —
  centers *are* master entries by construction. Perceptual distance uses the
  console's DAC model (NES NTSC decode, TMS levels) so we match what the screen
  shows, not the naive RGB triplets.
- Importance weighting — and this is where naive quantizers fail pixel art:
  **frequency is not importance**. A six-pixel specular highlight, a rim-light
  edge, or an eye catchlight is often the least frequent color in the image and
  the one that makes it read as cel-shaded. Pixel weight is therefore
  `frequency × distinctiveness × saliency`:
  - *distinctiveness*: colors far (in Oklab) from their spatial neighbors and at
    luminance/chroma extremes get super-linear weight, so rare-but-distinct
    clusters survive clustering instead of being absorbed into their surroundings;
  - *saliency*: contrast + center-prior map, favors subjects over backgrounds
    (`--no-saliency` disables);
  - **protected seats**: the top distinct extreme clusters (brightest highlight,
    darkest outline, most saturated accent) are detected and guaranteed palette
    slots before error minimization begins — they can be merged only with each
    other, never averaged into midtones. `--protect '#fff,#e04040'` pins
    user-chosen colors (lattice-snapped) explicitly.
- **Palette lock** (`--palette`): when the user supplies a palette (.gpl/JASC/
  Lospec/inline — the artist-workflow case where a project palette already
  exists), Stage 3 is skipped in favor of the given colors (lattice-snapped, with
  a warning listing any that moved) and Stage 4 only solves the assignment
  problem. Fitted palettes are exportable in the same formats (`--export-palette`)
  so a first run's result can seed a whole art set.

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
   Protected-seat colors from Stage 3 are carried through: the cell(s) containing a
   protected color must be assigned a palette that keeps it, and refitting may not
   drift a protected slot away (it stays lattice-pinned).
6. **Index-order post-pass**: within each palette, order colors dark→light (the
   `gen-portraits.py` DMG-coherence trick, generalized: stable cross-palette
   luminance ordering helps consoles with shared-index semantics and makes
   deterministic diffs readable).

Mode selection: when a console has several modes (SNES 1/3/7, GBA 0/4/3, ANTIC),
`--mode auto` simply contributes one candidate per plausible mode to the tournament
— the judge picks, like any other strategy dimension; `--mode <name>` pins it.

## Stage 5 — Dithering & remap

- Remap each pixel through its cell's palette; error metric = Oklab ΔE (with the
  original tools' channel-weighted RGB kept as `--metric wrgb` for reproducing old
  outputs).
- Dither options: `none` (art default), `bayer2|4|8` (ordered, retro-authentic),
  `floyd-steinberg` serpentine (photo default), `atkinson`, `riemersma`, and
  **`ramp`** — artist-style shading dither: ordered patterns allowed only between
  *luminance-adjacent colors of the same palette ramp*, and only inside smooth-
  gradient regions (never across detected edges/outlines). This is dithering as a
  shading technique — the checkerboard an artist lays between two cel shades to
  fake a midtone — not as broadband error correction: no random speckle, no
  off-ramp color pairs, flat regions stay flat. `ramp` candidates are seeded into
  the tournament for `art`-profile sources automatically. Strength 0–100 for all.
- Error diffusion is **cell-aware**: error never diffuses across a palette
  boundary into a cell that can't represent it (prevents the classic smearing
  artifact at attribute edges).

## Stage 6 — Tile-budget enforcement

For consoles with unique-tile limits (NES 256; MD/SNES VRAM; GB banks): count unique
tiles after remap; if over budget, iteratively merge the closest tile pair
(perceptual distance on decoded tiles, flip-aware where hardware supports H/V flip —
MD/SNES/GBC do, NES BG does not) and re-point the map, until within budget. Report
the merge count in the manifest; `--strict` errors instead of merging.

## Stage 7 — DAC snap & encode

- Final palette values snapped to hardware lattice (already true by construction).
  Output PNG stores the console's **author-space** colors by default (see §Color
  distance): the raw lattice expansion on panel-filter consoles (GBC), the
  DAC-decoded color where the DAC model *is* the hardware output (NES NTSC decode,
  MD 3-bit DAC ramp, mono ramps). `--dac-colors` stores the full DAC/panel
  simulation instead (the hardware-screen preview); `--raw-colors` forces raw
  expansion everywhere. The raw hardware values always travel in the manifest,
  `inspect`/`gen` accept a compliant PNG in either encoding, and doc 10's emulator
  comparison consumes the same DAC model.
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

The prime directive here is §The objective's: distances serve *perceived
equivalence*, and under palette pressure the question "which colors keep the
image's regions distinct?" outranks "which colors minimize residual ΔE?".
Everything below is in service of that.

- Working space **Oklab** (cheap, perceptually uniform, well-behaved for k-means
  means). ΔE = weighted Euclidean in Oklab with L-weight slightly >1 for `art`
  profile (protects contrast/edges) — calibrated in Phase 2 against a small human-
  judged fixture set, then frozen.
- All distances computed in the console's **author space** — the color encoding
  the fit optimizes and the PNG stores. Where the DAC model describes the
  console's *own output* (NES NTSC decode, MD VDP levels, mono ramps) that is the
  DAC-decoded color: what the hardware emits is what we optimize. Where the model
  describes a **panel filter** on top of an RGB DAC (the CGB LCD curve), author
  space is the raw lattice expansion: period artists authored saturated RGB555
  and let the panel mute it, emulators default to little/no correction, and the
  doc-10 GB E2E captures SameBoy with color correction *disabled*. Fitting
  through the panel filter bakes its washout into the chosen codes (yellow→
  orange, blue→teal — the predecessor comparison that triggered this rule);
  the filter stays available as an opt-in simulation (`--dac-colors`).
- The predecessor weighted-RGB metric (R2/G4/B3) is retained as `--metric wrgb` for
  byte-reproducing legacy outputs in tests.

## Performance targets

- 4K photo → any Tier 1 console: `--effort fast` (single candidate) **< 1 s** in
  Node on a laptop; `default` (pruned tournament, parallel workers) **< 3 s** Node,
  < 6 s in-browser; `max` (full portfolio + annealing) < 20 s. Judge overhead per
  candidate is milliseconds (metrics run at output resolution, which is tiny).
- Implementation rules: `Float32Array`/`Uint8Array` throughout, histograms not
  per-pixel loops where possible, no allocation inside inner loops, benchmarks in CI
  (doc 11) with regression thresholds.

## Prior art to beat (and steal from)

Benchmarked against during Phase 2, quality-fixture based: ImageMagick `-remap`,
libimagequant/pngquant (global quant quality bar), superfamiconv & Tilemap Studio
(SNES/GB tiling bar), img2gba/grit (GBA bar), and the original predecessor outputs
(which we must match-or-beat on their own portrait corpus — that corpus becomes a
permanent quality fixture).
