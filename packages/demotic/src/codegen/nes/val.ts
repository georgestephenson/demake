/**
 * 16.16 fixed-point code generation for the 6502.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * the Game Boy backend's `val.ts`, and all three have to agree exactly: a
 * one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere** — which an
 * arithmetic shift already does, so it is the cheap rule as well as the stated
 * one.
 *
 * This is where the 6502 is *better* than the Game Boy at the job, and it is
 * worth saying why: the SM83 has to funnel every memory operand through `HL` or
 * `DE`, so a 32-bit add costs two pointer loads before it starts. Here an add is
 * four `lda`/`adc`/`sta` triples over addresses the compiler already knows, with
 * no pointer at all — and when the operand is in page zero, which every
 * expression temporary is, each of those is two bytes.
 *
 * Two conventions differ from the Game Boy's, both because the flags do:
 *
 *   - **Comparisons branch rather than leaving a flag.** The SM83 version leaves
 *     `lhs < rhs` in the carry for the caller to test; here the sign lives in the
 *     final `sbc`'s N flag, and the *only* thing that can be done with it before
 *     something clobbers it is branch. So the comparison takes its target.
 *   - **The clamp comes in two forms.** Its argument is an address, and the
 *     cheapest way to pass one depends on where it is: a page-zero target goes in
 *     `X` and is reached with `$00,x`, while anything else needs a pointer written
 *     into page zero. Since every expression temporary is in page zero and most
 *     clamps are of temporaries, the short form is the common one — five bytes at
 *     the call site against eleven.
 */

import { absX, acc, imm, indY, type Ref } from "@demake/core";

import type { NesCtx } from "./ctx.js";
import { inFastPage, mem, ZP } from "./zp.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/** `dst = src`, four bytes. */
export function copy32(ctx: NesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(src, index));
    asm.sta(mem(dst, index));
  }
}

/** `dst = value`. */
export function set32(ctx: NesCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  // Zero is by far the commonest literal, and holding the byte in A across
  // stores is what makes `set32(x, 0)` four stores and one load.
  let held: number | null = null;
  for (let index = 0; index < 4; index += 1) {
    const byte = bytes[index] as number;
    if (held !== byte) {
      asm.lda(imm(byte));
      held = byte;
    }
    asm.sta(mem(dst, index));
  }
}

/** `dst += src`. */
export function add32(ctx: NesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.clc();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(dst, index));
    asm.adc(mem(src, index));
    asm.sta(mem(dst, index));
  }
}

/** `dst -= src`. */
export function sub32(ctx: NesCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.sec();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(dst, index));
    asm.sbc(mem(src, index));
    asm.sta(mem(dst, index));
  }
}

/**
 * `dst += value`, with the leading zero bytes of the literal skipped.
 *
 * Adding zero with the carry clear cannot change a byte or produce a carry, so
 * the first non-zero byte of the constant is where the code has to start. For
 * `+1.0` that removes half the instructions.
 */
export function addConst32(ctx: NesCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  let first = 0;
  while (first < 4 && bytes[first] === 0) first += 1;
  if (first === 4) return;
  asm.clc();
  for (let index = first; index < 4; index += 1) {
    asm.lda(mem(dst, index));
    asm.adc(imm(bytes[index] as number));
    asm.sta(mem(dst, index));
  }
}

/** `dst = -dst`. */
export function neg32(ctx: NesCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.sec();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(imm(0));
    asm.sbc(mem(dst, index));
    asm.sta(mem(dst, index));
  }
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: NesCtx, dst: Ref): void {
  const { asm } = ctx;
  // The top byte's sign has to come back in at the top, so it goes out through
  // the carry first: `asl` on a copy of it, then rotate the whole value right.
  asm.lda(mem(dst, 3));
  asm.asl(acc);
  for (let index = 3; index >= 0; index -= 1) asm.ror(mem(dst, index));
}

