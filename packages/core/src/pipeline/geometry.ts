/**
 * Stage 2 — geometry (doc 04 §Stage 2).
 *
 * Chooses the output size and resamples to it. The default (no `--size`) keeps
 * source dimensions when they already fit the console, otherwise scales down to
 * the largest aspect-preserving size on the tile granularity, never upscaling.
 * Kernels: `nearest`, `box` (area average — the photo default here), `majority`
 * (per-block modal color, the `art` default and the predecessor method), and
 * `lanczos3` (separable, in linear light).
 */

import { sin } from "../math/kernels.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import type { LinImage, ScaleKernel } from "./types.js";

/**
 * Granularity (px) the output width/height must be a multiple of: the attribute
 * *cell* size, so every pixel belongs to a fully-covered palette cell. The
 * attribute size is always a multiple of the tile size (e.g. NES 16×16 cells
 * over 8×8 tiles), so this also satisfies tile alignment. For the GB family
 * (cell == tile) it is just the tile size.
 */
function tileGranularity(spec: ConsoleSpec): { w: number; h: number } {
  if (spec.layout.kind === "tiles") {
    const t = spec.layout as TileLayout;
    return { w: Math.max(t.tileW, t.attribute.w), h: Math.max(t.tileH, t.attribute.h) };
  }
  return { w: 1, h: 1 };
}

function floorToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

/**
 * Compute the automatic output size (doc 04 §Stage 2, "no size given"): keep the
 * source 1:1 if it already displays, else the largest aspect-fit that fits the
 * console, rounded down to tile granularity, never upscaled.
 */
export function chooseAutoSize(
  srcW: number,
  srcH: number,
  spec: ConsoleSpec,
): { w: number; h: number } {
  const maxW = spec.display.width;
  const maxH = spec.display.height;
  const gran = tileGranularity(spec);

  if (srcW <= maxW && srcH <= maxH && srcW % gran.w === 0 && srcH % gran.h === 0) {
    return { w: srcW, h: srcH };
  }
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const w = floorToMultiple(Math.round(srcW * scale), gran.w);
  const h = floorToMultiple(Math.round(srcH * scale), gran.h);
  return { w: Math.min(w, maxW), h: Math.min(h, maxH) };
}

/** Snap an explicit target size to tile granularity and clamp to the display. */
export function snapExplicitSize(
  w: number,
  h: number,
  spec: ConsoleSpec,
): { w: number; h: number } {
  const gran = tileGranularity(spec);
  return {
    w: Math.min(spec.display.width, floorToMultiple(w, gran.w)),
    h: Math.min(spec.display.height, floorToMultiple(h, gran.h)),
  };
}

/** Resample `img` to `w × h` using the given kernel. */
export function resize(img: LinImage, w: number, h: number, kernel: ScaleKernel): LinImage {
  if (w === img.width && h === img.height) {
    return img;
  }
  switch (kernel) {
    case "nearest":
      return resampleNearest(img, w, h);
    case "majority":
      return resampleMajority(img, w, h);
    case "lanczos3":
      return resampleSeparable(img, w, h, lanczos3, 3);
    case "box":
    case "auto":
    default:
      return resampleSeparable(img, w, h, boxKernel, 0.5);
  }
}

function resampleNearest(img: LinImage, w: number, h: number): LinImage {
  const out = new Float32Array(w * h * 3);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y += 1) {
    const srcY = Math.min(img.height - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < w; x += 1) {
      const srcX = Math.min(img.width - 1, Math.floor((x + 0.5) * sx));
      const si = (srcY * img.width + srcX) * 3;
      const oi = (y * w + x) * 3;
      out[oi] = img.data[si]!;
      out[oi + 1] = img.data[si + 1]!;
      out[oi + 2] = img.data[si + 2]!;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Per-output-block modal color with mean-nearest tiebreak (doc 04). Colors are
 * bucketed on a coarse 6-bit-per-channel key so anti-aliased near-duplicates
 * vote together; the winner is the actual pixel closest to the block mean among
 * the modal bucket — so the output never invents a blend color.
 */
function resampleMajority(img: LinImage, w: number, h: number): LinImage {
  const out = new Float32Array(w * h * 3);
  const sx = img.width / w;
  const sy = img.height / h;
  const counts = new Map<number, number>();
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      counts.clear();
      let mr = 0;
      let mg = 0;
      let mb = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < img.width; xx += 1) {
          const si = (yy * img.width + xx) * 3;
          const r = img.data[si]!;
          const g = img.data[si + 1]!;
          const b = img.data[si + 2]!;
          const key = quantKey(r, g, b);
          counts.set(key, (counts.get(key) ?? 0) + 1);
          mr += r;
          mg += g;
          mb += b;
          n += 1;
        }
      }
      if (n === 0) continue;
      mr /= n;
      mg /= n;
      mb /= n;
      let bestKey = -1;
      let bestCount = -1;
      for (const [key, c] of counts) {
        if (c > bestCount || (c === bestCount && key < bestKey)) {
          bestCount = c;
          bestKey = key;
        }
      }
      // Pick the actual pixel in the winning bucket nearest the block mean.
      let bestR = mr;
      let bestG = mg;
      let bestB = mb;
      let bestDist = Infinity;
      for (let yy = y0; yy < y1 && yy < img.height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < img.width; xx += 1) {
          const si = (yy * img.width + xx) * 3;
          const r = img.data[si]!;
          const g = img.data[si + 1]!;
          const b = img.data[si + 2]!;
          if (quantKey(r, g, b) !== bestKey) continue;
          const d = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2;
          if (d < bestDist) {
            bestDist = d;
            bestR = r;
            bestG = g;
            bestB = b;
          }
        }
      }
      const oi = (y * w + x) * 3;
      out[oi] = bestR;
      out[oi + 1] = bestG;
      out[oi + 2] = bestB;
    }
  }
  return { width: w, height: h, data: out };
}

