/**
 * Expressions become straight-line V810.
 *
 * The same three properties every other backend gets, for the same reasons —
 * constants fold, comparisons never build a number, a property read is an
 * address rather than a copy — and every decision about *which* of those applies
 * is `shape.ts`'s, so no two backends can disagree about what an expression
 * means. What is here is only how it is spelled.
 *
 * Three things this machine spells better than any of the others:
 *
 *   - **A property read through a pointer is three instructions and no
 *     scratch.** One load gets the record's address out of the plan, one more
 *     reads a whole 16.16 property out of the record, and a store puts it
 *     wherever it was wanted — so the `ptr` case of an {@link EntityAddr}, the
 *     thing that makes a looped rule body possible at all, costs less here than
 *     on any other console in the set.
 *   - **The generator advances in one instruction.** `rng × 1664525` is a single
 *     `mul`, whose *low* half is exactly the product modulo 2^32 that the
 *     language's generator is defined as — where the TLCS-900/H needs three
 *     16×16 products assembled by hand and the Z80 a shift-and-add loop.
 *   - **The generator's modulo is one instruction too.** `divu` leaves the
 *     remainder in `r30`, so a draw's `mod` is a divide and a move.
 *
 * One thing it has to be careful about that its neighbours do not. The integer
 * part of a 16.16 value is taken with an **arithmetic** shift here, not a
 * logical one: the Neo Geo Pocket takes the high half into a sixteen-bit
 * register and subtracts there, so the wrap does the sign extension for it,
 * while a thirty-two-bit register keeps whatever the shift left behind. A
 * logical shift would make `random(-1, 1)` compute a count of −65534.
 */

import type { Ref } from "@demake/core";

import type { CBinaryOp, CExpr } from "../../program.js";
import {
  DERIVED_PARTS,
  fold,
  propOffset,
  resolveEntity,
  UNBOUND,
  type Binding,
  type EntityAddr,
  type Slot,
  type TestVerdict,
} from "../shape.js";

import type { VbCtx } from "./ctx.js";
import { E0, HI, LP, RAM, T0, T1, T2, T3, ZERO, ramDisp } from "./regs.js";
import {
  abs32,
  add32,
  addConst32,
  asr32,
  branchEqual32,
  branchLess32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  load32,
  mul32,
  neg32,
  ONE,
  set32,
  store32,
  sub32,
} from "./val.js";

export {
  DERIVED_PARTS,
  fold,
  propOffset,
  resolveEntity,
  UNBOUND,
  type Binding,
  type EntityAddr,
  type Slot,
  type TestVerdict,
};

/** Copy four bytes from `[ptr] + offset` to an absolute address. */
export function copyFromPtr(ctx: VbCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.ldw(ramDisp(ptr), RAM, T2);
  asm.ldw(offset, T2, T0);
  store32(ctx, T0, dst);
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: VbCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.ldw(ramDisp(ptr), RAM, T2);
  load32(ctx, src, T0);
  asm.stw(T0, offset, T2);
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: VbCtx, entity: EntityAddr, prop: string): Slot {
  switch (entity.kind) {
    case "none":
      return { addr: ctx.constant(0), temp: false };
    case "const":
      return { addr: entity.base + propOffset(prop), temp: false };
    case "ptr": {
      const temp = ctx.pushTemp();
      copyFromPtr(ctx, entity.ptr, propOffset(prop), temp);
      return { addr: temp, temp: true };
    }
  }
}

/** Read any property, stored or derived. */
export function readProp(ctx: VbCtx, entity: EntityAddr, prop: string): Slot {
  const derived = DERIVED_PARTS[prop];
  if (!derived) return readStored(ctx, entity, prop);
  if (entity.kind === "none") return { addr: ctx.constant(0), temp: false };

  const temp = ctx.pushTemp();
  const base = readStored(ctx, entity, derived.base);
  copy32(ctx, temp, base.addr);
  if (base.temp) ctx.popTemp();
  if (derived.add) {
    const extra = readStored(ctx, entity, derived.add);
    if (derived.halve) {
      // `centerx` is `x + floor(width / 2)`, and an arithmetic shift is floor.
      const half = ctx.pushTemp();
      copy32(ctx, half, extra.addr);
      asr32(ctx, half);
      add32(ctx, temp, half);
      ctx.popTemp();
    } else {
      add32(ctx, temp, extra.addr);
    }
    if (extra.temp) ctx.popTemp();
  }
  return { addr: temp, temp: true };
}

