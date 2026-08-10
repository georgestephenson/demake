/**
 * 16.16 fixed-point code generation for the V810.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other backends' `val.ts`, and all of them have to agree exactly: a
 * one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere.**
 *
 * This is the smallest value layer in the project, and by some distance. Three
 * reasons, in the order they matter:
 *
 *   - **The multiply is six instructions and pulls in nothing.** `mul` produces
 *     the whole 64-bit product — low half in the destination, high half in
 *     `r30` — and a 16.16 multiply wants its *middle* thirty-two bits, which is
 *     one shift each way and an `or`. There is no sign handling and no floor
 *     correction, because an arithmetic shift of a two's-complement product
 *     *is* floor: the thing every other backend spends a helper and a
 *     conditional on comes out of the hardware already right. This console is
 *     the only one in the set with no multiply routine at all.
 *   - **A value is a register**, as on the Mega Drive and the Neo Geo Pocket, so
 *     `add`, `sub`, `cmp` and `sar` are one instruction each — and `cmp` leaves
 *     a signed condition to branch on rather than one that has to be
 *     synthesised.
 *   - **Every address is one instruction away.** Work RAM is 64 KiB and a load
 *     reaches ±32 KiB from a base, so {@link RAM} parked at its middle covers
 *     all of it (`regs.ts`). A property read is `ld.w disp[r4]` and nothing else.
 *
 * What it *costs* is the divide, and that is the one place this machine is worse
 * than its neighbours rather than better: `div` is thirty-two by thirty-two with
 * a thirty-two-bit quotient, and a 16.16 divide's numerator is forty-eight bits
 * wide. So there is a shift-and-subtract loop here, with the Mega Drive's
 * escape — a divisor that is a whole number of cells is a *single* `divu`,
 * because `(a << 16) / (b << 16)` is `a / b`. Pong's opponent takes that path
 * and so does every gravity constant written as `n / fps`.
 *
 * Three conventions, and every emitter above depends on them:
 *
 *   - **{@link T0}–{@link T4} are scratch for every routine here.** Nothing may
 *     be held in them across a call into this file, and nothing may ever be held
 *     in `r30`, which `mul` and `div` write whether or not anybody asked.
 *   - **A comparison branches rather than leaving a flag**, as on every other
 *     memory-oriented backend.
 *   - **The sign of a difference is the signed comparison.** Both operands are
 *     clamped inside ±2^26, so their difference cannot overflow and `lt`/`ge`
 *     are the whole test.
 */

import type { Ref } from "@demake/core";

import type { VbCtx } from "./ctx.js";
import { ARG, HI, LP, RAM, T0, T1, T2, T3, T4, ZERO, inRam, ramDisp } from "./regs.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Address a byte at an offset from a value's base.
 *
 * The same three-spelling job the other backends' `mem` does — a resolved
 * number, a label, or a label plus an addend — and it is used far less here than
 * on an 8-bit console, because a 16.16 value is read whole rather than a byte at
 * a time.
 */
export function mem(address: Ref, offset = 0): Ref {
  if (typeof address === "number") return address + offset;
  if (offset === 0) return address;
  if (typeof address === "string") return { label: address, addend: offset };
  return { label: address.label, addend: address.addend + offset };
}

/**
 * Put a 16.16 value in a register.
 *
 * The one place this backend decides *where* a value lives, and it decides it
 * from the reference's own type — the WonderSwan's `source()` one console along,
 * reached by different hardware. A number is work RAM and reaches through
 * {@link RAM} in one instruction; a **label** is a pooled constant in the
 * cartridge, which no base register covers, so its address is built first. An
 * emitter that treated the two alike would read a game's variables where it
 * meant to read a constant, which is a program that traces perfectly for one
 * tick.
 */
export function load32(ctx: VbCtx, src: Ref, reg: number, via = T4): void {
  if (typeof src === "number" && inRam(src)) {
    ctx.asm.ldw(ramDisp(src), RAM, reg);
    return;
  }
  ctx.asm.movImm32(src, via);
  ctx.asm.ldw(0, via, reg);
}

