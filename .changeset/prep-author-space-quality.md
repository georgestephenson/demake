---
"@demake/core": minor
"@demake/cli-spec": minor
"demake": minor
---

Overhaul prep quality for pixel art (found by a new realistic eval battery —
AA'd portraits, title screens, sprite scenes, flat art, real photos — reviewed
image-by-image and, for the Game Boy Color, side-by-side against the
predecessor prep script's output). All output-affecting:

- **Author-space fitting, judging, and storage.** The GBC's `cgb` DAC model is
  an LCD _panel filter_, not the hardware DAC: fitting and storing through it
  baked its washout into the PNG (saturated yellow stored as orange, blue as
  teal, ~25% of chroma destroyed on round-trips) while the emulator E2E itself
  compares raw RGB555 (SameBoy runs color-correction-disabled). `prep` now
  fits, judges, and stores raw lattice expansion on panel-filter consoles —
  flat-art mean ΔE drops ~10× (e.g. 0.0485 → 0.0036) and hue swaps disappear.
  The panel simulation remains available as the new `--dac-colors` flag;
  `inspect`/`gen`/manifests accept compliant PNGs in either encoding.
- **Centroid collapse + master-palette denoise for `art` sources.** k-means
  mean centroids blend distinct flat regions into colors the art never
  contained; `art`-profile candidates now collapse each converged centroid to
  its cluster's highest-weight real source color and denoise AA/upscaler halos
  to a master palette before the constrained fit (the predecessor script's
  recipe, generalized to every tiled console).
- **Judge rigor.** Three new metrics — chroma-weighted hue error, palette
  recall (every dominant source color must survive into the output), and
  phantom-edge rate (dither speckle on regions the source keeps flat) — plus a
  symmetric chroma-ratio gamut metric, and a profile-fixed reference kernel
  (majority for `art`, Lanczos3 for `photo`) so crisp flat output is no longer
  penalized against a low-pass reference on AA'd sources.
- **Profile detection.** Real photographs were classified `art` (the old
  `≤4096 unique colors` rule fires on coarse-bucketed photos) and routed to the
  flat-art path; classification now uses exact-neighbor flatness and color-mass
  concentration, calibrated on the battery.
- **NES shared-backdrop oracle.** `inspect` proved covers only against the
  single most common output color as backdrop; it now tries a small
  deterministic candidate list, fixing false negatives on valid images.

New `pnpm eval:prep` runs the battery and writes side-by-side comparison
sheets; `packages/core/test/quality.test.ts` pins each failure mode as a
regression floor. The full GB/GBC pixel-perfect emulator battery still passes
byte-for-byte.
