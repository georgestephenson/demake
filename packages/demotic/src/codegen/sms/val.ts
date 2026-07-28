/**
 * 16.16 fixed-point code generation for the Z80.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other two backends' `val.ts`, and all four have to agree exactly:
 * a one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere** — which an
 * arithmetic shift already does, so it is the cheap rule as well as the stated
 * one.
 *
 * This is where the Z80 is better at the job than either of the others, and it
 * is worth saying why. `adc hl,rr` and `sbc hl,rr` do sixteen bits at a time
 * *with* a carry and a full set of flags, and `ld hl,(nn)` / `ld (nn),hl` reach
 * any address directly — so a 32-bit add is two loads, an add, a store, and the
 * same again for the high half. The SM83 has neither instruction and funnels
 * every operand through a pointer; the 6502 has the direct addressing but works
 * a byte at a time. Twenty-three bytes here against thirty-seven there.
 *
 * Three conventions, all of which differ from the 6502 backend's because the
 * flags do:
 *
 *   - **Loads do not set flags.** `ld a,(nn)` says nothing about what it loaded,
 *     where the 6502's `lda` sets N and Z. Every sign test therefore has an
 *     explicit `or a` after the load, and forgetting it produces code that
 *     branches on whatever the *previous* instruction decided.
 *   - **`or a` is how the carry is cleared, and it keeps the accumulator.** It
 *     computes `a | a`, so the value is unchanged and only the flags move. That
 *     is what lets a subtraction chain start without saving anything.
 *   - **Comparisons branch rather than leaving a flag**, as on the 6502 and for
 *     the same reason: the answer lives in the last `sbc`'s sign, and the only
 *     thing that can be done with it before something clobbers it is branch.
 *
 * Every routine clobbers `af`, `hl` and `de`. The ones that say so also clobber
 * `bc` and `ix`; nothing preserves the shadow set, because nothing uses it.
 */

import { type Ref } from "@demake/core";

import type { SmsCtx } from "./ctx.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Address a byte at an offset from a value's base.
 *
 * There is no short form to choose between here, unlike on the 6502: this CPU
 * addresses every location in the same three bytes, so the whole of the job is
 * carrying an addend through the three spellings of a reference.
 */
export function mem(address: Ref, offset = 0): Ref {
  if (typeof address === "number") return address + offset;
  if (offset === 0) return address;
  if (typeof address === "string") return { label: address, addend: offset };
  return { label: address.label, addend: address.addend + offset };
}

/** The low and high sixteen bits of a 32-bit literal. */
function halves(value: number): [number, number] {
  return [value & 0xffff, (value >>> 16) & 0xffff];
}

/** `dst = src`, four bytes. */
export function copy32(ctx: SmsCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.ld16From("hl", mem(src, 0));
  asm.st16To(mem(dst, 0), "hl");
  asm.ld16From("hl", mem(src, 2));
  asm.st16To(mem(dst, 2), "hl");
}

/** `dst = value`. */
export function set32(ctx: SmsCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  asm.ld16("hl", low);
  asm.st16To(mem(dst, 0), "hl");
  // Zero is by far the commonest literal, and both halves of it are the same —
  // so holding `hl` across the two stores makes `set32(x, 0)` nine bytes.
  if (high !== low) asm.ld16("hl", high);
  asm.st16To(mem(dst, 2), "hl");
}

/**
 * `dst += src`.
 *
 * No carry clear: `add hl,de` does not take one, and it *sets* the carry that
 * `adc hl,de` then consumes. The three instructions between them are loads and
 * stores, which leave the flags alone — the property the whole chain rests on.
 */
export function add32(ctx: SmsCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.ld16From("hl", mem(dst, 0));
  asm.ld16From("de", mem(src, 0));
  asm.addHL("de");
  asm.st16To(mem(dst, 0), "hl");
  asm.ld16From("hl", mem(dst, 2));
  asm.ld16From("de", mem(src, 2));
  asm.adcHL("de");
  asm.st16To(mem(dst, 2), "hl");
}

/** `dst -= src`. */
export function sub32(ctx: SmsCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.aluN("or", 0); // clear the carry; `sbc` takes one where `add` does not
  asm.ld16From("hl", mem(dst, 0));
  asm.ld16From("de", mem(src, 0));
  asm.sbcHL("de");
  asm.st16To(mem(dst, 0), "hl");
  asm.ld16From("hl", mem(dst, 2));
  asm.ld16From("de", mem(src, 2));
  asm.sbcHL("de");
  asm.st16To(mem(dst, 2), "hl");
}