/** Write a value into a property, clamping it the way `writeProp` does. */
export function writeProp(ctx: VbCtx, entity: EntityAddr, prop: string, value: Ref): void {
  if (entity.kind === "none") return;
  // The interpreter clamps on write, so the value is clamped in the staging slot
  // it already owns rather than copied first.
  clamp32(ctx, value);
  if (entity.kind === "const") {
    copy32(ctx, entity.base + propOffset(prop), value);
  } else {
    copyToPtr(ctx, entity.ptr, propOffset(prop), value);
  }
}

/**
 * Emit an expression, leaving its value somewhere and returning where.
 *
 * `into` asks for a specific destination; without it the compiler picks the
 * cheapest place, which for a bare property read is the entity record itself.
 */
export function emitExpr(ctx: VbCtx, expr: CExpr, bind: Binding, into?: number): Slot {
  const constant = fold(expr);
  if (constant !== undefined) {
    if (into === undefined) return { addr: ctx.constant(constant), temp: false };
    set32(ctx, into, constant);
    return { addr: into, temp: false };
  }

  const place = (slot: Slot): Slot => {
    if (into === undefined || slot.addr === into) return slot;
    copy32(ctx, into, slot.addr);
    if (slot.temp) ctx.popTemp();
    return { addr: into, temp: false };
  };

  switch (expr.kind) {
    case "read": {
      const entity = resolveEntity(ctx, expr.entity, bind);
      return place(readProp(ctx, entity, expr.prop));
    }
    case "camera": {
      const camera = ctx.layout.camera;
      if (camera === null) return place({ addr: ctx.constant(0), temp: false });
      return place({ addr: camera + (expr.axis === "x" ? 0 : 4), temp: false });
    }
    case "neg": {
      const target = into ?? ctx.pushTemp();
      emitExpr(ctx, expr.operand, bind, target);
      neg32(ctx, target);
      clamp32(ctx, target);
      return { addr: target, temp: into === undefined };
    }
    case "binary":
      return emitBinary(ctx, expr.op, expr.left, expr.right, bind, into);
    case "call":
      return emitCall(ctx, expr, bind, into);
    default:
      // `flip` and `scene` are assignment kinds; anywhere else they are zero,
      // and `fold` has already returned that.
      return place({ addr: ctx.constant(0), temp: false });
  }
}

function emitBinary(
  ctx: VbCtx,
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
    ctx.jump(done);
    ctx.asm.label(isTrue);
    set32(ctx, target, ONE);
    ctx.asm.label(done);
    return { addr: target, temp: into === undefined };
  }

  const target = into ?? ctx.pushTemp();
  emitExpr(ctx, leftExpr, bind, target);
  const rightConst = fold(rightExpr);
  if (op === "+" && rightConst !== undefined) {
    addConst32(ctx, target, rightConst);
    clamp32(ctx, target);
    return { addr: target, temp: into === undefined };
  }
  if (op === "-" && rightConst !== undefined) {
    addConst32(ctx, target, -rightConst);
    clamp32(ctx, target);
    return { addr: target, temp: into === undefined };
  }

  const right = ctx.scoped(() => emitExpr(ctx, rightExpr, bind));
  switch (op) {
    case "+":
      add32(ctx, target, right.addr);
      clamp32(ctx, target);
      break;
    case "-":
      sub32(ctx, target, right.addr);
      clamp32(ctx, target);
      break;
    case "*":
      mul32(ctx, target, right.addr);
      break;
    case "/":
      div32(ctx, target, right.addr);
      break;
  }
  return { addr: target, temp: into === undefined };
}

function emitCall(ctx: VbCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
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
      branchLess32(ctx, target, other.addr, keep, expr.fn === "min");
      copy32(ctx, target, other.addr);
      asm.label(keep);
      break;
    }
    case "clamp": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      ctx.scoped(() => {
        const low = emitExpr(ctx, args[1] as CExpr, bind);
        const aboveLow = ctx.unique("clampLow");
        branchLess32(ctx, target, low.addr, aboveLow, false);
        copy32(ctx, target, low.addr);
        asm.label(aboveLow);
      });
      ctx.scoped(() => {
        const high = emitExpr(ctx, args[2] as CExpr, bind);
        const belowHigh = ctx.unique("clampHigh");
        branchLess32(ctx, high.addr, target, belowHigh, false);
        copy32(ctx, target, high.addr);
        asm.label(belowHigh);
      });
      break;
    }
    case "random": {
      // Both bounds are materialised before either reaches the helper's
      // operands: evaluating the second could itself use them.
      ctx.scoped(() => {
        const low = ctx.pushTemp();
        emitExpr(ctx, args[0] as CExpr, bind, low);
        const high = ctx.pushTemp();
        emitExpr(ctx, args[1] as CExpr, bind, high);
        copy32(ctx, ctx.layout.mathA, low);
        copy32(ctx, ctx.layout.mathB, high);
      });
      asm.jal(ctx.need("RngPick", emitRngPick));
      copy32(ctx, target, ctx.layout.mathA);
      break;
    }
  }
  return { addr: target, temp: into === undefined };
}

