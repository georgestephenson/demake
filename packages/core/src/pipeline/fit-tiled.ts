/**
 * Stage 4 — layout fitting for tiled RGB-lattice consoles (doc 04 §Stage 4).
 *
 * The constrained assignment problem: partition the image's colors into the
 * console's `P × K` sub-palette structure and assign each attribute cell one
 * sub-palette. This is `prep-portraits.py`'s alternating-refinement core,
 * generalized to a declarative spec:
 *
 *   init (cluster cells → seed each palette by k-means) →
 *   repeat { assign each cell to its min-error palette; refit each palette } →
 *   keep the best of R deterministic restarts.
 *
 * Importance weighting (frequency × distinctiveness) protects rare-but-distinct
 * colors — a six-pixel highlight — from being averaged away (doc 04 §Stage 3).
 */

import { deltaESq, linearToOklab, type Oklab } from "../color/oklab.js";
import type { Prng } from "../math/prng.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import type { HwColor, HwColorSpace } from "./hwcolor.js";
import { latticeKmeans, type Points } from "./kmeans.js";
import type { LinImage } from "./types.js";

/** Tunable knobs derived from `--effort` and the profile. */
export interface FitParams {
  restarts: number;
  kmeansIters: number;
  refineRounds: number;
  lWeight: number;
}

/** The fitter's raw output (pre-dither, pre-budget). */
export interface TiledFit {
  cellsX: number;
  cellsY: number;
  palettes: HwColor[][];
  /** Sub-palette index per cell (row-major). */
  cellPalette: Uint16Array;
  /** Per-pixel Oklab of the source at output resolution (for remap/dither). */
  pixelLab: Float32Array;
  /** Total weighted remap error of the winning fit. */
  totalError: number;
}

/** Per-pixel importance and Oklab, precomputed once. */
interface Precomputed {
  lab: Float32Array; // 3 per pixel
  weight: Float32Array; // 1 per pixel
}

function precompute(img: LinImage): Precomputed {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const c = linearToOklab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
    lab[o] = c.L;
    lab[o + 1] = c.a;
    lab[o + 2] = c.b;
  }
  const weight = computeWeights(lab, img.width, img.height);
  return { lab, weight };
}

/**
 * Importance weight per pixel = 1 + local contrast + extremeness. Distinct
 * colors (edges, highlights, saturated accents) get super-linear weight so they
 * survive clustering (doc 04 §Stage 3, "frequency is not importance").
 */
function computeWeights(lab: Float32Array, width: number, height: number): Float32Array {
  const n = width * height;
  const weight = new Float32Array(n);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 3;
      const L = lab[o]!;
      const a = lab[o + 1]!;
      const b = lab[o + 2]!;
      // Local contrast: mean squared Oklab distance to the 4-neighborhood.
      let contrast = 0;
      let count = 0;
      if (x > 0) {
        contrast += neighborDist(lab, o, (i - 1) * 3);
        count += 1;
      }
      if (x < width - 1) {
        contrast += neighborDist(lab, o, (i + 1) * 3);
        count += 1;
      }
      if (y > 0) {
        contrast += neighborDist(lab, o, (i - width) * 3);
        count += 1;
      }
      if (y < height - 1) {
        contrast += neighborDist(lab, o, (i + width) * 3);
        count += 1;
      }
      contrast = count > 0 ? contrast / count : 0;
      // Extremeness: distance of L from mid-gray and chroma magnitude.
      const chroma = a * a + b * b;
      const extreme = (L - 0.5) * (L - 0.5) + chroma;
      weight[i] = 1 + 8 * contrast + 1.5 * extreme;
    }
  }
  return weight;
}

function neighborDist(lab: Float32Array, o1: number, o2: number): number {
  const dL = lab[o1]! - lab[o2]!;
  const da = lab[o1 + 1]! - lab[o2 + 1]!;
  const db = lab[o1 + 2]! - lab[o2 + 2]!;
  return dL * dL + da * da + db * db;
}

/** Build the k-means point set for a subset of pixel indices. */
function pointsFor(pre: Precomputed, pixelIndices: Int32Array, size: number): Points {
  const lab = new Float32Array(size * 3);
  const weight = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    const p = pixelIndices[i]!;
    const o = p * 3;
    lab[i * 3] = pre.lab[o]!;
    lab[i * 3 + 1] = pre.lab[o + 1]!;
    lab[i * 3 + 2] = pre.lab[o + 2]!;
    weight[i] = pre.weight[p]!;
  }
  return { lab, weight, count: size };
}

