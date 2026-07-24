/**
 * The judge (doc 04 §The judge).
 *
 * Scores a candidate output against the source with fidelity metrics, computed
 * between the **DAC-decoded** result and a fixed reference — the source
 * downscaled to output dimensions with Lanczos3 in linear light, so no
 * candidate can game the reference by choosing its own scale kernel. Metrics are
 * normalized to [0,1] against fixed anchors and combined by **weighted
 * geometric mean**, so one catastrophic metric tanks the aggregate and cannot be
 * averaged away.
 *
 * This is the same scorer the tournament uses internally and the CLI exposes via
 * `inspect --source` — tests, agents, and users measure exactly what `prep`
 * measured (doc 09 `judge()`).
 */

import { linearToOklab, type Oklab } from "../color/oklab.js";
import { srgb8ToLinear } from "../color/srgb.js";
import { exp, log } from "../math/kernels.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";

import { normalize } from "../pipeline/normalize.js";
import { resize } from "../pipeline/geometry.js";
import type { LinImage, Profile } from "../pipeline/types.js";

/** Metric identifiers (a subset of doc 04's table; extended over time). */
export type MetricId =
  "meanDeltaE" | "p95DeltaE" | "structure" | "gamut" | "hue" | "noise" | "palette";

/** Judge output for one image pair. */
export interface JudgeResult {
  aggregate: number;
  metrics: Record<MetricId, number>;
  profile: Profile;
  width: number;
  height: number;
  /** Raw (un-normalized) mean Oklab ΔE — surfaced in fit stats. */
  rawMeanDeltaE: number;
  /** Raw 95th-percentile Oklab ΔE. */
  rawP95DeltaE: number;
}

/** Fixed normalization anchors (calibrated on the Phase-2 eval battery). */
const ANCHORS = { meanDeltaE: 0.05, p95DeltaE: 0.16, hue: 0.25, noise: 0.02, palette: 0.05 };

/**
 * Per-profile metric weights (calibrated on the Phase-2 eval battery).
 *
 * The `art` profile leans on the region-color metrics: `palette` (did each
 * dominant source color survive into the output?), `noise` (phantom edges —
 * dither speckle on regions the source keeps flat), and `hue` (chroma-weighted
 * hue rotation). Photos tolerate dither and value smooth ramps, so `noise`
 * barely counts there and mean ΔE dominates.
 */
const WEIGHTS: Record<"art" | "photo", Record<MetricId, number>> = {
  art: {
    meanDeltaE: 1,
    p95DeltaE: 1,
    structure: 1.2,
    gamut: 0.9,
    hue: 1.2,
    noise: 1.3,
    palette: 1.4,
  },
  photo: {
    meanDeltaE: 1.3,
    p95DeltaE: 1,
    structure: 1,
    gamut: 1,
    hue: 0.9,
    noise: 0.4,
    palette: 0.5,
  },
};

/** Convert an RGBA raster to per-pixel Oklab (3 floats per pixel). */
function labFromRgba(img: RgbaImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const s = i * 4;
    const c = linearToOklab(
      srgb8ToLinear(img.data[s]!),
      srgb8ToLinear(img.data[s + 1]!),
      srgb8ToLinear(img.data[s + 2]!),
    );
    out[i * 3] = c.L;
    out[i * 3 + 1] = c.a;
    out[i * 3 + 2] = c.b;
  }
  return out;
}

/** Convert a linear-light working image to per-pixel Oklab. */
function labFromLin(img: LinImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const c = linearToOklab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
    out[o] = c.L;
    out[o + 1] = c.a;
    out[o + 2] = c.b;
  }
  return out;
}

function labAt(lab: Float32Array, i: number): Oklab {
  const o = i * 3;
  return { L: lab[o]!, a: lab[o + 1]!, b: lab[o + 2]! };
}

/** Sobel gradient magnitude of the L channel. */
function gradientMag(lab: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  const L = (x: number, y: number): number => lab[(y * width + x) * 3]!;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        L(x + 1, y - 1) +
        2 * L(x + 1, y) +
        L(x + 1, y + 1) -
        (L(x - 1, y - 1) + 2 * L(x - 1, y) + L(x - 1, y + 1));
      const gy =
        L(x - 1, y + 1) +
        2 * L(x, y + 1) +
        L(x + 1, y + 1) -
        (L(x - 1, y - 1) + 2 * L(x, y - 1) + L(x + 1, y - 1));
      out[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/** Pearson correlation of two equal-length arrays, mapped to [0,1]. */
function correlation01(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i += 1) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= a.length;
  mb /= a.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 1e-9 || vb <= 1e-9) return 1; // both flat → structurally identical
  const r = cov / Math.sqrt(va * vb);
  return (r + 1) / 2;
}

