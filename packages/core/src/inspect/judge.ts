/**
 * The judge (doc 04 §The judge, §The objective).
 *
 * Scores a candidate output against the source for **perceived equivalence,
 * not per-pixel closeness**. Metrics come in two groups:
 *
 * - **Relational** metrics measure what the eye reads — separation, structure,
 *   ordering — scored *modulo an allowed grade*: before the aligned metrics run,
 *   the best bounded, globally coherent grade (isotonic monotone L curve +
 *   single bounded chroma gain) is fitted from reference to output and applied
 *   to the reference. A coherent artist-style exaggeration is then nearly free;
 *   incoherent error (hue swaps, merges, speckle) still costs full price.
 * - **Absolute** metrics anchor the output to the source's actual colors and
 *   bound the grade (raw ΔE, hue, gamut, palette recall, naturalness).
 *
 * **Palette pressure** — how far the console's affordable color count falls
 * short of the source's diversity — slides weight from the absolute group to
 * the relational group: DMG-from-photo judges on separation and structure,
 * round-tripping authored art judges on absolute fidelity.
 *
 * The reference is fixed per profile (majority kernel for `art`, Lanczos3 for
 * `photo`) so no candidate can game it. Metrics normalize to [0,1] against
 * fixed anchors and combine by **weighted geometric mean**, so one catastrophic
 * metric tanks the aggregate and cannot be averaged away.
 *
 * This is the same scorer the tournament uses internally and the CLI exposes
 * via `inspect --source` — tests, agents, and users measure exactly what
 * `prep` measured (doc 09 `judge()`).
 */

import { linearToOklab, type Oklab } from "../color/oklab.js";
import { srgb8ToLinear } from "../color/srgb.js";
import { exp, log } from "../math/kernels.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";
import { getConsole } from "../consoles/registry.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import { normalize } from "../pipeline/normalize.js";
import { resize } from "../pipeline/geometry.js";
import type { LinImage, Profile } from "../pipeline/types.js";

/** Metric identifiers (doc 04 §The judge — relational + absolute groups). */
export type MetricId =
  // Relational (grade-tolerant; weight grows with palette pressure).
  | "alignedMean"
  | "alignedP95"
  | "separation"
  | "contrast"
  | "ordering"
  | "structure"
  | "noise"
  // Absolute (anchor + guardrails; weight shrinks with pressure).
  | "meanDeltaE"
  | "p95DeltaE"
  | "hue"
  | "gamut"
  | "palette"
  | "natural";

/** Judge output for one image pair. */
export interface JudgeResult {
  aggregate: number;
  metrics: Record<MetricId, number>;
  profile: Profile;
  width: number;
  height: number;
  /** Palette pressure in [0,1] the weights were slid by (0 = no console context). */
  pressure: number;
  /** Raw (un-normalized) mean Oklab ΔE — surfaced in fit stats. */
  rawMeanDeltaE: number;
  /** Raw 95th-percentile Oklab ΔE. */
  rawP95DeltaE: number;
}

/** Fixed normalization anchors (calibrated on the Phase-2 eval battery). */
const ANCHORS = {
  alignedMean: 0.045,
  alignedP95: 0.15,
  separation: 0.22,
  contrast: 0.008,
  ordering: 0.1,
  meanDeltaE: 0.05,
  p95DeltaE: 0.16,
  hue: 0.25,
  noise: 0.02,
  palette: 0.05,
  natural: 1,
};

/** Allowed-grade bounds (doc 04 §The objective — "bounded coherent grade"). */
const GRADE_L_SHIFT_MAX = 0.18;
const GRADE_CHROMA_MIN = 0.75;
const GRADE_CHROMA_MAX = 1.6;

/**
 * Per-profile base metric weights (calibrated on the Phase-2 eval battery).
 * Palette pressure then slides them: relational weights grow with pressure,
 * absolute weights shrink (naturalness, the guardrail, grows slightly).
 */
const WEIGHTS: Record<"art" | "photo", Record<MetricId, number>> = {
  art: {
    alignedMean: 1,
    alignedP95: 0.8,
    separation: 1.3,
    contrast: 0.9,
    ordering: 0.9,
    structure: 1.2,
    noise: 1.3,
    meanDeltaE: 0.8,
    p95DeltaE: 0.6,
    hue: 1.1,
    gamut: 0.8,
    palette: 1.2,
    natural: 0.6,
  },
  photo: {
    alignedMean: 1.2,
    alignedP95: 0.9,
    separation: 0.9,
    contrast: 0.9,
    ordering: 0.8,
    structure: 1,
    noise: 0.4,
    meanDeltaE: 1.1,
    p95DeltaE: 0.8,
    hue: 0.9,
    gamut: 0.9,
    palette: 0.6,
    natural: 0.6,
  },
};

