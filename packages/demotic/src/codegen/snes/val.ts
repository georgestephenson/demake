/**
 * 16.16 fixed-point code generation for the 65816.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other three backends' `val.ts`, and all of them have to agree
 * exactly: a one-bit disagreement in a velocity compounds into a visibly
 * different game a thousand ticks later, which is what the trace oracle exists to
 * catch. **Rounding is floor, toward negative infinity, everywhere** — which an
 * arithmetic shift already does, so it is the cheap rule as well as the stated
 * one.
 *
 * This is where the 65816 earns its place, and it is worth saying exactly how.
 * The 6502 does a 32-bit add as four `lda`/`adc`/`sta` triples; here the
 * accumulator is sixteen bits, so it is two. That halving runs through
 * everything — a copy is two loads and two stores, a comparison is two
 * subtractions, a zero test is one `ora`. The value layer is most of what a tick
 * does, so the backend is roughly half the size of the 6502's for the same game
 * before a single instruction has been chosen cleverly.
 *
 * Three conventions differ from the other backends', and all three come from the
 * same place — the registers are wide:
 *
 *   - **A helper is handed an address in `X`.** The 6502 has to write a pointer
 *     into page zero first, because `($nn),y` is its only indirection; here
 *     `$nnnn,x` reaches all of bank zero, so `ldx #Addr; jsr Clamp32` is the
 *     whole calling convention and there is one clamp routine rather than two.
 *   - **Comparisons branch rather than leaving a flag**, exactly as on the 6502
 *     and for the same reason: the sign of the difference lives in the last
 *     subtraction's N flag and the only thing that can be done with it before
 *     something clobbers it is branch.
 *   - **The accumulator is sixteen bits at every label.** Nothing here narrows
 *     it; see `ctx.ts` §The width invariant.
 */

import { imm16, type Ref } from "@demake/core";

import type { SnesCtx } from "./ctx.js";
import { absX, mem } from "./ops.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/** The high word of that limit, which is the only part the clamp compares. */
const LIMIT_HIGH = (FIXED_MAX >>> 16) & 0xffff;
const LIMIT_LOW_NEGATIVE = (-FIXED_MAX >>> 16) & 0xffff;

/** The low and high halves of a 16.16 literal. */
function halves(value: number): [number, number] {
  return [value & 0xffff, (value >>> 16) & 0xffff];
}

/** `dst = src`, four bytes — which is two words. */
export function copy32(ctx: SnesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.lda(mem(src));
  asm.sta(mem(dst));
  asm.lda(mem(src, 2));
  asm.sta(mem(dst, 2));
}

/** `dst = value`. */
export function set32(ctx: SnesCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  if (low === 0 && high === 0) {
    // `stz` is the one instruction the 6502 does not have that this backend uses
    // constantly: zero is by far the commonest literal a game writes.
    asm.stz(mem(dst));
    asm.stz(mem(dst, 2));
    return;
  }
  asm.lda(imm16(low));
  asm.sta(mem(dst));
  if (high !== low) asm.lda(imm16(high));
  asm.sta(mem(dst, 2));
}

/** `dst += src`. */
export function add32(ctx: SnesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.clc();
  asm.lda(mem(dst));
  asm.adc(mem(src));
  asm.sta(mem(dst));
  asm.lda(mem(dst, 2));
  asm.adc(mem(src, 2));
  asm.sta(mem(dst, 2));
}

/** `dst -= src`. */
export function sub32(ctx: SnesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.sec();
  asm.lda(mem(dst));
  asm.sbc(mem(src));
  asm.sta(mem(dst));
  asm.lda(mem(dst, 2));
  asm.sbc(mem(src, 2));
  asm.sta(mem(dst, 2));
}

/**
 * `dst += value`, with a zero low half skipped.
 *
 * Adding zero with the carry clear cannot change a word or produce a carry, so a
 * constant whose fractional part is zero — which every whole-cell literal is —
 * costs half as much.
 */
export function addConst32(ctx: SnesCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  if (low === 0 && high === 0) return;
  asm.clc();
  if (low !== 0) {
    asm.lda(mem(dst));
    asm.adc(imm16(low));
    asm.sta(mem(dst));
  }
  asm.lda(mem(dst, 2));
  asm.adc(imm16(high));
  asm.sta(mem(dst, 2));
}