/**
 * Chroma-weighted hue error: the mean distance between *normalized* chroma
 * vectors, weighted by how chromatic both pixels are. Catches hue rotations
 * (blue→teal, yellow→orange) that a small ΔE can hide; desaturation is the
 * gamut metric's job, so near-neutral pixels contribute nothing here.
 */
function hueError(refLab: Float32Array, resLab: Float32Array, n: number): number {
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const ra = refLab[o + 1]!;
    const rb = refLab[o + 2]!;
    const ca = resLab[o + 1]!;
    const cb = resLab[o + 2]!;
    const refC = Math.sqrt(ra * ra + rb * rb);
    const resC = Math.sqrt(ca * ca + cb * cb);
    const w = Math.min(refC, resC);
    if (w <= 0.02) continue; // neutral in either image → no defined hue
    const dua = ra / refC - ca / resC;
    const dub = rb / refC - cb / resC;
    sum += Math.sqrt(dua * dua + dub * dub) * w;
    weightSum += w;
  }
  return weightSum <= 1e-9 ? 0 : sum / weightSum;
}

/**
 * Phantom-edge rate: the fraction of neighbor pairs the *reference* keeps flat
 * where the *result* shows a strong step — dither speckle and fit seams on flat
 * regions. Real edges (present in the reference) don't count against it.
 */
function phantomEdgeRate(
  refLab: Float32Array,
  resLab: Float32Array,
  width: number,
  height: number,
): number {
  const FLAT_SQ = 0.02 * 0.02;
  const EDGE_SQ = 0.055 * 0.055;
  let flat = 0;
  let phantom = 0;
  const pairSq = (lab: Float32Array, i: number, j: number): number => {
    const oi = i * 3;
    const oj = j * 3;
    const dL = lab[oi]! - lab[oj]!;
    const da = lab[oi + 1]! - lab[oj + 1]!;
    const db = lab[oi + 2]! - lab[oj + 2]!;
    return dL * dL + da * da + db * db;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x < width - 1 && pairSq(refLab, i, i + 1) < FLAT_SQ) {
        flat += 1;
        if (pairSq(resLab, i, i + 1) > EDGE_SQ) phantom += 1;
      }
      if (y < height - 1 && pairSq(refLab, i, i + width) < FLAT_SQ) {
        flat += 1;
        if (pairSq(resLab, i, i + width) > EDGE_SQ) phantom += 1;
      }
    }
  }
  return flat === 0 ? 0 : phantom / flat;
}

/**
 * Palette recall: cluster the reference into its dominant coarse colors and ask
 * how close the *nearest color the result actually uses* comes to each, weighted
 * by coverage. This is the "regions keep their color" metric — a wholesale
 * region-color swap tanks it even when per-pixel ΔE stays moderate.
 */
function paletteRecall(refLab: Float32Array, resLab: Float32Array, n: number): number {
  // Dominant reference colors: coarse Oklab buckets with mean lab + coverage.
  const buckets = new Map<number, { L: number; a: number; b: number; count: number }>();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const L = refLab[o]!;
    const a = refLab[o + 1]!;
    const b = refLab[o + 2]!;
    const key =
      (Math.max(0, Math.min(24, Math.round(L * 24))) << 12) |
      (Math.max(0, Math.min(63, Math.round((a + 0.5) * 48))) << 6) |
      Math.max(0, Math.min(63, Math.round((b + 0.5) * 48)));
    const e = buckets.get(key);
    if (e) {
      e.L += L;
      e.a += a;
      e.b += b;
      e.count += 1;
    } else {
      buckets.set(key, { L, a, b, count: 1 });
    }
  }
  const dominant = [...buckets.values()]
    .filter((e) => e.count >= Math.max(4, n * 0.005))
    .sort((x, y) => y.count - x.count)
    .slice(0, 24);
  if (dominant.length === 0) return 1;

  // Distinct result colors (hardware palettes → few dozen at most).
  const resColors: Oklab[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const key =
      (Math.round(resLab[o]! * 512) << 20) ^
      (Math.round((resLab[o + 1]! + 0.5) * 512) << 10) ^
      Math.round((resLab[o + 2]! + 0.5) * 512);
    if (!seen.has(key)) {
      seen.add(key);
      resColors.push(labAt(resLab, i));
    }
  }

  let score = 0;
  let weight = 0;
  for (const d of dominant) {
    const target: Oklab = { L: d.L / d.count, a: d.a / d.count, b: d.b / d.count };
    let best = Infinity;
    for (const c of resColors) {
      const dL = target.L - c.L;
      const da = target.a - c.a;
      const db = target.b - c.b;
      const dist = dL * dL + da * da + db * db;
      if (dist < best) best = dist;
    }
    score += anchorGoodness(Math.sqrt(best), ANCHORS.palette) * d.count;
    weight += d.count;
  }
  return weight <= 0 ? 1 : score / weight;
}

