/**
 * 16.16 fixed-point code generation for ARM.
 *
 * Every routine here mirrors one in `packages/demotic/src/fixed.ts` and one in
 * each of the other four backends' `val.ts`, and all six have to agree exactly:
 * a one-bit disagreement in a velocity compounds into a visibly different game a
 * thousand ticks later, which is what the trace oracle exists to catch.
 * **Rounding is floor, toward negative infinity, everywhere.**
 *
 * This is the smallest value layer in the project, and three properties of the
 * machine are why:
 *
 *   - **A 16.16 value is a register, and so is its product.** `smull` produces
 *     the 64-bit product a fixed-point multiply is the middle of, and the barrel
 *     shifter takes the middle out of it in two more instructions — so the
 *     multiply is *inline* here where the Mega Drive needs a sixty-instruction
 *     helper and the Game Boy a bit loop. It needs no sign handling at all,
 *     because an arithmetic shift of a two's-complement value already floors.
 *   - **Every instruction is conditional**, so `abs` is a compare and one
 *     predicated `rsb`, and the clamp is a compare and a predicated `mov` per
 *     end — no branches, no labels, no helper.
 *   - **±1024 cells is an ARM immediate.** `1024 × 65536` is `$04000000`, which
 *     the rotated-immediate field expresses exactly, and so is its negation. The
 *     clamp every property write goes through therefore costs no pooled constant
 *     and no load.
 *
 * What the machine does *not* have is a divide — it is the first console in the
 * set with none at all — so that is the one routine this backend pulls in.
 *
 * Three conventions, and every emitter above depends on them:
 *
 *   - **`r0`–`r3` and `r12` are scratch for every routine here.** Nothing may be
 *     held in them across a call into this file. `r11` is the work-RAM base and
 *     is never touched (`regs.ts`).
 *   - **A comparison branches rather than leaving a flag**, as on every other
 *     backend: the answer is in the last `cmp`'s codes and the only thing to do
 *     with it before something clobbers it is branch.
 *   - **An operand is either an address or an immediate**, and that is a real
 *     difference from the other five. They read a constant out of a pooled ROM
 *     word because their instructions cannot carry one; here `movImm32` puts any
 *     32-bit value in a register in one instruction, so a constant operand never
 *     touches memory and `CtxBase.constant` is never called.
 */

import { armAsr, armAt, armImm, armLsl, armLsr, armReg, fitsArmImm } from "@demake/core";

import type { GbaCtx } from "./ctx.js";
import { A0, A1, A2, A3, ADDR, RAM, RAM_BASE, RAM_WINDOW } from "./regs.js";

/** 1.0 in 16.16. */
export const ONE = 0x10000;

/** The clamp `fixed.ts` applies to every write: ±1024 cells. */
export const FIXED_MAX = 1024 * ONE;

/**
 * Where a 32-bit operand is.
 *
 * The other five backends have no counterpart, because on those machines a
 * constant has to be *somewhere* — a pooled ROM word the instruction addresses.
 * Here it can be in the instruction stream, which is both shorter and one fewer
 * memory access, so the operand type has two cases and the value layer chooses
 * per call.
 */
export type Val =
  /** A four-byte value in work RAM. */
  | { readonly k: "at"; readonly addr: number }
  /** A constant, materialised by whichever of `mov`, `mvn` or a pool it needs. */
  | { readonly k: "imm"; readonly v: number };

/** A value in work RAM. */
export function at(addr: number): Val {
  return { k: "at", addr };
}

/** A constant operand. */
export function imm(v: number): Val {
  return { k: "imm", v: v | 0 };
}

/**
 * The addressing mode that reaches a work-RAM address.
 *
 * One instruction inside the base register's ±4095 window, two outside it — and
 * the second instruction goes in the stream *here*, immediately before the access
 * that uses it, so {@link ADDR} is never live across anything. Every emitter in
 * this backend goes through this rather than computing an address itself, which
 * is what makes "the whole of internal RAM is addressable" true without every
 * call site carrying the case.
 *
 * The converse is the rule an emitter above has to keep: **{@link ADDR} may not
 * hold anything across a call into this file.** An emitter that sets a hardware
 * base up there and then loads a value through one of these has silently changed
 * where its store lands — and the symptom is not a crash but a register that is
 * never written, which is a picture that never scrolls.
 */
export function mem(ctx: GbaCtx, addr: number, offset = 0): ReturnType<typeof armAt> {
  const target = addr + offset;
  const delta = target - RAM_BASE;
  if (delta >= 0 && delta < RAM_WINDOW) return armAt(RAM, delta);
  ctx.asm.movImm32(ADDR, target);
  return armAt(ADDR, 0);
}