/**
 * `dst += value`, with a half the literal cannot change left alone.
 *
 * A literal whose low half is zero cannot carry, so the high half is added with
 * `add hl,de` and the low half is not touched at all. For `+1.0` — which is what
 * every whole direction integrates by — that is half the instructions.
 */
export function addConst32(ctx: SmsCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  if (low === 0 && high === 0) return;
  if (low === 0) {
    asm.ld16From("hl", mem(dst, 2));
    asm.ld16("de", high);
    asm.addHL("de");
    asm.st16To(mem(dst, 2), "hl");
    return;
  }
  asm.ld16From("hl", mem(dst, 0));
  asm.ld16("de", low);
  asm.addHL("de");
  asm.st16To(mem(dst, 0), "hl");
  asm.ld16From("hl", mem(dst, 2));
  asm.ld16("de", high);
  asm.adcHL("de");
  asm.st16To(mem(dst, 2), "hl");
}

/** `dst = -dst`. */
export function neg32(ctx: SmsCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.aluN("or", 0);
  asm.ld16("hl", 0);
  asm.ld16From("de", mem(dst, 0));
  asm.sbcHL("de");
  asm.st16To(mem(dst, 0), "hl");
  asm.ld16("hl", 0);
  asm.ld16From("de", mem(dst, 2));
  asm.sbcHL("de");
  asm.st16To(mem(dst, 2), "hl");
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: SmsCtx, dst: Ref): void {
  const { asm } = ctx;
  // The top half first, so the bit that leaves it is in the carry when the
  // bottom half is rotated. The store and the load between them are flag-free.
  asm.ld16From("hl", mem(dst, 2));
  asm.shift("sra", "h");
  asm.shift("rr", "l");
  asm.st16To(mem(dst, 2), "hl");
  asm.ld16From("hl", mem(dst, 0));
  asm.shift("rr", "h");
  asm.shift("rr", "l");
  asm.st16To(mem(dst, 0), "hl");
}