/** Score result Oklab against reference Oklab (same dimensions). */
export function scoreLab(
  refLab: Float32Array,
  resLab: Float32Array,
  width: number,
  height: number,
  profile: "art" | "photo",
): JudgeResult {
  const n = width * height;
  const deltas = new Float32Array(n);
  let sum = 0;
  let refChroma = 0;
  let resChroma = 0;
  for (let i = 0; i < n; i += 1) {
    const r = labAt(refLab, i);
    const c = labAt(resLab, i);
    const dL = r.L - c.L;
    const da = r.a - c.a;
    const db = r.b - c.b;
    const de = Math.sqrt(dL * dL + da * da + db * db);
    deltas[i] = de;
    sum += de;
    refChroma += Math.sqrt(r.a * r.a + r.b * r.b);
    resChroma += Math.sqrt(c.a * c.a + c.b * c.b);
  }
  const mean = sum / n;
  const sorted = Float32Array.from(deltas).sort();
  const p95 = sorted[Math.min(n - 1, Math.floor(0.95 * n))]!;

  const structure = correlation01(
    gradientMag(refLab, width, height),
    gradientMag(resLab, width, height),
  );
  // Symmetric chroma fidelity: washing out *and* over-saturating both count.
  const gamut =
    refChroma <= 1e-6 && resChroma <= 1e-6
      ? 1
      : Math.min(refChroma, resChroma) / Math.max(refChroma, resChroma, 1e-6);

  const metrics: Record<MetricId, number> = {
    meanDeltaE: anchorGoodness(mean, ANCHORS.meanDeltaE),
    p95DeltaE: anchorGoodness(p95, ANCHORS.p95DeltaE),
    structure,
    gamut,
    hue: anchorGoodness(hueError(refLab, resLab, n), ANCHORS.hue),
    noise: anchorGoodness(phantomEdgeRate(refLab, resLab, width, height), ANCHORS.noise),
    palette: paletteRecall(refLab, resLab, n),
  };
  const aggregate = weightedGeoMean(metrics, WEIGHTS[profile]);
  return { aggregate, metrics, profile, width, height, rawMeanDeltaE: mean, rawP95DeltaE: p95 };
}

function anchorGoodness(value: number, anchor: number): number {
  return anchor / (anchor + value);
}

function weightedGeoMean(
  metrics: Record<MetricId, number>,
  weights: Record<MetricId, number>,
): number {
  let logSum = 0;
  let weightSum = 0;
  for (const id of Object.keys(metrics) as MetricId[]) {
    const v = Math.max(1e-6, Math.min(1, metrics[id]));
    const w = weights[id];
    logSum += w * log(v);
    weightSum += w;
  }
  return exp(logSum / weightSum);
}

/** Public `judge()` (doc 09): score any two image byte-buffers. */
export function judge(
  sourceBytes: Uint8Array,
  resultBytes: Uint8Array,
  options: { profile?: Profile } = {},
): JudgeResult {
  const result = decodeImage(resultBytes);
  const source = decodeImage(sourceBytes);
  const srcLin = normalize(source);
  const profile = options.profile && options.profile !== "auto" ? options.profile : "photo";
  const refLab = referenceLab(srcLin, result.width, result.height, profile);
  const resLab = labFromRgba(result);
  return scoreLab(refLab, resLab, result.width, result.height, profile);
}

/**
 * Build the fixed reference Oklab for a source at output dimensions. The
 * reference is fixed *per profile* — no candidate can game it by choosing its
 * own kernel: `art` uses the blend-free majority kernel (the reference is what
 * the art's flat colors look like at output size — a soft Lanczos reference
 * would penalize exactly the crispness flat art wants), `photo` uses Lanczos3
 * in linear light.
 */
export function referenceLab(
  source: LinImage,
  width: number,
  height: number,
  profile: "art" | "photo" = "photo",
): Float32Array {
  const ref = resize(source, width, height, profile === "art" ? "majority" : "lanczos3");
  return labFromLin(ref);
}

// Re-exported for reuse by prep without a second decode.
export { labFromRgba };
