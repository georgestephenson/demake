/**
 * Expressions become straight-line ARM.
 *
 * The same three properties the other five backends get, for the same reasons
 * (constants fold, comparisons never build a number, a property read is an
 * address rather than a copy) — and every decision about *which* of those
 * applies is `shape.ts`'s, so no two backends can disagree about what an
 * expression means. What is here is only how it is spelled.
 *
 * Two things this machine spells differently from all five, and neither is a
 * micro-optimisation:
 *
 *   - **A constant is not in memory.** The other backends read a folded constant
 *     out of a pooled ROM word, because their instructions cannot carry a 32-bit
 *     literal; `movImm32` can put any value in a register in one instruction, so
 *     {@link Slot} carries a {@link Val} rather than an address and a constant
 *     operand never touches memory at all. That is why `CtxBase.constant` is
 *     never called on this console.
 *   - **A property read through a pointer is two instructions.** `ldr` the
 *     record's address, `ldr` the property out of it — so the `ptr` case of an
 *     {@link EntityAddr}, the thing that makes a looped rule body possible, is as
 *     cheap here as a direct read is on a Game Boy.
 *
 * The generator needs one routine this architecture does not have. There is no
 * divide instruction at all, so the modulo a draw needs is a sixteen-iteration
 * restoring loop — the Z80's and the 6502's `Mod16`, arrived at here for the
 * same reason rather than by resemblance.
 */

import { armAsr, armAt, armImm, armLsl, armLsr, armReg } from "@demake/core";

import type { CBinaryOp, CExpr } from "../../program.js";
import {
  DERIVED_PARTS,
  fold,
  propOffset,
  resolveEntity,
  UNBOUND,
  type Binding,
  type EntityAddr,
  type TestVerdict,
} from "../shape.js";

import type { GbaCtx } from "./ctx.js";
import { A0, A1, A2, A3, LR, PC } from "./regs.js";
import {
  abs32,
  add32,
  addConst32,
  asr32,
  at,
  branchEqual32,
  branchLess32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  imm,
  load,
  mem,
  mul32,
  neg32,
  ONE,
  set32,
  store,
  sub32,
  type Val,
} from "./val.js";

export {
  DERIVED_PARTS,
  fold,
  propOffset,
  resolveEntity,
  UNBOUND,
  type Binding,
  type EntityAddr,
  type TestVerdict,
};

/**
 * A four-byte value, and whether the caller owns the temporary holding it.
 *
 * `shape.ts` has a `Slot` of its own whose `addr` is a `Ref`, and this is
 * deliberately not it: on this machine a value may be a constant the instruction
 * stream carries rather than something with an address, so the slot has to be
 * able to say so.
 */
export interface Slot {
  val: Val;
  /** True when this is a temporary the caller must release. */
  temp: boolean;
}

/** Copy four bytes from `[ptr] + offset` to a work-RAM address. */
export function copyFromPtr(ctx: GbaCtx, ptr: number, offset: number, dst: number): void {
  ctx.asm.ldr(A0, mem(ctx, ptr));
  ctx.asm.ldr(A0, armAt(A0, offset));
  store(ctx, A0, dst);
}

/** Copy four bytes from a work-RAM address to `[ptr] + offset`. */
export function copyToPtr(ctx: GbaCtx, ptr: number, offset: number, src: Val): void {
  load(ctx, A0, src);
  ctx.asm.ldr(A1, mem(ctx, ptr));
  ctx.asm.str(A0, armAt(A1, offset));
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: GbaCtx, entity: EntityAddr, prop: string): Slot {
  switch (entity.kind) {
    case "none":
      return { val: imm(0), temp: false };
    case "const":
      return { val: at(entity.base + propOffset(prop)), temp: false };
    case "ptr": {
      const temp = ctx.pushTemp();
      copyFromPtr(ctx, entity.ptr, propOffset(prop), temp);
      return { val: at(temp), temp: true };
    }
  }
}

/** Read any property, stored or derived. */
export function readProp(ctx: GbaCtx, entity: EntityAddr, prop: string): Slot {
  const derived = DERIVED_PARTS[prop];
  if (!derived) return readStored(ctx, entity, prop);
  if (entity.kind === "none") return { val: imm(0), temp: false };

  const temp = ctx.pushTemp();
  const base = readStored(ctx, entity, derived.base);
  copy32(ctx, temp, base.val);
  if (base.temp) ctx.popTemp();
  if (derived.add) {
    const extra = readStored(ctx, entity, derived.add);
    if (derived.halve) {
      // `centerx` is `x + floor(width / 2)`, and an arithmetic shift is floor.
      const half = ctx.pushTemp();
      copy32(ctx, half, extra.val);
      asr32(ctx, half);
      add32(ctx, temp, at(half));
      ctx.popTemp();
    } else {
      add32(ctx, temp, extra.val);
    }
    if (extra.temp) ctx.popTemp();
  }
  return { val: at(temp), temp: true };
}

