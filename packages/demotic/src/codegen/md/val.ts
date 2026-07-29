/**
 * 16.16 fixed-point code generation for the 68000.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other three backends' `val.ts`, and all five have to agree
 * exactly: a one-bit disagreement in a velocity compounds into a visibly
 * different game a thousand ticks later, which is what the trace oracle exists
 * to catch. **Rounding is floor, toward negative infinity, everywhere.**
 *
 * This file is a quarter the size of the Sega's and an eighth of the NES's, and
 * the reason is the whole reason this console is worth a backend: **a 16.16
 * value is a register here.** `move.l`, `add.l`, `sub.l`, `neg.l`, `asr.l` and
 * `cmp.l` each do in one instruction what the Z80 does in four and the 6502 in
 * eight, and `cmp.l` sets a signed condition directly rather than leaving one to
 * be synthesised. A 32-bit add is two instructions; on the Game Boy it is
 * sixteen.
 *
 * What the machine does *not* do in one instruction is a 32×32 multiply or a
 * 32-bit divide, so those are the only two routines this console pulls in — and
 * both are built out of the 16×16 multiply and 32÷16 divide it does have, which
 * is why they are straight-line code rather than the bit loops the other three
 * backends need.
 *
 * Three conventions, and every emitter above depends on them:
 *
 *   - **`d0` and `d1` are scratch for every routine here**, and `a0` is the
 *     pointer a helper takes its argument in. Nothing may be held in them across
 *     a call into this file.
 *   - **A comparison branches rather than leaving a flag**, as on the other two
 *     memory-oriented backends: the answer is in the last `cmp`'s codes, and the
 *     only thing to do with it before something clobbers it is branch.
 *   - **The sign of a difference is the signed comparison**, because the
 *     operands are clamped: both are inside ±2^26, so `cmp.l` cannot overflow
 *     and `blt`/`bge` are the whole test.
 */

import { eaA, eaAbs, eaD, eaDisp, eaImm, eaInd, type Ea, type Ref } from "@demake/core";

import type { MdCtx } from "./ctx.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Address a byte at an offset from a value's base.
 *
 * The same three-spelling job the other backends' `mem` does. It is used far
 * less here, because a 16.16 value is read whole rather than a half or a byte at
 * a time — the only offsets that survive are the ones that mean something, like
 * the high word of a coordinate being the cell it sits in.
 */
export function mem(address: Ref, offset = 0): Ref {
  if (typeof address === "number") return address + offset;
  if (offset === 0) return address;
  if (typeof address === "string") return { label: address, addend: offset };
  return { label: address.label, addend: address.addend + offset };
}

/** An absolute operand, in whichever of the two forms the address needs. */
export function at(address: Ref, offset = 0): Ea {
  return eaAbs(mem(address, offset));
}

/** `dst = src`, four bytes. */
export function copy32(ctx: MdCtx, dst: Ref, src: Ref): void {
  ctx.asm.move("l", at(src), eaD(0));
  ctx.asm.move("l", eaD(0), at(dst));
}

/** `dst = value`. */
export function set32(ctx: MdCtx, dst: Ref, value: number): void {
  // `clr.l` for zero, which is two bytes shorter and by far the commonest write.
  if ((value | 0) === 0) ctx.asm.clr("l", at(dst));
  else ctx.asm.move("l", eaImm(value >>> 0), at(dst));
}

/** `dst += src`. */
export function add32(ctx: MdCtx, dst: Ref, src: Ref): void {
  ctx.asm.move("l", at(src), eaD(0));
  ctx.asm.addTo("l", 0, at(dst));
}

/** `dst -= src`. */
export function sub32(ctx: MdCtx, dst: Ref, src: Ref): void {
  ctx.asm.move("l", at(src), eaD(0));
  ctx.asm.subTo("l", 0, at(dst));
}

/** `dst += value`, in whichever of the three forms the literal fits. */
export function addConst32(ctx: MdCtx, dst: Ref, value: number): void {
  const amount = value | 0;
  if (amount === 0) return;
  if (amount >= 1 && amount <= 8) {
    ctx.asm.addq("l", amount, at(dst));
    return;
  }
  if (amount <= -1 && amount >= -8) {
    ctx.asm.subq("l", -amount, at(dst));
    return;
  }
  ctx.asm.addi("l", amount >>> 0, at(dst));
}

