/**
 * 16.16 fixed-point code generation for the TLCS-900/H.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other backends' `val.ts`, and all of them have to agree exactly: a
 * one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere.**
 *
 * This is the smallest value layer in the project, and the reason is the whole
 * reason this console is worth a backend: **a 16.16 value is a register here**,
 * as it is on the Mega Drive. `ld`, `add`, `sub`, `neg`, `sra` and `cp` each do
 * in one instruction what the Z80 does in four and the 6502 in eight, and `cp`
 * leaves a *signed* condition the processor can branch on directly rather than
 * one that has to be synthesised.
 *
 * It is smaller than the Mega Drive's for two further reasons, and both are this
 * instruction set's rather than this file's. **The ALU reaches memory on the
 * destination side**, so `add (dst),XWA` is a 32-bit accumulate in one
 * instruction with no pointer and no scratch — where the 68000 needs a load, an
 * add and a store. And **a long conditional branch needs no inversion**, because
 * this processor has both a ±32 KiB relative branch and a conditional absolute
 * jump (`ctx.far`, `ctx.farJump`).
 *
 * Three conventions, and every emitter above depends on them:
 *
 *   - **`XWA` and `XBC` are scratch for every routine here**, and `XIX` is the
 *     pointer a helper takes its argument in. Nothing may be held in them across
 *     a call into this file.
 *   - **A comparison branches rather than leaving a flag**, as on the other
 *     memory-oriented backends: the answer is in the last `cp`'s condition
 *     codes, and the only thing to do with it before something clobbers it is
 *     branch.
 *   - **The sign of a difference is the signed comparison.** Both operands are
 *     clamped inside ±2^26, so their difference cannot overflow and `lt`/`ge` —
 *     which the hardware computes as `S xor V` — are the whole test.
 */

import type { Ref } from "@demake/core";

import type { NgpcCtx } from "./ctx.js";
import { abs as absolute, at as based, type Mem } from "./ops.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Address a byte at an offset from a value's base.
 *
 * The same three-spelling job the other backends' `mem` does. It is used far
 * less here than on an 8-bit console, because a 16.16 value is read whole rather
 * than a byte at a time — the only offsets that survive are the ones that mean
 * something, like the high word of a coordinate being the cell it sits in.
 */
export function mem(address: Ref, offset = 0): Ref {
  if (typeof address === "number") return address + offset;
  if (offset === 0) return address;
  if (typeof address === "string") return { label: address, addend: offset };
  return { label: address.label, addend: address.addend + offset };
}

/** An absolute operand, in whichever of the three widths the address needs. */
export function at(address: Ref, offset = 0): Mem {
  return absolute(mem(address, offset));
}

/** `dst = src`, four bytes. */
export function copy32(ctx: NgpcCtx, dst: Ref, src: Ref): void {
  ctx.asm.ldm("xwa", at(src));
  ctx.asm.stm(at(dst), "xwa");
}

/** `dst = value`. */
export function set32(ctx: NgpcCtx, dst: Ref, value: number): void {
  // Zero is by far the commonest write, and clearing a register with `xor` is
  // two bytes against the five a full-width immediate costs.
  if ((value | 0) === 0) ctx.asm.alu("xor", "xwa", "xwa");
  else ctx.asm.ldn("xwa", value >>> 0);
  ctx.asm.stm(at(dst), "xwa");
}

/**
 * `dst += src`.
 *
 * Two instructions, because the ALU reaches memory on the destination side —
 * there is no load of the destination and no store of the result.
 */
export function add32(ctx: NgpcCtx, dst: Ref, src: Ref): void {
  ctx.asm.ldm("xwa", at(src));
  ctx.asm.aluToMem("add", at(dst), "xwa");
}

/** `dst -= src`. */
export function sub32(ctx: NgpcCtx, dst: Ref, src: Ref): void {
  ctx.asm.ldm("xwa", at(src));
  ctx.asm.aluToMem("sub", at(dst), "xwa");
}

/** `dst += value`. */
export function addConst32(ctx: NgpcCtx, dst: Ref, value: number): void {
  const amount = value | 0;
  if (amount === 0) return;
  ctx.asm.ldn("xwa", amount >>> 0);
  ctx.asm.aluToMem("add", at(dst), "xwa");
}