/**
 * The addressing mode a *sixteen-bit* access reaches, which is not the same one.
 *
 * `ldrh`, `strh`, `ldrsh` and `ldrsb` predate the ARM7 and were fitted into a
 * hole in the data-processing space, so their offset field is **eight bits**
 * where a word or byte transfer's is twelve. A base register therefore reaches
 * 255 bytes on these and 4095 on the others, and an emitter that used
 * {@link mem} for one of them assembles fine right up until a game grows past
 * the first two hundred and fifty-six bytes of its own state.
 *
 * So the four narrow forms are *only* reachable through the functions below,
 * which pick the addressing rather than take it. What they do past the window is
 * add the high byte of the displacement into {@link ADDR} — one instruction and
 * no pooled constant, because a value with only bits 8–11 set is always an ARM
 * immediate — and fall back to a full materialisation past 4 KiB.
 */
function memHalf(ctx: GbaCtx, addr: number): ReturnType<typeof armAt> {
  const delta = addr - RAM_BASE;
  if (delta >= 0 && delta < 0x100) return armAt(RAM, delta);
  if (delta >= 0 && delta < RAM_WINDOW) {
    ctx.asm.add(ADDR, RAM, armImm(delta & 0xf00));
    return armAt(ADDR, delta & 0xff);
  }
  ctx.asm.movImm32(ADDR, addr);
  return armAt(ADDR, 0);
}

/** `reg = the halfword at addr`, zero-extended. */
export function loadHalf(ctx: GbaCtx, reg: number, addr: number): void {
  ctx.asm.ldrh(reg, memHalf(ctx, addr));
}

/** `reg = the halfword at addr`, sign-extended. */
export function loadHalfSigned(ctx: GbaCtx, reg: number, addr: number): void {
  ctx.asm.ldrsh(reg, memHalf(ctx, addr));
}

/** `reg = the byte at addr`, sign-extended. */
export function loadByteSigned(ctx: GbaCtx, reg: number, addr: number): void {
  ctx.asm.ldrsb(reg, memHalf(ctx, addr));
}

/** Write a register's low halfword to `addr`. */
export function storeHalf(ctx: GbaCtx, reg: number, addr: number): void {
  ctx.asm.strh(reg, memHalf(ctx, addr));
}

/** Put a value in a register. */
export function load(ctx: GbaCtx, reg: number, src: Val): void {
  if (src.k === "imm") {
    ctx.asm.movImm32(reg, src.v >>> 0);
    return;
  }
  ctx.asm.ldr(reg, mem(ctx, src.addr));
}

/** Write a register to a work-RAM address. */
export function store(ctx: GbaCtx, reg: number, dst: number): void {
  ctx.asm.str(reg, mem(ctx, dst));
}

/**
 * The second operand of an arithmetic instruction, without a spare register
 * where the immediate field can carry it.
 *
 * A constant that the rotation can express becomes `#k` and costs nothing; one it
 * cannot, and any value in memory, goes through `scratch`. That is the whole of
 * why `addConst32` is one instruction for the constants a game actually contains
 * — a whole number of cells is `n << 16`, and every such value up to 255 cells is
 * an ARM immediate.
 */
function operand(ctx: GbaCtx, src: Val, scratch: number): ReturnType<typeof armImm> {
  if (src.k === "imm" && fitsArmImm(src.v >>> 0)) return armImm(src.v >>> 0);
  load(ctx, scratch, src);
  return armReg(scratch);
}

/** `dst = src`. */
export function copy32(ctx: GbaCtx, dst: number, src: Val): void {
  load(ctx, A0, src);
  store(ctx, A0, dst);
}

/** `dst = value`. */
export function set32(ctx: GbaCtx, dst: number, value: number): void {
  ctx.asm.movImm32(A0, value >>> 0);
  store(ctx, A0, dst);
}

/** `dst += src`. */
export function add32(ctx: GbaCtx, dst: number, src: Val): void {
  load(ctx, A0, at(dst));
  ctx.asm.add(A0, A0, operand(ctx, src, A1));
  store(ctx, A0, dst);
}

/** `dst -= src`. */
export function sub32(ctx: GbaCtx, dst: number, src: Val): void {
  load(ctx, A0, at(dst));
  ctx.asm.sub(A0, A0, operand(ctx, src, A1));
  store(ctx, A0, dst);
}

/** `dst += value`, taking the immediate field where the value fits it. */
export function addConst32(ctx: GbaCtx, dst: number, value: number): void {
  const amount = value | 0;
  if (amount === 0) return;
  load(ctx, A0, at(dst));
  if (fitsArmImm(amount >>> 0)) ctx.asm.add(A0, A0, armImm(amount >>> 0));
  else if (fitsArmImm(-amount >>> 0)) ctx.asm.sub(A0, A0, armImm(-amount >>> 0));
  else {
    ctx.asm.movImm32(A1, amount >>> 0);
    ctx.asm.add(A0, A0, armReg(A1));
  }
  store(ctx, A0, dst);
}