/** Set Z when the value is zero. Clobbers A. */
export function isZero32(ctx: NesCtx, addr: Ref): void {
  const { asm } = ctx;
  asm.lda(mem(addr, 0));
  for (let index = 1; index < 4; index += 1) asm.ora(mem(addr, index));
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: NesCtx, addr: Ref, target: string, whenZero = true): void {
  isZero32(ctx, addr);
  ctx.far(whenZero ? "eq" : "ne", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * The subtraction's high byte holds the sign of the difference, and the clamped
 * range rules out the overflow case that would make that reasoning wrong. The
 * final `sbc` leaves that sign in N, and the `lda`s between the `sbc`s do not
 * disturb the carry — which is what lets the chain run without saving anything.
 */
export function branchLess32(ctx: NesCtx, lhs: Ref, rhs: Ref, target: string, whenLess = true) {
  const { asm } = ctx;
  asm.sec();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(lhs, index));
    asm.sbc(mem(rhs, index));
  }
  ctx.far(whenLess ? "mi" : "pl", target);
}

/** Branch on equality, by comparing until a byte differs. */
export function branchEqual32(ctx: NesCtx, lhs: Ref, rhs: Ref, target: string, whenEqual = true) {
  const { asm } = ctx;
  if (whenEqual) {
    // A local label, so these four can be short branches: the whole comparison
    // is a dozen bytes and nothing between them can be far away.
    const no = ctx.unique("neq");
    for (let index = 0; index < 4; index += 1) {
      asm.lda(mem(lhs, index));
      asm.cmp(mem(rhs, index));
      asm.bne(no);
    }
    ctx.far("eq", target);
    asm.label(no);
    return;
  }
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(lhs, index));
    asm.cmp(mem(rhs, index));
    ctx.far("ne", target);
  }
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: NesCtx, addr: Ref, value: number, target: string): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(addr, index));
    asm.cmp(imm(bytes[index] as number));
    ctx.far("ne", target);
  }
}

/** `dst = |dst|`. */
export function abs32(ctx: NesCtx, dst: Ref): void {
  const { asm } = ctx;
  const done = ctx.unique("absDone");
  asm.lda(mem(dst, 3));
  ctx.far("pl", done);
  neg32(ctx, dst);
  asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. Which
 * of the two routines it calls depends only on where the value is: a page-zero
 * target — every expression temporary and every staging slot — is passed in `X`
 * and reached with `$00,x`, which is two instructions at the call site. Anything
 * else needs its address written into a pointer first.
 */
export function clamp32(ctx: NesCtx, dst: Ref): void {
  const { asm } = ctx;
  if (inFastPage(dst)) {
    asm.ldx(imm(dst as number));
    asm.jsr(ctx.need("ClampZp", emitClampZp));
    return;
  }
  ctx.pointer(ZP.p0, dst);
  asm.jsr(ctx.need("ClampPtr", emitClampPtr));
}

/** How one of the clamp routines reaches the four bytes it was given. */
interface ByteAccess {
  load(index: number): void;
  orIn(index: number): void;
  store(index: number): void;
}

/**
 * The clamp's decision, emitted twice over two ways of reaching a byte.
 *
 * The access is the only difference between the page-zero form and the pointer
 * form, so the logic exists once: above `$04000000` is out of range, and exactly
 * `$04000000` is in it, so the boundary needs the low three bytes checked; below
 * `$FC000000` is out of range the other way. Both limits are three zero bytes and
 * a sign, which is why they share the store.
 */
function emitClampBody(ctx: NesCtx, byte: ByteAccess): void {
  const { asm } = ctx;
  const done = ctx.unique("clampDone");
  const high = ctx.unique("clampHigh");
  const negative = ctx.unique("clampNeg");
  const store = ctx.unique("clampStore");

  byte.load(3);
  ctx.far("mi", negative);
  asm.cmp(imm(0x04));
  ctx.far("cc", done);
  ctx.far("ne", high);
  // Exactly $04000000 is in range; $04 with anything below it is not.
  byte.load(0);
  byte.orIn(1);
  byte.orIn(2);
  ctx.far("eq", done);
  asm.label(high);
  asm.lda(imm((FIXED_MAX >>> 24) & 0xff));
  asm.jmp(store);
  asm.label(negative);
  asm.cmp(imm(0xfc));
  ctx.far("cs", done);
  asm.lda(imm((-FIXED_MAX >>> 24) & 0xff));
  asm.label(store);
  asm.sta(mem(ZP.t1));
  asm.lda(imm(0));
  byte.store(0);
  byte.store(1);
  byte.store(2);
  asm.lda(mem(ZP.t1));
  byte.store(3);
  asm.label(done);
  asm.rts();
}

/**
 * `X` = a page-zero address: clamp the four bytes there.
 *
 * `$0000,x` rather than `$00,x`, deliberately. The zero-page indexed form wraps
 * at `$FF`, so a four-byte value starting at `$FD` would have its top byte land
 * on `$00` — which is the first argument pointer. Absolute indexed carries
 * instead, and costs one cycle for the guarantee.
 */
function emitClampZp(ctx: NesCtx): void {
  const { asm } = ctx;
  emitClampBody(ctx, {
    load: (index) => asm.lda(absX(index)),
    orIn: (index) => asm.ora(absX(index)),
    store: (index) => asm.sta(absX(index)),
  });
}

/** `p0` points at the value: clamp the four bytes there. */
function emitClampPtr(ctx: NesCtx): void {
  const { asm } = ctx;
  const reach = (index: number): void => {
    asm.ldy(imm(index));
  };
  emitClampBody(ctx, {
    load: (index) => {
      reach(index);
      asm.lda(indY(ZP.p0));
    },
    orIn: (index) => {
      reach(index);
      asm.ora(indY(ZP.p0));
    },
    store: (index) => {
      reach(index);
      asm.sta(indY(ZP.p0));
    },
  });
}

/**
 * `dst = floor(dst * src / 65536)`.
 *
 * Both operands go to the helper by address, because it needs them in its own
 * workspace anyway: sign comes off first and is reapplied to the whole product
 * before the shift, since a two's complement right shift is floor and negating
 * afterwards would round the wrong way for anything with a fractional part.
 */
export function mul32(ctx: NesCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, ctx.need("Mul32", emitMul32));
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: NesCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, ctx.need("Div32", emitDiv32));
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(ctx: NesCtx, dst: Ref, src: Ref, routine: Ref): void {
  const { asm, layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  asm.jsr(routine);
  copy32(ctx, dst, layout.mathA);
}

/** `mathA = |mathA|`, remembering its sign for the caller. */
function signOf(ctx: NesCtx, sign: number): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.mathA, 3));
  asm.eor(mem(layout.mathB, 3));
  asm.and(imm(0x80));
  asm.sta(mem(sign));
  abs32(ctx, layout.mathA);
  abs32(ctx, layout.mathB);
}

