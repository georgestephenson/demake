/**
 * Oklab color space (Björn Ottosson, 2020) — doc 04 §Color distance.
 *
 * Oklab is the pipeline's working perceptual space: k-means means behave well
 * in it, and perceptual distance is a simple weighted Euclidean metric. The
 * forward transform needs `cbrt`; both directions route through the
 * deterministic kernels so palettes are reproducible across engines.
 *
 * Inputs and outputs on the linear-RGB side are linear-light in [0,1].
 */

import { cbrt } from "../math/kernels.js";

/** A color in Oklab: L (lightness), a (green–red), b (blue–yellow). */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** Convert linear-light sRGB (0–1) to Oklab. */
export function linearToOklab(r: number, g: number, b: number): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = cbrt(l);
  const m_ = cbrt(m);
  const s_ = cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** Convert Oklab back to linear-light sRGB (0–1); may fall outside gamut. */
export function oklabToLinear(lab: Oklab): { r: number; g: number; b: number } {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/**
 * Weighted squared Oklab distance between two colors.
 *
 * `lWeight` slightly above 1 protects contrast/edges for the `art` profile
 * (doc 04 §Color distance); the default 1 is plain perceptual distance. Squared
 * (no `sqrt`) because callers only ever compare distances.
 */
export function deltaESq(x: Oklab, y: Oklab, lWeight = 1): number {
  const dL = x.L - y.L;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return lWeight * dL * dL + da * da + db * db;
}
