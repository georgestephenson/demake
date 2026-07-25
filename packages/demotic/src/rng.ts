/**
 * The game's random source — one generator, defined once.
 *
 * Randomness in Demotic is *specified*, not borrowed. A host `Math.random` would
 * make every run a different game, which would take the trace oracle (doc 14
 * §Conformance) with it: two implementations could not be compared at all. So
 * the generator is part of the language, and this file is its definition.
 *
 * It is a 32-bit linear congruential generator with Numerical Recipes' constants
 * — chosen because a console runtime has to reproduce it bit-for-bit, and this
 * is a multiply and an add. Anything with better statistical properties (xorshift
 * aside) costs more than a 6502 can spare per frame, and the games this language
 * describes need "a different pipe gap each time", not cryptography.
 *
 * The low bits of an LCG cycle short, so every draw comes from the high half.
 */

/** The seed a program uses when it does not name one. */
export const DEFAULT_SEED = 1;

/** Advance the generator. */
export function advance(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/** A whole number in `[0, count)` from a state, taken from its high bits. */
export function pick(state: number, count: number): number {
  return count <= 1 ? 0 : (state >>> 16) % count;
}
