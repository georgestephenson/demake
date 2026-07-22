/**
 * Seeded pseudo-random number generator (doc 02 §Image codecs and determinism).
 *
 * The tournament's randomized stages — k-means initialization, restart jitter,
 * annealing moves — must be reproducible, so they draw from this PRNG rather
 * than the banned `Math.random`. It is a PCG32 (`XSH RR`, O'Neill 2014): tiny
 * state, good statistical quality, and trivially reproducible from a `u64` seed.
 *
 * All arithmetic is done in 32-bit halves with `Math.imul` because JavaScript
 * has no native 64-bit integer math on `number`; the halves are recombined so
 * the stream matches the canonical PCG32 reference exactly.
 */

const MUL_HI = 0x5851f42d;
const MUL_LO = 0x4c957f2d;
const INC_HI = 0x14057b7e;
const INC_LO = 0xf767814f;

/** A deterministic PCG32 stream. Construct via {@link makePrng}. */
export interface Prng {
  /** Next unsigned 32-bit integer in the stream. */
  nextU32(): number;
  /** Next float in [0, 1) with 32 bits of entropy. */
  next(): number;
  /** Uniform integer in [0, bound); `bound` must be a positive integer. */
  nextInt(bound: number): number;
}

/** 64-bit LCG state held as two 32-bit halves (hi, lo), both unsigned. */
interface State {
  hi: number;
  lo: number;
}

/** state = state * MUL + INC, all modulo 2^64, using 32-bit limbs. */
function advance(state: State): void {
  const { hi, lo } = state;
  // 64-bit multiply of (hi:lo) by (MUL_HI:MUL_LO), keeping the low 64 bits.
  const lolo = Math.imul(lo, MUL_LO) >>> 0;
  const carry = mulHigh(lo, MUL_LO);
  const cross = (Math.imul(lo, MUL_HI) + Math.imul(hi, MUL_LO)) >>> 0;
  let newHi = (carry + cross) >>> 0;
  let newLo = lolo;

  // Add the increment (64-bit).
  const sumLo = (newLo + INC_LO) >>> 0;
  const addCarry = sumLo < newLo ? 1 : 0;
  newLo = sumLo;
  newHi = (newHi + INC_HI + addCarry) >>> 0;

  state.hi = newHi;
  state.lo = newLo;
}

/** High 32 bits of the unsigned 32×32→64 product a·b. */
function mulHigh(a: number, b: number): number {
  const aLo = a & 0xffff;
  const aHi = a >>> 16;
  const bLo = b & 0xffff;
  const bHi = b >>> 16;
  const lo = aLo * bLo;
  const mid1 = aHi * bLo;
  const mid2 = aLo * bHi;
  const hi = aHi * bHi;
  const carry = ((lo >>> 16) + (mid1 & 0xffff) + (mid2 & 0xffff)) >>> 16;
  return (hi + (mid1 >>> 16) + (mid2 >>> 16) + carry) >>> 0;
}

/**
 * PCG32 output function (`XSH RR`) on the 64-bit state held as (hi, lo).
 *
 * `xorshifted = ((state >> 18) ^ state) >> 27` (its low 32 bits), then rotate
 * right by `rot = state >> 59`. All computed with 32-bit limb shifts.
 */
function output(state: State): number {
  const { hi, lo } = state;
  // v = (state >> 18) ^ state, as two 32-bit limbs.
  const vLo = (((lo >>> 18) | (hi << 14)) ^ lo) >>> 0;
  const vHi = ((hi >>> 18) ^ hi) >>> 0;
  // xorshifted = low 32 bits of (v >> 27).
  const xorshifted = ((vLo >>> 27) | (vHi << 5)) >>> 0;
  const rot = hi >>> 27; // state >> 59
  return rotr32(xorshifted, rot);
}

/** Rotate a 32-bit value right by `r` bits. */
function rotr32(value: number, r: number): number {
  const rr = r & 31;
  if (rr === 0) {
    return value >>> 0;
  }
  return ((value >>> rr) | (value << (32 - rr))) >>> 0;
}

/**
 * Create a deterministic PCG32 stream from a numeric seed. The same seed always
 * yields the same sequence on every engine.
 */
export function makePrng(seed: number): Prng {
  // Fold the (possibly large) seed into a 64-bit initial state, then run the
  // standard PCG seeding routine (step, add seedseq, step).
  const s = seed >>> 0;
  const sHi = Math.floor(seed / 0x100000000) >>> 0;
  const state: State = { hi: 0, lo: 0 };
  advance(state);
  const sumLo = (state.lo + s) >>> 0;
  const carry = sumLo < state.lo ? 1 : 0;
  state.lo = sumLo;
  state.hi = (state.hi + sHi + carry) >>> 0;
  advance(state);

  const prng: Prng = {
    nextU32(): number {
      const value = output(state);
      advance(state);
      return value >>> 0;
    },
    next(): number {
      return prng.nextU32() / 0x100000000;
    },
    nextInt(bound: number): number {
      // Debiased bounded generation (rejection on the modulo remainder).
      const threshold = (0x100000000 - bound) % bound;
      for (;;) {
        const r = prng.nextU32();
        if (r >= threshold) {
          return r % bound;
        }
      }
    },
  };
  return prng;
}
