/**
 * sRGB ↔ linear-light conversions (doc 04 §Stage 0).
 *
 * All resampling and averaging in the pipeline happens in linear light, so
 * every 8-bit sRGB source is decoded here and re-encoded only at Stage 7. The
 * gamma curve needs `pow`, which routes through the deterministic kernel so the
 * conversion is byte-reproducible across engines.
 */

import { pow } from "../math/kernels.js";

/** Decode one sRGB channel in [0,1] to linear light in [0,1]. */
export function srgbToLinear(c: number): number {
  if (c <= 0.04045) {
    return c / 12.92;
  }
  return pow((c + 0.055) / 1.055, 2.4);
}

/** Encode one linear-light channel in [0,1] to sRGB in [0,1]. */
export function linearToSrgb(c: number): number {
  if (c <= 0.0031308) {
    return 12.92 * c;
  }
  return 1.055 * pow(c, 1 / 2.4) - 0.055;
}

/** Convert an 8-bit sRGB byte (0–255) to a linear-light float (0–1). */
export function srgb8ToLinear(byte: number): number {
  return srgbToLinear(byte / 255);
}

/**
 * A remembered answer per linear value, because this is one of the hottest
 * functions in the engine and the same values arrive over and over.
 *
 * Every colour a fit snaps to the hardware lattice passes three values through
 * {@link linearToSrgb8} — per centroid, per iteration, per restart — and every
 * pixel of a picture passes three more. On a fixed-master console that was
 * 13 per cent of a whole tournament, because the deterministic `pow` kernel is
 * an eighteen-term series over a log and this calls it to choose one of 256
 * answers. A flat region of a picture, and a centroid that has stopped moving,
 * ask the same question thousands of times.
 *
 * **It is a cache and not a table, and the difference is forced.** The obvious
 * optimisation is that a monotone step function onto 256 values is 255
 * thresholds and a binary search — and it cannot be done here, because the
 * curve is *not* monotone at the last bit: `pow` is a series rather than a
 * correctly-rounded operation, so around a threshold the byte can step back down
 * as the input rises (`color.test.ts` §is not monotone at the last bit pins
 * three of them). No step function can reproduce that, so what is remembered is
 * the curve's own answer for an input it has already been given — exact by
 * construction, because a slot matches only on `===` and a hit therefore returns
 * precisely what the curve returned for that value.
 *
 * Direct-mapped and fixed-size, so it needs no eviction policy and cannot grow:
 * a collision is a miss, which costs a curve evaluation and is what would have
 * happened anyway. `NaN` never equals itself, so it always misses and always
 * reaches the curve — which is how it keeps returning what the curve returns for
 * it.
 */
const CACHE_BITS = 13;
const CACHE_MASK = (1 << CACHE_BITS) - 1;
/** Empty slots hold `NaN`, which no lookup can match. */
const cacheKeys = new Float64Array(CACHE_MASK + 1).fill(Number.NaN);
const cacheValues = new Uint8Array(CACHE_MASK + 1);
/** One buffer, read as a double and as its two halves — the bits are the hash. */
const hashBits = new Float64Array(1);
const hashWords = new Uint32Array(hashBits.buffer);

/** Convert a linear-light float (0–1) to an 8-bit sRGB byte (0–255). */
export function linearToSrgb8(c: number): number {
  hashBits[0] = c;
  // Mantissa and exponent halves mixed, then folded to the table's width.
  const mixed = Math.imul((hashWords[0] as number) ^ (hashWords[1] as number), 0x9e3779b1);
  const slot = (mixed ^ (mixed >>> CACHE_BITS)) & CACHE_MASK;
  if (cacheKeys[slot] === c) return cacheValues[slot] as number;
  const v = linearToSrgb(c <= 0 ? 0 : c >= 1 ? 1 : c);
  // Round-half-to-nearest; `Math.round` is exact/deterministic.
  const byte = Math.round(v * 255);
  const clamped = byte < 0 ? 0 : byte > 255 ? 255 : byte;
  // `NaN` in, `NaN` out — and never stored, because it would never be found.
  if (c === c) {
    cacheKeys[slot] = c;
    cacheValues[slot] = clamped;
  }
  return clamped;
}