const RELATIONAL = new Set<MetricId>([
  "alignedMean",
  "alignedP95",
  "separation",
  "contrast",
  "ordering",
  "structure",
  "noise",
]);

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

// ---------------------------------------------------------------------------
// The allowed grade (doc 04 §The objective): the best bounded, globally
// coherent transform from reference to output — a monotone L curve (isotonic
// regression via pool-adjacent-violators over L bins) plus one chroma gain.
// ---------------------------------------------------------------------------

interface GradeFit {
  /** Reference labs with the fitted grade applied (what aligned ΔE compares against). */
  alignedRef: Float32Array;
  /** Fitted global chroma gain (clamped to the allowed range). */
  chromaGain: number;
  /** Mean |L shift| the fitted curve applies — the grade's tonal magnitude. */
  meanLShift: number;
}

const GRADE_BINS = 24;

function fitAllowedGrade(refLab: Float32Array, resLab: Float32Array, n: number): GradeFit {
  // Bin reference L; target = mean output L per bin.
  const sum = new Float64Array(GRADE_BINS);
  const cnt = new Float64Array(GRADE_BINS);
  let crossRef = 0;
  let refSq = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const bin = Math.max(0, Math.min(GRADE_BINS - 1, Math.floor(refLab[o]! * GRADE_BINS)));
    sum[bin]! += resLab[o]!;
    cnt[bin]! += 1;
    const refC = Math.sqrt(refLab[o + 1]! ** 2 + refLab[o + 2]! ** 2);
    const resC = Math.sqrt(resLab[o + 1]! ** 2 + resLab[o + 2]! ** 2);
    crossRef += refC * resC;
    refSq += refC * refC;
  }

  // Bin means; empty bins interpolate from filled neighbors afterwards.
  const value = new Float64Array(GRADE_BINS).fill(NaN);
  for (let b = 0; b < GRADE_BINS; b += 1) {
    if (cnt[b]! > 0) value[b] = sum[b]! / cnt[b]!;
  }
  // Pool-adjacent-violators: enforce a monotone non-decreasing curve.
  const blocks: Array<{ v: number; w: number; span: number }> = [];
  for (let b = 0; b < GRADE_BINS; b += 1) {
    if (Number.isNaN(value[b]!)) continue;
    blocks.push({ v: value[b]!, w: cnt[b]!, span: 1 });
    while (blocks.length >= 2 && blocks[blocks.length - 2]!.v > blocks[blocks.length - 1]!.v) {
      const hi = blocks.pop()!;
      const lo = blocks.pop()!;
      blocks.push({
        v: (lo.v * lo.w + hi.v * hi.w) / (lo.w + hi.w),
        w: lo.w + hi.w,
        span: lo.span + hi.span,
      });
    }
  }
  // Expand blocks back to per-bin values, then fill empty bins by carry.
  const curve = new Float64Array(GRADE_BINS).fill(NaN);
  let bi = 0;
  let filled = 0;
  for (let b = 0; b < GRADE_BINS && bi < blocks.length; b += 1) {
    if (Number.isNaN(value[b]!)) continue;
    curve[b] = blocks[bi]!.v;
    filled += 1;
    if (filled >= blocks[bi]!.span) {
      bi += 1;
      filled = 0;
    }
  }
  let last = NaN;
  for (let b = 0; b < GRADE_BINS; b += 1) {
    if (!Number.isNaN(curve[b]!)) last = curve[b]!;
    else if (!Number.isNaN(last)) curve[b] = last;
  }
  for (let b = GRADE_BINS - 1; b >= 0; b -= 1) {
    if (!Number.isNaN(curve[b]!)) last = curve[b]!;
    else if (!Number.isNaN(last)) curve[b] = last;
  }

  const chromaGain =
    refSq <= 1e-9 ? 1 : Math.max(GRADE_CHROMA_MIN, Math.min(GRADE_CHROMA_MAX, crossRef / refSq));

  // Apply the bounded grade to the reference.
  const alignedRef = new Float32Array(n * 3);
  let shiftSum = 0;
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const L0 = refLab[o]!;
    // Piecewise-linear interpolation between bin centers.
    const t = Math.max(0, Math.min(GRADE_BINS - 1e-6, L0 * GRADE_BINS - 0.5));
    const b0 = Math.max(0, Math.min(GRADE_BINS - 1, Math.floor(t)));
    const b1 = Math.min(GRADE_BINS - 1, b0 + 1);
    const frac = t - b0;
    const target = Number.isNaN(curve[b0]!)
      ? L0
      : curve[b0]! * (1 - frac) + (Number.isNaN(curve[b1]!) ? curve[b0]! : curve[b1]!) * frac;
    const shift = Math.max(-GRADE_L_SHIFT_MAX, Math.min(GRADE_L_SHIFT_MAX, target - L0));
    alignedRef[o] = L0 + shift;
    alignedRef[o + 1] = refLab[o + 1]! * chromaGain;
    alignedRef[o + 2] = refLab[o + 2]! * chromaGain;
    shiftSum += Math.abs(shift);
  }
  return { alignedRef, chromaGain, meanLShift: n > 0 ? shiftSum / n : 0 };
}