/** Set Z when the value is zero. Clobbers `a`, `hl`. */
export function isZero32(ctx: SmsCtx, addr: Ref): void {
  const { asm } = ctx;
  asm.ld16From("hl", mem(addr, 0));
  asm.ld("a", "h");
  asm.alu("or", "l");
  asm.ld16From("hl", mem(addr, 2));
  asm.alu("or", "h");
  asm.alu("or", "l");
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: SmsCtx, addr: Ref, target: string, whenZero = true): void {
  isZero32(ctx, addr);
  ctx.far(whenZero ? "z" : "nz", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * The sign of the 32-bit difference *is* the answer, because the clamped range
 * rules out the overflow that would make that reasoning wrong: both operands are
 * inside ±2^26, so their difference is inside ±2^27 and cannot wrap. That is
 * what lets this branch on `m` rather than having to compute sign-exclusive-or-
 * overflow, which is the general Z80 idiom for a signed compare.
 */
export function branchLess32(ctx: SmsCtx, lhs: Ref, rhs: Ref, target: string, whenLess = true) {
  const { asm } = ctx;
  asm.aluN("or", 0);
  asm.ld16From("hl", mem(lhs, 0));
  asm.ld16From("de", mem(rhs, 0));
  asm.sbcHL("de");
  asm.ld16From("hl", mem(lhs, 2));
  asm.ld16From("de", mem(rhs, 2));
  asm.sbcHL("de");
  ctx.far(whenLess ? "m" : "p", target);
}

/** Compare two halves, leaving Z set when they match. */
function compareHalf(ctx: SmsCtx, lhs: Ref, rhs: Ref, offset: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", mem(lhs, offset));
  asm.ld16From("de", mem(rhs, offset));
  asm.aluN("or", 0);
  asm.sbcHL("de");
}

/** Branch on equality, by comparing a half at a time. */
export function branchEqual32(ctx: SmsCtx, lhs: Ref, rhs: Ref, target: string, whenEqual = true) {
  const { asm } = ctx;
  if (whenEqual) {
    // A local label, so both skips can be short branches: the whole comparison
    // is two dozen bytes and nothing between them can be far away.
    const no = ctx.unique("neq");
    compareHalf(ctx, lhs, rhs, 0);
    asm.jr(no, "nz");
    compareHalf(ctx, lhs, rhs, 2);
    asm.jr(no, "nz");
    asm.jp(target);
    asm.label(no);
    return;
  }
  compareHalf(ctx, lhs, rhs, 0);
  ctx.far("nz", target);
  compareHalf(ctx, lhs, rhs, 2);
  ctx.far("nz", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: SmsCtx, addr: Ref, value: number, target: string): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  for (const [offset, want] of [
    [0, low],
    [2, high],
  ] as const) {
    asm.ld16From("hl", mem(addr, offset));
    asm.ld16("de", want);
    asm.aluN("or", 0);
    asm.sbcHL("de");
    ctx.far("nz", target);
  }
}

/** Load the sign byte of a value and set the flags from it. */
function testSign(ctx: SmsCtx, addr: Ref): void {
  const { asm } = ctx;
  asm.lda(mem(addr, 3));
  // A load says nothing about what it loaded on this CPU, so the flags have to
  // be made explicitly. This is the line whose absence is hardest to see.
  asm.aluN("or", 0);
}

/** `dst = |dst|`. */
export function abs32(ctx: SmsCtx, dst: Ref): void {
  const { asm } = ctx;
  const done = ctx.unique("absDone");
  testSign(ctx, dst);
  ctx.far("p", done);
  neg32(ctx, dst);
  asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * address goes in `ix`, which is what an index register is for: the routine
 * reads and writes four bytes at a known displacement without a single pointer
 * store, where the 6502 backend needs two forms of the same routine because its
 * only indirect mode goes through page zero.
 */
export function clamp32(ctx: SmsCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.ld16Idx("ix", dst);
  asm.call(ctx.need("Clamp32", emitClamp32));
}

/**
 * The clamp's decision: above `$04000000` or below `$FC000000` is out of range.
 *
 * Exactly `$04000000` is *in* range, which is why the positive boundary needs
 * the low three bytes checked before it gives up; the negative one does not,
 * because `$FC000000` is the limit itself and anything below it has a smaller
 * top byte.
 */
function emitClamp32(ctx: SmsCtx): void {
  const { asm } = ctx;
  const negative = ctx.unique("clampNeg");
  const high = ctx.unique("clampHigh");
  const store = ctx.unique("clampStore");

  asm.ldIdx("a", "ix", 3);
  asm.aluN("or", 0);
  asm.jp(negative, "m");
  asm.aluN("cp", (FIXED_MAX >>> 24) & 0xff);
  asm.ret("c"); // below the top byte of the limit: in range
  asm.jr(high, "nz"); // above it: clamp
  asm.ldIdx("a", "ix", 0);
  asm.aluIdx("or", "ix", 1);
  asm.aluIdx("or", "ix", 2);
  asm.ret("z"); // exactly $04000000
  asm.label(high);
  asm.ldn("a", (FIXED_MAX >>> 24) & 0xff);
  asm.jr(store);
  asm.label(negative);
  asm.aluN("cp", (-FIXED_MAX >>> 24) & 0xff);
  asm.ret("nc"); // at or above $FC000000: in range
  asm.ldn("a", (-FIXED_MAX >>> 24) & 0xff);
  asm.label(store);
  asm.stIdx("ix", 3, "a");
  asm.alu("xor", "a");
  asm.stIdx("ix", 0, "a");
  asm.stIdx("ix", 1, "a");
  asm.stIdx("ix", 2, "a");
  asm.ret();
}

// --- block arithmetic, for the multiply and divide workspaces ----------------

/** `addr[0..bytes) = 0`. Clobbers `a`, `hl`. */
function blockClear(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  asm.alu("xor", "a");
  asm.ld16("hl", addr);
  for (let index = 0; index < bytes; index += 1) {
    asm.ld("hlp", "a");
    if (index + 1 < bytes) asm.inc16("hl");
  }
}

/** `addr[0..bytes) <<= 1`. Clobbers `hl` and the flags. */
function blockShiftLeft(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr);
  asm.shift("sla", "hlp");
  for (let index = 1; index < bytes; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
}

/** `addr[0..bytes) >>= 1`, logical. Clobbers `hl` and the flags. */
function blockShiftRight(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr + bytes - 1);
  asm.shift("srl", "hlp");
  for (let index = bytes - 2; index >= 0; index -= 1) {
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
}

/** `dst[0..bytes) += src[0..bytes)`. Clobbers `a`, `hl`, `de`. */
function blockAdd(ctx: SmsCtx, dst: number, src: number, bytes: number): void {
  const { asm } = ctx;
  asm.ld16("hl", dst);
  asm.ld16("de", src);
  asm.aluN("or", 0); // clear the carry into the first `adc`
  for (let index = 0; index < bytes; index += 1) {
    asm.ldaDE();
    asm.alu("adc", "hlp");
    asm.ld("hlp", "a");
    if (index + 1 < bytes) {
      // Neither 16-bit increment touches the carry, which is what lets the chain
      // walk both pointers between the adds.
      asm.inc16("hl");
      asm.inc16("de");
    }
  }
}

/** `addr[0..bytes) = -addr[0..bytes)`. Clobbers `a`, `hl`. */
function blockNeg(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr);
  asm.aluN("or", 0);
  for (let index = 0; index < bytes; index += 1) {
    // `ld a,0` rather than `xor a`, because the second would clear the borrow
    // this chain is carrying. One byte more, and the reason it is worth it.
    asm.ldn("a", 0);
    asm.alu("sbc", "hlp");
    asm.ld("hlp", "a");
    if (index + 1 < bytes) asm.inc16("hl");
  }
}

/** Move a block down by one byte — a shift right by eight. Clobbers `bc`. */
function blockShiftDownByte(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr + 1);
  asm.ld16("de", addr);
  asm.ld16("bc", bytes - 1);
  asm.ldir();
  asm.alu("xor", "a");
  asm.sta(addr + bytes - 1);
}

/** Move a block up by one byte — a shift left by eight. Clobbers `bc`. */
function blockShiftUpByte(ctx: SmsCtx, addr: number, bytes: number): void {
  const { asm } = ctx;
  // Backwards, or the copy would smear the first byte through the block.
  asm.ld16("hl", addr + bytes - 2);
  asm.ld16("de", addr + bytes - 1);
  asm.ld16("bc", bytes - 1);
  asm.lddr();
  asm.alu("xor", "a");
  asm.sta(addr);
}

// --- multiply and divide -----------------------------------------------------

/**
 * `dst = floor(dst * src / 65536)`.
 *
 * Both operands go to the helper by address, because it needs them in its own
 * workspace anyway: sign comes off first and is reapplied to the whole product
 * before the shift, since a two's complement right shift is floor and negating
 * afterwards would round the wrong way for anything with a fractional part.
 */
export function mul32(ctx: SmsCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Mul32", emitMul32);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: SmsCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Div32", emitDiv32);
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(
  ctx: SmsCtx,
  dst: Ref,
  src: Ref,
  name: string,
  body: (ctx: SmsCtx) => void,
): void {
  const { asm, layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  asm.call(ctx.need(name, body));
  copy32(ctx, dst, layout.mathA);
}

/** `mathA = |mathA|` and `mathB = |mathB|`, remembering the product's sign. */
function signOf(ctx: SmsCtx, sign: number): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.mathA, 3));
  asm.ld16("hl", mem(layout.mathB, 3));
  asm.alu("xor", "hlp");
  asm.aluN("and", 0x80);
  asm.sta(sign);
  abs32(ctx, layout.mathA);
  abs32(ctx, layout.mathB);
}

