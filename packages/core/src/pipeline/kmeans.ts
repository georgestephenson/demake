/**
 * Lattice-constrained weighted k-means in Oklab (doc 04 §Stage 3, §Stage 4).
 *
 * The workhorse used both for the global working-palette (Stage 3) and to refit
 * each sub-palette over its assigned cells (Stage 4). Cluster means are computed
 * in Oklab (well-behaved there) and **snapped to the hardware lattice every
 * iteration** via the {@link HwColorSpace} — snapping inside the loop, not after,
 * avoids post-hoc drift (the reason the predecessor snapped-then-remapped).
 *
 * Initialization is deterministic k-means++ seeded from the {@link Prng}, so the
 * whole thing is reproducible; empty clusters are re-seeded from the worst-fit
 * point rather than dropped, keeping the palette full.
 */

import { deltaESq, oklabToLinear, type Oklab } from "../color/oklab.js";
import type { Prng } from "../math/prng.js";

import type { HwColor, HwColorSpace } from "./hwcolor.js";

/** Source points to cluster: parallel Oklab + weight arrays. */
export interface Points {
  /** Oklab triples, 3 per point. */
  lab: Float32Array;
  /** Per-point importance weight (≥ 0). */
  weight: Float32Array;
  /** Number of points. */
  count: number;
}

function labAt(points: Points, i: number): Oklab {
  const o = i * 3;
  return { L: points.lab[o]!, a: points.lab[o + 1]!, b: points.lab[o + 2]! };
}

/** Weighted k-means++ initial center selection (returns point indices). */
function kmeansppInit(points: Points, k: number, prng: Prng, lWeight: number): number[] {
  const chosen: number[] = [];
  const dist = new Float32Array(points.count).fill(Infinity);

  // First center: weighted random pick.
  let totalW = 0;
  for (let i = 0; i < points.count; i += 1) totalW += points.weight[i]!;
  let target = prng.next() * totalW;
  let first = 0;
  for (let i = 0; i < points.count; i += 1) {
    target -= points.weight[i]!;
    if (target <= 0) {
      first = i;
      break;
    }
  }
  chosen.push(first);

  while (chosen.length < k) {
    const last = chosen[chosen.length - 1]!;
    const cLab = labAt(points, last);
    let sum = 0;
    for (let i = 0; i < points.count; i += 1) {
      const d = deltaESq(labAt(points, i), cLab, lWeight);
      if (d < dist[i]!) dist[i] = d;
      sum += dist[i]! * points.weight[i]!;
    }
    if (sum <= 0) break; // all points coincide with a center
    let t = prng.next() * sum;
    let pick = last;
    for (let i = 0; i < points.count; i += 1) {
      t -= dist[i]! * points.weight[i]!;
      if (t <= 0) {
        pick = i;
        break;
      }
    }
    chosen.push(pick);
  }
  return chosen;
}

/**
 * Cluster `points` into at most `k` lattice-snapped colors.
 *
 * @returns the fitted palette (deduplicated hardware colors, ≤ k entries).
 */
export function latticeKmeans(
  points: Points,
  k: number,
  space: HwColorSpace,
  prng: Prng,
  iterations: number,
  lWeight: number,
): HwColor[] {
  if (points.count === 0) {
    return [space.snapLinear(0, 0, 0)];
  }
  const kk = Math.min(k, points.count);
  const seedIdx = kmeansppInit(points, kk, prng, lWeight);
  let centers: HwColor[] = seedIdx.map((i) => {
    const lab = labAt(points, i);
    const lin = oklabToLinear(lab);
    return space.snapLinear(lin.r, lin.g, lin.b);
  });

  const assign = new Int32Array(points.count);
  for (let iter = 0; iter < iterations; iter += 1) {
    // Assignment step.
    let moved = false;
    for (let i = 0; i < points.count; i += 1) {
      const lab = labAt(points, i);
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c += 1) {
        const d = deltaESq(lab, centers[c]!.lab, lWeight);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) moved = true;
      assign[i] = best;
    }

    // Update step: weighted Oklab mean → linear → snap.
    const sumL = new Float64Array(centers.length);
    const sumA = new Float64Array(centers.length);
    const sumB = new Float64Array(centers.length);
    const sumW = new Float64Array(centers.length);
    for (let i = 0; i < points.count; i += 1) {
      const c = assign[i]!;
      const w = points.weight[i]!;
      const o = i * 3;
      sumL[c]! += points.lab[o]! * w;
      sumA[c]! += points.lab[o + 1]! * w;
      sumB[c]! += points.lab[o + 2]! * w;
      sumW[c]! += w;
    }
    const next: HwColor[] = [];
    for (let c = 0; c < centers.length; c += 1) {
      if (sumW[c]! > 0) {
        const lab: Oklab = {
          L: sumL[c]! / sumW[c]!,
          a: sumA[c]! / sumW[c]!,
          b: sumB[c]! / sumW[c]!,
        };
        const lin = oklabToLinear(lab);
        next.push(space.snapLinear(lin.r, lin.g, lin.b));
      } else {
        // Empty cluster: reseed from the worst-fit point (deterministic).
        const worst = worstFitPoint(points, centers, lWeight);
        const lab = labAt(points, worst);
        const lin = oklabToLinear(lab);
        next.push(space.snapLinear(lin.r, lin.g, lin.b));
      }
    }
    centers = next;
    if (!moved && iter > 0) break;
  }

  return dedupeColors(centers);
}

function worstFitPoint(points: Points, centers: HwColor[], lWeight: number): number {
  let worst = 0;
  let worstD = -1;
  for (let i = 0; i < points.count; i += 1) {
    const lab = labAt(points, i);
    let bestD = Infinity;
    for (const c of centers) {
      const d = deltaESq(lab, c.lab, lWeight);
      if (d < bestD) bestD = d;
    }
    const scored = bestD * points.weight[i]!;
    if (scored > worstD) {
      worstD = scored;
      worst = i;
    }
  }
  return worst;
}

/** Remove duplicate hardware colors (same raw codes), preserving order. */
export function dedupeColors(colors: HwColor[]): HwColor[] {
  const seen = new Set<string>();
  const out: HwColor[] = [];
  for (const c of colors) {
    const key = c.codes.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
