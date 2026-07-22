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
}

/** Classify a source image's profile from cheap pixel statistics. */
export function analyze(source: RgbaImage): Analysis {
  const { width, height, data } = source;
  const seen = new Set<number>();
  const key = (i: number): number => {
    const r = data[i]! >> 3;
    const g = data[i + 1]! >> 3;
    const b = data[i + 2]! >> 3;
    return (r << 10) | (g << 5) | b;
  };

  let flatPairs = 0;
  let pairs = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const k = key(i);
      if (seen.size < 70000) seen.add(k);
      if (x < width - 1) {
        pairs += 1;
        if (key(i + 4) === k) flatPairs += 1;
      }
      if (y < height - 1) {
        pairs += 1;
        if (key(i + width * 4) === k) flatPairs += 1;
      }
    }
  }
  const uniqueColors = seen.size;
  const flatness = pairs > 0 ? flatPairs / pairs : 0;

  // Art: limited palette and/or lots of flat neighbor pairs. Photo otherwise.
  const looksArt = uniqueColors <= 4096 || flatness >= 0.5;
  return { profile: looksArt ? "art" : "photo", uniqueColors, flatness };
}
