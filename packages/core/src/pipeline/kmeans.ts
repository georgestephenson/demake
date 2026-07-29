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
 *
 * **How often a cluster empties is the console's, not the picture's.** A
 * centroid is snapped to the hardware lattice every iteration, so on a coarse
 * one two centroids land on the same colour and one of them loses all its
 * members: a Master System's sixty-four colours empty several clusters most
 * iterations where a Game Gear's four thousand ninety-six almost never do. That
 * is why the reseed is on the assignment scan's own answer rather than in a pass
 * of its own — it used to be the single most expensive thing in the pipeline for
 * exactly one family of consoles, and it was recomputing what had just been
 * found.
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
 * With `collapse`, each converged centroid is replaced by the *actual member
 * color* (lattice-snapped) carrying the most weight in its cluster — the
 * predecessor's "keep colours that exist in the art rather than mushy
 * averages". A weighted mean of two distinct flat regions is a blend neither
 * region contains; collapsing keeps flat art flat and saturated. Photos prefer
 * the mean (smoother ramps), so the flag is profile-driven.
 *
 * `frozen` pins index 0 to a color the caller has already decided on — the
 * shared backdrop of a `sharedIndex0` console. It competes for points like any
 * other center and is never moved, so the `k - 1` free centers fit *what the
 * backdrop does not already serve* rather than being fitted over the whole cell
 * and then having one of them turn out to be the backdrop again.
 *
 * @returns the fitted palette: `k` deduplicated hardware colors wherever the
 * points hold that many distinct ones, `frozen` first when given.
 */
export function latticeKmeans(
  points: Points,
  k: number,
  space: HwColorSpace,
  prng: Prng,
  iterations: number,
  lWeight: number,
  collapse = false,
  frozen?: HwColor,
): HwColor[] {
  if (points.count === 0) {
    return [frozen ?? space.snapLinear(0, 0, 0)];
  }
  const kk = Math.min(k, points.count + (frozen ? 1 : 0));
  const seedIdx = kmeansppInit(points, frozen ? kk - 1 : kk, prng, lWeight);
  const seeded = seedIdx.map((i) => {
    const lab = labAt(points, i);
    const lin = oklabToLinear(lab);
    return space.snapLinear(lin.r, lin.g, lin.b);
  });
  let centers: HwColor[] = frozen ? [frozen, ...seeded] : seeded;

  const assign = new Int32Array(points.count);
  for (let iter = 0; iter < iterations; iter += 1) {
    // Assignment step, which also finds the point that fits worst.
    //
    // The two are the same scan: "how far is this point from its nearest centre"
    // is what assignment computes and what a reseed needs, so keeping the answer
    // costs a multiply and a compare per point and saves a second pass over
    // every point and every centre. The tie-break is the same one the separate
    // scan used — the first index with a strictly greater score — so the reseed
    // picks exactly the point it picked before.
    let moved = false;
    let worst = 0;
    let worstScore = -1;
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
      const scored = bestD * points.weight[i]!;
      if (scored > worstScore) {
        worstScore = scored;
        worst = i;
      }
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
      // The frozen center is the caller's decision, not this loop's: it takes
      // the points it is nearest to and stays exactly where it is.
      if (frozen && c === 0) {
        next.push(frozen);
      } else if (sumW[c]! > 0) {
        const lab: Oklab = {
          L: sumL[c]! / sumW[c]!,
          a: sumA[c]! / sumW[c]!,
          b: sumB[c]! / sumW[c]!,
        };
        const lin = oklabToLinear(lab);
        next.push(space.snapLinear(lin.r, lin.g, lin.b));
      } else {
        // Empty cluster: reseed from the worst-fit point (deterministic). Every
        // empty cluster in one iteration reseeds from the *same* point — the
        // answer depends on `points` and on the centres this iteration assigned
        // against, and neither changes while the new centres accumulate into
        // `next`.
        const lab = labAt(points, worst);
        const lin = oklabToLinear(lab);
        next.push(space.snapLinear(lin.r, lin.g, lin.b));
      }
    }
    centers = next;
    if (!moved && iter > 0) break;
  }

  if (collapse) {
    centers = collapseToMembers(points, centers, space, lWeight, frozen !== undefined);
  }
  return topUp(dedupeColors(centers), points, kk, space, lWeight);
}

/**
 * Refill a palette that dedupe left short of `k`.
 *
 * Two centers that converged on different Oklab means can snap to the *same*
 * lattice color, and on a fixed-master console — fifty-odd colors, and a shadow
 * end so sparse that three tints of one sky land on one entry — that is the
 * common case rather than the corner. Dropping the duplicate and returning a
 * shorter palette silently hands back three colors where the caller's hardware
 * has four, and the caller has no way to notice: a Nintendo palette really can
 * only hold four. So the slot is refilled from the point the palette serves
 * worst, which is the same move the loop above makes for an empty cluster.
 *
 * Adding a center can only reduce error, because assignment is nearest-center —
 * so this needs no further iteration, and it stops as soon as the points hold no
 * color the palette does not already have.
 */
function topUp(
  palette: HwColor[],
  points: Points,
  k: number,
  space: HwColorSpace,
  lWeight: number,
): HwColor[] {
  if (palette.length >= k) return palette;
  const out = [...palette];
  const have = new Set(out.map((c) => c.codes.join(",")));
  while (out.length < k) {
    let worst = -1;
    let worstScore = 0;
    for (let i = 0; i < points.count; i += 1) {
      const lab = labAt(points, i);
      let best = Infinity;
      for (const c of out) {
        const d = deltaESq(lab, c.lab, lWeight);
        if (d < best) best = d;
      }
      const scored = best * points.weight[i]!;
      if (scored > worstScore) {
        worstScore = scored;
        worst = i;
      }
    }
    if (worst < 0) break;
    const lin = oklabToLinear(labAt(points, worst));
    const add = space.snapLinear(lin.r, lin.g, lin.b);
    const key = add.codes.join(",");
    // The worst-served point already snaps to a color the palette holds: every
    // remaining slot would be a duplicate, so there is nothing left to add.
    if (have.has(key)) break;
    have.add(key);
    out.push(add);
  }
  return out;
}

/** Replace each center with its cluster's highest-weight actual member color. */
function collapseToMembers(
  points: Points,
  centers: HwColor[],
  space: HwColorSpace,
  lWeight: number,
  keepFirst = false,
): HwColor[] {
  // Accumulate member weight per (cluster, snapped lattice color).
  const tallies: Map<string, { color: HwColor; weight: number }>[] = centers.map(() => new Map());
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
    const lin = oklabToLinear(lab);
    const snapped = space.snapLinear(lin.r, lin.g, lin.b);
    const key = snapped.codes.join(",");
    const tally = tallies[best]!;
    const entry = tally.get(key);
    if (entry) entry.weight += points.weight[i]!;
    else tally.set(key, { color: snapped, weight: points.weight[i]! });
  }
  return centers.map((center, c) => {
    // A frozen center is not a cluster mean to be replaced by a real member; it
    // is the color the hardware will display at index 0 whatever this fit says.
    if (keepFirst && c === 0) return center;
    let bestColor = center;
    let bestWeight = -1;
    let bestKey = "";
    for (const [key, { color, weight }] of tallies[c]!) {
      if (weight > bestWeight || (weight === bestWeight && key < bestKey)) {
        bestWeight = weight;
        bestColor = color;
        bestKey = key;
      }
    }
    return bestColor;
  });
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