/** `dst = -dst`. */
export function neg32(ctx: GbaCtx, dst: number): void {
  load(ctx, A0, at(dst));
  ctx.asm.rsb(A0, A0, armImm(0));
  store(ctx, A0, dst);
}

/** `dst >>= 1`, arithmetic — which is floor division by two. */
export function asr32(ctx: GbaCtx, dst: number): void {
  load(ctx, A0, at(dst));
  ctx.asm.mov(A0, armAsr(A0, 1));
  store(ctx, A0, dst);
}

/**
 * `dst = |dst|`, with no branch.
 *
 * A compare and one predicated `rsb`. Every other backend needs a label and a
 * jump over the negate; this is the clearest small illustration of what
 * conditional execution buys, and there are dozens of these in a game.
 */
export function abs32(ctx: GbaCtx, dst: number): void {
  load(ctx, A0, at(dst));
  ctx.asm.cmp(A0, armImm(0));
  ctx.asm.rsb(A0, A0, armImm(0), "lt");
  store(ctx, A0, dst);
}

/**
 * Hold a value inside ±1024 cells, the range `clampFixed` enforces.
 *
 * Every property write goes through this, because the interpreter's does — and
 * here it is four instructions and no call, because both ends of the range are
 * ARM immediates and both assignments are predicated. The Mega Drive needs a
 * routine reached through a pointer; this needs nothing.
 */
export function clamp32(ctx: GbaCtx, dst: number): void {
  load(ctx, A0, at(dst));
  clampReg(ctx, A0);
  store(ctx, A0, dst);
}

/** The same, on a value already in a register. */
export function clampReg(ctx: GbaCtx, reg: number): void {
  ctx.asm.cmp(reg, armImm(FIXED_MAX));
  ctx.asm.mov(reg, armImm(FIXED_MAX), "gt");
  ctx.asm.cmp(reg, armImm(-FIXED_MAX >>> 0));
  ctx.asm.mov(reg, armImm(-FIXED_MAX >>> 0), "lt");
}

/** Branch to `target` when the value at `addr` is zero, or when it is not. */
export function branchZero32(ctx: GbaCtx, addr: number, target: string, whenZero = true): void {
  load(ctx, A0, at(addr));
  ctx.asm.cmp(A0, armImm(0));
  ctx.far(whenZero ? "eq" : "ne", target);
}

/**
 * Branch on `lhs < rhs`, signed.
 *
 * `lt` is `N ≠ V`, which is the signed less-than for any pair of operands —
 * the overflow flag is exactly what makes it right at the ends of the range. So
 * this needs no argument about the operands being clamped, unlike the Z80
 * version; it is simply the comparison the machine has.
 */
export function branchLess32(
  ctx: GbaCtx,
  lhs: Val,
  rhs: Val,
  target: string,
  whenLess = true,
): void {
  load(ctx, A0, lhs);
  ctx.asm.cmp(A0, operand(ctx, rhs, A1));
  ctx.far(whenLess ? "lt" : "ge", target);
}

/** Branch on equality. */
export function branchEqual32(
  ctx: GbaCtx,
  lhs: Val,
  rhs: Val,
  target: string,
  whenEqual = true,
): void {
  load(ctx, A0, lhs);
  ctx.asm.cmp(A0, operand(ctx, rhs, A1));
  ctx.far(whenEqual ? "eq" : "ne", target);
}

/** Branch to `target` unless the four bytes hold exactly this constant. */
export function branchUnlessConst32(
  ctx: GbaCtx,
  addr: number,
  value: number,
  target: string,
): void {
  branchEqual32(ctx, at(addr), imm(value), target, false);
}

// --- multiply and divide -----------------------------------------------------

/**
 * `dst = floor(dst × src / 65536)`, inline.
 *
 * The whole of it: a signed 64-bit product, then its middle four bytes. No sign
 * handling, because a two's-complement arithmetic shift *is* floor — negating
 * afterwards would round toward zero and every value with a fractional part
 * would be one step out, which is the same trap the other four backends' comments
 * name and the only one this machine avoids for free.
 *
 * The product cannot lose a bit: both operands are clamped to ±2^26, so it is
 * below 2^52 and `smull` holds it exactly. Taking bits 16 to 47 truncates a
 * quotient that would not fit thirty-two bits, which is what every other backend
 * does before its clamp — so all six agree on the out-of-range case as well as
 * the ordinary one.
 */
