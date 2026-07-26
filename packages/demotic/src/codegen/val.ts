/**
 * 16.16 fixed-point code generation.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts`, and the
 * pairing has to be exact: a one-bit disagreement in a velocity compounds into
 * a visibly different game a thousand ticks later, which is what the trace
 * oracle exists to catch. **Rounding is floor, toward negative infinity,
 * everywhere** — which an arithmetic shift already does, so it is the cheap
 * rule as well as the stated one.
 *
 * The difference from an interpreter is that these are *emitters*: they take
 * addresses that are constants at compile time and produce straight-line code
 * against them. There is no operand marshalling, because there are no operands
 * to marshal.
 *
 * Two decisions worth stating:
 *
 *   - **Comparison lowers to `less` and `equal`, not to a three-way result.**
 *     Every relational operator is one of those two, possibly negated or with
 *     its operands swapped, and both are cheaper than computing a sign. `less`
 *     is a plain subtraction whose high byte carries the answer, which is exact
 *     here because the clamped range makes overflow impossible.
 *   - **A constant operand is addressed in ROM, not copied into RAM.** Adding
 *     one is then the same shape as adding a variable, and the pool
 *     deduplicates.
 */

import { type Ref } from "@demake/core";

import type { Ctx } from "./ctx.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/** A four-byte value the emitters can read. */
export interface Value {
  /** Where it lives. */
  addr: Ref;
  /** True when the caller owns the storage and may overwrite it. */
  mutable: boolean;
}

/** Offset an address operand, whichever spelling it uses. */
function plus(addr: Ref, offset: number): Ref {
  if (typeof addr === "number") return addr + offset;
  if (typeof addr === "string") return { label: addr, addend: offset };
  return { label: addr.label, addend: addr.addend + offset };
}

/** `dst = src`, four bytes. */
export function copy32(ctx: Ctx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", src);
  asm.ld16("de", dst);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.staDE();
    if (index < 3) asm.inc16("de");
  }
}

/** `dst = value`, skipping bytes that are already correct is not safe here. */
export function set32(ctx: Ctx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  // Zero is by far the commonest literal, and `xor a` is one byte.
  let held: number | null = null;
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[index] as number;
    if (held !== byte) {
      if (byte === 0) asm.alu("xor", "a");
      else asm.ldn("a", byte);
      held = byte;
    }
    asm.sta(plus(dst, index));
  }
}

/** `dst += src`. */
export function add32(ctx: Ctx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", src);
  asm.ld16("de", dst);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaDE();
    asm.alu(index === 0 ? "add" : "adc", "hlp");
    asm.staDE();
    if (index < 3) {
      asm.inc16("hl");
      asm.inc16("de");
    }
  }
}

/** `dst -= src`. */
export function sub32(ctx: Ctx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", src);
  asm.ld16("de", dst);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaDE();
    asm.alu(index === 0 ? "sub" : "sbc", "hlp");
    asm.staDE();
    if (index < 3) {
      asm.inc16("hl");
      asm.inc16("de");
    }
  }
}

/**
 * `dst += value`, with the leading zero bytes of the literal skipped.
 *
 * Adding zero with the carry clear cannot change a byte or produce a carry, so
 * the first non-zero byte of the constant is where the code has to start. For
 * `+1.0` that removes half the instructions.
 */
export function addConst32(ctx: Ctx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  let first = 0;
  while (first < 4 && bytes[first] === 0) first += 1;
  if (first === 4) return;
  for (let index = first; index < 4; index += 1) {
    asm.lda(plus(dst, index));
    asm.aluN(index === first ? "add" : "adc", bytes[index] as number);
    asm.sta(plus(dst, index));
  }
}