// ---------------------------------------------------------------------------
// Relational metrics
// ---------------------------------------------------------------------------

/**
 * Asymmetric local-contrast loss: mean shortfall of the output's 3×3 L
 * standard deviation versus the reference's. Flattening (lost shading, merged
 * texture) is penalized; extra contrast is the allowed grade's business and
 * costs nothing here.
 */
function contrastLoss(
  refLab: Float32Array,
  resLab: Float32Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let lossSum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let rs = 0;
      let rs2 = 0;
      let os = 0;
      let os2 = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const o = ((y + dy) * width + (x + dx)) * 3;
          const rv = refLab[o]!;
          const ov = resLab[o]!;
          rs += rv;
          rs2 += rv * rv;
          os += ov;
          os2 += ov * ov;
        }
      }
      const rVar = Math.max(0, rs2 / 9 - (rs / 9) ** 2);
      const oVar = Math.max(0, os2 / 9 - (os / 9) ** 2);
      lossSum += Math.max(0, Math.sqrt(rVar) - Math.sqrt(oVar));
      count += 1;
    }
  }
  return count > 0 ? lossSum / count : 0;
}

/**
 * Ramp-ordering violation rate: among neighbor pairs with a *significant*
 * reference L step, the fraction whose step the output flips or collapses.
 * Invariant to any monotone tone curve by construction — exaggerating a ramp
 * is free, reordering or flattening it is not.
 */
function orderingError(
  refLab: Float32Array,
  resLab: Float32Array,
  width: number,
  height: number,
): number {
  const SIGNIFICANT = 0.04;
  const COLLAPSED = 0.004;
  let significant = 0;
  let violations = 0;
  const check = (i: number, j: number): void => {
    const dRef = refLab[j * 3]! - refLab[i * 3]!;
    if (Math.abs(dRef) < SIGNIFICANT) return;
    significant += 1;
    const dOut = resLab[j * 3]! - resLab[i * 3]!;
    if (Math.abs(dOut) < COLLAPSED || dOut * dRef < 0) violations += 1;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x < width - 1) check(i, i + 1);
      if (y < height - 1) check(i, i + width);
    }
  }
  return significant === 0 ? 0 : violations / significant;
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

// ---------------------------------------------------------------------------
// Dominant-color machinery shared by palette recall and separation retention
// ---------------------------------------------------------------------------

interface DominantColor extends Oklab {
  /** Pixel-count coverage of this color's bucket. */
  count: number;
}

/** Dominant reference colors: coarse Oklab buckets with mean lab + coverage. */
function dominantColors(refLab: Float32Array, n: number, minShare: number): DominantColor[] {
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
  return [...buckets.values()]
    .filter((e) => e.count >= Math.max(4, n * minShare))
    .sort((x, y) => y.count - x.count)
    .slice(0, 24)
    .map((e) => ({ L: e.L / e.count, a: e.a / e.count, b: e.b / e.count, count: e.count }));
}

/** Distinct output colors (hardware palettes → a few dozen at most). */
function distinctResultColors(resLab: Float32Array, n: number): Oklab[] {
  const out: Oklab[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const key =
      (Math.round(resLab[o]! * 512) << 20) ^
      (Math.round((resLab[o + 1]! + 0.5) * 512) << 10) ^
      Math.round((resLab[o + 2]! + 0.5) * 512);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(labAt(resLab, i));
    }
  }
  return out;
}