/** `dst = -dst`. */
export function neg32(ctx: SnesCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.sec();
  asm.lda(imm16(0));
  asm.sbc(mem(dst));
  asm.sta(mem(dst));
  asm.lda(imm16(0));
  asm.sbc(mem(dst, 2));
  asm.sta(mem(dst, 2));
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: SnesCtx, dst: Ref): void {
  const { asm } = ctx;
  // The sign has to come back in at the top, so it goes out through the carry
  // first: shift a copy of the high word left, then rotate the pair right.
  asm.lda(mem(dst, 2));
  asm.asl();
  asm.ror(mem(dst, 2));
  asm.ror(mem(dst));
}

/** Set Z when the value is zero. Clobbers A. */
export function isZero32(ctx: SnesCtx, addr: Ref): void {
  const { asm } = ctx;
  asm.lda(mem(addr));
  asm.ora(mem(addr, 2));
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: SnesCtx, addr: Ref, target: string, whenZero = true): void {
  isZero32(ctx, addr);
  ctx.far(whenZero ? "eq" : "ne", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * The subtraction's high word holds the sign of the difference, and the clamped
 * range rules out the overflow case that would make that reasoning wrong. The
 * final `sbc` leaves that sign in N, and the `lda` between the two `sbc`s does
 * not disturb the carry — which is what lets the chain run without saving
 * anything.
 */
export function branchLess32(ctx: SnesCtx, lhs: Ref, rhs: Ref, target: string, whenLess = true) {
  const { asm } = ctx;
  asm.sec();
  asm.lda(mem(lhs));
  asm.sbc(mem(rhs));
  asm.lda(mem(lhs, 2));
  asm.sbc(mem(rhs, 2));
  ctx.far(whenLess ? "mi" : "pl", target);
}

/** Branch on equality, by comparing until a word differs. */
export function branchEqual32(ctx: SnesCtx, lhs: Ref, rhs: Ref, target: string, whenEqual = true) {
  const { asm } = ctx;
  if (whenEqual) {
    // A local label, so these two can be short branches: the whole comparison is
    // a dozen bytes and nothing between them can be far away.
    const no = ctx.unique("neq");
    asm.lda(mem(lhs));
    asm.cmp(mem(rhs));
    asm.bne(no);
    asm.lda(mem(lhs, 2));
    asm.cmp(mem(rhs, 2));
    ctx.far("eq", target);
    asm.label(no);
    return;
  }
  asm.lda(mem(lhs));
  asm.cmp(mem(rhs));
  ctx.far("ne", target);
  asm.lda(mem(lhs, 2));
  asm.cmp(mem(rhs, 2));
  ctx.far("ne", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: SnesCtx, addr: Ref, value: number, target: string): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  asm.lda(mem(addr));
  asm.cmp(imm16(low));
  ctx.far("ne", target);
  asm.lda(mem(addr, 2));
  asm.cmp(imm16(high));
  ctx.far("ne", target);
}

/** `dst = |dst|`. */
export function abs32(ctx: SnesCtx, dst: Ref): void {
  const { asm } = ctx;
  const done = ctx.unique("absDone");
  asm.lda(mem(dst, 2));
  ctx.far("pl", done);
  neg32(ctx, dst);
  asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. There
 * is one routine rather than the 6502 backend's two, because there is one way to
 * pass it an address: `X` holds it, and `$0000,x` reaches whatever bank zero
 * holds. Two instructions at every call site.
 */
export function clamp32(ctx: SnesCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.ldx(imm16(dst));
  ctx.call(ctx.need("Clamp32", emitClamp32));
}

/**
 * `X` = the address of a 16.16 value: hold it inside the representable range.
 *
 * The whole decision is two comparisons of the *high* word, because both limits
 * are whole cells: above `$0400` is out of range, below `$FC00` is out of range
 * the other way, and only the boundary itself needs the low word looked at —
 * exactly `$0400_0000` is in range and anything above it is not.
 */
function emitClamp32(ctx: SnesCtx): void {
  const { asm } = ctx;
  const negative = ctx.unique("clampNeg");
  const high = ctx.unique("clampHigh");
  const store = ctx.unique("clampStore");
  const done = ctx.unique("clampDone");

  asm.lda(absX(2));
  asm.bmi(negative);
  asm.cmp(imm16(LIMIT_HIGH));
  asm.bcc(done);
  asm.bne(high);
  asm.lda(absX(0));
  asm.beq(done);
  asm.label(high);
  asm.lda(imm16(LIMIT_HIGH));
  asm.bra(store);
  asm.label(negative);
  asm.cmp(imm16(LIMIT_LOW_NEGATIVE));
  asm.bcs(done);
  asm.lda(imm16(LIMIT_LOW_NEGATIVE));
  asm.label(store);
  asm.sta(absX(2));
  asm.stz(absX(0));
  asm.label(done);
  ctx.ret();
}

/**
 * `dst = floor(dst * src / 65536)`.
 *
 * Both operands go to the helper by address, because it needs them in its own
 * workspace anyway: sign comes off first and is reapplied to the whole product
 * before the shift, since a two's complement right shift is floor and negating
 * afterwards would round the wrong way for anything with a fractional part.
 */
export function mul32(ctx: SnesCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, ctx.need("Mul32", emitMul32));
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: SnesCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, ctx.need("Div32", emitDiv32));
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(ctx: SnesCtx, dst: Ref, src: Ref, routine: Ref): void {
  const { layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  ctx.call(routine);
  copy32(ctx, dst, layout.mathA);
}

/** `mathA = |mathA|` and `mathB = |mathB|`, remembering the sign of the product. */
function signOf(ctx: SnesCtx, sign: number): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.mathA, 2));
  asm.eor(mem(layout.mathB, 2));
  asm.and(imm16(0x8000));
  asm.sta(mem(sign));
  abs32(ctx, layout.mathA);
  abs32(ctx, layout.mathB);
}

