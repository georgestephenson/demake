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
export type MetricId = "meanDeltaE" | "p95DeltaE" | "structure" | "gamut";

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

/** Fixed normalization anchors (provisional; calibrated & frozen in Phase 2). */
const ANCHORS = { meanDeltaE: 0.05, p95DeltaE: 0.16 };

/** Per-profile metric weights (provisional; calibrated & frozen in Phase 2). */
const WEIGHTS: Record<"art" | "photo", Record<MetricId, number>> = {
  art: { meanDeltaE: 1, p95DeltaE: 1.1, structure: 1.4, gamut: 0.7 },
  photo: { meanDeltaE: 1.3, p95DeltaE: 1, structure: 1, gamut: 1 },
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
  const gamut = refChroma <= 1e-6 ? 1 : Math.min(1, resChroma / refChroma);

  const metrics: Record<MetricId, number> = {
    meanDeltaE: anchorGoodness(mean, ANCHORS.meanDeltaE),
    p95DeltaE: anchorGoodness(p95, ANCHORS.p95DeltaE),
    structure,
    gamut,
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
  const refLin = resize(srcLin, result.width, result.height, "lanczos3");
  const refLab = labFromLin(refLin);
  const resLab = labFromRgba(result);
  const profile = options.profile && options.profile !== "auto" ? options.profile : "photo";
  return scoreLab(refLab, resLab, result.width, result.height, profile);
}

/** Build the fixed reference Oklab for a source at output dimensions. */
export function referenceLab(source: LinImage, width: number, height: number): Float32Array {
  const ref = resize(source, width, height, "lanczos3");
  return labFromLin(ref);
}

// Re-exported for reuse by prep without a second decode.
export { labFromRgba };
