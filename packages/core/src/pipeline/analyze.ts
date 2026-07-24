/**
 * Stage 1 — source analysis (doc 04 §Stage 1).
 *
 * Cheap statistics that seed the tournament: they classify the source as `art`
 * (few colors, flat regions, hard edges → majority scaling, no dither) or
 * `photo` (continuous tone → Lanczos/box scaling, error-diffusion dither), and
 * under `--effort fast` pick the single candidate. Every decision is
 * overridable and surfaced in `--json`/`-v`.
 */

import type { RgbaImage } from "../image/rgba.js";

/** Result of source analysis. */
export interface Analysis {
  profile: "art" | "photo";
  /** Distinct colors after a coarse 5-bit-per-channel bucketing. */
  uniqueColors: number;
  /** Fraction of pixels equal to their right/down neighbor (coarse) — flatness. */
  flatness: number;
  /** Fraction of pixels *exactly* equal to their right/down neighbor (8-bit). */
  exactFlatness: number;
  /** Fraction of pixels covered by the 16 most common coarse colors. */
  concentration: number;
}

/** Classify a source image's profile from cheap pixel statistics. */
export function analyze(source: RgbaImage): Analysis {
  const { width, height, data } = source;
  const counts = new Map<number, number>();
  const key = (i: number): number => {
    const r = data[i]! >> 3;
    const g = data[i + 1]! >> 3;
    const b = data[i + 2]! >> 3;
    return (r << 10) | (g << 5) | b;
  };

  const exact = (i: number): number => (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;

  let flatPairs = 0;
  let exactPairs = 0;
  let pairs = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const k = key(i);
      const e = exact(i);
      if (counts.size < 70000 || counts.has(k)) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      if (x < width - 1) {
        pairs += 1;
        if (key(i + 4) === k) flatPairs += 1;
        if (exact(i + 4) === e) exactPairs += 1;
      }
      if (y < height - 1) {
        pairs += 1;
        if (key(i + width * 4) === k) flatPairs += 1;
        if (exact(i + width * 4) === e) exactPairs += 1;
      }
    }
  }
  const uniqueColors = counts.size;
  const flatness = pairs > 0 ? flatPairs / pairs : 0;
  const exactFlatness = pairs > 0 ? exactPairs / pairs : 0;

  // Color-mass concentration: how much of the image the 16 heaviest coarse
  // colors cover. Flat art stays concentrated even when upscaler blur or AA
  // halos inflate the unique-color count; continuous-tone photos spread out.
  const top = [...counts.values()].sort((a, b) => b - a);
  let covered = 0;
  for (let i = 0; i < 16 && i < top.length; i += 1) covered += top[i]!;
  const concentration = width * height > 0 ? covered / (width * height) : 0;

  // Art: exact-equal neighbor runs (flat regions survive AA at region
  // interiors), an unambiguously tiny palette, or concentrated color mass
  // (blur/AA inflates unique counts but not where the mass sits). Photo
  // otherwise. Calibrated on the Phase-2 eval battery: real photographs sit at
  // exactFlatness ≤ 0.12 / concentration ≤ 0.30 even when coarse bucketing
  // drops their unique-color count to a few thousand, so unique count alone is
  // *not* an art signal (the old ≤4096 rule misread photos as art).
  const looksArt = exactFlatness >= 0.2 || uniqueColors <= 64 || concentration >= 0.5;
  return {
    profile: looksArt ? "art" : "photo",
    uniqueColors,
    flatness,
    exactFlatness,
    concentration,
  };
}