/** Branch into `body` when the four bytes at `addr` are exactly 1.0. */
function ifOne(ctx: SnesCtx, addr: number, body: () => void): void {
  const { asm } = ctx;
  const no = ctx.unique("notOne");
  asm.lda(mem(addr));
  ctx.far("ne", no);
  asm.lda(mem(addr, 2));
  asm.cmp(imm16(1));
  ctx.far("ne", no);
  body();
  asm.label(no);
}

/**
 * The multiply helper: `mathA *= mathB`, in 16.16.
 *
 * Shift-and-add over the multiplier's bits, exiting the moment it runs dry, with
 * the ±1.0 identity taken before the loop — a direction is almost always exactly
 * one, and that case is exact so it can skip the arithmetic entirely.
 *
 * The console *has* a hardware multiplier, and it is deliberately not used: it is
 * eight bits by eight, so a 32-bit product is sixteen of them plus the adds to
 * assemble the partial products, and each one costs a mode switch to write its
 * operand. That is a real optimisation and a real risk, and this loop is the one
 * that can be read against `fixed.ts` line by line.
 */
function emitMul32(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  // Six words of workspace: a 48-bit product, a 48-bit multiplicand, the sign.
  const product = layout.mathWork; // 8 bytes
  const multiplicand = layout.mathWork + 8; // 8 bytes
  const sign = layout.mathWork + 16;

  signOf(ctx, sign);

  const store = ctx.unique("mulStore");
  const general = ctx.unique("mulGeneral");
  const loop = ctx.unique("mulLoop");
  const noAdd = ctx.unique("mulNoAdd");
  const finish = ctx.unique("mulFinish");
  const positive = ctx.unique("mulPositive");
  const skipWord = ctx.unique("mulSkipWord");
  const doneSkip = ctx.unique("mulDoneSkip");
  const shifted = ctx.unique("mulShift");

  // x * 1 is exact and extremely common: every object moving at a whole
  // direction does two of them per tick.
  ifOne(ctx, b, () => {
    asm.jmp(store);
  });
  ifOne(ctx, a, () => {
    copy32(ctx, a, b);
    asm.jmp(store);
  });
  asm.jmp(general);

  asm.label(store);
  asm.lda(mem(sign));
  ctx.far("eq", positive);
  neg32(ctx, a);
  asm.label(positive);
  clamp32(ctx, a);
  ctx.ret();

  asm.label(general);
  for (let word = 0; word < 8; word += 2) {
    asm.stz(mem(product, word));
    asm.stz(mem(multiplicand, word));
  }
  copy32(ctx, multiplicand, a);

  // A zero low word of the multiplier is sixteen free iterations: shift it out
  // and the multiplicand up by the same amount. Speeds are whole cells per
  // second, so their low sixteen bits are zero and this removes half the loop
  // before it starts.
  asm.label(skipWord);
  asm.lda(mem(b));
  ctx.far("ne", doneSkip);
  isZero32(ctx, b);
  ctx.far("eq", doneSkip);
  asm.lda(mem(b, 2));
  asm.sta(mem(b));
  asm.stz(mem(b, 2));
  for (let word = 6; word >= 2; word -= 2) {
    asm.lda(mem(multiplicand, word - 2));
    asm.sta(mem(multiplicand, word));
  }
  asm.stz(mem(multiplicand));
  asm.jmp(skipWord);
  asm.label(doneSkip);

  asm.label(loop);
  isZero32(ctx, b);
  ctx.far("eq", finish);
  asm.lda(mem(b));
  asm.and(imm16(1));
  ctx.far("eq", noAdd);
  asm.clc();
  for (let word = 0; word < 8; word += 2) {
    asm.lda(mem(product, word));
    asm.adc(mem(multiplicand, word));
    asm.sta(mem(product, word));
  }
  asm.label(noAdd);
  asm.asl(mem(multiplicand));
  for (let word = 2; word < 8; word += 2) asm.rol(mem(multiplicand, word));
  asm.lsr(mem(b, 2));
  asm.ror(mem(b));
  asm.jmp(loop);

  asm.label(finish);
  asm.lda(mem(sign));
  ctx.far("eq", shifted);
  asm.sec();
  for (let word = 0; word < 8; word += 2) {
    asm.lda(imm16(0));
    asm.sbc(mem(product, word));
    asm.sta(mem(product, word));
  }
  asm.label(shifted);
  // The product is 16.32; the result is its middle four bytes.
  asm.lda(mem(product, 2));
  asm.sta(mem(a));
  asm.lda(mem(product, 4));
  asm.sta(mem(a, 2));
  clamp32(ctx, a);
  ctx.ret();
}