/** Branch into `body` when the four bytes at `addr` are exactly 1.0. */
function ifOne(ctx: NesCtx, addr: number, body: () => void): void {
  const { asm } = ctx;
  const no = ctx.unique("notOne");
  for (const [index, expected] of [
    [0, 0],
    [1, 0],
    [3, 0],
    [2, 1],
  ] as const) {
    asm.lda(mem(addr, index));
    asm.cmp(imm(expected));
    ctx.far("ne", no);
  }
  body();
  asm.label(no);
}

/**
 * The multiply helper: `mathA *= mathB`, in 16.16.
 *
 * Shift-and-add over the multiplier's bits, exiting the moment it runs dry, with
 * the ±1.0 identity taken before the loop — a direction is almost always exactly
 * one, and that case is exact so it can skip the arithmetic entirely.
 */
function emitMul32(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const product = layout.mathWork; // 7 bytes
  const multiplicand = layout.mathWork + 7; // 7 bytes
  const sign = layout.mathWork + 14;

  signOf(ctx, sign);

  const store = ctx.unique("mulStore");
  const general = ctx.unique("mulGeneral");
  const loop = ctx.unique("mulLoop");
  const noAdd = ctx.unique("mulNoAdd");
  const finish = ctx.unique("mulFinish");
  const positive = ctx.unique("mulPositive");
  const skipByte = ctx.unique("mulSkipByte");
  const doneSkip = ctx.unique("mulDoneSkip");

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
  asm.rts();

  asm.label(general);
  asm.lda(imm(0));
  for (let index = 0; index < 7; index += 1) {
    asm.sta(mem(product, index));
    asm.sta(mem(multiplicand, index));
  }
  copy32(ctx, multiplicand, a);

  // Trailing zero bytes of the multiplier are free: shift eight of them out at
  // once and the multiplicand eight the other way. Speeds are whole cells per
  // second, so their low sixteen bits are zero and this removes most of the loop
  // before it starts.
  asm.label(skipByte);
  asm.lda(mem(b, 0));
  ctx.far("ne", doneSkip);
  isZero32(ctx, b);
  ctx.far("eq", doneSkip);
  for (let index = 0; index < 3; index += 1) {
    asm.lda(mem(b, index + 1));
    asm.sta(mem(b, index));
  }
  asm.lda(imm(0));
  asm.sta(mem(b, 3));
  for (let index = 6; index >= 1; index -= 1) {
    asm.lda(mem(multiplicand, index - 1));
    asm.sta(mem(multiplicand, index));
  }
  asm.lda(imm(0));
  asm.sta(mem(multiplicand));
  asm.jmp(skipByte);
  asm.label(doneSkip);

  asm.label(loop);
  isZero32(ctx, b);
  ctx.far("eq", finish);
  asm.lda(mem(b, 0));
  asm.and(imm(1));
  ctx.far("eq", noAdd);
  asm.clc();
  for (let index = 0; index < 7; index += 1) {
    asm.lda(mem(product, index));
    asm.adc(mem(multiplicand, index));
    asm.sta(mem(product, index));
  }
  asm.label(noAdd);
  asm.asl(mem(multiplicand, 0));
  for (let index = 1; index < 7; index += 1) asm.rol(mem(multiplicand, index));
  asm.lsr(mem(b, 3));
  for (let index = 2; index >= 0; index -= 1) asm.ror(mem(b, index));
  asm.jmp(loop);

  asm.label(finish);
  const shifted = ctx.unique("mulShift");
  asm.lda(mem(sign));
  ctx.far("eq", shifted);
  asm.sec();
  for (let index = 0; index < 7; index += 1) {
    asm.lda(imm(0));
    asm.sbc(mem(product, index));
    asm.sta(mem(product, index));
  }
  asm.label(shifted);
  // The product is 16.32; the result is its middle four bytes.
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(product, 2 + index));
    asm.sta(mem(a, index));
  }
  clamp32(ctx, a);
  asm.rts();
}