/**
 * Branch on a comparison without ever building its 16.16 result.
 *
 * `invert` swaps the sense, which is what lets a caller ask for "jump when
 * false" and get the same code with one flag changed.
 */
export function emitCompare(
  ctx: VbCtx,
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
        branchEqual32(ctx, left.addr, right.addr, target, !invert);
        break;
      case "!=":
        branchEqual32(ctx, left.addr, right.addr, target, invert);
        break;
      case "<":
        branchLess32(ctx, left.addr, right.addr, target, !invert);
        break;
      case ">":
        branchLess32(ctx, right.addr, left.addr, target, !invert);
        break;
      case "<=":
        // `a <= b` is `!(b < a)`.
        branchLess32(ctx, right.addr, left.addr, target, invert);
        break;
      case ">=":
        branchLess32(ctx, left.addr, right.addr, target, invert);
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
export function emitTest(ctx: VbCtx, expr: CExpr, bind: Binding, falseTarget: string): TestVerdict {
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
    branchZero32(ctx, value.addr, falseTarget);
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
 * When the bounds meet or cross, the low bound is the answer and the generator
 * is **not** advanced — which is behaviour, because *when* a draw happens is
 * part of the language.
 *
 * The integer parts are taken with `sar` rather than `shr`, which is the one
 * thing this routine does differently from the Neo Geo Pocket's: that machine
 * subtracts in a sixteen-bit register and gets the sign extension from the wrap,
 * and a thirty-two-bit register does not.
 *
 * Exported so `vb-arith.test.ts` can call it directly and diff four draws in a
 * row against `rng.ts`. Until the rest of this backend exists there is no game
 * to reach it through, and the generator is exactly the sort of thing that is
 * wrong in a way only arithmetic can show.
 */
export function emitRngPick(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const low = ctx.unique("rngLow");

  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds. This is the
  // one helper in the backend that calls another, so it is the one that has to
  // put its own return address somewhere first (`ctx.enter`).
  ctx.enter();
  asm.jal(ctx.need("RngAdvance", emitRngAdvance));

  asm.ldw(ramDisp(layout.mathA), RAM, T0);
  asm.sarImm5(16, T0); // floor(lo), signed
  asm.ldw(ramDisp(layout.mathB), RAM, T1);
  asm.sarImm5(16, T1); // floor(hi), signed
  asm.mov(T0, E0); // the fallback answer, kept clear of the divide
  asm.sub(T0, T1); // count = floor(hi) - floor(lo)
  asm.cmpImm5(0, T1);
  ctx.far("le", low);
  asm.addImm5(1, T1);

  asm.ldw(ramDisp(rng), RAM, T3);
  asm.shrImm5(16, T3); // the generator's high half, and nothing above it
  asm.divu(T1, T3); // the remainder is the modulo, and it lands in r30
  asm.add(HI, E0);

  asm.label(low);
  // The answer is a whole number of cells, so its fraction is zero: shifting the
  // count into the high half is the conversion.
  asm.shlImm5(16, E0);
  asm.stw(E0, ramDisp(layout.mathA), RAM);
  ctx.leave();
}

/**
 * `rng = rng * 1664525 + 1013904223`, modulo 2^32.
 *
 * One multiply. `mul` puts the product's low half in its destination and that
 * *is* the product modulo 2^32, so the three assembled 16×16 products the
 * TLCS-900/H needs and the shift-and-add loop the Z80 needs are both simply
 * absent here — the whole generator is four instructions.
 */
function emitRngAdvance(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng as number;
  asm.ldw(ramDisp(rng), RAM, T0);
  asm.movImm32(1664525, T1);
  asm.mul(T1, T0);
  asm.addImm32(1013904223, T0);
  asm.stw(T0, ramDisp(rng), RAM);
  asm.jmp(LP);
}

/** Registers this file promises not to leave anything in. */
export const EXPR_SCRATCH = [T0, T1, T2, T3, E0, HI, ZERO] as const;