/** Run `body` when the four bytes at `addr` are exactly 1.0. */
function ifOne(ctx: SmsCtx, addr: number, body: () => void): void {
  const { asm } = ctx;
  const no = ctx.unique("notOne");
  asm.ld16From("hl", mem(addr, 0));
  asm.ld("a", "h");
  asm.alu("or", "l");
  ctx.far("nz", no);
  asm.ld16From("hl", mem(addr, 2));
  asm.ld("a", "h");
  asm.aluN("or", 0);
  ctx.far("nz", no);
  asm.ld("a", "l");
  asm.dec("a");
  ctx.far("nz", no);
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
 * The product is seven bytes rather than eight because the operands are clamped:
 * `|a| ≤ 2^26` and `|b| ≤ 2^26` put the product below `2^52`, and the result is
 * its middle four bytes.
 */
function emitMul32(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const product = layout.mathWork; // 7 bytes
  const multiplicand = layout.mathWork + 7; // 7 bytes
  const sign = layout.mathWork + 14;

  const store = ctx.unique("mulStore");
  const general = ctx.unique("mulGeneral");
  const loop = ctx.unique("mulLoop");
  const noAdd = ctx.unique("mulNoAdd");
  const finish = ctx.unique("mulFinish");
  const positive = ctx.unique("mulPositive");
  const skipByte = ctx.unique("mulSkipByte");
  const doneSkip = ctx.unique("mulDoneSkip");
  const shifted = ctx.unique("mulShift");

  signOf(ctx, sign);

  // x * 1 is exact and extremely common: every object moving at a whole
  // direction does two of them per tick.
  ifOne(ctx, b, () => {
    asm.jp(store);
  });
  ifOne(ctx, a, () => {
    copy32(ctx, a, b);
    asm.jp(store);
  });
  asm.jp(general);

  asm.label(store);
  asm.lda(sign);
  asm.aluN("or", 0);
  ctx.far("z", positive);
  neg32(ctx, a);
  asm.label(positive);
  clamp32(ctx, a);
  asm.ret();

  asm.label(general);
  blockClear(ctx, product, 7);
  blockClear(ctx, multiplicand, 7);
  copy32(ctx, multiplicand, a);

  // Trailing zero bytes of the multiplier are free: shift eight of them out at
  // once and the multiplicand eight the other way. Speeds are whole cells per
  // second, so their low sixteen bits are zero and this removes most of the loop
  // before it starts.
  asm.label(skipByte);
  asm.lda(b);
  asm.aluN("or", 0);
  ctx.far("nz", doneSkip);
  isZero32(ctx, b);
  ctx.far("z", doneSkip);
  blockShiftDownByte(ctx, b, 4);
  blockShiftUpByte(ctx, multiplicand, 7);
  asm.jp(skipByte);
  asm.label(doneSkip);

  asm.label(loop);
  isZero32(ctx, b);
  ctx.far("z", finish);
  asm.lda(b);
  asm.aluN("and", 1);
  ctx.far("z", noAdd);
  blockAdd(ctx, product, multiplicand, 7);
  asm.label(noAdd);
  blockShiftLeft(ctx, multiplicand, 7);
  blockShiftRight(ctx, b, 4);
  asm.jp(loop);

  asm.label(finish);
  asm.lda(sign);
  asm.aluN("or", 0);
  ctx.far("z", shifted);
  blockNeg(ctx, product, 7);
  asm.label(shifted);
  // The product is 16.32; the result is its middle four bytes.
  copy32(ctx, a, product + 2);
  clamp32(ctx, a);
  asm.ret();
}

/**
 * The divide helper: `mathA = mathA * 65536 / mathB`.
 *
 * A divisor that is a whole number of cells has no fractional bits, so
 * `a * 65536 / (k * 65536)` collapses to `a / k` — a 32-by-8 division that is an
 * order of magnitude cheaper. Every `speed / fps` in a game takes that path,
 * which is why it is worth the branch.
 *
 * The dividend and the remainder are laid out *adjacently*, which the 6502
 * version cannot be bothered to do and this one depends on: shifting the
 * dividend left and the remainder's low bit in is then one ten-byte block shift
 * rather than two chained ones.
 */
function emitDiv32(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const work = layout.mathWork; // 6 bytes of dividend, then quotient
  const rem = layout.mathWork + 6; // 4 bytes, immediately above it
  const sign = layout.mathWork + 14;
  const counter = layout.mathWork + 15;

  const zero = ctx.unique("divZero");
  const general = ctx.unique("divGeneral");
  const signAndFloor = ctx.unique("divSign");
  const loop = ctx.unique("divLoop");
  const noFit = ctx.unique("divNoFit");
  const skipByte = ctx.unique("divSkipByte");
  const doneByte = ctx.unique("divDoneByte");
  const skipBit = ctx.unique("divSkipBit");
  const doneBit = ctx.unique("divDoneBit");
  const done = ctx.unique("divDone");

  isZero32(ctx, b);
  ctx.far("z", zero);
  isZero32(ctx, a);
  ctx.far("z", zero);
  signOf(ctx, sign);

  // A whole-cell divisor is bytes 0, 1 and 3 zero and byte 2 non-zero.
  asm.lda(mem(b, 0));
  asm.aluN("or", 0);
  ctx.far("nz", general);
  asm.lda(mem(b, 1));
  asm.aluN("or", 0);
  ctx.far("nz", general);
  asm.lda(mem(b, 3));
  asm.aluN("or", 0);
  ctx.far("nz", general);
  asm.lda(mem(b, 2));
  asm.aluN("or", 0);
  ctx.far("z", general);
  emitDivideByByte(ctx, a, b + 2, rem);
  asm.jp(signAndFloor);

  asm.label(general);
  // Dividend = |a| << 16 in the low six bytes; the quotient grows into the bytes
  // the dividend vacates.
  blockClear(ctx, work, 6);
  copy32(ctx, work + 2, a);

  // Leading zeros of the dividend produce leading zeros of the quotient, so they
  // can be shifted out and their iterations skipped — whole bytes first, then
  // the remaining bits of the top one.
  asm.ldn("a", 48);
  asm.sta(counter);
  asm.label(skipByte);
  asm.lda(work + 5);
  asm.aluN("or", 0);
  ctx.far("nz", doneByte);
  asm.lda(counter);
  asm.aluN("cp", 9);
  ctx.far("c", doneByte);
  asm.aluN("sub", 8);
  asm.sta(counter);
  blockShiftUpByte(ctx, work, 6);
  asm.jp(skipByte);
  asm.label(doneByte);
  asm.label(skipBit);
  asm.lda(work + 5);
  asm.aluN("or", 0);
  ctx.far("m", doneBit);
  asm.lda(counter);
  asm.aluN("cp", 2);
  ctx.far("c", doneBit);
  asm.dec("a");
  asm.sta(counter);
  blockShiftLeft(ctx, work, 6);
  asm.jp(skipBit);
  asm.label(doneBit);

  blockClear(ctx, rem, 4);
  asm.label(loop);
  // One shift over the dividend *and* the remainder, which are contiguous.
  blockShiftLeft(ctx, work, 10);
  // Does the divisor fit? An unsigned 32-bit compare, which is the borrow out of
  // a full subtraction — the carry, not the sign.
  asm.aluN("or", 0);
  asm.ld16From("hl", rem);
  asm.ld16From("de", mem(b, 0));
  asm.sbcHL("de");
  asm.ld16From("hl", rem + 2);
  asm.ld16From("de", mem(b, 2));
  asm.sbcHL("de");
  ctx.far("c", noFit);
  sub32(ctx, rem, b);
  asm.lda(work);
  asm.aluN("or", 1);
  asm.sta(work);
  asm.label(noFit);
  asm.lda(counter);
  asm.dec("a");
  asm.sta(counter);
  ctx.far("nz", loop);

  copy32(ctx, a, work);

  asm.label(signAndFloor);
  asm.lda(sign);
  asm.aluN("or", 0);
  ctx.far("z", done);
  neg32(ctx, a);
  // floor, not truncate: a negative quotient with a remainder rounds away.
  isZero32(ctx, rem);
  ctx.far("z", done);
  addConst32(ctx, a, -1);
  asm.label(done);
  clamp32(ctx, a);
  asm.ret();

  asm.label(zero);
  set32(ctx, a, 0);
  asm.ret();
}

/**
 * `value /= [divisor]`, 32 by 8, remainder into `rem`.
 *
 * The dividend and the quotient share the four bytes of `value`, and the
 * remainder is one byte in the accumulator: the remainder of a division by `k`
 * is below `k`, so it fits — but it can reach `2k-1` inside the loop, which
 * overflows a byte when the divisor is above 128. The carry out of the shift is
 * that ninth bit, and it always means "subtract".
 */
function emitDivideByByte(ctx: SmsCtx, value: number, divisor: number, rem: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("byteDivLoop");
  const next = ctx.unique("byteDivNext");
  const subtract = ctx.unique("byteDivSub");
  const counter = ctx.layout.mathWork + 16;

  asm.ldn("a", 32);
  asm.sta(counter);
  asm.alu("xor", "a"); // the running remainder
  asm.label(loop);
  // The accumulator holds the remainder across the shift, so it goes into `b`
  // while `blockShiftLeft` uses the flags and `hl`.
  asm.ld("b", "a");
  blockShiftLeft(ctx, value, 4);
  asm.ld("a", "b");
  asm.shift("rl", "a"); // the bit that left the dividend becomes the remainder's
  ctx.far("c", subtract); // the ninth bit: always enough to subtract
  asm.ld16("hl", divisor);
  asm.alu("cp", "hlp");
  ctx.far("c", next);
  asm.label(subtract);
  asm.ld16("hl", divisor);
  asm.alu("sub", "hlp");
  asm.ld16("hl", value);
  asm.inc("hlp");
  asm.label(next);
  asm.ld("b", "a");
  asm.lda(counter);
  asm.dec("a");
  asm.sta(counter);
  asm.ld("a", "b");
  ctx.far("nz", loop);
  asm.sta(rem);
  asm.alu("xor", "a");
  asm.sta(rem + 1);
  asm.sta(rem + 2);
  asm.sta(rem + 3);
}