/** Write a value into a property, clamping it the way `writeProp` does. */
export function writeProp(ctx: GbaCtx, entity: EntityAddr, prop: string, value: number): void {
  if (entity.kind === "none") return;
  // The interpreter clamps on write, so the value is clamped in the staging slot
  // it already owns rather than copied first.
  clamp32(ctx, value);
  if (entity.kind === "const") {
    copy32(ctx, entity.base + propOffset(prop), at(value));
  } else {
    copyToPtr(ctx, entity.ptr, propOffset(prop), at(value));
  }
}

/**
 * Emit an expression, leaving its value somewhere and returning where.
 *
 * `into` asks for a specific destination; without it the compiler picks the
 * cheapest place, which for a bare property read is the entity record itself and
 * for a folded constant is nowhere at all.
 */
export function emitExpr(ctx: GbaCtx, expr: CExpr, bind: Binding, into?: number): Slot {
  const constant = fold(expr);
  if (constant !== undefined) {
    if (into === undefined) return { val: imm(constant), temp: false };
    set32(ctx, into, constant);
    return { val: at(into), temp: false };
  }

  const place = (slot: Slot): Slot => {
    if (into === undefined) return slot;
    if (slot.val.k === "at" && slot.val.addr === into) return slot;
    copy32(ctx, into, slot.val);
    if (slot.temp) ctx.popTemp();
    return { val: at(into), temp: false };
  };

  switch (expr.kind) {
    case "read": {
      const entity = resolveEntity(ctx, expr.entity, bind);
      return place(readProp(ctx, entity, expr.prop));
    }
    case "camera": {
      const camera = ctx.layout.camera;
      if (camera === null) return place({ val: imm(0), temp: false });
      return place({ val: at(camera + (expr.axis === "x" ? 0 : 4)), temp: false });
    }
    case "neg": {
      const target = into ?? ctx.pushTemp();
      emitExpr(ctx, expr.operand, bind, target);
      neg32(ctx, target);
      clamp32(ctx, target);
      return { val: at(target), temp: into === undefined };
    }
    case "binary":
      return emitBinary(ctx, expr.op, expr.left, expr.right, bind, into);
    case "call":
      return emitCall(ctx, expr, bind, into);
    default:
      // `flip` and `scene` are assignment kinds; anywhere else they are zero,
      // and `fold` has already returned that.
      return place({ val: imm(0), temp: false });
  }
}

function emitBinary(
  ctx: GbaCtx,
  op: CBinaryOp,
  leftExpr: CExpr,
  rightExpr: CExpr,
  bind: Binding,
  into?: number,
): Slot {
  if (op === "<" || op === ">" || op === "<=" || op === ">=" || op === "=" || op === "!=") {
    const target = into ?? ctx.pushTemp();
    const isTrue = ctx.unique("cmpTrue");
    const done = ctx.unique("cmpDone");
    emitCompare(ctx, op, leftExpr, rightExpr, bind, isTrue, false);
    set32(ctx, target, 0);
    ctx.asm.b(done);
    ctx.asm.label(isTrue);
    set32(ctx, target, ONE);
    ctx.asm.label(done);
    return { val: at(target), temp: into === undefined };
  }

  const target = into ?? ctx.pushTemp();
  emitExpr(ctx, leftExpr, bind, target);
  const rightConst = fold(rightExpr);
  if (op === "+" && rightConst !== undefined) {
    addConst32(ctx, target, rightConst);
    clamp32(ctx, target);
    return { val: at(target), temp: into === undefined };
  }
  if (op === "-" && rightConst !== undefined) {
    addConst32(ctx, target, -rightConst);
    clamp32(ctx, target);
    return { val: at(target), temp: into === undefined };
  }

  const right = ctx.scoped(() => emitExpr(ctx, rightExpr, bind));
  switch (op) {
    case "+":
      add32(ctx, target, right.val);
      clamp32(ctx, target);
      break;
    case "-":
      sub32(ctx, target, right.val);
      clamp32(ctx, target);
      break;
    case "*":
      mul32(ctx, target, right.val);
      break;
    case "/":
      div32(ctx, target, right.val);
      break;
  }
  return { val: at(target), temp: into === undefined };
}

