/**
 * The backend's own corner of the direct page, and how it addresses everything
 * else.
 *
 * The counterpart of `codegen/mos/zp.ts`, and the striking thing is how much
 * *smaller* it is. Page zero on a 6502 is the only place a pointer can live,
 * because `($nn),y` is that CPU's one indirect mode — so every shared helper
 * there needs a fixed pair of bytes to be told its argument in. Here the index
 * registers are sixteen bits wide and `$nnnn,x` reaches all of bank zero, so a
 * helper is told an address by being *handed* it in `X`: `ldx #Addr; jsr Clamp32`
 * is the whole calling convention, and there is nothing to reserve for it.
 *
 * What is left is scratch a helper needs across a call it makes itself, and the
 * cursor a looped rule body walks with. Everything here is a *word*, because the
 * accumulator is sixteen bits everywhere this backend runs (`ctx.ts` §The width
 * invariant).
 *
 * `SNES_MEMORY` hands the allocator the direct page from {@link DP_FREE} up, so
 * these addresses are not the plan's to give away.
 */

import {
  at65816,
  dp,
  imm16,
  imm8,
  snesAbs,
  snesAbsX,
  snesAbsY,
  snesImmHigh,
  snesImmLow,
  type Asm65816,
  type Operand65816,
  type Ref,
} from "@demake/core";

/**
 * What the byte helpers need of a context, structurally.
 *
 * Not `SnesCtx` itself, and the reason is a module cycle rather than taste: the
 * RAM plan (`codegen/layout.ts`) reads {@link DP_FREE} from this file to know
 * where the allocator may start, and a context imports the plan. Naming only the
 * two things a byte store uses keeps this module's imports to the assembler.
 */
interface NarrowTarget {
  readonly asm: Asm65816;
  narrow(body: () => void): void;
}

/**
 * The 65816's operand constructors, under the names assembly spells them.
 *
 * `abs`, `absX`, `absY`, `immLow` and `immHigh` collide with the 6502
 * assembler's by name and not by type, so `@demake/core` exports them prefixed
 * and they are aliased back here — in one place, so a call site in the rest of
 * this backend reads like assembly and nothing can hand a 6502 operand to a
 * 65816 instruction.
 */
export const abs = snesAbs;
export const absX = snesAbsX;
export const absY = snesAbsY;
export const immLow = snesImmLow;
export const immHigh = snesImmHigh;

/** Word scratch the shared helpers use, and the loop cursor rule bodies survive. */
export const DP = {
  /** Scratch inside one helper, valid only for the length of one. */
  t0: 0x00,
  t1: 0x02,
  t2: 0x04,
  t3: 0x06,
  /** A value a helper keeps across calling another. */
  saved: 0x08,
  /** A loop counter a helper keeps out of the registers. */
  count: 0x0a,
  /** One spare word, deliberately: the next routine that needs one has it. */
  spare: 0x0c,
  /**
   * The entity-list loop's own state: the record being walked, and where the
   * walk is up to.
   *
   * Separate from the scratch above because it is the one thing that has to
   * survive everything a *rule body* does — a rule may multiply, divide, fire a
   * sound and write four properties between one entry and the next, and all of
   * that uses `X`. A helper's scratch is valid for the length of one helper;
   * this is valid for the length of a loop.
   */
  loop: 0x0e,
  loopIndex: 0x10,
} as const;

/** First byte of the direct page the allocator may hand out. */
export const DP_FREE = 0x12;

/**
 * Address a value, choosing the direct-page form when the address is in it.
 *
 * Only ever unindexed, for the reason the 6502 backend gives: a direct-page
 * indexed access and an absolute indexed one are different instructions with
 * different wrapping, so the short form is never inferred where an index is
 * involved. This backend indexes explicitly, and always absolutely — `$nnnn,x`
 * covers the whole bank, which is what lets an entity be reached by address
 * rather than through a pointer.
 */
export function mem(address: Ref, offset = 0): Operand65816 {
  if (typeof address === "number") return at65816(address + offset);
  if (offset === 0) return abs(address);
  return abs(
    typeof address === "string"
      ? { label: address, addend: offset }
      : { label: address.label, addend: address.addend + offset },
  );
}

/** The same, forced to the direct page — for an address the caller knows is in it. */
export function fast(address: number, offset = 0): Operand65816 {
  return dp(address + offset);
}

/** Whether an address is one the direct page reaches. */
export function inDirectPage(address: Ref): boolean {
  return typeof address === "number" && address < 0x100;
}

// --- single bytes -------------------------------------------------------------
//
// Most of a game's state is 16.16 and the accumulator is sixteen bits to suit it
// (`ctx.ts` §The width invariant), but a flag, a counter and a contact bitfield
// are one byte each — and the byte beside them belongs to something else. So a
// byte is *read* as a word with the neighbour masked away, which costs nothing,
// and *written* with the accumulator narrowed for the length of the store, which
// costs one instruction each way. Both forms are here rather than open-coded,
// because a sixteen-bit store to a one-byte field is a bug that shows up as an
// unrelated flag changing value.

/** `A = the byte at `addr``, with the byte above it masked away. */
export function loadByte(ctx: NarrowTarget, addr: Ref, offset = 0): void {
  ctx.asm.lda(mem(addr, offset));
  ctx.asm.and(imm16(0x00ff));
}

/** Store a compile-time byte, leaving the one beside it alone. */
export function setByte(ctx: NarrowTarget, addr: Ref, value: number, offset = 0): void {
  ctx.narrow(() => {
    ctx.asm.lda(imm8(value & 0xff));
    ctx.asm.sta(mem(addr, offset));
  });
}

/** Zero one byte. */
export function clearByte(ctx: NarrowTarget, addr: Ref, offset = 0): void {
  ctx.narrow(() => {
    ctx.asm.stz(mem(addr, offset));
  });
}

/** Zero a run of bytes, under one pair of mode switches. */
export function clearBytes(ctx: NarrowTarget, addr: number, count: number): void {
  if (count <= 0) return;
  ctx.narrow(() => {
    for (let index = 0; index < count; index += 1) ctx.asm.stz(mem(addr + index));
  });
}

/** `[addr] += 1`, on one byte. */
export function incByte(ctx: NarrowTarget, addr: Ref, offset = 0): void {
  ctx.narrow(() => {
    ctx.asm.inc(mem(addr, offset));
  });
}

/**
 * `[addr] |= mask`, on one byte, without narrowing.
 *
 * `tsb` writes back `memory | A`, so a mask whose high byte is zero leaves the
 * byte above the target exactly as it found it — which is what makes a
 * sixteen-bit read-modify-write safe on a one-byte field. Nothing here runs
 * under an interrupt that writes the neighbour, which is the other half of why
 * it is safe.
 */
export function orByte(ctx: NarrowTarget, addr: Ref, mask: number, offset = 0): void {
  ctx.asm.lda(imm16(mask & 0x00ff));
  ctx.asm.tsb(mem(addr, offset));
}