/**
 * The divide helper: `mathA = mathA * 65536 / mathB`.
 *
 * A divisor that is a whole number of cells has no fractional bits, so
 * `a * 65536 / (k * 65536)` collapses to `a / k` — a 32-by-8 division that is an
 * order of magnitude cheaper. Every `speed / fps` in a game takes that path,
 * which is why it is worth the branch.
 */
function emitDiv32(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const work = layout.mathWork; // 6 bytes of dividend, then quotient
  const rem = layout.mathWork + 7; // 4 bytes
  const sign = layout.mathWork + 14;
  const counter = layout.mathWork + 15;

  const zero = ctx.unique("divZero");
  const general = ctx.unique("divGeneral");
  const signAndFloor = ctx.unique("divSign");

  isZero32(ctx, b);
  ctx.far("eq", zero);
  isZero32(ctx, a);
  ctx.far("eq", zero);
  signOf(ctx, sign);

  // Whole-cell divisor? Bytes 0, 1 and 3 zero, byte 2 non-zero.
  asm.lda(mem(b, 0));
  ctx.far("ne", general);
  asm.lda(mem(b, 1));
  ctx.far("ne", general);
  asm.lda(mem(b, 3));
  ctx.far("ne", general);
  asm.lda(mem(b, 2));
  ctx.far("eq", general);
  emitDivideByByte(ctx, a, b + 2, rem);
  asm.jmp(signAndFloor);

  asm.label(general);
  // Dividend = |a| << 16 in the low six bytes; the quotient grows into the bytes
  // the dividend vacates.
  asm.lda(imm(0));
  for (let index = 0; index < 7; index += 1) asm.sta(mem(work, index));
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(a, index));
    asm.sta(mem(work, 2 + index));
  }

  // Leading zeros of the dividend produce leading zeros of the quotient, so they
  // can be shifted out and their iterations skipped — whole bytes first, then
  // the remaining bits of the top one.
  const loop = ctx.unique("divLoop");
  const noFit = ctx.unique("divNoFit");
  const fits = ctx.unique("divFits");
  const skipByte = ctx.unique("divSkipByte");
  const doneByte = ctx.unique("divDoneByte");
  const skipBit = ctx.unique("divSkipBit");
  const doneBit = ctx.unique("divDoneBit");

  asm.lda(imm(48));
  asm.sta(mem(counter));
  asm.label(skipByte);
  asm.lda(mem(work, 5));
  ctx.far("ne", doneByte);
  asm.lda(mem(counter));
  asm.cmp(imm(9));
  ctx.far("cc", doneByte);
  asm.sec();
  asm.sbc(imm(8));
  asm.sta(mem(counter));
  for (let index = 5; index >= 1; index -= 1) {
    asm.lda(mem(work, index - 1));
    asm.sta(mem(work, index));
  }
  asm.lda(imm(0));
  asm.sta(mem(work, 0));
  asm.jmp(skipByte);
  asm.label(doneByte);
  asm.label(skipBit);
  asm.lda(mem(work, 5));
  ctx.far("mi", doneBit);
  asm.lda(mem(counter));
  asm.cmp(imm(2));
  ctx.far("cc", doneBit);
  asm.sec();
  asm.sbc(imm(1));
  asm.sta(mem(counter));
  asm.asl(mem(work, 0));
  for (let index = 1; index < 6; index += 1) asm.rol(mem(work, index));
  asm.jmp(skipBit);
  asm.label(doneBit);

  // The remainder is four bytes of workspace rather than four registers: this CPU
  // has three, and a zero-page byte costs one cycle more than a register would.
  asm.lda(imm(0));
  for (let index = 0; index < 4; index += 1) asm.sta(mem(rem, index));
  asm.label(loop);
  asm.asl(mem(work, 0));
  for (let index = 1; index < 6; index += 1) asm.rol(mem(work, index));
  asm.rol(mem(rem, 0));
  for (let index = 1; index < 4; index += 1) asm.rol(mem(rem, index));
  // Does the divisor fit? Compare from the top down and stop at the first byte
  // that decides it — which is almost always the first.
  for (let index = 3; index >= 0; index -= 1) {
    asm.lda(mem(rem, index));
    asm.cmp(mem(b, index));
    ctx.far("cc", noFit);
    if (index > 0) ctx.far("ne", fits);
  }
  asm.label(fits);
  asm.sec();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(rem, index));
    asm.sbc(mem(b, index));
    asm.sta(mem(rem, index));
  }
  asm.lda(mem(work, 0));
  asm.ora(imm(1));
  asm.sta(mem(work, 0));
  asm.label(noFit);
  asm.dec(mem(counter));
  ctx.far("ne", loop);

  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(work, index));
    asm.sta(mem(a, index));
  }

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
  // makes `sbc #0` subtract one. The SM83 backend sets its carry here for the
  // same effect, because there the flag means the opposite.
  asm.clc();
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(a, index));
    asm.sbc(imm(0));
    asm.sta(mem(a, index));
  }
  asm.label(done);
  clamp32(ctx, a);
  asm.rts();

  asm.label(zero);
  set32(ctx, a, 0);
  asm.rts();
}