function emitCall(ctx: GbaCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
  const { asm } = ctx;
  const target = into ?? ctx.pushTemp();
  const args = expr.args;

  switch (expr.fn) {
    case "abs":
      emitExpr(ctx, args[0] as CExpr, bind, target);
      abs32(ctx, target);
      break;
    case "min":
    case "max": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      const other = ctx.scoped(() => emitExpr(ctx, args[1] as CExpr, bind));
      const keep = ctx.unique("pickKeep");
      // `min` keeps the left when it is smaller; `max` keeps it when it is not.
      branchLess32(ctx, at(target), other.val, keep, expr.fn === "min");
      copy32(ctx, target, other.val);
      asm.label(keep);
      break;
    }
    case "clamp": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      ctx.scoped(() => {
        const low = emitExpr(ctx, args[1] as CExpr, bind);
        const aboveLow = ctx.unique("clampLow");
        branchLess32(ctx, at(target), low.val, aboveLow, false);
        copy32(ctx, target, low.val);
        asm.label(aboveLow);
      });
      ctx.scoped(() => {
        const high = emitExpr(ctx, args[2] as CExpr, bind);
        const belowHigh = ctx.unique("clampHigh");
        branchLess32(ctx, high.val, at(target), belowHigh, false);
        copy32(ctx, target, high.val);
        asm.label(belowHigh);
      });
      break;
    }
    case "random": {
      // Both bounds are materialised before either reaches the helper's operands:
      // evaluating the second could itself use them.
      ctx.scoped(() => {
        const low = ctx.pushTemp();
        emitExpr(ctx, args[0] as CExpr, bind, low);
        const high = ctx.pushTemp();
        emitExpr(ctx, args[1] as CExpr, bind, high);
        copy32(ctx, ctx.layout.mathA, at(low));
        copy32(ctx, ctx.layout.mathB, at(high));
      });
      asm.bl(ctx.need("RngPick", emitRngPick));
      copy32(ctx, target, at(ctx.layout.mathA));
      break;
    }
  }
  return { val: at(target), temp: into === undefined };
}

/**
 * Branch on a comparison without ever building its 16.16 result.
 *
 * `invert` swaps the sense, which is what lets a caller ask for "jump when
 * false" and get the same code with one flag changed.
 */
export function emitCompare(
  ctx: GbaCtx,
  op: CBinaryOp,
  leftExpr: CExpr,
  rightExpr: CExpr,
  bind: Binding,
  target: string,
  invert: boolean,
): void {
  ctx.scoped(() => {
    const left = emitExpr(ctx, leftExpr, bind);
    const right = ctx.scoped(() => emitExpr(ctx, rightExpr, bind));
    switch (op) {
      case "=":
        branchEqual32(ctx, left.val, right.val, target, !invert);
        break;
      case "!=":
        branchEqual32(ctx, left.val, right.val, target, invert);
        break;
      case "<":
        branchLess32(ctx, left.val, right.val, target, !invert);
        break;
      case ">":
        branchLess32(ctx, right.val, left.val, target, !invert);
        break;
      case "<=":
        // `a <= b` is `!(b < a)`.
        branchLess32(ctx, right.val, left.val, target, invert);
        break;
      case ">=":
        branchLess32(ctx, left.val, right.val, target, invert);
        break;
      default:
        throw new Error(`'${op}' is not a comparison`);
    }
  });
}

/**
 * Emit a truth test that jumps to `falseTarget` when the expression is zero.
 *
 * Returns `always` or `never` when the answer was known, in which case nothing
 * was emitted and the caller can drop the branch — and, for `never`, the whole
 * body behind it.
 */
export function emitTest(
  ctx: GbaCtx,
  expr: CExpr,
  bind: Binding,
  falseTarget: string,
): TestVerdict {
  const constant = fold(expr);
  if (constant !== undefined) return constant !== 0 ? "always" : "never";

  if (expr.kind === "binary") {
    const relational = ["<", ">", "<=", ">=", "=", "!="].includes(expr.op);
    if (relational) {
      emitCompare(ctx, expr.op, expr.left, expr.right, bind, falseTarget, true);
      return "runtime";
    }
  }

  ctx.scoped(() => {
    const value = emitExpr(ctx, expr, bind);
    if (value.val.k === "at") branchZero32(ctx, value.val.addr, falseTarget);
    else {
      // A constant that `fold` could not see through cannot happen — but an
      // immediate slot is representable, so the case is answered rather than
      // left to produce a wrong branch.
      load(ctx, A0, value.val);
      ctx.asm.cmp(A0, armImm(0));
      ctx.far("eq", falseTarget);
    }
  });
  return "runtime";
}

