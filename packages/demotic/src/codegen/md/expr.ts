/**
 * Expressions become straight-line 68000.
 *
 * The same three properties the other three backends get, for the same reasons
 * (constants fold, comparisons never build a number, a property read is an
 * address rather than a copy) — and every decision about *which* of those
 * applies is `shape.ts`'s, so no two backends can disagree about what an
 * expression means. What is here is only how it is spelled.
 *
 * Two things this machine spells better than any of the others:
 *
 *   - **A property read through a pointer is one instruction.** `movea.l` puts
 *     the record's address in `a0` and `move.l 16(a0),d0` reads a property out of
 *     it, so the `ptr` case of an {@link EntityAddr} — the thing that makes a
 *     looped rule body possible — costs eight bytes rather than the Z80's
 *     fifteen or the 6502's four separate indexed loads.
 *   - **The generator's modulo is one instruction.** `divu.w` leaves the
 *     remainder in the high half of the register it divided, so `Mod16` is a
 *     divide and a `swap` where the Z80 needs a twenty-one-byte loop and the
 *     6502 a byte-at-a-time one.
 */

import { eaAbs, eaD, eaDisp, eaImm, type Ref } from "@demake/core";

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

import type { MdCtx } from "./ctx.js";
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
  mul32,
  neg32,
  ONE,
  set32,
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
export function copyFromPtr(ctx: MdCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.movea("l", at(ptr), 0);
  asm.move("l", eaDisp(0, offset), eaD(0));
  asm.move("l", eaD(0), at(dst));
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: MdCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.movea("l", at(ptr), 0);
  asm.move("l", at(src), eaD(0));
  asm.move("l", eaD(0), eaDisp(0, offset));
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: MdCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: MdCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: MdCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: MdCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: MdCtx,
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
    ctx.asm.bra(done);
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

function emitCall(ctx: MdCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
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
      // Both bounds are materialised before either reaches the helper's operands:
      // evaluating the second could itself use them.
      ctx.scoped(() => {
        const low = ctx.pushTemp();
        emitExpr(ctx, args[0] as CExpr, bind, low);
        const high = ctx.pushTemp();
        emitExpr(ctx, args[1] as CExpr, bind, high);
        copy32(ctx, ctx.layout.mathA, low);
        copy32(ctx, ctx.layout.mathB, high);
      });
      asm.jsr(ctx.need("RngPick", emitRngPick));
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
  ctx: MdCtx,
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
export function emitTest(ctx: MdCtx, expr: CExpr, bind: Binding, falseTarget: string): TestVerdict {
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
 * is **not** advanced — which is behaviour, because *when* a draw happens is part
 * of the language.
 */
function emitRngPick(ctx: MdCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  const low = ctx.unique("rngLow");

  // The integer parts, which are the high words of the two 16.16 bounds.
  asm.move("l", at(lo), eaD(0));
  asm.swap(0);
  asm.move("l", at(hi), eaD(1));
  asm.swap(1);
  // The bound and the count go in `d6` and `d7`, not in the low registers, and
  // that is not a preference: `RngAdvance` builds a 32-bit product out of
  // `d0`–`d3`, so anything held there across the call is gone by the time the
  // draw needs it. It presents as a game whose random numbers are plausible and
  // wrong, which is the hardest kind to see.
  asm.move("w", eaD(0), eaD(6)); // the low bound, which is the fallback answer
  asm.move("w", eaD(1), eaD(7));
  asm.sub("w", eaD(0), 7); // count = floor(hi) - floor(lo), signed
  ctx.far("le", low);
  asm.addq("w", 1, eaD(7));

  asm.jsr(ctx.need("RngAdvance", emitRngAdvance));
  asm.move("l", at(rng), eaD(4));
  asm.swap(4); // the generator's high half
  asm.moveq(0, 5);
  asm.move("w", eaD(4), eaD(5));
  // The remainder of an unsigned divide is its high half — the whole of `Mod16`
  // on this machine, where the other three backends need a shift loop.
  asm.divu(eaD(7), 5);
  asm.swap(5);
  asm.add("w", eaD(5), 6);

  asm.label(low);
  asm.moveq(0, 0);
  asm.move("w", eaD(6), eaD(0));
  asm.swap(0); // the answer is a whole number of cells, so its fraction is zero
  asm.move("l", eaD(0), at(lo));
  asm.rts();
}

/**
 * `rng = rng * 1664525 + 1013904223`, modulo 2^32.
 *
 * Three 16×16 products rather than a shift-and-add loop: the low half of a
 * 32×32 product needs `al·bl` plus the low half of `ah·bl + al·bh`, and the top
 * product is thrown away because it only reaches bits the modulus discards.
 */
function emitRngAdvance(ctx: MdCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng as number;
  const MUL_LOW = 1664525 & 0xffff;
  const MUL_HIGH = (1664525 >>> 16) & 0xffff;
  const ADD = 1013904223;

  asm.move("l", at(rng), eaD(0));
  asm.move("l", eaD(0), eaD(1));
  asm.move("l", eaD(0), eaD(2));
  asm.swap(2); // d2's low word is the multiplicand's high half
  asm.mulu(eaImm(MUL_LOW), 1); // al · bl
  asm.mulu(eaImm(MUL_LOW), 2); // ah · bl
  asm.move("l", eaD(0), eaD(3));
  asm.mulu(eaImm(MUL_HIGH), 3); // al · bh
  asm.add("l", eaD(3), 2);
  asm.swap(2);
  asm.clr("w", eaD(2)); // the middle product, shifted into place
  asm.add("l", eaD(2), 1);
  asm.addi("l", ADD, eaD(1));
  asm.move("l", eaD(1), at(rng));
  asm.rts();
}

/** Silence the unused-import checker for operands the emitters reach for. */
export const EXPR_OPERANDS = { eaAbs };
