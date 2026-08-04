/**
 * 16.16 fixed-point code generation for the V30MZ.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other backends' `val.ts`, and all of them have to agree exactly: a
 * one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere** — which an
 * arithmetic shift already does, so it is the cheap rule as well as the stated
 * one.
 *
 * This is the second machine in the set that makes the value layer *small*, and
 * it does it for a different reason from the Mega Drive's. A 68000 makes a 16.16
 * value a register; a V30MZ does not — it is sixteen bits wide, so an add is
 * still two instructions. What it has instead is **an ALU that reaches memory on
 * both sides** and **a real multiplier and divider**:
 *
 *   - `add [dst], ax` and `adc [dst+2], dx` are a 32-bit add in four
 *     instructions with no pointer and no scratch, because a memory operand is a
 *     mod/reg/rm byte rather than a second instruction.
 *   - `mul` is 16×16→32 in `dx:ax`, so a 16.16 multiply is **four multiplies and
 *     no loop at all** — the only backend here where it is straight-line code.
 *   - `div` is 32÷16→16 with a remainder, so the two divisor shapes a game
 *     actually uses each become three chained divides: a whole number of cells
 *     (every `speed / fps`) and a divisor below one.
 *
 * What is left over is the bit loop, and it is reached only by a *fractional
 * divisor of one cell or more* — which no example game has. It is written the
 * short way it can be here: the divisor is at least `1.0` in that case, so the
 * top sixteen bits of the dividend cannot produce a quotient bit, and the loop
 * starts with them already in the remainder and runs thirty-two times rather
 * than forty-eight.
 *
 * Three conventions:
 *
 *   - **Every operand is in the data segment**, which is the console's RAM.
 *     Tables in the cartridge take a `cs:` override and are `ops.ts`'s `romAt`;
 *     nothing in this file touches one.
 *   - **A conditional branch reaches ±128 bytes**, so anything branching to a
 *     label a caller supplied goes through `ctx.far`. Short jumps are for a
 *     target a few instructions away in the same emitter.
 *   - **`mov ax, 0` rather than `xor ax, ax`** wherever a borrow is being
 *     carried. The second is a byte shorter and clears the carry, which in the
 *     middle of a multi-word negate is the whole answer.
 *
 * Every routine clobbers `ax` and `dx`. The ones that say so also clobber `bx`
 * and `cx`.
 */

import { type Ref } from "@demake/core";

import type { WscCtx } from "./ctx.js";
import { abs, at, romAbs, type Mem } from "./ops.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Address a byte at an offset from a value's base.
 *
 * Carrying an addend through the three spellings of a reference, exactly as the
 * Z80 backend's does: this CPU reaches every address in the same instruction, so
 * there is no short form to choose between.
 */
export function mem(address: Ref, offset = 0): Ref {
  if (typeof address === "number") return address + offset;
  if (offset === 0) return address;
  if (typeof address === "string") return { label: address, addend: offset };
  return { label: address.label, addend: address.addend + offset };
}

/**
 * A 16.16 operand to *read*, in whichever segment it lives in.
 *
 * **A label is in the cartridge and a number is in RAM**, and on this console
 * that is the difference between a `cs:` override and no prefix. It is not a
 * convention anybody has to remember: every address the allocator hands out is a
 * number and every pooled constant is a label, so the type of the reference
 * already says which it is. Reading a constant without the override reads a
 * game's own variables instead — which produces a game that boots, runs, and is
 * wrong from its second tick.
 */
export function source(address: Ref, offset = 0): Mem {
  const target = mem(address, offset);
  return typeof target === "number" ? abs(target) : romAbs(target);
}

/**
 * The same operand to *write*, which can only ever be RAM.
 *
 * A label here would be a store into the cartridge — silently nothing on
 * hardware, and a wrong answer in a core that lets it through. It raises.
 */
export function dest(address: Ref, offset = 0): Mem {
  const target = mem(address, offset);
  if (typeof target !== "number") {
    throw new Error("a 16.16 write needs a RAM address; this is a cartridge label");
  }
  return abs(target);
}

/** The low and high sixteen bits of a 32-bit literal. */
function halves(value: number): [number, number] {
  return [value & 0xffff, (value >>> 16) & 0xffff];
}