/** And back. A pooled constant is never a destination, so a label here raises. */
export function store32(ctx: VbCtx, reg: number, dst: Ref, via = T4): void {
  if (typeof dst === "number" && inRam(dst)) {
    ctx.asm.stw(reg, ramDisp(dst), RAM);
    return;
  }
  if (typeof dst !== "number") {
    throw new Error(`cannot write to '${typeof dst === "string" ? dst : dst.label}': it is in ROM`);
  }
  ctx.asm.movImm32(dst, via);
  ctx.asm.stw(reg, 0, via);
}

/** `dst = -dst`, in two instructions — this processor has no negate. */
export function negate(ctx: VbCtx, reg: number): void {
  ctx.asm.not(reg, reg);
  ctx.asm.addImm5(1, reg);
}

/** Copy four bytes. */
export function copy32(ctx: VbCtx, dst: Ref, src: Ref): void {
  load32(ctx, src, T0);
  store32(ctx, T0, dst);
}

/** Store a constant. */
export function set32(ctx: VbCtx, dst: Ref, value: number): void {
  ctx.asm.movImm32(value | 0, T0);
  store32(ctx, T0, dst);
}

/** `dst += src`. */
export function add32(ctx: VbCtx, dst: Ref, src: Ref): void {
  load32(ctx, dst, T0);
  load32(ctx, src, T1);
  ctx.asm.add(T1, T0);
  store32(ctx, T0, dst);
}

/** `dst -= src`. */
export function sub32(ctx: VbCtx, dst: Ref, src: Ref): void {
  load32(ctx, dst, T0);
  load32(ctx, src, T1);
  ctx.asm.sub(T1, T0);
  store32(ctx, T0, dst);
}

/** `dst += value`. */
export function addConst32(ctx: VbCtx, dst: Ref, value: number): void {
  if ((value | 0) === 0) return;
  load32(ctx, dst, T0);
  ctx.asm.addImm32(value | 0, T0);
  store32(ctx, T0, dst);
}

/** `dst = -dst`. */
export function neg32(ctx: VbCtx, dst: Ref): void {
  load32(ctx, dst, T0);
  negate(ctx, T0);
  store32(ctx, T0, dst);
}

/** `dst >>= 1`, arithmetically — which is floor, and is what `centerx` wants. */
export function asr32(ctx: VbCtx, dst: Ref): void {
  load32(ctx, dst, T0);
  ctx.asm.sarImm5(1, T0);
  store32(ctx, T0, dst);
}

/** Branch to `target` when the four bytes are (or are not) zero. */
export function branchZero32(ctx: VbCtx, addr: Ref, target: string, whenZero = true): void {
  load32(ctx, addr, T0);
  ctx.asm.cmpImm5(0, T0);
  ctx.far(whenZero ? "e" : "ne", target);
}

/** Branch to `target` when `lhs < rhs` (or when it is not). */
export function branchLess32(
  ctx: VbCtx,
  lhs: Ref,
  rhs: Ref,
  target: string,
  whenLess = true,
): void {
  load32(ctx, lhs, T0);
  load32(ctx, rhs, T1);
  ctx.asm.cmp(T1, T0);
  ctx.far(whenLess ? "lt" : "ge", target);
}