/** Minimum weighted distance from a pixel to any color in a palette. */
function pixelPaletteError(
  pre: Precomputed,
  pixel: number,
  palette: HwColor[],
  lWeight: number,
): number {
  const o = pixel * 3;
  const lab: Oklab = { L: pre.lab[o]!, a: pre.lab[o + 1]!, b: pre.lab[o + 2]! };
  let best = Infinity;
  for (const c of palette) {
    const d = deltaESq(lab, c.lab, lWeight);
    if (d < best) best = d;
  }
  return best * pre.weight[pixel]!;
}

/** Fit sub-palettes and cell assignments for a tiled console.
 *
 * `reserved`, when given, is forced into index 0 of every sub-palette — the
 * shared backdrop of consoles whose `subPalettes.sharedIndex0` is set (NES): all
 * palettes then share color 0, so backdrop pixels map to index 0 everywhere. */
export function fitTiled(
  img: LinImage,
  spec: ConsoleSpec,
  space: HwColorSpace,
  prng: Prng,
  params: FitParams,
  reserved: HwColor | null = null,
): TiledFit {
  const layout = spec.layout as TileLayout;
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = Math.floor(img.width / cellW);
  const cellsY = Math.floor(img.height / cellH);
  const cellCount = cellsX * cellsY;
  const P = layout.subPalettes.count;
  const K = layout.subPalettes.size;

  const pre = precompute(img);

  // Pixel index lists per cell (built once; cell membership is fixed).
  const cellPixels: Int32Array[] = [];
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const idx: number[] = [];
      for (let y = 0; y < cellH; y += 1) {
        for (let x = 0; x < cellW; x += 1) {
          const px = cx * cellW + x;
          const py = cy * cellH + y;
          idx.push(py * img.width + px);
        }
      }
      cellPixels.push(Int32Array.from(idx));
    }
  }

  // Per-cell mean Oklab signature (for initial cell grouping).
  const cellMean = new Float32Array(cellCount * 3);
  for (let c = 0; c < cellCount; c += 1) {
    let sL = 0;
    let sa = 0;
    let sb = 0;
    const px = cellPixels[c]!;
    for (const p of px) {
      const o = p * 3;
      sL += pre.lab[o]!;
      sa += pre.lab[o + 1]!;
      sb += pre.lab[o + 2]!;
    }
    cellMean[c * 3] = sL / px.length;
    cellMean[c * 3 + 1] = sa / px.length;
    cellMean[c * 3 + 2] = sb / px.length;
  }

  let best: Omit<TiledFit, "pixelLab"> | undefined;
  const effectiveRestarts = Math.max(1, params.restarts);
  for (let r = 0; r < effectiveRestarts; r += 1) {
    const fit = runOnce(
      pre,
      cellPixels,
      cellMean,
      cellsX,
      cellsY,
      P,
      K,
      space,
      prng,
      params,
      reserved,
    );
    if (!best || fit.totalError < best.totalError) {
      best = fit;
    }
  }

  const result = best!;
  return { ...result, pixelLab: pre.lab };
}

function runOnce(
  pre: Precomputed,
  cellPixels: Int32Array[],
  cellMean: Float32Array,
  cellsX: number,
  cellsY: number,
  P: number,
  K: number,
  space: HwColorSpace,
  prng: Prng,
  params: FitParams,
  reserved: HwColor | null,
): Omit<TiledFit, "pixelLab"> {
  const cellCount = cellsX * cellsY;
  const cellPalette = new Uint16Array(cellCount);

  // Init: cluster cell means into P groups (k-means++ over cell signatures).
  const meanPoints: Points = {
    lab: cellMean,
    weight: new Float32Array(cellCount).fill(1),
    count: cellCount,
  };
  const groupCenters = pickCellGroups(meanPoints, Math.min(P, cellCount), prng, params.lWeight);
  for (let c = 0; c < cellCount; c += 1) {
    cellPalette[c] = nearestGroup(cellMean, c, groupCenters, params.lWeight);
  }

  let palettes = refitPalettes(pre, cellPixels, cellPalette, P, K, space, prng, params, reserved);

  for (let round = 0; round < params.refineRounds; round += 1) {
    // Assignment step.
    let moved = false;
    for (let c = 0; c < cellCount; c += 1) {
      let best = 0;
      let bestErr = Infinity;
      for (let p = 0; p < palettes.length; p += 1) {
        if (palettes[p]!.length === 0) continue;
        let err = 0;
        for (const px of cellPixels[c]!) {
          err += pixelPaletteError(pre, px, palettes[p]!, params.lWeight);
        }
        if (err < bestErr) {
          bestErr = err;
          best = p;
        }
      }
      if (cellPalette[c] !== best) moved = true;
      cellPalette[c] = best;
    }
    palettes = refitPalettes(pre, cellPixels, cellPalette, P, K, space, prng, params, reserved);
    if (!moved && round > 0) break;
  }

  let totalError = 0;
  for (let c = 0; c < cellCount; c += 1) {
    const pal = palettes[cellPalette[c]!]!;
    for (const px of cellPixels[c]!) {
      totalError += pixelPaletteError(pre, px, pal, params.lWeight);
    }
  }

  return { cellsX, cellsY, palettes, cellPalette, totalError };
}