/** `dst = -dst`. */
export function neg32(ctx: NgpcCtx, dst: Ref): void {
  ctx.asm.ldm("xwa", at(dst));
  ctx.asm.neg("xwa");
  ctx.asm.stm(at(dst), "xwa");
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: NgpcCtx, dst: Ref): void {
  ctx.asm.ldm("xwa", at(dst));
  ctx.asm.shift("sra", 1, "xwa");
  ctx.asm.stm(at(dst), "xwa");
}

/**
 * Branch to `target` when the value at `addr` is zero, or when it is not.
 *
 * A load sets no flags on this processor — the Z80's habit, inherited — so the
 * test is explicit. `or` against itself is two bytes and leaves the value alone.
 */
export function branchZero32(ctx: NgpcCtx, addr: Ref, target: string, whenZero = true): void {
  ctx.asm.ldm("xwa", at(addr));
  ctx.asm.alu("or", "xwa", "xwa");
  ctx.far(whenZero ? "z" : "nz", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * `lt` is `S xor V`, which is the signed less-than for any pair of operands —
 * the overflow flag is exactly what makes it right at the ends of the range. So
 * like the Mega Drive's and unlike the Z80's this needs no argument about the
 * operands being clamped; it is simply the comparison the machine has.
 */
export function branchLess32(
  ctx: NgpcCtx,
  lhs: Ref,
  rhs: Ref,
  target: string,
  whenLess = true,
): void {
  ctx.asm.ldm("xwa", at(lhs));
  ctx.asm.aluMem("cp", "xwa", at(rhs));
  ctx.far(whenLess ? "lt" : "ge", target);
}

/** Branch on equality. */
export function branchEqual32(
  ctx: NgpcCtx,
  lhs: Ref,
  rhs: Ref,
  target: string,
  whenEqual = true,
): void {
  ctx.asm.ldm("xwa", at(lhs));
  ctx.asm.aluMem("cp", "xwa", at(rhs));
  ctx.far(whenEqual ? "z" : "nz", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: NgpcCtx, addr: Ref, value: number, target: string): void {
  ctx.asm.ldm("xwa", at(addr));
  ctx.asm.aluImm("cp", "xwa", value >>> 0);
  ctx.far("nz", target);
}

/** `dst = |dst|`. */
export function abs32(ctx: NgpcCtx, dst: Ref): void {
  const done = ctx.unique("absDone");
  ctx.asm.ldm("xwa", at(dst));
  ctx.asm.alu("or", "xwa", "xwa");
  ctx.far("pl", done);
  ctx.asm.neg("xwa");
  ctx.asm.stm(at(dst), "xwa");
  ctx.asm.label(done);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * address goes in `XIX` and the routine reads and writes through it — five bytes
 * at the call site plus the call, against the twenty-odd an inlined pair of
 * comparisons would take, and there are hundreds of them.
 */
export function clamp32(ctx: NgpcCtx, dst: Ref): void {
  ctx.asm.lda("xix", at(dst));
  ctx.asm.call(ctx.need("Clamp32", emitClamp32));
}

function emitClamp32(ctx: NgpcCtx): void {
  const { asm } = ctx;
  const notHigh = ctx.unique("clampNotHigh");
  const done = ctx.unique("clampDone");
  asm.ldm("xwa", based("xix"));
  asm.aluImm("cp", "xwa", FIXED_MAX);
  ctx.far("le", notHigh);
  asm.ldn("xwa", FIXED_MAX);
  asm.stm(based("xix"), "xwa");
  asm.ret();
  asm.label(notHigh);
  asm.aluImm("cp", "xwa", -FIXED_MAX >>> 0);
  ctx.far("ge", done);
  asm.ldn("xwa", -FIXED_MAX >>> 0);
  asm.stm(based("xix"), "xwa");
  asm.label(done);
  asm.ret();
}

// --- multiply and divide -----------------------------------------------------

/** `dst = floor(dst * src / 65536)`. */
export function mul32(ctx: NgpcCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Mul32", emitMul32);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: NgpcCtx, dst: Ref, src: Ref): void {
  callBinary(ctx, dst, src, "Div32", emitDiv32);
}

/** Copy both operands into the helper's workspace, call it, take the result. */
function callBinary(
  ctx: NgpcCtx,
  dst: Ref,
  src: Ref,
  name: string,
  body: (ctx: NgpcCtx) => void,
): void {
  const { asm, layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  asm.call(ctx.need(name, body));
  copy32(ctx, dst, layout.mathA);
}

/**
 * Take the sign of the product or quotient and make both operands positive.
 *
 * Leaves the exclusive-or of the two signs at `mathWork` — its top bit is the
 * answer — and `mathA`/`mathB` holding magnitudes. Shared because the multiply
 * and the divide open identically, and because getting the sign *before*
 * anything is negated is the part that is easy to write the other way round.
 */
function takeSign(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const aPositive = ctx.unique("signAPos");
  const bPositive = ctx.unique("signBPos");
  asm.ldm("xwa", at(layout.mathA));
  asm.ldm("xbc", at(layout.mathB));
  asm.alu("xor", "xwa", "xbc");
  asm.stm(at(layout.mathWork), "xwa");

  asm.ldm("xwa", at(layout.mathA));
  asm.alu("or", "xwa", "xwa");
  ctx.far("pl", aPositive);
  asm.neg("xwa");
  asm.stm(at(layout.mathA), "xwa");
  asm.label(aPositive);
  asm.ldm("xwa", at(layout.mathB));
  asm.alu("or", "xwa", "xwa");
  ctx.far("pl", bPositive);
  asm.neg("xwa");
  asm.stm(at(layout.mathB), "xwa");
  asm.label(bPositive);
}

/**
 * The multiply: `mathA = floor(mathA × mathB / 65536)`.
 *
 * Three 16×16 products and no loop, which is one fewer than the Mega Drive needs
 * and far fewer instructions, because **the clamp does most of the work**. Both
 * operands are inside ±2^26, so the high halves are below 2^10 — which means the
 * middle product `ah·bl + al·bh` cannot overflow thirty-two bits and there is no
 * carry to propagate anywhere. The 68000 version assembles a full 64-bit product
 * because it does not lean on that; this one takes the product's middle
 * thirty-two bits directly:
 *
 *     (al·bl >> 16) + (ah·bl + al·bh) + (ah·bh << 16)
 *
 * Taking the *middle* thirty-two bits is the convention every backend in this
 * project shares (`md-arith.test.ts` §multiply), so all of them agree on a
 * product that overflows where `fixed.ts` would clamp.
 *
 * The floor is the part that is easy to get wrong. Negating after the shift
 * rounds toward zero, not toward negative infinity — so a negative product with
 * any fraction at all has to come down one step, and the fraction is exactly
 * "the low sixteen bits of `al·bl` were not zero".
 */
function emitMul32(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const work = layout.mathWork;
  const positive = ctx.unique("mulPositive");
  const exact = ctx.unique("mulExact");

  takeSign(ctx);

  // p0 = al × bl, kept whole: its high half joins the result and its low half
  // decides the floor.
  asm.ldm("xde", at(layout.mathA));
  asm.ldm("xhl", at(layout.mathB));
  asm.mul("xde", "hl");
  asm.stm(at(work, 4), "xde");

  // mid = ah × bl + al × bh.
  asm.ldm("xde", at(layout.mathA));
  asm.shift("srl", 16, "xde");
  asm.ldm("xhl", at(layout.mathB));
  asm.mul("xde", "hl");
  asm.stm(at(work, 8), "xde");
  asm.ldm("xde", at(layout.mathA));
  asm.ldm("xhl", at(layout.mathB));
  asm.shift("srl", 16, "xhl");
  asm.mul("xde", "hl");
  asm.aluToMem("add", at(work, 8), "xde");

  // p3 = ah × bh, which enters the result shifted up sixteen.
  asm.ldm("xde", at(layout.mathA));
  asm.shift("srl", 16, "xde");
  asm.ldm("xhl", at(layout.mathB));
  asm.shift("srl", 16, "xhl");
  asm.mul("xde", "hl");
  asm.shift("sll", 16, "xde");

  // Assemble: (p0 >> 16) + mid + (p3 << 16).
  asm.aluMem("add", "xde", at(work, 8));
  asm.ldm("xhl", at(work, 4));
  asm.shift("srl", 16, "xhl");
  asm.alu("add", "xde", "xhl");

  asm.ldm("xwa", at(work));
  asm.alu("or", "xwa", "xwa");
  ctx.far("pl", positive);
  asm.ld("xwa", "xde");
  asm.neg("xwa");
  // Down one more step where the product had a fraction, which is what makes
  // this floor rather than truncation.
  asm.ldm("xbc", at(work, 4));
  asm.aluImm("and", "xbc", 0xffff);
  asm.alu("or", "xbc", "xbc");
  ctx.far("z", exact);
  asm.aluImm("sub", "xwa", 1);
  asm.label(exact);
  asm.stm(at(layout.mathA), "xwa");
  asm.ret();

  asm.label(positive);
  asm.stm(at(layout.mathA), "xde");
  asm.ret();
}

/**
 * The divide: `mathA = floor(mathA × 65536 / mathB)`, and zero by zero is zero.
 *
 * A restoring shift-and-subtract loop over forty-eight iterations — the
 * dividend is the numerator shifted up sixteen, so it is forty-eight bits wide,
 * and the quotient keeps the low thirty-two of however many it produces. This
 * console has a divide instruction and it is the wrong shape: `div` is
 * thirty-two by *sixteen* with a sixteen-bit quotient, and a `speed / fps` here
 * routinely wants more than sixteen bits of answer.
 *
 * The loop itself is four instructions of work because the registers are
 * thirty-two bits wide: `sla` the numerator to push its top bit into the carry,
 * `rl` the remainder to pull it in, compare, and subtract where it fits. The
 * remainder stays below the divisor, so it cannot overflow.
 *
 * The floor adjustment is the divide's version of the multiply's: a negative
 * quotient with any remainder at all comes down one step.
 */
function emitDiv32(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const work = layout.mathWork;
  const zero = ctx.unique("divZero");
  const loop = ctx.unique("divLoop");
  const noSub = ctx.unique("divNoSub");
  const shift = ctx.unique("divShift");
  const positive = ctx.unique("divPositive");
  const exact = ctx.unique("divExact");

  takeSign(ctx);

  asm.ldm("xhl", at(layout.mathB));
  asm.alu("or", "xhl", "xhl");
  ctx.far("z", zero);

  asm.ldm("xiy", at(layout.mathA)); // the numerator, shifted in from the top
  asm.alu("xor", "xde", "xde"); // the remainder
  asm.alu("xor", "xbc", "xbc"); // the quotient
  asm.ldn("iz", 48);

  asm.label(loop);
  asm.shift("sla", 1, "xiy");
  asm.shift("rl", 1, "xde");
  asm.alu("cp", "xde", "xhl");
  ctx.far("ult", noSub);
  asm.alu("sub", "xde", "xhl");
  asm.scf();
  ctx.far("t", shift);
  asm.label(noSub);
  asm.rcf();
  asm.label(shift);
  asm.shift("rl", 1, "xbc");
  asm.djnz("iz", loop);

  asm.ldm("xwa", at(work));
  asm.alu("or", "xwa", "xwa");
  ctx.far("pl", positive);
  asm.ld("xwa", "xbc");
  asm.neg("xwa");
  // A remainder means the true quotient was not whole, so the floor is one
  // further down. `XDE` still holds it.
  asm.alu("or", "xde", "xde");
  ctx.far("z", exact);
  asm.aluImm("sub", "xwa", 1);
  asm.label(exact);
  asm.stm(at(layout.mathA), "xwa");
  asm.ret();

  asm.label(positive);
  asm.stm(at(layout.mathA), "xbc");
  asm.ret();

  asm.label(zero);
  asm.alu("xor", "xwa", "xwa");
  asm.stm(at(layout.mathA), "xwa");
  asm.ret();
}