/** Branch to `target` when the two are (or are not) equal. */
export function branchEqual32(
  ctx: VbCtx,
  lhs: Ref,
  rhs: Ref,
  target: string,
  whenEqual = true,
): void {
  load32(ctx, lhs, T0);
  load32(ctx, rhs, T1);
  ctx.asm.cmp(T1, T0);
  ctx.far(whenEqual ? "e" : "ne", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(ctx: VbCtx, addr: Ref, value: number, target: string): void {
  load32(ctx, addr, T0);
  ctx.asm.movImm32(value | 0, T1);
  ctx.asm.cmp(T1, T0);
  ctx.far("ne", target);
}

/** `dst = |dst|`. */
export function abs32(ctx: VbCtx, dst: Ref): void {
  const done = ctx.unique("absDone");
  load32(ctx, dst, T0);
  ctx.asm.cmpImm5(0, T0);
  ctx.asm.bcond("ge", done);
  negate(ctx, T0);
  ctx.asm.label(done);
  store32(ctx, T0, dst);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does. The
 * address goes in {@link ARG} and the routine reads and writes through it —
 * three instructions at the call site plus the call, against the dozen an
 * inlined pair of comparisons would take, and there are hundreds of them.
 */
export function clamp32(ctx: VbCtx, dst: Ref): void {
  address(ctx, dst, ARG);
  ctx.asm.jal(ctx.need("Clamp32", emitClamp32));
}

/** Put a reference's *address* in a register, whichever kind it is. */
export function address(ctx: VbCtx, ref: Ref, reg: number): void {
  if (typeof ref === "number" && inRam(ref)) {
    ctx.asm.movea(ramDisp(ref), RAM, reg);
    return;
  }
  ctx.asm.movImm32(ref, reg);
}

function emitClamp32(ctx: VbCtx): void {
  const { asm } = ctx;
  const notHigh = ctx.unique("clampNotHigh");
  const store = ctx.unique("clampStore");
  asm.ldw(0, ARG, T0);
  asm.movImm32(FIXED_MAX, T1);
  asm.cmp(T1, T0);
  asm.bcond("le", notHigh);
  asm.mov(T1, T0);
  asm.br(store);
  asm.label(notHigh);
  asm.movImm32(-FIXED_MAX, T1);
  asm.cmp(T1, T0);
  asm.bcond("ge", store);
  asm.mov(T1, T0);
  asm.label(store);
  asm.stw(T0, 0, ARG);
  asm.jmp(LP);
}

// --- multiply and divide -----------------------------------------------------

/**
 * `dst = floor(dst * src / 65536)` — six instructions and no routine.
 *
 * `mul` leaves the whole 64-bit product across two registers, and a 16.16
 * product is its middle thirty-two bits: the low half's top sixteen and the high
 * half's bottom sixteen. That is one logical shift, one arithmetic-free shift up
 * and an `or`.
 *
 * **There is no floor correction and no sign handling**, and it is worth saying
 * why, because every other backend in this project has both. Shifting a
 * two's-complement 64-bit product right by sixteen *is* floor — the bits that
 * fall off the bottom are the fraction, and a negative number loses them
 * downward. The multiply the other five consoles write assembles the product
 * from unsigned halves and therefore has to put the sign back and step down when
 * anything was discarded; here the hardware never took the sign apart.
 *
 * Taking the *middle* thirty-two bits is the convention every backend shares
 * (`md-arith.test.ts` §multiply), so all of them agree on a product that
 * overflows where `fixed.ts` would clamp.
 */
export function mul32(ctx: VbCtx, dst: Ref, src: Ref): void {
  const { asm } = ctx;
  load32(ctx, dst, T0);
  load32(ctx, src, T1);
  asm.mul(T1, T0); // T0 = low half, r30 = high half
  asm.shrImm5(16, T0);
  asm.shlImm5(16, HI);
  asm.or(HI, T0);
  store32(ctx, T0, dst);
}

/** `dst = floor(dst * 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: VbCtx, dst: Ref, src: Ref): void {
  const { layout } = ctx;
  copy32(ctx, layout.mathA, dst);
  copy32(ctx, layout.mathB, src);
  ctx.asm.jal(ctx.need("Div32", emitDiv32));
  copy32(ctx, dst, layout.mathA);
}

/**
 * The divide: `mathA = floor(mathA × 65536 / mathB)`, and zero by zero is zero.
 *
 * Two paths, and which one a game takes is a property of what it divides *by*.
 *
 * **A divisor that is a whole number of cells is one instruction.** If the low
 * sixteen bits of `b` are clear then `b = B × 65536`, so `(a × 65536) / b` is
 * exactly `a / B` — a single `divu` on values that already fit. That is the Mega
 * Drive's escape reached by different arithmetic, and it is the path pong's
 * opponent takes and the one every `n / fps` constant folds onto.
 *
 * **Anything else is a forty-eight-iteration shift-and-subtract**, because this
 * processor's `div` is thirty-two by thirty-two and the numerator here is
 * forty-eight bits wide. The remainder stays below the divisor so it cannot
 * overflow, and the numerator's own bits run out after thirty-two iterations —
 * the remaining sixteen shift in zeroes, which is what makes the answer a 16.16
 * quotient rather than an integer one.
 *
 * The floor adjustment is the multiply's, arrived at the hard way: the loop
 * works on magnitudes, so a negative quotient with any remainder at all has to
 * come down one step.
 */
function emitDiv32(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const zero = ctx.unique("divZero");
  const loop = ctx.unique("divLoop");
  const noSub = ctx.unique("divNoSub");
  const positive = ctx.unique("divPositive");
  const exact = ctx.unique("divExact");
  const general = ctx.unique("divGeneral");
  const finish = ctx.unique("divFinish");
  const aPositive = ctx.unique("divAPos");
  const bPositive = ctx.unique("divBPos");

  // T0 = numerator, T1 = divisor, T2 = sign, T3 = quotient, T4 = remainder.
  asm.ldw(ramDisp(layout.mathA), RAM, T0);
  asm.ldw(ramDisp(layout.mathB), RAM, T1);
  asm.mov(T0, T2);
  asm.xor(T1, T2); // the sign of the answer, in bit 31

  asm.cmpImm5(0, T0);
  asm.bcond("ge", aPositive);
  asm.not(T0, T0);
  asm.addImm5(1, T0);
  asm.label(aPositive);
  asm.cmpImm5(0, T1);
  asm.bcond("ge", bPositive);
  asm.not(T1, T1);
  asm.addImm5(1, T1);
  asm.label(bPositive);

  asm.cmpImm5(0, T1);
  ctx.far("e", zero);

  // The fast path: a divisor that is a whole number of cells.
  asm.movImm32(0xffff, T3);
  asm.and(T1, T3);
  asm.bcond("ne", general);
  asm.mov(T1, T3);
  asm.shrImm5(16, T3);
  asm.mov(T0, T4);
  asm.divu(T3, T4); // T4 = quotient, r30 = remainder
  asm.mov(T4, T3);
  asm.mov(HI, T4);
  ctx.jump(finish);

  asm.label(general);
  asm.mov(ZERO, T3); // quotient
  asm.mov(ZERO, T4); // remainder
  asm.movImm32(48, ARG); // the counter, which nothing else is using here
  asm.label(loop);
  asm.mov(T0, HI);
  asm.shrImm5(31, HI); // the numerator's top bit
  asm.shlImm5(1, T4);
  asm.or(HI, T4);
  asm.shlImm5(1, T0);
  asm.shlImm5(1, T3);
  asm.cmp(T1, T4); // T4 - T1, unsigned
  asm.bcond("c", noSub); // remainder below divisor: nothing to take
  asm.sub(T1, T4);
  asm.ori(1, T3, T3);
  asm.label(noSub);
  asm.addImm5(-1, ARG);
  asm.bcond("nz", loop);

  asm.label(finish);
  asm.cmpImm5(0, T2);
  asm.bcond("ge", positive);
  asm.not(T3, T3);
  asm.addImm5(1, T3);
  // A remainder means the true quotient was not whole, so the floor is one
  // further down.
  asm.cmpImm5(0, T4);
  asm.bcond("e", exact);
  asm.addImm5(-1, T3);
  asm.label(exact);
  asm.label(positive);
  asm.stw(T3, ramDisp(layout.mathA), RAM);
  asm.jmp(LP);

  asm.label(zero);
  asm.stw(ZERO, ramDisp(layout.mathA), RAM);
  asm.jmp(LP);
}
