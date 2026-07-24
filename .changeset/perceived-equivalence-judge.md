---
"@demake/core": minor
"demake": minor
---

Implement the perceived-equivalence judge and graded tournament candidates
(doc 04 §The objective — the direction change away from per-pixel closeness).
Output-affecting for `prep` across consoles:

- **Grade-aligned metrics.** The judge now fits the best _allowed grade_ from
  reference to output — an isotonic monotone lightness curve (bounded to
  ±0.18 L) plus a single global chroma gain (0.75–1.6×) — and scores aligned
  mean/p95 ΔE against the graded reference. A coherent artist-style
  exaggeration is nearly free; incoherent color error still costs full price.
- **New relational metrics**: asymmetric separation retention (dominant region
  pairs merging is penalized, spreading them is not), asymmetric local
  contrast (flattening penalized, expansion tolerated), and ramp-ordering
  monotonicity (invariant to any monotone tone curve). A naturalness metric
  bounds the fitted grade's magnitude so exaggeration can't run to garish.
- **Palette pressure** — source color diversity versus the console layout's
  affordable colors — now slides judge weights: relational metrics dominate on
  tight budgets (DMG-from-photo), absolute fidelity dominates at zero pressure
  (authored art, round-trips). Exposed as `stats.palettePressure` and on
  `JudgeResult`; `judge()` accepts a `console` option to engage it.
- **Graded candidates** (`art-majority-flat-expand`, `photo-lanczos-fs-expand`,
  `photo-lanczos-fs-punchy`, `photo-lanczos-atkinson-punchy`): bounded
  pre-quantization tonal stretch + chroma boost, generalizing the mono path's
  long-standing percentile auto-contrast to tiled consoles. Judged against the
  _ungraded_ reference, they win exactly where they should — coarse palettes
  under pressure (e.g. photographic sources on SMS RGB222) — and lose to the
  faithful candidates on authored art, keeping round-trips idempotent.

Verified on the eval battery (graded winners on SMS photos are dramatic
side-by-side improvements; flat art, portraits and round-trips unchanged) and
pinned in `quality.test.ts`: distinct-but-exaggerated must outscore
closer-but-merged, coherent grades are nearly free, tonal collapse is not
excused by alignment, and zero-pressure sources never pick a graded winner.
The GB/GBC pixel-perfect emulator battery still passes byte-for-byte.
