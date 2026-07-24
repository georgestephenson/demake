/**
 * Pre-quantization grading (doc 04 §The tournament — "grading is a candidate
 * dimension, not a policy").
 *
 * A bounded, globally coherent grade applied to the working image before the
 * constrained fit: percentile-stretch the Oklab lightness range and boost
 * chroma, the way period artists exaggerated tone and saturation to spend a
 * tiny palette well. The mono path's percentile auto-contrast is the
 * long-standing special case of this; here it is generalized to the tiled
 * consoles as tournament candidates the grade-aligned judge can evaluate
 * against the *ungraded* reference. Bounds stay inside the judge's allowed
 * grade (doc 04 §The objective) so a graded candidate is judged on what it
 * does with the palette, not penalized for the grade itself.
 */

import { linearToOklab, oklabToLinear } from "../color/oklab.js";

import type { LinImage } from "./types.js";

/** A named bounded grade (a candidate dimension). */
export type GradeId = "expand" | "punchy";

interface GradeParams {
  /** Output L range the 2nd..98th percentile of source L is stretched toward. */
  lLow: number;
  lHigh: number;
  /** Maximum tonal gain — keeps low-contrast sources from over-stretching. */
  maxGain: number;
  /** Global chroma multiplier (must stay inside the judge's allowed range). */
  chroma: number;
}

const GRADES: Record<GradeId, GradeParams> = {
  expand: { lLow: 0.08, lHigh: 0.95, maxGain: 1.45, chroma: 1.22 },
  punchy: { lLow: 0.05, lHigh: 0.97, maxGain: 1.75, chroma: 1.5 },
};

/** Apply a named grade to a linear-light working image (returns a new image). */
export function applyGrade(img: LinImage, id: GradeId): LinImage {
  const params = GRADES[id];
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  const ls = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const c = linearToOklab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
    lab[o] = c.L;
    lab[o + 1] = c.a;
    lab[o + 2] = c.b;
    ls[i] = c.L;
  }
  const sorted = Float32Array.from(ls).sort();
  const at = (q: number): number => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]!;
  const lo = at(0.02);
  const hi = at(0.98);
  const span = Math.max(1e-6, hi - lo);
  const gain = Math.min(params.maxGain, (params.lHigh - params.lLow) / span);
  if (gain <= 1 && params.chroma <= 1) return img;
  const mid = (lo + hi) / 2;
  const outMid = (params.lLow + params.lHigh) / 2;

  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const L = Math.max(0.01, Math.min(0.99, outMid + (lab[o]! - mid) * Math.max(1, gain)));
    const lin = oklabToLinear({
      L,
      a: lab[o + 1]! * params.chroma,
      b: lab[o + 2]! * params.chroma,
    });
    out[o] = Math.max(0, Math.min(1, lin.r));
    out[o + 1] = Math.max(0, Math.min(1, lin.g));
    out[o + 2] = Math.max(0, Math.min(1, lin.b));
  }
  return { width: img.width, height: img.height, data: out };
}