/**
 * `value /= [divisor]`, 32 by 8, remainder into `rem`.
 *
 * The dividend and the quotient share the four bytes of `value`, and the
 * remainder is one byte in A: the remainder of a division by `k` is below `k`, so
 * it fits — but it can reach `2k-1` inside the loop, which overflows a byte when
 * the divisor is above 128. The carry out of the shift is that ninth bit, and it
 * always means "subtract".
 */
function emitDivideByByte(ctx: NesCtx, value: number, divisor: number, rem: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("byteDivLoop");
  const next = ctx.unique("byteDivNext");
  const subtract = ctx.unique("byteDivSub");

  asm.ldx(imm(32));
  asm.lda(imm(0));
  asm.label(loop);
  asm.asl(mem(value, 0));
  for (let index = 1; index < 4; index += 1) asm.rol(mem(value, index));
  asm.rol(acc);
  asm.bcs(subtract);
  asm.cmp(mem(divisor));
  asm.bcc(next);
  asm.label(subtract);
  asm.sec();
  asm.sbc(mem(divisor));
  asm.inc(mem(value, 0));
  asm.label(next);
  asm.dex();
  ctx.far("ne", loop);
  asm.sta(mem(rem, 0));
  asm.lda(imm(0));
  for (let index = 1; index < 4; index += 1) asm.sta(mem(rem, index));
}