/**
 * The game's generator, drawn from `mathA`..`mathB` into `mathA`.
 *
 * A 32-bit LCG with Numerical Recipes' constants, reproduced bit for bit from
 * `rng.ts`. It is part of the language, not a convenience: two implementations
 * that disagree about it cannot be compared at all. The low bits of an LCG cycle
 * short, so a draw comes from the high half.
 *
 * **When the bounds meet or cross the low bound is the answer, and the generator
 * advances anyway** — `rng.ts`'s `draw` is the definition of both halves, and
 * *when* a draw happens is behaviour rather than an implementation detail.
 *
 * Exported so `gba-arith.test.ts` can prove the generator against `rng.ts`
 * before the rest of this backend exists — the same reason `sms-arith.test.ts`
 * is the only test of the Sega value layer while its emitter is being written.
 */
export function emitRngPick(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const low = ctx.unique("rngLow");

  // `r4` and `r5` outlive the call to `RngAdvance`, so they are saved rather than
  // borrowed: the convention (`regs.ts`) is that a helper may lose `r0`–`r3` and
  // must preserve everything above them, and this routine is a caller as well as
  // a helper.
  asm.push([4, 5, LR]);
  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds. At the top of
  // the routine nothing is live yet, so the call costs no saves.
  asm.bl(ctx.need("RngAdvance", emitRngAdvance));

  asm.ldr(A0, mem(ctx, layout.mathA));
  asm.ldr(A1, mem(ctx, layout.mathB));
  // The whole-cell parts, arithmetically shifted so a negative bound floors.
  asm.mov(4, armAsr(A0, 16));
  asm.mov(5, armAsr(A1, 16));
  asm.subs(5, 5, armReg(4));
  ctx.far("le", low);
  asm.add(5, 5, armImm(1));

  asm.ldr(A0, mem(ctx, rng));
  asm.mov(A0, armLsr(A0, 16));
  asm.mov(A1, armReg(5));
  asm.bl(ctx.need("Mod16", emitMod16));
  asm.add(4, 4, armReg(A0));

  asm.label(low);
  // The answer is a whole number of cells, so its fraction is zero.
  asm.mov(A0, armLsl(4, 16));
  asm.str(A0, mem(ctx, layout.mathA));
  asm.pop([4, 5, PC]);
  asm.ltorg();
}

/**
 * `rng = rng × 1664525 + 1013904223`, modulo 2^32.
 *
 * One instruction for the multiply, because `mul` gives exactly the low
 * thirty-two bits of a product and the modulus discards nothing else. The Mega
 * Drive assembles three 16×16 products for this and the 8-bit consoles run a
 * loop; here it is the whole routine.
 */
function emitRngAdvance(ctx: GbaCtx): void {
  const { asm } = ctx;
  const rng = ctx.layout.rng as number;
  asm.ldr(A0, mem(ctx, rng));
  asm.movImm32(A1, 1664525);
  asm.mul(A2, A0, A1);
  asm.movImm32(A1, 1013904223);
  asm.add(A2, A2, armReg(A1));
  asm.str(A2, mem(ctx, rng));
  asm.ret();
  asm.ltorg();
}

/**
 * `r0 = r0 mod r1`, for a sixteen-bit dividend and a non-zero divisor.
 *
 * The Z80's and the 6502's routine, and it is here for the reason it is there
 * rather than by resemblance: this is the only console in the set with **no
 * divide instruction at all**, so the remainder a draw needs is a restoring loop.
 * Sixteen iterations, because the dividend is the generator's high half — the
 * value is left-aligned first so those sixteen shifts are the ones that carry
 * bits out.
 *
 * The invariant that makes one conditional subtract enough: the remainder is
 * below the divisor at the top of every iteration, so after the shift it is below
 * twice it.
 */
function emitMod16(ctx: GbaCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("modLoop");
  asm.mov(A0, armLsl(A0, 16));
  asm.mov(A2, armImm(0));
  asm.mov(A3, armImm(16));
  asm.label(loop);
  asm.adds(A0, A0, armReg(A0));
  asm.adcs(A2, A2, armReg(A2));
  asm.cmp(A2, armReg(A1));
  asm.sub(A2, A2, armReg(A1), "cs");
  asm.subs(A3, A3, armImm(1));
  ctx.far("ne", loop);
  asm.mov(A0, armReg(A2));
  asm.ret();
  asm.ltorg();
}