function dist(a: Oklab, b: Oklab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function nearestOf(target: Oklab, colors: Oklab[]): Oklab {
  let best = colors[0]!;
  let bestD = Infinity;
  for (const c of colors) {
    const d = dist(target, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Palette recall: how close the *nearest color the result actually uses* comes
 * to each dominant source color, weighted by coverage. This is the "regions
 * keep their color" metric in absolute space — a wholesale region-color swap
 * tanks it even when per-pixel ΔE stays moderate, and it is what stops the
 * allowed grade from silently walking brand colors away.
 */
function paletteRecall(dominant: DominantColor[], resColors: Oklab[]): number {
  if (dominant.length === 0 || resColors.length === 0) return 1;
  let score = 0;
  let weight = 0;
  for (const d of dominant) {
    const near = nearestOf(d, resColors);
    score += anchorGoodness(dist(d, near), ANCHORS.palette) * d.count;
    weight += d.count;
  }
  return weight <= 0 ? 1 : score / weight;
}

/**
 * Separation retention (asymmetric — doc 04 §The objective "separation beats
 * accuracy"): for pairs of dominant source colors, measure how much of their
 * distance the output *loses* once each is mapped to the nearest color the
 * output actually uses. Two regions collapsing onto one output color is the
 * real quantization damage and scores shrink = 1; *increasing* their distance
 * (artist-style exaggeration) costs nothing. Nearby pairs — the ones at risk
 * of merging — carry the most weight.
 */
function separationError(dominant: DominantColor[], resColors: Oklab[]): number {
  if (dominant.length < 2 || resColors.length === 0) return 0;
  const NEAR = 0.4; // pairs further apart than this are in no danger
  let errSum = 0;
  let weightSum = 0;
  for (let i = 0; i < dominant.length; i += 1) {
    for (let j = i + 1; j < dominant.length; j += 1) {
      const a = dominant[i]!;
      const b = dominant[j]!;
      const dRef = dist(a, b);
      if (dRef <= 0.02 || dRef >= NEAR) continue;
      const dOut = dist(nearestOf(a, resColors), nearestOf(b, resColors));
      const shrink = Math.max(0, 1 - dOut / dRef);
      const w = Math.min(a.count, b.count) * (1 - dRef / NEAR);
      errSum += shrink * w;
      weightSum += w;
    }
  }
  return weightSum <= 1e-9 ? 0 : errSum / weightSum;
}

// ---------------------------------------------------------------------------
// Palette pressure
// ---------------------------------------------------------------------------

/** Total distinct colors a console's layout can afford on screen at once. */
export function affordableColors(spec: ConsoleSpec): number {
  if (spec.color.model === "mono") return spec.color.shades ?? 4;
  if (spec.layout.kind === "scanline") {
    // TMS row-pair: 15 usable master colors (transparent excluded).
    return 15;
  }
  if (spec.layout.kind === "tiles") {
    const layout = spec.layout as TileLayout;
    const { count, size, sharedIndex0 } = layout.subPalettes;
    return sharedIndex0 !== undefined ? count * (size - 1) + 1 : count * size;
  }
  return 32;
}

/**
 * Palette pressure (doc 04 §The objective): 0 when the console can afford the
 * source's color diversity, approaching 1 as the affordable count falls short.
 * Diversity = coarse Oklab buckets covering ≥0.25% of the reference each —
 * uncapped, unlike {@link dominantColors} (whose top-24 cap exists only to
 * bound pairwise metric cost).
 */
export function palettePressure(refLab: Float32Array, n: number, spec: ConsoleSpec): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    const key =
      (Math.max(0, Math.min(24, Math.round(refLab[o]! * 24))) << 12) |
      (Math.max(0, Math.min(63, Math.round((refLab[o + 1]! + 0.5) * 48))) << 6) |
      Math.max(0, Math.min(63, Math.round((refLab[o + 2]! + 0.5) * 48)));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(4, n * 0.0025);
  let diversity = 0;
  for (const c of counts.values()) if (c >= threshold) diversity += 1;
  const affordable = affordableColors(spec);
  if (diversity <= affordable) return 0;
  return Math.max(0, Math.min(1, 1 - affordable / diversity));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Score result Oklab against reference Oklab (same dimensions). */
export function scoreLab(
  refLab: Float32Array,
  resLab: Float32Array,
  width: number,
  height: number,
  profile: "art" | "photo",
  pressure = 0,
): JudgeResult {
  const n = width * height;

  // Raw (absolute) ΔE + chroma sums.
  const deltas = new Float32Array(n);
  let sum = 0;
  let refChroma = 0;
  let resChroma = 0;
  for (let i = 0; i < n; i += 1) {
    const r = labAt(refLab, i);
    const c = labAt(resLab, i);
    const de = dist(r, c);
    deltas[i] = de;
    sum += de;
    refChroma += Math.sqrt(r.a * r.a + r.b * r.b);
    resChroma += Math.sqrt(c.a * c.a + c.b * c.b);
  }
  const mean = sum / n;
  const sorted = Float32Array.from(deltas).sort();
  const p95 = sorted[Math.min(n - 1, Math.floor(0.95 * n))]!;

  // Grade-aligned ΔE: residual after the best allowed grade.
  const grade = fitAllowedGrade(refLab, resLab, n);
  let alignedSum = 0;
  const alignedDeltas = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const de = dist(labAt(grade.alignedRef, i), labAt(resLab, i));
    alignedDeltas[i] = de;
    alignedSum += de;
  }
  const alignedMean = alignedSum / n;
  const alignedSorted = Float32Array.from(alignedDeltas).sort();
  const alignedP95 = alignedSorted[Math.min(n - 1, Math.floor(0.95 * n))]!;

  // Naturalness: the fitted grade's own magnitude — big tonal shifts and
  // chroma gains approaching the bound read as garish, not graded.
  const naturalCost =
    Math.min(2, grade.meanLShift / 0.12) + Math.min(2, Math.abs(grade.chromaGain - 1) / 0.45);

  const structure = correlation01(
    gradientMag(refLab, width, height),
    gradientMag(resLab, width, height),
  );
  // Symmetric chroma fidelity: washing out *and* over-saturating both count.
  const gamut =
    refChroma <= 1e-6 && resChroma <= 1e-6
      ? 1
      : Math.min(refChroma, resChroma) / Math.max(refChroma, resChroma, 1e-6);

  const dominant = dominantColors(refLab, n, 0.005);
  const resColors = distinctResultColors(resLab, n);

  const metrics: Record<MetricId, number> = {
    alignedMean: anchorGoodness(alignedMean, ANCHORS.alignedMean),
    alignedP95: anchorGoodness(alignedP95, ANCHORS.alignedP95),
    separation: anchorGoodness(separationError(dominant, resColors), ANCHORS.separation),
    contrast: anchorGoodness(contrastLoss(refLab, resLab, width, height), ANCHORS.contrast),
    ordering: anchorGoodness(orderingError(refLab, resLab, width, height), ANCHORS.ordering),
    structure,
    noise: anchorGoodness(phantomEdgeRate(refLab, resLab, width, height), ANCHORS.noise),
    meanDeltaE: anchorGoodness(mean, ANCHORS.meanDeltaE),
    p95DeltaE: anchorGoodness(p95, ANCHORS.p95DeltaE),
    hue: anchorGoodness(hueError(refLab, resLab, n), ANCHORS.hue),
    gamut,
    palette: paletteRecall(dominant, resColors),
    natural: anchorGoodness(naturalCost, ANCHORS.natural),
  };
  const aggregate = weightedGeoMean(metrics, WEIGHTS[profile], pressure);
  return {
    aggregate,
    metrics,
    profile,
    width,
    height,
    pressure,
    rawMeanDeltaE: mean,
    rawP95DeltaE: p95,
  };
}

function anchorGoodness(value: number, anchor: number): number {
  return anchor / (anchor + value);
}

/**
 * Weighted geometric mean with palette-pressure weight sliding (doc 04 §The
 * objective): relational weights grow with pressure, absolute weights shrink;
 * the naturalness guardrail grows slightly (grading is likelier under
 * pressure, so its bound matters more).
 */
function weightedGeoMean(
  metrics: Record<MetricId, number>,
  weights: Record<MetricId, number>,
  pressure: number,
): number {
  const p = Math.max(0, Math.min(1, pressure));
  let logSum = 0;
  let weightSum = 0;
  for (const id of Object.keys(metrics) as MetricId[]) {
    const v = Math.max(1e-6, Math.min(1, metrics[id]));
    let w = weights[id];
    if (RELATIONAL.has(id)) w *= 1 + 0.8 * p;
    else if (id === "natural") w *= 1 + 0.3 * p;
    else w *= Math.max(0.25, 1 - 0.7 * p);
    logSum += w * log(v);
    weightSum += w;
  }
  return exp(logSum / weightSum);
}

/** Public `judge()` (doc 09): score any two image byte-buffers. */
export function judge(
  sourceBytes: Uint8Array,
  resultBytes: Uint8Array,
  options: { profile?: Profile; console?: string } = {},
): JudgeResult {
  const result = decodeImage(resultBytes);
  const source = decodeImage(sourceBytes);
  const srcLin = normalize(source);
  const profile = options.profile && options.profile !== "auto" ? options.profile : "photo";
  const refLab = referenceLab(srcLin, result.width, result.height, profile);
  const resLab = labFromRgba(result);
  const pressure = options.console
    ? palettePressure(refLab, result.width * result.height, getConsole(options.console))
    : 0;
  return scoreLab(refLab, resLab, result.width, result.height, profile, pressure);
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
