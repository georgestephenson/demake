/**
 * Which V810 register holds what, for the whole Virtual Boy backend.
 *
 * The first backend in this project with a register convention worth writing
 * down, because it is the first with *thirty-two* of them. Every other machine
 * here has so few that an emitter names them at the call site and the convention
 * is "whatever is free"; on this one the useful question is the opposite —
 * what is worth keeping live across a whole program — and there are exactly two
 * answers.
 *
 *   - **{@link RAM} holds the middle of work RAM, always.** A load reaches
 *     ±32 KiB from a base register and work RAM is 64 KiB, so a base at its
 *     centre puts *every* address in the plan one instruction away. That is why
 *     this console's `MemoryPlan` has no cheap page: there is nothing to be
 *     cheaper than.
 *   - **{@link HI} is not a register at all.** `mul` and `div` write their high
 *     half and their remainder to `r30` whether or not anybody asked, so nothing
 *     may be held there across either — and naming it is the cheapest way to
 *     stop an emitter allocating it by accident.
 *
 * Everything else is scratch with a scope. {@link T0}–{@link T4} belong to
 * `val.ts` and are destroyed by any call into it; {@link E0}–{@link E7} are the
 * renderer's and the rule emitters', and are *not* safe across a rule body,
 * which fires between one loop iteration and the next and helps itself to
 * everything (which is why the loop cursor is in memory — `MemoryPlan.loopBytes`).
 */

import { VB_RAM_BASE } from "../layout.js";

/** Hardwired zero. */
export const ZERO = 0;

/** The stack pointer, by the processor's own convention. */
export const SP = 3;

/**
 * The base every work-RAM access is measured from — the *middle* of the region.
 *
 * Held for the length of the program and reloaded by nothing, so a property read
 * is one instruction on this console where it is three on the Mega Drive and
 * eight on a Game Boy.
 */
export const RAM = 4;

/** Where {@link RAM} points. */
export const RAM_BASE = VB_RAM_BASE;

/** `val.ts`'s scratch. Nothing may be held in these across a call into it. */
export const T0 = 6;
export const T1 = 7;
export const T2 = 8;
export const T3 = 9;
export const T4 = 10;

/** The address a helper is handed its operand in. */
export const ARG = 11;

/** The emitters' scratch: valid for the length of one routine, never past a rule. */
export const E0 = 12;
export const E1 = 13;
export const E2 = 14;
export const E3 = 15;
export const E4 = 16;
export const E5 = 17;
export const E6 = 18;
export const E7 = 19;

/** A base register the renderer parks a hardware address in. */
export const HW = 20;
export const HW2 = 21;

/**
 * What `mul` and `div` clobber.
 *
 * Named so that it is never allocated rather than because anything reads it by
 * this name: the multiply and the divide in `val.ts` take the high half and the
 * remainder from `r30` deliberately, and every other emitter has to know not to
 * leave anything there.
 */
export const HI = 30;

/** Where `jal` leaves the return address. */
export const LP = 31;

/** Whether an address is one {@link RAM} reaches in a single instruction. */
export function inRam(address: number): boolean {
  const delta = address - RAM_BASE;
  return delta >= -0x8000 && delta <= 0x7fff;
}

/** The displacement that names a work-RAM address from {@link RAM}. */
export function ramDisp(address: number): number {
  return address - RAM_BASE;
}
