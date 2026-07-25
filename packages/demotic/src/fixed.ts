/**
 * 16.16 fixed-point arithmetic — the numeric substrate of the whole language.
 *
 * The load-bearing decision behind this prototype is *simulate constrained,
 * render unconstrained*: game state advances in integer fixed point on a fixed
 * logical tick, identically in the browser preview and (eventually) on console
 * hardware, so the two can be compared trace-for-trace. Only rendering is free
 * to be as high-resolution as it likes.
 *
 * That means no floats anywhere in the simulation. Values are plain JS numbers
 * holding *integers* scaled by 2^16.
 *
 * Range: every value is clamped to ±{@link MAX_UNITS} cells. That bound is not
 * cosmetic — it keeps `a * b` in {@link mul} below 2^52, inside the 53-bit
 * range where JS numbers are exact integers, so multiplication never silently
 * loses a bit. A console runtime would use 8.8 or 16.16 in registers; the same
 * bound applies there for the same reason.
 */

/** Number of fractional bits. */
export const FRAC_BITS = 16;

/** 1.0 in fixed point. */
export const ONE = 1 << FRAC_BITS;

/** Largest magnitude, in cells, any value may take (see file header). */
export const MAX_UNITS = 1024;

const MAX_FIXED = MAX_UNITS * ONE;

/** An integer holding a 16.16 fixed-point value. */
export type Fixed = number;

/** Exact conversion from an integer cell count. */
export function fromInt(n: number): Fixed {
  return clampFixed(n * ONE);
}

/**
 * Convert a decimal literal from source text. Rounds half away from zero so
 * `0.5` and `-0.5` are symmetric; parsing is the only place a non-integer
 * enters the system.
 */
export function fromDecimal(n: number): Fixed {
  const scaled = n * ONE;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return clampFixed(rounded);
}

/** Lossy conversion back to a JS number — for rendering and diagnostics only. */
export function toNumber(f: Fixed): number {
  return f / ONE;
}

/** Truncate toward negative infinity to a whole cell count. */
export function floorToInt(f: Fixed): number {
  return Math.floor(f / ONE);
}

/** Round half up to the nearest whole cell. */
export function roundToInt(f: Fixed): number {
  return Math.floor((f + ONE / 2) / ONE);
}

/**
 * Fixed-point multiply. Floors toward negative infinity — one rule, applied
 * everywhere, so a console runtime has a single behaviour to match.
 */
export function mul(a: Fixed, b: Fixed): Fixed {
  return clampFixed(Math.floor((a * b) / ONE));
}

/** Fixed-point divide, flooring toward negative infinity. Division by zero yields 0. */
export function div(a: Fixed, b: Fixed): Fixed {
  if (b === 0) return 0;
  return clampFixed(Math.floor((a * ONE) / b));
}

/** Clamp a raw fixed-point integer into the representable range. */
export function clampFixed(f: Fixed): Fixed {
  if (f > MAX_FIXED) return MAX_FIXED;
  if (f < -MAX_FIXED) return -MAX_FIXED;
  return f;
}

/** Clamp `f` into `[lo, hi]`. */
export function clamp(f: Fixed, lo: Fixed, hi: Fixed): Fixed {
  if (f < lo) return lo;
  if (f > hi) return hi;
  return f;
}

/** Format a fixed-point value for traces and error messages (4 decimal places). */
export function formatFixed(f: Fixed): string {
  const negative = f < 0;
  const magnitude = negative ? -f : f;
  const whole = Math.floor(magnitude / ONE);
  const frac = Math.floor(((magnitude % ONE) * 10000) / ONE);
  return `${negative && (whole !== 0 || frac !== 0) ? "-" : ""}${whole}.${String(frac).padStart(4, "0")}`;
}