/**
 * The divide helper: `mathA = mathA * 65536 / mathB`.
 *
 * A divisor that is a whole number of cells has no fractional bits, so
 * `a * 65536 / (k * 65536)` collapses to `a / k` — a 32-by-16 division that is
 * half the work of the general one. Every `speed / fps` in a game takes that
 * path, which is why it is worth the branch.
 */
function emitDiv32(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const work = layout.mathWork; // 6 bytes of dividend, then quotient
  const rem = layout.mathWork + 8; // 4 bytes
  const sign = layout.mathWork + 16;
  const counter = layout.mathWork + 18;

  const zero = ctx.unique("divZero");
  const general = ctx.unique("divGeneral");
  const signAndFloor = ctx.unique("divSign");

  isZero32(ctx, b);
  ctx.far("eq", zero);
  isZero32(ctx, a);
  ctx.far("eq", zero);
  signOf(ctx, sign);

  // Whole-cell divisor? Low word zero, high word not.
  asm.lda(mem(b));
  ctx.far("ne", general);
  asm.lda(mem(b, 2));
  ctx.far("eq", general);
  emitDivideByWord(ctx, a, b + 2, rem);
  asm.jmp(signAndFloor);

  asm.label(general);
  // Dividend = |a| << 16 in the low three words; the quotient grows into the
  // words the dividend vacates.
  asm.stz(mem(work));
  asm.lda(mem(a));
  asm.sta(mem(work, 2));
  asm.lda(mem(a, 2));
  asm.sta(mem(work, 4));

  const loop = ctx.unique("divLoop");
  const noFit = ctx.unique("divNoFit");
  const fits = ctx.unique("divFits");
  const skipWord = ctx.unique("divSkipWord");
  const doneWord = ctx.unique("divDoneWord");
  const skipBit = ctx.unique("divSkipBit");
  const doneBit = ctx.unique("divDoneBit");

  asm.lda(imm16(48));
  asm.sta(mem(counter));
  // Leading zeros of the dividend produce leading zeros of the quotient, so they
  // can be shifted out and their iterations skipped — a whole word first, then
  // the remaining bits of the top one.
  asm.label(skipWord);
  asm.lda(mem(work, 4));
  ctx.far("ne", doneWord);
  asm.lda(mem(counter));
  asm.cmp(imm16(17));
  ctx.far("cc", doneWord);
  asm.sec();
  asm.sbc(imm16(16));
  asm.sta(mem(counter));
  asm.lda(mem(work, 2));
  asm.sta(mem(work, 4));
  asm.lda(mem(work));
  asm.sta(mem(work, 2));
  asm.stz(mem(work));
  asm.jmp(skipWord);
  asm.label(doneWord);
  asm.label(skipBit);
  asm.lda(mem(work, 4));
  ctx.far("mi", doneBit);
  asm.lda(mem(counter));
  asm.cmp(imm16(2));
  ctx.far("cc", doneBit);
  asm.dec(mem(counter));
  asm.asl(mem(work));
  asm.rol(mem(work, 2));
  asm.rol(mem(work, 4));
  asm.jmp(skipBit);
  asm.label(doneBit);

  asm.stz(mem(rem));
  asm.stz(mem(rem, 2));
  asm.label(loop);
  asm.asl(mem(work));
  asm.rol(mem(work, 2));
  asm.rol(mem(work, 4));
  asm.rol(mem(rem));
  asm.rol(mem(rem, 2));
  // Does the divisor fit? The high words decide it unless they are equal.
  asm.lda(mem(rem, 2));
  asm.cmp(mem(b, 2));
  ctx.far("cc", noFit);
  ctx.far("ne", fits);
  asm.lda(mem(rem));
  asm.cmp(mem(b));
  ctx.far("cc", noFit);
  asm.label(fits);
  asm.sec();
  asm.lda(mem(rem));
  asm.sbc(mem(b));
  asm.sta(mem(rem));
  asm.lda(mem(rem, 2));
  asm.sbc(mem(b, 2));
  asm.sta(mem(rem, 2));
  asm.inc(mem(work));
  asm.label(noFit);
  asm.dec(mem(counter));
  ctx.far("ne", loop);

  asm.lda(mem(work));
  asm.sta(mem(a));
  asm.lda(mem(work, 2));
  asm.sta(mem(a, 2));

  asm.label(signAndFloor);
  const done = ctx.unique("divDone");
  asm.lda(mem(sign));
  ctx.far("eq", done);
  neg32(ctx, a);
  // floor, not truncate: a negative quotient with a remainder rounds away.
  isZero32(ctx, rem);
  ctx.far("eq", done);
  // `clc` rather than `sec`, and the difference is the whole reason this is worth
  // a comment: on this CPU the carry means *no borrow*, so clearing it is what
  // makes `sbc #0` subtract one. The Game Boy backend sets its carry here for the
  // same effect, because there the flag means the opposite.
  asm.clc();
  asm.lda(mem(a));
  asm.sbc(imm16(0));
  asm.sta(mem(a));
  asm.lda(mem(a, 2));
  asm.sbc(imm16(0));
  asm.sta(mem(a, 2));
  asm.label(done);
  clamp32(ctx, a);
  ctx.ret();

  asm.label(zero);
  set32(ctx, a, 0);
  ctx.ret();
}

/**
 * `value /= [divisor]`, 32 by 16, remainder into `rem`.
 *
 * The dividend and the quotient share the four bytes of `value`, and the
 * remainder is one word in `A`: the remainder of a division by `k` is below `k`,
 * so it fits — but it can reach `2k-1` inside the loop, which overflows a word
 * when the divisor is above `$8000`. The carry out of the rotate is that
 * seventeenth bit, and it always means "subtract".
 */
function emitDivideByWord(ctx: SnesCtx, value: number, divisor: number, rem: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("wordDivLoop");
  const next = ctx.unique("wordDivNext");
  const subtract = ctx.unique("wordDivSub");

  asm.ldx(imm16(32));
  asm.lda(imm16(0));
  asm.label(loop);
  asm.asl(mem(value));
  asm.rol(mem(value, 2));
  asm.rol();
  asm.bcs(subtract);
  asm.cmp(mem(divisor));
  asm.bcc(next);
  asm.label(subtract);
  asm.sec();
  asm.sbc(mem(divisor));
  asm.inc(mem(value));
  asm.label(next);
  asm.dex();
  ctx.far("ne", loop);
  asm.sta(mem(rem));
  asm.stz(mem(rem, 2));
}