/** `dst = -dst`. */
export function neg32(ctx: Ctx, dst: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", dst);
  asm.alu("or", "a"); // clear carry
  for (let index = 0; index < 4; index += 1) {
    asm.ldn("a", 0);
    asm.alu("sbc", "hlp");
    asm.staHLI();
  }
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: Ctx, dst: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", plus(dst, 3));
  asm.shift("sra", "hlp");
  for (let index = 0; index < 3; index += 1) {
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
}

/** Z is set when the value is zero. Clobbers A and HL. */
export function isZero32(ctx: Ctx, addr: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", addr);
  asm.ldaHLI();
  asm.alu("or", "hlp");
  asm.inc16("hl");
  asm.alu("or", "hlp");
  asm.inc16("hl");
  asm.alu("or", "hlp");
}

/**
 * Leave `lhs < rhs` in the carry flag (signed).
 *
 * The subtraction's high byte holds the sign of the difference, and the clamped
 * range rules out the overflow case that would make that reasoning wrong. `rla`
 * moves that sign into carry, so the caller branches with `jr c`.
 */
export function less32(ctx: Ctx, lhs: Ref, rhs: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", rhs);
  asm.ld16("de", lhs);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaDE();
    asm.alu(index === 0 ? "sub" : "sbc", "hlp");
    if (index < 3) {
      asm.inc16("hl");
      asm.inc16("de");
    }
  }
  asm.rla();
}

/** Z is set when the two values are equal. Uses xor, so no carry is involved. */
export function equal32(ctx: Ctx, lhs: Ref, rhs: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", rhs);
  asm.ld16("de", lhs);
  asm.ldaDE();
  asm.alu("xor", "hlp");
  asm.ld("b", "a");
  for (let index = 1; index < 4; index += 1) {
    asm.inc16("hl");
    asm.inc16("de");
    asm.ldaDE();
    asm.alu("xor", "hlp");
    asm.alu("or", "b");
    if (index < 3) asm.ld("b", "a");
  }
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * common case is nowhere near the limit, so the test is arranged to fall
 * through in three instructions when the high byte is small.
 */
export function clamp32(ctx: Ctx, dst: Ref): void {
  const { asm } = ctx;
  asm.ld16("hl", dst);
  asm.call(ctx.need("Clamp32", emitClamp32));
}

/**
 * `[hl] = clamp([hl], -1024, 1024)` on a 16.16 value.
 *
 * A routine rather than the forty bytes it used to be inline: every write to a
 * position clamps, so a game with a few dozen of them was spending a fifth of
 * its cartridge on the same eight branches over and over. The shooter's
 * twenty-seven collision pairs alone were seven kilobytes of it.
 */
function emitClamp32(ctx: Ctx): void {
  const { asm } = ctx;
  const done = ctx.unique("clampDone");
  const high = ctx.unique("clampHigh");
  const low = ctx.unique("clampLow");
  const negative = ctx.unique("clampNeg");
  const store = ctx.unique("clampStore");

  // de keeps the base while hl walks the bytes.
  asm.ld("d", "h");
  asm.ld("e", "l");
  asm.inc16("hl");
  asm.inc16("hl");
  asm.inc16("hl");
  asm.ld("a", "hlp");
  asm.bit(7, "a");
  asm.jr(negative, "nz");
  asm.aluN("cp", 0x04);
  asm.jr(done, "c");
  asm.jr(high, "nz");
  // Exactly $04xxxxxx is in range only when the low three bytes are zero.
  asm.ld("h", "d");
  asm.ld("l", "e");
  asm.ldaHLI();
  asm.alu("or", "hlp");
  asm.inc16("hl");
  asm.alu("or", "hlp");
  asm.jr(done, "z");
  asm.label(high);
  asm.ldn("c", (FIXED_MAX >>> 24) & 0xff);
  asm.jr(store);
  asm.label(negative);
  asm.aluN("cp", 0xfc);
  asm.jr(done, "nc");
  asm.label(low);
  asm.ldn("c", (-FIXED_MAX >>> 24) & 0xff);
  asm.label(store);
  // Both limits are three zero bytes and a sign, so they share the write.
  asm.ld("h", "d");
  asm.ld("l", "e");
  asm.alu("xor", "a");
  asm.staHLI();
  asm.staHLI();
  asm.staHLI();
  asm.ld("a", "c");
  asm.ld("hlp", "a");
  asm.label(done);
  asm.ret();
}

/**
 * `dst = floor(dst * src / 65536)`.
 *
 * Shift-and-add over the multiplier's bits, exiting the moment it runs dry,
 * with the ±1.0 identities taken before the loop — a direction is almost always
 * exactly one, and that case is exact so it can skip the arithmetic entirely.
 */
export function mul32(ctx: Ctx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  const routine = ctx.need("Mul32", emitMul32);
  asm.ld16("hl", dst);
  asm.ld16("de", src);
  asm.ld16("bc", dst);
  asm.call(routine);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: Ctx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  const routine = ctx.need("Div32", emitDiv32);
  asm.ld16("hl", dst);
  asm.ld16("de", src);
  asm.ld16("bc", dst);
  asm.call(routine);
}

// --- the two helpers ---------------------------------------------------------

/** Copy four bytes from `[hl]` into an absolute address, advancing HL. */
function copyFromHL(ctx: Ctx, dst: number): void {
  const { asm } = ctx;
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.sta(dst + index);
  }
}