/** `dst = src`, four bytes. */
export function copy32(ctx: WscCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  // Through `ax`, which has an opcode of its own for a direct address: three
  // bytes a move rather than four.
  asm.movm("ax", source(src, 0));
  asm.movmr(dest(dst, 0), "ax");
  asm.movm("ax", source(src, 2));
  asm.movmr(dest(dst, 2), "ax");
}

/** `dst = value`. */
export function set32(ctx: WscCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  asm.movmi(dest(dst, 0), low);
  asm.movmi(dest(dst, 2), high);
}

/**
 * `dst += src`.
 *
 * Four instructions, and the two in the middle are the whole reason this
 * architecture is cheap here: the source is loaded once and the destination is
 * never loaded at all, because `add [mem], reg` exists.
 */
export function add32(ctx: WscCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.movm("ax", source(src, 0));
  asm.movm("dx", source(src, 2));
  asm.aluMR("add", dest(dst, 0), "ax");
  asm.aluMR("adc", dest(dst, 2), "dx");
}

/** `dst -= src`. */
export function sub32(ctx: WscCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  asm.movm("ax", source(src, 0));
  asm.movm("dx", source(src, 2));
  asm.aluMR("sub", dest(dst, 0), "ax");
  asm.aluMR("sbb", dest(dst, 2), "dx");
}

/**
 * `dst += value`, with a half the literal cannot change left alone.
 *
 * A literal whose low half is zero cannot carry, so the high half is added on
 * its own and the low half is not touched. For `+1.0` — which is what every
 * whole direction integrates by — that is one instruction.
 */
export function addConst32(ctx: WscCtx, dst: Ref, value: number): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  if (low === 0 && high === 0) return;
  if (low === 0) {
    asm.aluMI("add", dest(dst, 2), high);
    return;
  }
  asm.aluMI("add", dest(dst, 0), low);
  asm.aluMI("adc", dest(dst, 2), high);
}

/** `dst = -dst`. */
export function neg32(ctx: WscCtx, dst: Ref): void {
  const { asm } = ctx;
  asm.movm("ax", dest(dst, 0));
  asm.movm("dx", dest(dst, 2));
  asm.unary("neg", "dx");
  asm.unary("neg", "ax");
  asm.aluI("sbb", "dx", 0);
  asm.movmr(dest(dst, 0), "ax");
  asm.movmr(dest(dst, 2), "dx");
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: WscCtx, dst: Ref): void {
  const { asm } = ctx;
  // The top half first, so the bit that leaves it is in the carry when the
  // bottom half is rotated through it.
  asm.shiftM("sar", dest(dst, 2));
  asm.shiftM("rcr", dest(dst, 0));
}

