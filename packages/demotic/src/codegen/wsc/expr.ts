/**
 * Expressions become straight-line V30MZ.
 *
 * The same three properties every backend gets, for the same reasons (constants
 * fold, comparisons never build a number, a property read is an address rather
 * than a copy) — and every decision about *which* of those applies is
 * `shape.ts`'s, so no two backends can disagree about what an expression means.
 * What is here is only how it is spelled.
 *
 * Two things this CPU spells better than any predecessor, and both are the
 * multiplier:
 *
 *   - **The generator advances with no loop.** `rng * 1664525 + 1013904223` is
 *     three `mul` instructions and two adds, where every other backend here
 *     shifts and adds over thirty-two bits. It is bit-for-bit `rng.ts` either
 *     way — that is the point of it being part of the language — but here it is
 *     straight-line code.
 *   - **The modulo a draw needs is one instruction.** `div` leaves the
 *     remainder in `dx`, and a sixteen-bit dividend against a sixteen-bit
 *     divisor cannot overflow the quotient, so `Mod16` is not a routine on this
 *     console: it is `xor dx,dx` and a divide, inline.
 *
 * A pointer dereference is a register too: `mov bx,[ptr]` and then `[bx+n]`
 * reaches any slot of the record, so reading a property through `self` is five
 * instructions with nothing staged first.
 */

import { type Ref } from "@demake/core";

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

import type { WscCtx } from "./ctx.js";
import { abs, at } from "./ops.js";
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
  mem,
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

/** Copy four bytes from `[ptr] + offset` to an absolute address. Clobbers `bx`. */
export function copyFromPtr(ctx: WscCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.movm("bx", abs(ptr));
  asm.movm("ax", at("bx", offset));
  asm.movmr(abs(mem(dst, 0)), "ax");
  asm.movm("ax", at("bx", offset + 2));
  asm.movmr(abs(mem(dst, 2)), "ax");
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. Clobbers `bx`. */
export function copyToPtr(ctx: WscCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.movm("bx", abs(ptr));
  asm.movm("ax", abs(mem(src, 0)));
  asm.movmr(at("bx", offset), "ax");
  asm.movm("ax", abs(mem(src, 2)));
  asm.movmr(at("bx", offset + 2), "ax");
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: WscCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: WscCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: WscCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: WscCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: WscCtx,
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
    ctx.asm.jmp(done);
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

function emitCall(ctx: WscCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
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
 * `invert` swaps the sense, which is what lets a caller ask for "jump when false"
 * and get the same code with one flag changed.
 */
export function emitCompare(
  ctx: WscCtx,
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
export function emitTest(ctx: WscCtx, expr: CExpr, bind: Binding, falseTarget: string): TestVerdict {
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
 */
function emitRngPick(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  const bound = layout.scratch;
  const low = ctx.unique("rngLow");
  const store = ctx.unique("rngStore");

  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds.
  asm.call(ctx.need("RngAdvance", emitRngAdvance));

  // count = floor(hi) - floor(lo), in whole cells, and then one more.
  asm.movm("ax", abs(mem(lo, 2)));
  asm.movmr(abs(bound), "ax");
  asm.movm("cx", abs(mem(hi, 2)));
  asm.alu("sub", "cx", "ax");
  // A count of zero or less means the bounds met or crossed: the low bound is
  // the answer. Short jumps, because the body between here and the label is
  // twenty bytes and visible in this function.
  asm.jcc("s", low);
  asm.jcc("z", low);
  // So the divisor below is at least two, which is why it needs no zero guard.
  asm.inc("cx");

  // The draw is the generator's high half, modulo the count. One instruction:
  // the dividend is sixteen bits and `dx` is cleared, so the quotient cannot
  // overflow and the remainder is what a modulo is.
  asm.movm("ax", abs(mem(rng, 2)));
  asm.movi("dx", 0);
  asm.unary("div", "cx");
  asm.mov("ax", "dx");
  asm.aluM("add", "ax", abs(bound));
  asm.jmp(store);

  asm.label(low);
  asm.movm("ax", abs(bound));
  asm.label(store);
  asm.movmi(abs(mem(lo, 0)), 0);
  asm.movmr(abs(mem(lo, 2)), "ax");
  asm.ret();
}

/**
 * `rng = rng * 1664525 + 1013904223`, modulo 2^32.
 *
 * Three multiplies and no loop. The product's low thirty-two bits are all that
 * matters, so the fourth partial — the two high halves — never has to be
 * computed at all, and neither does the shift-and-add every other backend here
 * spends thirty-two iterations on.
 */
function emitRngAdvance(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng as number;
  const MUL_LOW = 1664525 & 0xffff;
  const MUL_HIGH = (1664525 >>> 16) & 0xffff;
  const ADD_LOW = 1013904223 & 0xffff;
  const ADD_HIGH = (1013904223 >>> 16) & 0xffff;
  const acc = layout.mathWork;

  // r0 × m0 is the whole of the low half and the first thing in the high one.
  asm.movi("cx", MUL_LOW);
  asm.movm("ax", abs(mem(rng, 0)));
  asm.unary("mul", "cx");
  asm.movmr(abs(acc), "ax");
  asm.movmr(abs(acc + 2), "dx");

  // r1 × m0 and r0 × m1 land at bit 16; what they carry above it is discarded,
  // which is what "modulo 2^32" means.
  asm.movm("ax", abs(mem(rng, 2)));
  asm.unary("mul", "cx");
  asm.aluMR("add", abs(acc + 2), "ax");
  asm.movi("cx", MUL_HIGH);
  asm.movm("ax", abs(mem(rng, 0)));
  asm.unary("mul", "cx");
  asm.aluMR("add", abs(acc + 2), "ax");

  asm.aluMI("add", abs(acc), ADD_LOW);
  asm.aluMI("adc", abs(acc + 2), ADD_HIGH);
  copy32(ctx, rng, acc);
  asm.ret();
}