/** `mathA = |mathA|`, returning its sign in the Z flag of the caller's choosing. */
function absInto(ctx: Ctx, addr: number, skip: string): void {
  const { asm } = ctx;
  asm.lda(addr + 3);
  asm.bit(7, "a");
  asm.jr(skip, "z");
  neg32(ctx, addr);
  asm.label(skip);
}

/**
 * The multiply helper: HL = left, DE = right, BC = destination.
 *
 * Sign is taken off first and reapplied to the whole product before the shift,
 * because a two's complement right shift is floor — negating afterwards would
 * round the wrong way for anything with a fractional part.
 */
function emitMul32(ctx: Ctx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const product = layout.mathWork; // 7 bytes
  const multiplicand = layout.mathWork + 7; // 7 bytes
  const sign = layout.mathWork + 14;
  const dest = layout.mathWork + 15; // 2 bytes

  asm.ld("a", "c");
  asm.sta(dest);
  asm.ld("a", "b");
  asm.sta(dest + 1);
  copyFromHL(ctx, a);
  asm.ld("h", "d");
  asm.ld("l", "e");
  copyFromHL(ctx, b);

  // sign = sign(a) xor sign(b)
  asm.lda(a + 3);
  asm.ld("b", "a");
  asm.lda(b + 3);
  asm.alu("xor", "b");
  asm.aluN("and", 0x80);
  asm.sta(sign);
  absInto(ctx, a, ctx.unique("mulAbsA"));
  absInto(ctx, b, ctx.unique("mulAbsB"));

  const store = ctx.unique("mulStore");
  const general = ctx.unique("mulGeneral");
  const loop = ctx.unique("mulLoop");
  const noAdd = ctx.unique("mulNoAdd");
  const finish = ctx.unique("mulFinish");
  const positive = ctx.unique("mulPositive");

  // x * 1 is exact and extremely common: every object moving at a whole
  // direction does two of them per tick.
  emitIsOne(ctx, b, () => {
    asm.jp(store);
  });
  emitIsOne(ctx, a, () => {
    copy32(ctx, a, b);
    asm.jp(store);
  });
  asm.jp(general);

  asm.label(store);
  asm.lda(sign);
  asm.alu("or", "a");
  asm.jr(positive, "z");
  neg32(ctx, a);
  asm.label(positive);
  clamp32(ctx, a);
  emitStoreResult(ctx, a, dest);
  asm.ret();

  asm.label(general);
  for (let index = 0; index < 7; index += 1) {
    asm.ldn("a", 0);
    asm.sta(product + index);
    asm.sta(multiplicand + index);
  }
  copy32(ctx, multiplicand, a);

  // Trailing zero bytes of the multiplier are free: shift eight of them out at
  // once and the multiplicand eight the other way. Speeds are whole cells per
  // second, so their low sixteen bits are zero and this removes most of the
  // loop before it starts.
  const skipByte = ctx.unique("mulSkipByte");
  const doneSkip = ctx.unique("mulDoneSkip");
  asm.label(skipByte);
  asm.lda(b);
  asm.alu("or", "a");
  asm.jp(doneSkip, "nz");
  isZero32(ctx, b);
  asm.jp(doneSkip, "z");
  for (let index = 0; index < 3; index += 1) {
    asm.lda(b + index + 1);
    asm.sta(b + index);
  }
  asm.alu("xor", "a");
  asm.sta(b + 3);
  for (let index = 6; index >= 1; index -= 1) {
    asm.lda(multiplicand + index - 1);
    asm.sta(multiplicand + index);
  }
  asm.alu("xor", "a");
  asm.sta(multiplicand);
  asm.jp(skipByte);
  asm.label(doneSkip);

  asm.label(loop);
  // while (b != 0)
  isZero32(ctx, b);
  asm.jp(finish, "z");
  asm.lda(b);
  asm.aluN("and", 1);
  asm.jr(noAdd, "z");
  asm.ld16("hl", multiplicand);
  asm.ld16("de", product);
  for (let index = 0; index < 7; index += 1) {
    asm.ldaDE();
    asm.alu(index === 0 ? "add" : "adc", "hlp");
    asm.staDE();
    if (index < 6) {
      asm.inc16("hl");
      asm.inc16("de");
    }
  }
  asm.label(noAdd);
  asm.ld16("hl", multiplicand);
  asm.shift("sla", "hlp");
  for (let index = 0; index < 6; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
  asm.ld16("hl", b + 3);
  asm.shift("srl", "hlp");
  for (let index = 0; index < 3; index += 1) {
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
  asm.jp(loop);

  asm.label(finish);
  const shifted = ctx.unique("mulShift");
  asm.lda(sign);
  asm.alu("or", "a");
  asm.jr(shifted, "z");
  asm.ld16("hl", product);
  asm.alu("or", "a");
  for (let index = 0; index < 7; index += 1) {
    asm.ldn("a", 0);
    asm.alu("sbc", "hlp");
    asm.staHLI();
  }
  asm.label(shifted);
  for (let index = 0; index < 4; index += 1) {
    asm.lda(product + 2 + index);
    asm.sta(a + index);
  }
  clamp32(ctx, a);
  emitStoreResult(ctx, a, dest);
  asm.ret();
}

/** Branch into `body` when the four bytes at `addr` are exactly 1.0. */
function emitIsOne(ctx: Ctx, addr: number, body: () => void): void {
  const { asm } = ctx;
  const no = ctx.unique("notOne");
  asm.lda(addr);
  asm.alu("or", "a");
  asm.jr(no, "nz");
  asm.lda(addr + 1);
  asm.alu("or", "a");
  asm.jr(no, "nz");
  asm.lda(addr + 3);
  asm.alu("or", "a");
  asm.jr(no, "nz");
  asm.lda(addr + 2);
  asm.aluN("cp", 1);
  asm.jr(no, "nz");
  body();
  asm.label(no);
}

/** Copy the helper's accumulator to the destination the caller passed in BC. */
function emitStoreResult(ctx: Ctx, from: number, destPtr: number): void {
  const { asm } = ctx;
  asm.lda(destPtr);
  asm.ld("e", "a");
  asm.lda(destPtr + 1);
  asm.ld("d", "a");
  asm.ld16("hl", from);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.staDE();
    if (index < 3) asm.inc16("de");
  }
}

/**
 * The divide helper: HL = dividend, DE = divisor, BC = destination.
 *
 * A divisor that is a whole number of cells has no fractional bits, so
 * `a * 65536 / (k * 65536)` collapses to `a / k` — a 32-by-8 division that
 * fits entirely in registers and is an order of magnitude cheaper. Every
 * `speed / fps` in a game takes that path, which is why it is worth the branch.
 */
function emitDiv32(ctx: Ctx): void {
  const { asm, layout } = ctx;
  const opA = layout.mathA;
  const opB = layout.mathB;
  const work = layout.mathWork; // 6 bytes of dividend/quotient
  const rem = layout.mathWork + 7; // 4 bytes
  const sign = layout.mathWork + 14;
  const dest = layout.mathWork + 15;

  const zero = ctx.unique("divZero");
  const general = ctx.unique("divGeneral");
  const signAndFloor = ctx.unique("divSign");

  asm.ld("a", "c");
  asm.sta(dest);
  asm.ld("a", "b");
  asm.sta(dest + 1);
  copyFromHL(ctx, opA);
  asm.ld("h", "d");
  asm.ld("l", "e");
  copyFromHL(ctx, opB);

  isZero32(ctx, opB);
  asm.jp(zero, "z");
  isZero32(ctx, opA);
  asm.jp(zero, "z");

  asm.lda(opA + 3);
  asm.ld("b", "a");
  asm.lda(opB + 3);
  asm.alu("xor", "b");
  asm.aluN("and", 0x80);
  asm.sta(sign);
  absInto(ctx, opA, ctx.unique("divAbsA"));
  absInto(ctx, opB, ctx.unique("divAbsB"));

  // Whole-cell divisor? Bytes 0, 1 and 3 zero, byte 2 non-zero.
  asm.lda(opB);
  asm.alu("or", "a");
  asm.jp(general, "nz");
  asm.lda(opB + 1);
  asm.alu("or", "a");
  asm.jp(general, "nz");
  asm.lda(opB + 3);
  asm.alu("or", "a");
  asm.jp(general, "nz");
  asm.lda(opB + 2);
  asm.alu("or", "a");
  asm.jp(general, "z");
  emitDivideByByte(ctx, opA, opB + 2, rem);
  asm.jp(signAndFloor);

  asm.label(general);
  // Dividend = |a| << 16 in the low six bytes; the quotient grows into the
  // bytes the dividend vacates.
  for (let index = 0; index < 7; index += 1) {
    asm.ldn("a", 0);
    asm.sta(work + index);
  }
  for (let index = 0; index < 4; index += 1) {
    asm.lda(opA + index);
    asm.sta(work + 2 + index);
  }

  // Leading zeros of the dividend produce leading zeros of the quotient, so
  // they can be shifted out and their iterations skipped. That is worth doing
  // twice over: whole bytes first, then the remaining bits of the top one.
  const counter = layout.scratch + 4;
  const loop = ctx.unique("divLoop");
  const noFit = ctx.unique("divNoFit");
  const fits = ctx.unique("divFits");
  const skipByte = ctx.unique("divSkipByte");
  const doneByte = ctx.unique("divDoneByte");
  const skipBit = ctx.unique("divSkipBit");
  const doneBit = ctx.unique("divDoneBit");

  asm.ldn("a", 48);
  asm.sta(counter);
  asm.label(skipByte);
  asm.lda(work + 5);
  asm.alu("or", "a");
  asm.jp(doneByte, "nz");
  asm.lda(counter);
  asm.aluN("cp", 9);
  asm.jp(doneByte, "c");
  asm.aluN("sub", 8);
  asm.sta(counter);
  for (let index = 5; index >= 1; index -= 1) {
    asm.lda(work + index - 1);
    asm.sta(work + index);
  }
  asm.alu("xor", "a");
  asm.sta(work);
  asm.jp(skipByte);
  asm.label(doneByte);
  asm.label(skipBit);
  asm.lda(work + 5);
  asm.bit(7, "a");
  asm.jp(doneBit, "nz");
  asm.lda(counter);
  asm.aluN("cp", 2);
  asm.jp(doneBit, "c");
  asm.dec("a");
  asm.sta(counter);
  asm.ld16("hl", work);
  asm.shift("sla", "hlp");
  for (let index = 0; index < 5; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
  asm.jp(skipBit);
  asm.label(doneBit);

  // The remainder lives in b c d e for the whole loop: it is read four times
  // per iteration, and memory would cost more than the register pressure does.
  asm.ldn("b", 0);
  asm.ldn("c", 0);
  asm.ldn("d", 0);
  asm.ldn("e", 0);
  asm.label(loop);
  asm.ld16("hl", work);
  asm.shift("sla", "hlp");
  for (let index = 0; index < 5; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
  asm.shift("rl", "e");
  asm.shift("rl", "d");
  asm.shift("rl", "c");
  asm.shift("rl", "b");
  // Does the divisor fit? Compare from the top down and stop at the first
  // byte that decides it — which is almost always the first.
  asm.ld16("hl", opB + 3);
  asm.ld("a", "b");
  asm.alu("cp", "hlp");
  asm.jp(noFit, "c");
  asm.jp(fits, "nz");
  asm.dec16("hl");
  asm.ld("a", "c");
  asm.alu("cp", "hlp");
  asm.jp(noFit, "c");
  asm.jp(fits, "nz");
  asm.dec16("hl");
  asm.ld("a", "d");
  asm.alu("cp", "hlp");
  asm.jp(noFit, "c");
  asm.jp(fits, "nz");
  asm.dec16("hl");
  asm.ld("a", "e");
  asm.alu("cp", "hlp");
  asm.jp(noFit, "c");
  asm.label(fits);
  asm.ld16("hl", opB);
  asm.ld("a", "e");
  asm.alu("sub", "hlp");
  asm.ld("e", "a");
  asm.inc16("hl");
  asm.ld("a", "d");
  asm.alu("sbc", "hlp");
  asm.ld("d", "a");
  asm.inc16("hl");
  asm.ld("a", "c");
  asm.alu("sbc", "hlp");
  asm.ld("c", "a");
  asm.inc16("hl");
  asm.ld("a", "b");
  asm.alu("sbc", "hlp");
  asm.ld("b", "a");
  asm.ld16("hl", work);
  asm.set(0, "hlp");
  asm.label(noFit);
  asm.ld16("hl", counter);
  asm.dec("hlp");
  asm.jp(loop, "nz");

  asm.ld("a", "e");
  asm.sta(rem);
  asm.ld("a", "d");
  asm.sta(rem + 1);
  asm.ld("a", "c");
  asm.sta(rem + 2);
  asm.ld("a", "b");
  asm.sta(rem + 3);
  for (let index = 0; index < 4; index += 1) {
    asm.lda(work + index);
    asm.sta(opA + index);
  }

  asm.label(signAndFloor);
  const done = ctx.unique("divDone");
  asm.lda(sign);
  asm.alu("or", "a");
  asm.jr(done, "z");
  neg32(ctx, opA);
  // floor, not truncate: a negative quotient with a remainder rounds away.
  isZero32(ctx, rem);
  asm.jr(done, "z");
  asm.ld16("hl", opA);
  asm.scf();
  for (let index = 0; index < 4; index += 1) {
    asm.ld("a", "hlp");
    asm.aluN("sbc", 0);
    asm.staHLI();
  }
  asm.label(done);
  clamp32(ctx, opA);
  emitStoreResult(ctx, opA, dest);
  asm.ret();

  asm.label(zero);
  for (let index = 0; index < 4; index += 1) {
    asm.ldn("a", 0);
    asm.sta(opA + index);
  }
  emitStoreResult(ctx, opA, dest);
  asm.ret();
}

/**
 * `value /= [divisor]`, 32 by 8, remainder into `rem`.
 *
 * The dividend, the quotient and the remainder all live in registers: b c d e
 * carry the dividend and take the quotient as it vacates, a holds the
 * remainder, h the divisor and l the bit counter. The remainder can reach
 * `2k-1`, which overflows a byte when the divisor is above 128 — the carry out
 * of the shift is that ninth bit, and it always means "subtract".
 */
function emitDivideByByte(ctx: Ctx, value: number, divisor: number, rem: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("byteDivLoop");
  const next = ctx.unique("byteDivNext");
  const subtract = ctx.unique("byteDivSub");

  asm.lda(value + 3);
  asm.ld("b", "a");
  asm.lda(value + 2);
  asm.ld("c", "a");
  asm.lda(value + 1);
  asm.ld("d", "a");
  asm.lda(value);
  asm.ld("e", "a");
  asm.lda(divisor);
  asm.ld("h", "a");
  asm.ldn("l", 32);
  asm.alu("xor", "a");
  asm.label(loop);
  asm.shift("sla", "e");
  asm.shift("rl", "d");
  asm.shift("rl", "c");
  asm.shift("rl", "b");
  asm.rla();
  asm.jr(subtract, "c");
  asm.alu("cp", "h");
  asm.jr(next, "c");
  asm.label(subtract);
  asm.alu("sub", "h");
  asm.inc("e");
  asm.label(next);
  asm.dec("l");
  asm.jr(loop, "nz");
  asm.sta(rem);
  asm.ld("a", "e");
  asm.sta(value);
  asm.ld("a", "d");
  asm.sta(value + 1);
  asm.ld("a", "c");
  asm.sta(value + 2);
  asm.ld("a", "b");
  asm.sta(value + 3);
  asm.ldn("a", 0);
  asm.sta(rem + 1);
  asm.sta(rem + 2);
  asm.sta(rem + 3);
}