/** Set Z when the value is zero. Clobbers `ax`. */
export function isZero32(ctx: WscCtx, addr: Ref): void {
  const { asm } = ctx;
  asm.movm("ax", source(addr, 0));
  asm.aluM("or", "ax", source(addr, 2));
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: WscCtx, addr: Ref, target: string, whenZero = true): void {
  isZero32(ctx, addr);
  ctx.far(whenZero ? "z" : "nz", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * The sign of the 32-bit difference *is* the answer, because the clamped range
 * rules out the overflow that would make that reasoning wrong: both operands are
 * inside ±2^26, so their difference is inside ±2^27 and cannot wrap. That is
 * what lets this branch on the sign flag rather than on `SF ^ OF`, which is what
 * a general signed comparison would need.
 */
export function branchLess32(ctx: WscCtx, lhs: Ref, rhs: Ref, target: string, whenLess = true) {
  const { asm } = ctx;
  asm.movm("ax", source(lhs, 0));
  asm.movm("dx", source(lhs, 2));
  asm.aluM("sub", "ax", source(rhs, 0));
  asm.aluM("sbb", "dx", source(rhs, 2));
  ctx.far(whenLess ? "s" : "ns", target);
}

/**
 * Branch on equality.
 *
 * One subtraction and one `or`: the difference is zero exactly when the values
 * match, and `or` over the two halves collapses that into one flag. The moves
 * between the `sub` and the `sbb` leave the flags alone, which is the property
 * the chain rests on.
 */
export function branchEqual32(ctx: WscCtx, lhs: Ref, rhs: Ref, target: string, whenEqual = true) {
  const { asm } = ctx;
  asm.movm("ax", source(lhs, 0));
  asm.movm("dx", source(lhs, 2));
  asm.aluM("sub", "ax", source(rhs, 0));
  asm.aluM("sbb", "dx", source(rhs, 2));
  asm.alu("or", "ax", "dx");
  ctx.far(whenEqual ? "z" : "nz", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: WscCtx, addr: Ref, value: number, target: string): void {
  const { asm } = ctx;
  const [low, high] = halves(value);
  asm.movm("ax", source(addr, 0));
  asm.aluI("cmp", "ax", low);
  ctx.far("nz", target);
  asm.movm("ax", source(addr, 2));
  asm.aluI("cmp", "ax", high);
  ctx.far("nz", target);
}

/** `dst = |dst|`. */
export function abs32(ctx: WscCtx, dst: Ref): void {
  const { asm } = ctx;
  const done = ctx.unique("absDone");
  // The sign of a 16.16 value is the sign of its high half, and comparing that
  // half against zero is how it reaches the flags without loading it.
  asm.aluMI("cmp", dest(dst, 2), 0);
  ctx.far("ns", done);
  neg32(ctx, dst);
  asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * address goes in `bx`, which reaches memory as `[bx]` and `[bx+2]` — so the
 * routine reads and writes four bytes without a pointer store anywhere, and
 * there is one copy of it rather than the two forms the 6502 backend needs.
 */
export function clamp32(ctx: WscCtx, dst: Ref): void {
  const { asm } = ctx;
  dest(dst); // a clamp writes, so this can only be RAM
  asm.movi("bx", dst);
  asm.call(ctx.need("Clamp32", emitClamp32));
}

/**
 * The clamp's decision: above `$04000000` or below `$FC000000` is out of range.
 *
 * Exactly `$04000000` is *in* range, which is why the positive boundary checks
 * the low half before it gives up; the negative one does not, because
 * `$FC000000` is the limit itself and every value whose high half equals it is
 * at or above it.
 */
function emitClamp32(ctx: WscCtx): void {
  const { asm } = ctx;
  const notHigh = ctx.unique("clampNotHigh");
  const setHigh = ctx.unique("clampHigh");
  const setLow = ctx.unique("clampLow");
  const done = ctx.unique("clampDone");
  const limit = (FIXED_MAX >>> 16) & 0xffff;
  const negative = (-FIXED_MAX >>> 16) & 0xffff;

  asm.movm("dx", at("bx", 2));
  asm.aluI("cmp", "dx", limit);
  asm.jcc("l", notHigh);
  asm.jcc("g", setHigh);
  asm.aluMI("cmp", at("bx", 0), 0);
  asm.jcc("z", done);
  asm.label(setHigh);
  asm.movmi(at("bx", 0), 0);
  asm.movmi(at("bx", 2), limit);
  asm.ret();

  asm.label(notHigh);
  asm.aluI("cmp", "dx", negative);
  asm.jcc("l", setLow);
  asm.label(done);
  asm.ret();

  asm.label(setLow);
  asm.movmi(at("bx", 0), 0);
  asm.movmi(at("bx", 2), negative);
  asm.ret();
}

// --- multiply and divide -----------------------------------------------------

/**
 * `dst = floor(dst * src / 65536)`.
 *
 * Both operands go to the helper by address, because it needs them in its own
 * workspace anyway: the sign comes off first and is reapplied to the *whole*
 * product before the shift, since a two's-complement right shift is floor and
 * negating afterwards would round the wrong way for anything with a fractional
 * part. That is not a subtlety anyone can skip — a third of a cell squared is
 * where it shows.
 */
export function mul32(ctx: WscCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Mul32", emitMul32);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: WscCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Div32", emitDiv32);
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(
  ctx: WscCtx,
  dst: Ref,
  src: Ref,
  name: string,
  body: (ctx: WscCtx) => void,
): void {
  const { asm, layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  asm.call(ctx.need(name, body));
  copy32(ctx, dst, layout.mathA);
}

/** `mathA = |mathA|` and `mathB = |mathB|`, remembering the result's sign. */
function signOf(ctx: WscCtx, sign: number): void {
  const { asm, layout } = ctx;
  asm.movm8("al", abs(mem(layout.mathA, 3)));
  asm.aluM8("xor", "al", abs(mem(layout.mathB, 3)));
  asm.aluI8("and", "al", 0x80);
  asm.movmr8(abs(sign), "al");
  abs32(ctx, layout.mathA);
  abs32(ctx, layout.mathB);
}

/** `addr[0 .. words)` = its own negation, a word at a time. */
function negBlock(ctx: WscCtx, addr: number, words: number): void {
  const { asm } = ctx;
  for (let index = 0; index < words; index += 1) {
    // `mov ax, 0` rather than `xor ax, ax`: the second is a byte shorter and
    // clears the borrow this chain is carrying.
    asm.movi("ax", 0);
    asm.aluM(index === 0 ? "sub" : "sbb", "ax", abs(addr + index * 2));
    asm.movmr(abs(addr + index * 2), "ax");
  }
}

/**
 * The multiply helper: `mathA *= mathB`, in 16.16.
 *
 * Four multiplies and no loop, which no other backend here can say. The product
 * of two magnitudes is assembled into three words — bits 0 to 47, which is all
 * the clamped range can reach — the sign is applied to all three, and the result
 * is the top two.
 *
 * Why forty-eight bits and not thirty-two: the answer is the product's bits 16
 * to 47, and taking those *before* the sign is applied would truncate toward
 * zero instead of flooring. The low sixteen bits are never read; they exist so
 * that negating the product is negating the product.
 */
function emitMul32(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const product = layout.mathWork; // three words: bits 0-15, 16-31, 32-47
  const sign = layout.mathWork + 6;
  const positive = ctx.unique("mulPositive");

  signOf(ctx, sign);

  // a0 × b0 — its high half is the first thing that reaches bit 16.
  asm.movm("ax", abs(mem(a, 0)));
  asm.unaryM("mul", abs(mem(b, 0)));
  asm.movmr(abs(product), "ax");
  asm.movmr(abs(product + 2), "dx");
  asm.movmi(abs(product + 4), 0);

  // a0 × b1 and a1 × b0, both of which land whole at bit 16.
  asm.movm("ax", abs(mem(a, 0)));
  asm.unaryM("mul", abs(mem(b, 2)));
  asm.aluMR("add", abs(product + 2), "ax");
  asm.aluMR("adc", abs(product + 4), "dx");
  asm.movm("ax", abs(mem(a, 2)));
  asm.unaryM("mul", abs(mem(b, 0)));
  asm.aluMR("add", abs(product + 2), "ax");
  asm.aluMR("adc", abs(product + 4), "dx");

  // a1 × b1 lands at bit 32; anything above bit 47 is past what the clamp keeps.
  asm.movm("ax", abs(mem(a, 2)));
  asm.unaryM("mul", abs(mem(b, 2)));
  asm.aluMR("add", abs(product + 4), "ax");

  asm.aluMI8("cmp", abs(sign), 0);
  asm.jcc("z", positive);
  negBlock(ctx, product, 3);
  asm.label(positive);
  copy32(ctx, a, product + 2);
  clamp32(ctx, a);
  asm.ret();
}

/**
 * The divide helper: `mathA = mathA * 65536 / mathB`.
 *
 * Three shapes of divisor, and the two a game actually uses are chained `div`
 * instructions rather than a loop:
 *
 *   - **A whole number of cells** — every `speed / fps`, and pong's opponent —
 *     has no fractional bits, so `a × 65536 / (k × 65536)` collapses to `a / k`:
 *     two divides, high half then low, the second taking the first's remainder.
 *   - **A divisor below one** leaves the divisor in sixteen bits, so the 48-bit
 *     dividend goes through three divides the same way.
 *   - **Anything else** is the bit loop, and it is thirty-two iterations rather
 *     than forty-eight: such a divisor is at least `1.0`, so the top sixteen bits
 *     of the dividend cannot produce a quotient bit and start out in the
 *     remainder instead.
 *
 * The remainder decides the floor. A negative quotient with anything left over
 * rounds away from zero, which is one subtraction and the reason the remainder
 * is kept at all.
 */
function emitDiv32(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const a = layout.mathA;
  const b = layout.mathB;
  const work = layout.mathWork; // the dividend's low 32 bits, then the quotient
  const rem = layout.mathWork + 4; // four bytes, immediately above it
  const sign = layout.mathWork + 8;

  const zero = ctx.unique("divZero");
  const fraction = ctx.unique("divFraction");
  const general = ctx.unique("divGeneral");
  const signAndFloor = ctx.unique("divSign");
  const loop = ctx.unique("divLoop");
  const noFit = ctx.unique("divNoFit");
  const done = ctx.unique("divDone");

  isZero32(ctx, b);
  ctx.far("z", zero);
  isZero32(ctx, a);
  ctx.far("z", zero);
  signOf(ctx, sign);

  // The divisor's shape decides the path, and both fast ones are the same three
  // instructions with a different word divided by.
  asm.movm("ax", abs(mem(b, 0)));
  asm.test("ax", "ax");
  ctx.far("nz", fraction);

  // A whole number of cells: `|a| / b1`, high half first so the second divide
  // takes the first's remainder as its own high word.
  asm.movi("dx", 0);
  asm.movm("ax", abs(mem(a, 2)));
  asm.unaryM("div", abs(mem(b, 2)));
  asm.movmr(abs(work + 2), "ax");
  asm.movm("ax", abs(mem(a, 0)));
  asm.unaryM("div", abs(mem(b, 2)));
  asm.movmr(abs(work), "ax");
  asm.movmr(abs(rem), "dx");
  asm.movmi(abs(rem + 2), 0);
  asm.jmp(signAndFloor);

  asm.label(fraction);
  asm.movm("dx", abs(mem(b, 2)));
  asm.test("dx", "dx");
  ctx.far("nz", general);

  // A divisor below one: the same chain over a 48-bit dividend, whose lowest
  // word is the zero `× 65536` put there. The top divide's quotient is bits 32
  // and above of the answer and is discarded, exactly as the other backends'
  // 32-iteration loop discards them.
  asm.movi("dx", 0);
  asm.movm("ax", abs(mem(a, 2)));
  asm.unaryM("div", abs(mem(b, 0)));
  asm.movm("ax", abs(mem(a, 0)));
  asm.unaryM("div", abs(mem(b, 0)));
  asm.movmr(abs(work + 2), "ax");
  asm.movi("ax", 0);
  asm.unaryM("div", abs(mem(b, 0)));
  asm.movmr(abs(work), "ax");
  asm.movmr(abs(rem), "dx");
  asm.movmi(abs(rem + 2), 0);
  asm.jmp(signAndFloor);

  asm.label(general);
  // The dividend is `|a| << 16`: its low 32 bits are `a0 : 0000`, and its top
  // word is `a1` — which is already the remainder, because a divisor of at least
  // 1.0 cannot be subtracted from anything sixteen bits wide.
  asm.movmi(abs(work), 0);
  asm.movm("ax", abs(mem(a, 0)));
  asm.movmr(abs(work + 2), "ax");
  asm.movm("ax", abs(mem(a, 2)));
  asm.movmr(abs(rem), "ax");
  asm.movmi(abs(rem + 2), 0);
  asm.movi("cx", 32);

  asm.label(loop);
  // One shift over the dividend *and* the remainder, which are contiguous: the
  // bit that leaves the dividend enters the remainder, and the quotient bit
  // decided below goes into the space the dividend vacated.
  asm.shiftM("shl", abs(work));
  asm.shiftM("rcl", abs(work + 2));
  asm.shiftM("rcl", abs(rem));
  asm.shiftM("rcl", abs(rem + 2));
  asm.movm("ax", abs(rem));
  asm.movm("dx", abs(rem + 2));
  asm.aluM("sub", "ax", abs(mem(b, 0)));
  asm.aluM("sbb", "dx", abs(mem(b, 2)));
  // The borrow, not the sign: this is an unsigned comparison of two magnitudes.
  asm.jcc("c", noFit);
  asm.movmr(abs(rem), "ax");
  asm.movmr(abs(rem + 2), "dx");
  asm.aluMI("or", abs(work), 1);
  asm.label(noFit);
  asm.loop(loop);

  asm.label(signAndFloor);
  copy32(ctx, a, work);
  asm.aluMI8("cmp", abs(sign), 0);
  asm.jcc("z", done);
  neg32(ctx, a);
  // floor, not truncate: a negative quotient with a remainder rounds away.
  isZero32(ctx, rem);
  asm.jcc("z", done);
  addConst32(ctx, a, -1);
  asm.label(done);
  clamp32(ctx, a);
  asm.ret();

  asm.label(zero);
  set32(ctx, a, 0);
  asm.ret();
}
