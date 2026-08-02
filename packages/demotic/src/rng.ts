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
 *
 * {@link draw} is the whole of what `random(low, high)` means, in one function,
 * and it is here rather than in the interpreter for a reason six implementations
 * make concrete: the reference and every backend have to agree about *when* the
 * generator advances as well as about what it produces, and a rule stated only in
 * `sim.ts` is a rule five emitters can each get wrong on their own.
 */

import { fromInt, ONE, type Fixed } from "./fixed.js";

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

/** What a draw produced, and the state it left behind. */
export interface Draw {
  /** The generator afterwards. Always advanced — see {@link draw}. */
  state: number;
  /** A whole number of cells, as 16.16. */
  value: Fixed;
}

/**
 * `random(low, high)`: the definition, for the interpreter and every backend.
 *
 * Three things about it are behaviour rather than implementation, and all three
 * are why this is one function rather than a convention:
 *
 *   - **The generator always advances**, including when the bounds meet or cross
 *     and the answer is fixed. *When* a draw happens is part of what a program
 *     does (doc 14 §Randomness), so a backend that skipped the advance in the
 *     degenerate case would run a different game from the tick after it — and
 *     five of them did, until this was written down where all six read it.
 *   - **The bounds are floored to whole cells before anything else.** A draw
 *     yields a whole number of cells, so `random(0.5, 3.5)` is `random(0, 3)`.
 *   - **The draw comes from the state's high half**, because an LCG's low bits
 *     cycle short.
 */
export function draw(state: number, low: Fixed, high: Fixed): Draw {
  const next = advance(state);
  const lo = Math.floor(low / ONE);
  const hi = Math.floor(high / ONE);
  return { state: next, value: fromInt(hi <= lo ? lo : lo + pick(next, hi - lo + 1)) };
}