/** `dst = -dst`. */
export function neg32(ctx: MdCtx, dst: Ref): void {
  ctx.asm.neg("l", at(dst));
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: MdCtx, dst: Ref): void {
  ctx.asm.move("l", at(dst), eaD(0));
  ctx.asm.asr("l", 1, 0);
  ctx.asm.move("l", eaD(0), at(dst));
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: MdCtx, addr: Ref, target: string, whenZero = true): void {
  ctx.asm.tst("l", at(addr));
  ctx.far(whenZero ? "eq" : "ne", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * `blt` is `N ≠ V`, which is the signed less-than for any pair of operands —
 * the overflow flag is exactly what makes it right at the ends of the range. So
 * unlike the Z80 version this needs no argument about the operands being
 * clamped; it is simply the comparison the machine has.
 */
export function branchLess32(ctx: MdCtx, lhs: Ref, rhs: Ref, target: string, whenLess = true) {
  ctx.asm.move("l", at(lhs), eaD(0));
  ctx.asm.cmp("l", at(rhs), 0);
  ctx.far(whenLess ? "lt" : "ge", target);
}

/** Branch on equality. */
export function branchEqual32(ctx: MdCtx, lhs: Ref, rhs: Ref, target: string, whenEqual = true) {
  ctx.asm.move("l", at(lhs), eaD(0));
  ctx.asm.cmp("l", at(rhs), 0);
  ctx.far(whenEqual ? "eq" : "ne", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: MdCtx, addr: Ref, value: number, target: string): void {
  ctx.asm.cmpi("l", value >>> 0, at(addr));
  ctx.far("ne", target);
}

/** `dst = |dst|`. */
export function abs32(ctx: MdCtx, dst: Ref): void {
  const done = ctx.unique("absDone");
  ctx.asm.tst("l", at(dst));
  ctx.far("pl", done);
  ctx.asm.neg("l", at(dst));
  ctx.asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * address goes in `a0` and the routine reads and writes through it, which is
 * four bytes at the call site for a RAM address plus the call — against the
 * twenty-odd an inlined comparison would take, and there are hundreds of them.
 */
export function clamp32(ctx: MdCtx, dst: Ref): void {
  ctx.asm.lea(at(dst), 0);
  ctx.asm.jsr(ctx.need("Clamp32", emitClamp32));
}

function emitClamp32(ctx: MdCtx): void {
  const { asm } = ctx;
  const notHigh = ctx.unique("clampNotHigh");
  const done = ctx.unique("clampDone");
  asm.move("l", eaInd(0), eaD(0));
  asm.cmp("l", eaImm(FIXED_MAX), 0);
  ctx.far("le", notHigh);
  asm.move("l", eaImm(FIXED_MAX), eaInd(0));
  asm.rts();
  asm.label(notHigh);
  asm.cmp("l", eaImm(-FIXED_MAX >>> 0), 0);
  ctx.far("ge", done);
  asm.move("l", eaImm(-FIXED_MAX >>> 0), eaInd(0));
  asm.label(done);
  asm.rts();
}

// --- multiply and divide -----------------------------------------------------

/** `dst = floor(dst * src / 65536)`. */
export function mul32(ctx: MdCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Mul32", emitMul32);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: MdCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Div32", emitDiv32);
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(
  ctx: MdCtx,
  dst: Ref,
  src: Ref,
  name: string,
  body: (ctx: MdCtx) => void,
): void {
  const { asm, layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  asm.jsr(ctx.need(name, body));
  copy32(ctx, dst, layout.mathA);
}

/**
 * The multiply: `mathA = floor(mathA × mathB / 65536)`.
 *
 * Four 16×16 products assembled into a 64-bit one, the sign applied to the whole
 * of it, and then an arithmetic shift right by sixteen. There is no loop — which
 * is the difference from every other backend in the project, and it is the whole
 * reason this console can afford objects whose speed changes.
 *
 * The order of the sign and the shift is not a preference. A two's complement
 * right shift *is* floor, so negating the product before shifting rounds toward
 * negative infinity; negating afterwards would round toward zero, and every
 * value with a fractional part would be one step out. The Z80 and 6502 backends
 * make the same choice for the same reason.
 *
 * The 64-bit product cannot overflow: both operands are clamped to ±2^26, so it
 * is below 2^52.
 */
function emitMul32(ctx: MdCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const sign = layout.mathWork;

  const aPositive = ctx.unique("mulAPos");
  const bPositive = ctx.unique("mulBPos");
  const noCarry1 = ctx.unique("mulNc1");
  const noCarry2 = ctx.unique("mulNc2");
  const noCarry3 = ctx.unique("mulNc3");
  const positive = ctx.unique("mulPositive");

  asm.move("l", at(a), eaD(0));
  asm.move("l", at(b), eaD(1));
  // The product's sign is the exclusive-or of the operands' — taken before
  // either is made positive, and kept in memory because every register is about
  // to be a partial product.
  asm.move("l", eaD(0), eaD(6));
  asm.eorTo("l", 1, eaD(6));
  asm.move("l", eaD(6), at(sign));
  asm.tst("l", eaD(0));
  ctx.far("pl", aPositive);
  asm.neg("l", eaD(0));
  asm.label(aPositive);
  asm.tst("l", eaD(1));
  ctx.far("pl", bPositive);
  asm.neg("l", eaD(1));
  asm.label(bPositive);

  // The four partial products: d2 = al·bl, d3 = ah·bl, d4 = al·bh, d5 = ah·bh.
  asm.move("l", eaD(0), eaD(2));
  asm.mulu(eaD(1), 2);
  asm.move("l", eaD(0), eaD(3));
  asm.swap(3);
  asm.mulu(eaD(1), 3);
  asm.move("l", eaD(1), eaD(4));
  asm.swap(4);
  asm.mulu(eaD(0), 4);
  asm.move("l", eaD(0), eaD(5));
  asm.swap(5);
  asm.move("l", eaD(1), eaD(6));
  asm.swap(6);
  asm.mulu(eaD(6), 5);

  // mid = ah·bl + al·bh, whose carry out is bit 16 of the high half.
  asm.add("l", eaD(4), 3);
  ctx.far("cc", noCarry1);
  asm.addi("l", 0x10000, eaD(5));
  asm.label(noCarry1);
  // lo += (mid & $FFFF) << 16
  asm.move("l", eaD(3), eaD(6));
  asm.swap(6);
  asm.move("l", eaD(6), eaD(7));
  asm.clr("w", eaD(7));
  asm.add("l", eaD(7), 2);
  ctx.far("cc", noCarry2);
  asm.addq("l", 1, eaD(5));
  asm.label(noCarry2);
  // hi += mid >> 16
  asm.moveq(0, 7);
  asm.move("w", eaD(6), eaD(7));
  asm.add("l", eaD(7), 5);

  // Negate the whole 64-bit product where the sign says so.
  asm.tst("l", at(sign));
  ctx.far("pl", positive);
  asm.not("l", eaD(2));
  asm.not("l", eaD(5));
  asm.addq("l", 1, eaD(2));
  ctx.far("cc", noCarry3);
  asm.addq("l", 1, eaD(5));
  asm.label(noCarry3);
  asm.label(positive);

  // The result is the product's middle four bytes: (hi << 16) | (lo >>> 16).
  asm.move("l", eaD(2), eaD(0));
  asm.lsr("l", 8, 0);
  asm.lsr("l", 8, 0);
  asm.move("l", eaD(5), eaD(1));
  asm.swap(1);
  asm.clr("w", eaD(1));
  asm.orTo("l", 1, eaD(0));
  asm.move("l", eaD(0), at(a));
  clamp32(ctx, a);
  asm.rts();
}

/**
 * The divide: `mathA = floor(mathA × 65536 / mathB)`.
 *
 * Two paths, and the fast one is not an optimisation of the general case so much
 * as the case that actually happens. **A divisor that is a whole number of cells
 * has no fractional bits**, so `a × 65536 / (k × 65536)` collapses to `a / k` —
 * and a 32-by-16 division is two `divu.w` instructions on this machine rather
 * than a loop. Every `speed / fps` in a game takes it, which is every object
 * whose speed can change, every tick.
 *
 * The general path is a restoring division over the 64-bit dividend, with the
 * leading zeros skipped a bit at a time: the quotient grows into the bits the
 * dividend vacates, exactly as in the Z80 and 6502 versions, so all three
 * truncate an over-range quotient to the same low thirty-two bits before the
 * clamp sees it.
 */
function emitDiv32(ctx: MdCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const sign = layout.mathWork;
  const remainder = layout.mathWork + 4;

  const zero = ctx.unique("divZero");
  const general = ctx.unique("divGeneral");
  const finish = ctx.unique("divFinish");
  const aPositive = ctx.unique("divAPos");
  const bPositive = ctx.unique("divBPos");
  const skip = ctx.unique("divSkip");
  const skipDone = ctx.unique("divSkipDone");
  const loop = ctx.unique("divLoop");
  const subtract = ctx.unique("divSub");
  const noFit = ctx.unique("divNoFit");
  const done = ctx.unique("divDone");

  asm.tst("l", at(b));
  ctx.far("eq", zero);
  asm.tst("l", at(a));
  ctx.far("eq", zero);

  asm.move("l", at(a), eaD(0));
  asm.move("l", at(b), eaD(1));
  asm.move("l", eaD(0), eaD(6));
  asm.eorTo("l", 1, eaD(6));
  asm.move("l", eaD(6), at(sign));
  asm.tst("l", eaD(0));
  ctx.far("pl", aPositive);
  asm.neg("l", eaD(0));
  asm.label(aPositive);
  asm.tst("l", eaD(1));
  ctx.far("pl", bPositive);
  asm.neg("l", eaD(1));
  asm.label(bPositive);

  // A whole-cell divisor is a divisor whose low sixteen bits are zero.
  asm.move("l", eaD(1), eaD(2));
  asm.tst("w", eaD(2));
  ctx.far("ne", general);
  asm.swap(2); // d2's low word is now the divisor in whole cells
  // d0 / d2, 32 by 16, as two 32-by-16 divisions. The first quotient fits
  // because the high half is below 65536; the second because the remainder that
  // feeds it is below the divisor.
  asm.move("l", eaD(0), eaD(3));
  asm.clr("w", eaD(3));
  asm.swap(3);
  asm.divu(eaD(2), 3);
  asm.move("l", eaD(3), eaD(4)); // the high quotient word, and the remainder
  asm.move("w", eaD(0), eaD(3)); // (remainder << 16) | the dividend's low word
  asm.divu(eaD(2), 3);
  asm.moveq(0, 5);
  asm.move("w", eaD(4), eaD(5));
  asm.swap(5);
  asm.move("w", eaD(3), eaD(5)); // the quotient, both halves
  asm.move("l", eaD(3), eaD(6));
  asm.swap(6);
  asm.moveq(0, 7);
  asm.move("w", eaD(6), eaD(7));
  asm.move("l", eaD(7), at(remainder));
  asm.move("l", eaD(5), at(a));
  asm.bra(finish);

  asm.label(general);
  // The dividend is |a| × 65536, in the 64-bit pair d3 (high) : d2 (low).
  asm.move("l", eaD(0), eaD(3));
  asm.lsr("l", 8, 3);
  asm.lsr("l", 8, 3);
  asm.move("l", eaD(0), eaD(2));
  asm.swap(2);
  asm.clr("w", eaD(2));
  asm.moveq(0, 4); // the running remainder
  asm.move("w", eaImm(63), eaD(6)); // iterations left, counted by dbra

  // Leading zeros of the dividend produce leading zeros of the quotient, so they
  // can be shifted out and their iterations skipped.
  asm.label(skip);
  asm.tst("l", eaD(3));
  ctx.far("mi", skipDone);
  asm.tst("w", eaD(6));
  ctx.far("eq", skipDone);
  asm.asl("l", 1, 2);
  asm.roxl("l", 1, 3);
  asm.subq("w", 1, eaD(6));
  asm.bra(skip);
  asm.label(skipDone);

  asm.label(loop);
  asm.asl("l", 1, 2);
  asm.roxl("l", 1, 3);
  asm.roxl("l", 1, 4);
  // The bit that left the remainder is a thirty-third bit, and a thirty-third
  // bit is always enough to subtract.
  ctx.far("cs", subtract);
  asm.cmp("l", eaD(1), 4);
  ctx.far("cs", noFit);
  asm.label(subtract);
  asm.sub("l", eaD(1), 4);
  asm.addq("l", 1, eaD(2));
  asm.label(noFit);
  asm.dbra(6, loop);

  asm.move("l", eaD(2), at(a));
  asm.move("l", eaD(4), at(remainder));

  asm.label(finish);
  asm.tst("l", at(sign));
  ctx.far("pl", done);
  asm.neg("l", at(a));
  // floor, not truncate: a negative quotient with a remainder rounds away.
  asm.tst("l", at(remainder));
  ctx.far("eq", done);
  asm.subq("l", 1, at(a));
  asm.label(done);
  clamp32(ctx, a);
  asm.rts();

  asm.label(zero);
  set32(ctx, a, 0);
  asm.rts();
}

/** Silence the unused-import checker for operands the emitters reach for. */
export const VALUE_OPERANDS = { eaA, eaDisp };
