/**
 * Expressions become straight-line TLCS-900/H.
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
 *     scratch.** `ld XIX,(ptr)` puts the record's address in a register and
 *     `ld XWA,(XIX+16)` reads a whole 16.16 property out of it, so the `ptr`
 *     case of an {@link EntityAddr} — the thing that makes a looped rule body
 *     possible at all — costs what the Mega Drive's does and a fraction of the
 *     Z80's or the 6502's.
 *   - **The generator's modulo is one instruction.** `div` leaves the remainder
 *     in the high half of the register it divided, so the draw's `mod` is a
 *     divide and a shift where the Z80 needs a twenty-one-byte loop and the 6502
 *     a byte-at-a-time one. The Mega Drive's `divu.w` is the same trick.
 *   - **The generator advances with three multiplies and no loop**, for the same
 *     reason: `mul` is a real 16×16 instruction, so the low half of a 32×32
 *     product is `al·bl` plus the low half of `ah·bl + al·bh` and the top
 *     product is thrown away because it only reaches bits the modulus discards.
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

import type { NgpcCtx } from "./ctx.js";
import { at as based } from "./ops.js";
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
export function copyFromPtr(ctx: NgpcCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.ldm("xix", at(ptr));
  asm.ldm("xwa", based("xix", offset));
  asm.stm(at(dst), "xwa");
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: NgpcCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.ldm("xix", at(ptr));
  asm.ldm("xwa", at(src));
  asm.stm(based("xix", offset), "xwa");
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: NgpcCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: NgpcCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: NgpcCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: NgpcCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: NgpcCtx,
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
    ctx.far("t", done);
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

function emitCall(
  ctx: NgpcCtx,
  expr: CExpr & { kind: "call" },
  bind: Binding,
  into?: number,
): Slot {
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
      asm.call(ctx.need("RngPick", emitRngPick));
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
  ctx: NgpcCtx,
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
export function emitTest(
  ctx: NgpcCtx,
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
 */
function emitRngPick(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  const low = ctx.unique("rngLow");

  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds. At the top of
  // the routine nothing is live yet, so the call costs no saves.
  asm.call(ctx.need("RngAdvance", emitRngAdvance));

  // The integer parts, which are the high words of the two 16.16 bounds. A
  // logical shift keeps the sixteen bits; whether they mean a negative number is
  // the *comparison's* business, and `sub`'s condition codes answer it.
  asm.ldm("xde", at(lo));
  asm.shift("srl", 16, "xde");
  asm.ldm("xhl", at(hi));
  asm.shift("srl", 16, "xhl");
  // The low bound is the fallback answer, so it is kept where neither the divide
  // nor anything else will reach it.
  asm.ld("xiy", "xde");

  asm.alu("sub", "hl", "de"); // count = floor(hi) - floor(lo), signed
  ctx.far("le", low);
  asm.inc(1, "hl");

  asm.ldm("xwa", at(rng));
  asm.shift("srl", 16, "xwa"); // the generator's high half, and nothing above it
  // The remainder of a divide is its high half — the whole of the modulo on this
  // machine, where two of the other backends need a shift loop.
  asm.div("xwa", "hl");
  asm.shift("srl", 16, "xwa");
  asm.alu("add", "iy", "wa");

  asm.label(low);
  // The answer is a whole number of cells, so its fraction is zero: shifting the
  // count into the high half is the conversion.
  asm.ld("xwa", "xiy");
  asm.shift("sll", 16, "xwa");
  asm.stm(at(lo), "xwa");
  asm.ret();
}

/**
 * `rng = rng * 1664525 + 1013904223`, modulo 2^32.
 *
 * Three 16×16 products rather than a shift-and-add loop: the low half of a 32×32
 * product needs `al·bl` plus the low half of `ah·bl + al·bh`, and the top product
 * is thrown away because it only reaches bits the modulus discards. The constants
 * go through a register rather than an immediate because a widening multiply's
 * immediate form is half the width of its destination, and this one needs both
 * halves.
 */
function emitRngAdvance(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng as number;
  const MUL_LOW = 1664525 & 0xffff;
  const MUL_HIGH = (1664525 >>> 16) & 0xffff;
  const ADD = 1013904223;

  asm.ldm("xde", at(rng)); // XDE = a, so DE is its low half
  asm.ld("xhl", "xde");
  asm.shift("srl", 16, "xhl"); // HL = a's high half

  asm.ldn("bc", MUL_LOW);
  asm.ld("xwa", "xde");
  asm.mul("xwa", "bc"); // al · bl, the whole 32 bits of it
  asm.ld("xiy", "xhl");
  asm.mul("xiy", "bc"); // ah · bl

  asm.ldn("bc", MUL_HIGH);
  asm.ld("xiz", "xde");
  asm.mul("xiz", "bc"); // al · bh

  asm.alu("add", "xiy", "xiz"); // the middle product
  asm.shift("sll", 16, "xiy"); // ...shifted into place, its top half discarded
  asm.alu("add", "xwa", "xiy");
  asm.aluImm("add", "xwa", ADD >>> 0);
  asm.stm(at(rng), "xwa");
  asm.ret();
}