/** k-means++ over cell signatures, returning P center signatures. */
function pickCellGroups(points: Points, p: number, prng: Prng, lWeight: number): Float32Array {
  const centers = new Float32Array(p * 3);
  const first = prng.nextInt(points.count);
  centers[0] = points.lab[first * 3]!;
  centers[1] = points.lab[first * 3 + 1]!;
  centers[2] = points.lab[first * 3 + 2]!;
  const dist = new Float32Array(points.count).fill(Infinity);
  for (let k = 1; k < p; k += 1) {
    const cx: Oklab = {
      L: centers[(k - 1) * 3]!,
      a: centers[(k - 1) * 3 + 1]!,
      b: centers[(k - 1) * 3 + 2]!,
    };
    let sum = 0;
    for (let i = 0; i < points.count; i += 1) {
      const d = deltaESq(
        { L: points.lab[i * 3]!, a: points.lab[i * 3 + 1]!, b: points.lab[i * 3 + 2]! },
        cx,
        lWeight,
      );
      if (d < dist[i]!) dist[i] = d;
      sum += dist[i]!;
    }
    if (sum <= 0) {
      centers[k * 3] = points.lab[0]!;
      centers[k * 3 + 1] = points.lab[1]!;
      centers[k * 3 + 2] = points.lab[2]!;
      continue;
    }
    let t = prng.next() * sum;
    let pick = 0;
    for (let i = 0; i < points.count; i += 1) {
      t -= dist[i]!;
      if (t <= 0) {
        pick = i;
        break;
      }
    }
    centers[k * 3] = points.lab[pick * 3]!;
    centers[k * 3 + 1] = points.lab[pick * 3 + 1]!;
    centers[k * 3 + 2] = points.lab[pick * 3 + 2]!;
  }
  return centers;
}

function nearestGroup(
  cellMean: Float32Array,
  c: number,
  centers: Float32Array,
  lWeight: number,
): number {
  const lab: Oklab = { L: cellMean[c * 3]!, a: cellMean[c * 3 + 1]!, b: cellMean[c * 3 + 2]! };
  const count = centers.length / 3;
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < count; k += 1) {
    const d = deltaESq(
      lab,
      { L: centers[k * 3]!, a: centers[k * 3 + 1]!, b: centers[k * 3 + 2]! },
      lWeight,
    );
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** Refit each sub-palette by k-means over its assigned cells' pixels. */
function refitPalettes(
  pre: Precomputed,
  cellPixels: Int32Array[],
  cellPalette: Uint16Array,
  P: number,
  K: number,
  space: HwColorSpace,
  prng: Prng,
  params: FitParams,
  reserved: HwColor | null,
): HwColor[][] {
  const palettes: HwColor[][] = [];
  // With a reserved backdrop, k-means fits the other K−1 colors; the backdrop is
  // forced into index 0, so every palette shares it.
  const freeK = reserved ? Math.max(1, K - 1) : K;
  for (let p = 0; p < P; p += 1) {
    const members: number[] = [];
    for (let c = 0; c < cellPalette.length; c += 1) {
      if (cellPalette[c] === p) {
        for (const px of cellPixels[c]!) members.push(px);
      }
    }
    if (members.length === 0) {
      palettes.push(reserved ? [reserved] : []);
      continue;
    }
    const points = pointsFor(pre, Int32Array.from(members), members.length);
    const fitted = latticeKmeans(points, freeK, space, prng, params.kmeansIters, params.lWeight);
    palettes.push(reserved ? withReserved(reserved, fitted, K) : fitted);
  }
  return palettes;
}

/** Prepend the reserved backdrop at index 0, dedupe, and cap at K colors. */
function withReserved(reserved: HwColor, fitted: HwColor[], K: number): HwColor[] {
  const key = reserved.codes.join(",");
  const out: HwColor[] = [reserved];
  for (const c of fitted) {
    if (out.length >= K) break;
    if (c.codes.join(",") !== key) out.push(c);
  }
  return out;
}
