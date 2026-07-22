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

/** Convert a linear-light float (0–1) to an 8-bit sRGB byte (0–255). */
export function linearToSrgb8(c: number): number {
  const v = linearToSrgb(c <= 0 ? 0 : c >= 1 ? 1 : c);
  // Round-half-to-nearest; `Math.round` is exact/deterministic.
  const byte = Math.round(v * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}