export function mul32(ctx: GbaCtx, dst: number, src: Val): void {
  load(ctx, A0, at(dst));
  load(ctx, A1, src);
  ctx.asm.smull(A2, A3, A0, A1);
  ctx.asm.mov(A0, armLsr(A2, 16));
  ctx.asm.orr(A0, A0, armLsl(A3, 16));
  clampReg(ctx, A0);
  store(ctx, A0, dst);
}

/** `dst = floor(dst × 65536 / src)`, and zero when the divisor is zero. */
export function div32(ctx: GbaCtx, dst: number, src: Val): void {
  load(ctx, A0, at(dst));
  load(ctx, A1, src);
  ctx.asm.bl(ctx.need("Div32", emitDiv32));
  store(ctx, A0, dst);
}

/**
 * The divide: `r0 = floor(r0 × 65536 / r1)`.
 *
 * A restoring division over the 64-bit dividend, and **the same algorithm the
 * Mega Drive's and the Z80's use, deliberately**: the leading zeros of the
 * dividend are shifted out first and their iterations skipped, the quotient grows
 * into the bits the dividend vacates, and an over-range quotient therefore
 * truncates to the same low thirty-two bits on every console before the clamp
 * sees it. Reimplementing it a cleverer way would be a second answer to a
 * question the trace oracle compares.
 *
 * There is no fast path for a whole-cell divisor, unlike the Mega Drive's — and
 * that is a consequence of this being the one console here with no divide
 * instruction at all, rather than an omission. On that machine the fast path is
 * *two instructions*; here it would be a thirty-two-iteration loop against a
 * sixty-four-iteration one, and the general loop already costs under a third of a
 * percent of a frame.
 */
function emitDiv32(ctx: GbaCtx): void {
  const { asm } = ctx;
  const skip = ctx.unique("divSkip");
  const skipDone = ctx.unique("divSkipDone");
  const loop = ctx.unique("divLoop");
  const subtract = ctx.unique("divSub");
  const noFit = ctx.unique("divNoFit");
  const positive = ctx.unique("divPositive");
  const zero = ctx.unique("divZero");

  asm.cmp(A1, armImm(0));
  ctx.far("eq", zero);
  asm.cmp(A0, armImm(0));
  // A zero dividend is already the answer, and returning it costs nothing.
  asm.ret("eq");

  asm.push([4, 5, 6]);
  // The quotient's sign is the exclusive-or of the operands', taken before either
  // is made positive.
  asm.eor(6, A0, armReg(A1));
  asm.cmp(A0, armImm(0));
  asm.rsb(A0, A0, armImm(0), "lt");
  asm.cmp(A1, armImm(0));
  asm.rsb(A1, A1, armImm(0), "lt");

  // The dividend is |a| × 65536, as the pair r3 (high) : r2 (low).
  asm.mov(A2, armLsl(A0, 16));
  asm.mov(A3, armLsr(A0, 16));
  asm.mov(4, armImm(0)); // the running remainder
  asm.mov(5, armImm(63)); // iterations left

  asm.label(skip);
  asm.cmp(A3, armImm(0));
  ctx.far("mi", skipDone);
  asm.cmp(5, armImm(0));
  ctx.far("eq", skipDone);
  asm.adds(A2, A2, armReg(A2));
  asm.adc(A3, A3, armReg(A3));
  asm.sub(5, 5, armImm(1));
  asm.b(skip);
  asm.label(skipDone);

  asm.label(loop);
  asm.adds(A2, A2, armReg(A2));
  asm.adcs(A3, A3, armReg(A3));
  // The bit that leaves the dividend's high half enters the remainder, and the
  // bit that leaves the *remainder* is a thirty-third bit — which is always
  // enough to subtract, whatever the divisor is.
  asm.adcs(4, 4, armReg(4));
  ctx.far("cs", subtract);
  asm.cmp(4, armReg(A1));
  ctx.far("cc", noFit);
  asm.label(subtract);
  asm.sub(4, 4, armReg(A1));
  asm.add(A2, A2, armImm(1));
  asm.label(noFit);
  asm.subs(5, 5, armImm(1));
  ctx.far("pl", loop);

  asm.mov(A0, armReg(A2));
  asm.cmp(6, armImm(0));
  ctx.far("pl", positive);
  asm.rsb(A0, A0, armImm(0));
  // floor, not truncate: a negative quotient with a remainder rounds away.
  asm.cmp(4, armImm(0));
  asm.sub(A0, A0, armImm(1), "ne");
  asm.label(positive);
  asm.pop([4, 5, 6]);
  clampReg(ctx, A0);
  asm.ret();

  asm.label(zero);
  asm.mov(A0, armImm(0));
  asm.ret();
  asm.ltorg();
}