function quantKey(r: number, g: number, b: number): number {
  const rc = Math.min(63, Math.max(0, Math.round(r * 63)));
  const gc = Math.min(63, Math.max(0, Math.round(g * 63)));
  const bc = Math.min(63, Math.max(0, Math.round(b * 63)));
  return (rc << 12) | (gc << 6) | bc;
}

type Kernel = (t: number) => number;

function lanczos3(t: number): number {
  const a = 3;
  if (t === 0) return 1;
  if (t <= -a || t >= a) return 0;
  // Math.PI is a deterministic constant (a property, not a banned transcendental
  // call); the deterministic `sin` kernel supplies the non-constant part.
  const pt = Math.PI * t;
  return (a * sin(pt) * sin(pt / a)) / (pt * pt);
}

function boxKernel(t: number): number {
  return t > -0.5 && t <= 0.5 ? 1 : 0;
}

/** Generic separable resampler (linear light) for `box`/`lanczos3`. */
function resampleSeparable(
  img: LinImage,
  w: number,
  h: number,
  kernel: Kernel,
  support: number,
): LinImage {
  const horiz = resampleAxis(img.data, img.width, img.height, w, kernel, support, true);
  const both = resampleAxis(horiz, w, img.height, h, kernel, support, false);
  return { width: w, height: h, data: both };
}

/**
 * Resample one axis. `horizontal` scales width (input rows of `srcLen`), else
 * height. Weights are normalized per output sample; the kernel is stretched by
 * the downscale factor so downsampling low-pass filters correctly.
 */
function resampleAxis(
  data: Float32Array,
  width: number,
  height: number,
  outLen: number,
  kernel: Kernel,
  support: number,
  horizontal: boolean,
): Float32Array {
  const inLen = horizontal ? width : height;
  const scale = outLen / inLen;
  const filterScale = scale < 1 ? scale : 1;
  const filterSupport = support / filterScale;
  const outWidth = horizontal ? outLen : width;
  const outHeight = horizontal ? height : outLen;
  const out = new Float32Array(outWidth * outHeight * 3);

  for (let o = 0; o < outLen; o += 1) {
    const center = (o + 0.5) / scale;
    const start = Math.max(0, Math.floor(center - filterSupport));
    const end = Math.min(inLen - 1, Math.ceil(center + filterSupport));
    let weightSum = 0;
    const weights: number[] = [];
    for (let i = start; i <= end; i += 1) {
      const wgt = kernel((i + 0.5 - center) * filterScale);
      weights.push(wgt);
      weightSum += wgt;
    }
    if (weightSum === 0) weightSum = 1;

    if (horizontal) {
      for (let y = 0; y < height; y += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = start, k = 0; i <= end; i += 1, k += 1) {
          const si = (y * width + i) * 3;
          const wgt = weights[k]!;
          r += data[si]! * wgt;
          g += data[si + 1]! * wgt;
          b += data[si + 2]! * wgt;
        }
        const oi = (y * outWidth + o) * 3;
        out[oi] = r / weightSum;
        out[oi + 1] = g / weightSum;
        out[oi + 2] = b / weightSum;
      }
    } else {
      for (let x = 0; x < width; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = start, k = 0; i <= end; i += 1, k += 1) {
          const si = (i * width + x) * 3;
          const wgt = weights[k]!;
          r += data[si]! * wgt;
          g += data[si + 1]! * wgt;
          b += data[si + 2]! * wgt;
        }
        const oi = (o * outWidth + x) * 3;
        out[oi] = r / weightSum;
        out[oi + 1] = g / weightSum;
        out[oi + 2] = b / weightSum;
      }
    }
  }
  return out;
}
