/**
 * Deterministic math kernels (doc 02 §Floating-point discipline).
 *
 * `Math.exp/log/pow/cbrt/...` are implemented differently by each JS engine, so
 * their results can disagree at the 1-ulp level — a difference k-means then
 * amplifies into different palettes and thus different output bytes. The
 * `no-nondeterminism` lint rule bans them in core. These replacements are built
 * exclusively from IEEE-754 basic operations (`+ - * / sqrt` and integer
 * rounding), which every conformant engine computes bit-identically, so the
 * whole engine stays byte-for-byte reproducible across Node, browsers and OSes.
 *
 * Accuracy is not the point — *agreement* is. The series below are nonetheless
 * accurate to well under 1e-12 relative error across the argument ranges the
 * color pipeline uses, far tighter than 8-bit color needs.
 */

/** ln(2) to full double precision. */
const LN2 = 0.6931471805599453;
/** 1 / ln(2). */
const LOG2E = 1.4426950408889634;
/** π and related constants to full double precision. */
const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;

/**
 * Multiply `x` by an integer power of two, exactly.
 *
 * Powers of two are representable exactly in IEEE-754, and multiplying by them
 * only shifts the exponent, so this is lossless and engine-independent. Built
 * by repeated squaring to stay O(log|k|).
 */
function ldexp(x: number, k: number): number {
  if (k === 0 || x === 0 || !Number.isFinite(x)) {
    return x;
  }
  let result = x;
  let n = k < 0 ? -k : k;
  let base = k < 0 ? 0.5 : 2;
  while (n > 0) {
    if ((n & 1) === 1) {
      result *= base;
    }
    base *= base;
    n >>>= 1;
  }
  return result;
}

/**
 * Natural logarithm, deterministic.
 *
 * Decomposes `x = m · 2^e` with `m ∈ [√½, √2)` (an exponent range where the
 * `atanh` series converges fastest), then evaluates `ln(m)` via
 * `2·(s + s³/3 + s⁵/5 + …)` with `s = (m−1)/(m+1)`.
 */
export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) {
    return NaN;
  }
  if (x === 0) {
    return -Infinity;
  }
  if (x === Infinity) {
    return Infinity;
  }

  // frexp: bring the mantissa into [0.5, 1) by exact ×2 / ×0.5 steps.
  let m = x;
  let e = 0;
  while (m >= 1) {
    m *= 0.5;
    e += 1;
  }
  while (m < 0.5) {
    m *= 2;
    e -= 1;
  }
  // Recenter to [√½, √2) so |s| is small.
  if (m < 0.7071067811865476) {
    m *= 2;
    e -= 1;
  }

  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = 0;
  let k = 1;
  // ~20 terms is far more than needed for |s| < 0.18.
  for (let i = 0; i < 24; i += 1) {
    sum += term / k;
    term *= s2;
    k += 2;
  }
  return 2 * sum + e * LN2;
}

/**
 * Exponential function, deterministic.
 *
 * Range-reduces `x = k·ln2 + r` with `|r| ≤ ln2/2`, evaluates `exp(r)` by its
 * Taylor series (fast-converging on that interval), then scales by `2^k`.
 */
export function exp(x: number): number {
  if (Number.isNaN(x)) {
    return NaN;
  }
  if (x === Infinity) {
    return Infinity;
  }
  if (x === -Infinity) {
    return 0;
  }

  const k = Math.round(x * LOG2E);
  const r = x - k * LN2;

  // Taylor series for exp(r), r ∈ [-ln2/2, ln2/2].
  let term = 1;
  let sum = 1;
  for (let i = 1; i < 18; i += 1) {
    term *= r / i;
    sum += term;
  }
  return ldexp(sum, k);
}

/**
 * `base ** exponent`, deterministic, for the non-negative bases the color
 * pipeline uses (gamma curves). Integer exponents are handled exactly by
 * repeated squaring; everything else routes through `exp(exponent · log(base))`.
 */
export function pow(base: number, exponent: number): number {
  if (exponent === 0) {
    return 1;
  }
  if (base === 0) {
    return exponent > 0 ? 0 : Infinity;
  }
  if (Number.isInteger(exponent) && Math.abs(exponent) < 1024) {
    let result = 1;
    let b = base;
    let n = exponent < 0 ? -exponent : exponent;
    while (n > 0) {
      if ((n & 1) === 1) {
        result *= b;
      }
      b *= b;
      n = Math.floor(n / 2);
    }
    return exponent < 0 ? 1 / result : result;
  }
  if (base < 0) {
    return NaN;
  }
  return exp(exponent * log(base));
}

/**
 * Sine, deterministic. Range-reduces to `[-π/2, π/2]` (exact `Math.round` for
 * the quotient) then evaluates the Taylor series — accurate to ~1e-12 and, being
 * basic-op only, identical across engines. Needed by the Lanczos resampler.
 */
export function sin(x: number): number {
  if (!Number.isFinite(x)) {
    return NaN;
  }
  // Reduce to [-π, π].
  const k = Math.round(x / TWO_PI);
  let r = x - k * TWO_PI;
  // Fold into [-π/2, π/2] using sin(π − r) = sin(r).
  if (r > HALF_PI) {
    r = PI - r;
  } else if (r < -HALF_PI) {
    r = -PI - r;
  }
  const r2 = r * r;
  let term = r;
  let sum = r;
  for (let i = 1; i < 8; i += 1) {
    const denom = 2 * i * (2 * i + 1);
    term *= -r2 / denom;
    sum += term;
  }
  return sum;
}

/** Cosine, deterministic; defined via `cos(x) = sin(x + π/2)`. */
export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/**
 * Cube root, deterministic and defined for negative inputs.
 *
 * Seeds from `exp(log|x|/3)` (itself deterministic) and polishes with two
 * Newton–Raphson steps — pure basic ops, so the refinement is bit-exact.
 */
export function cbrt(x: number): number {
  if (x === 0 || Number.isNaN(x) || !Number.isFinite(x)) {
    return x;
  }
  const sign = x < 0 ? -1 : 1;
  const a = x < 0 ? -x : x;
  let r = exp(log(a) / 3);
  // Newton on f(r) = r³ − a: r ← r − (r³ − a)/(3r²) = (2r + a/r²)/3.
  r = (2 * r + a / (r * r)) / 3;
  r = (2 * r + a / (r * r)) / 3;
  return sign * r;
}
