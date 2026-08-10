/**
 * Expressions become straight-line 65816.
 *
 * The same three properties the other backends get, for the same reasons
 * (constants fold, comparisons never build a number, a property read is an
 * address rather than a copy) — and every decision about *which* of those applies
 * is `shape.ts`'s, so no two backends can disagree about what an expression
 * means. What is here is only how it is spelled.
 *
 * One difference is worth naming. On the 6502 an entity behind a pointer is
 * reached with `($nn),y` and a byte at a time, so a property of it costs four
 * indexed loads through page zero. Here the index registers are sixteen bits and
 * `$nnnn,x` reaches all of bank zero, so the record's *address* goes in `X` and a
 * property is `lda $0000+offset,x` — two loads for four bytes, and no pointer
 * anywhere. `X` is reloaded per access rather than kept live, because a rule body
 * between two accesses uses every register there is.
 */

import { imm16, type Ref } from "@demake/core";

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

import type { SnesCtx } from "./ctx.js";
import {
  add32,
  addConst32,
  asr32,
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
import { absX, DP, mem } from "./ops.js";

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
export function copyFromPtr(ctx: SnesCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.ldx(mem(ptr));
  asm.lda(absX(offset));
  asm.sta(mem(dst));
  asm.lda(absX(offset + 2));
  asm.sta(mem(dst, 2));
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: SnesCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.ldx(mem(ptr));
  asm.lda(mem(src));
  asm.sta(absX(offset));
  asm.lda(mem(src, 2));
  asm.sta(absX(offset + 2));
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: SnesCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: SnesCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: SnesCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: SnesCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: SnesCtx,
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

function emitCall(
  ctx: SnesCtx,
  expr: CExpr & { kind: "call" },
  bind: Binding,
  into?: number,
): Slot {
  const { asm } = ctx;
  const target = into ?? ctx.pushTemp();
  const args = expr.args;

  switch (expr.fn) {
    case "abs": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      const done = ctx.unique("absDone");
      asm.lda(mem(target, 2));
      ctx.far("pl", done);
      neg32(ctx, target);
      asm.label(done);
      break;
    }
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
      ctx.call(ctx.need("RngPick", emitRngPick));
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
  ctx: SnesCtx,
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
  ctx: SnesCtx,
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
 */
function emitRngPick(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  // The count and the low bound outlive the call to `Mod16`, so they live in the
  // helper scratch rather than in registers that routine wants.
  const count = DP.saved;
  const bound = DP.count;
  const low = ctx.unique("rngLow");
  const store = ctx.unique("rngStore");

  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds. At the top of
  // the routine nothing is live yet, so the call costs no saves.
  ctx.call(ctx.need("RngAdvance", emitRngAdvance));

  // count = floor(hi) - floor(lo), in whole cells, then one more for the span.
  asm.lda(mem(lo, 2));
  asm.sta(mem(bound));
  asm.sec();
  asm.lda(mem(hi, 2));
  asm.sbc(mem(bound));
  asm.sta(mem(count));
  // A count of zero or less means the bounds met or crossed: the low bound is the
  // answer, and the subtraction's own flags say which without a reload.
  // Note the advance has already happened; `rng.ts`'s `draw` does it either way.
  ctx.far("mi", low);
  ctx.far("eq", low);
  asm.inc(mem(count));

  // The draw is the generator's high half, modulo the count.
  asm.lda(mem(rng, 2));
  asm.sta(mem(DP.t2));
  ctx.call(ctx.need("Mod16", emitMod16));
  asm.clc();
  asm.lda(mem(DP.t2));
  asm.adc(mem(bound));
  asm.sta(mem(DP.t2));
  asm.jmp(store);

  asm.label(low);
  asm.lda(mem(bound));
  asm.sta(mem(DP.t2));
  asm.label(store);
  asm.stz(mem(lo));
  asm.lda(mem(DP.t2));
  asm.sta(mem(lo, 2));
  ctx.ret();
}

/** `rng = rng * 1664525 + 1013904223`, modulo 2^32. */
function emitRngAdvance(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng as number;
  const acc = layout.mathWork; // 4 bytes
  const term = layout.mathWork + 4; // 4 bytes
  const multiplier = layout.mathWork + 8; // 4 bytes
  const MUL = 1664525;
  const ADD = 1013904223;

  copy32(ctx, term, rng);
  set32(ctx, acc, 0);
  set32(ctx, multiplier, MUL);

  const loop = ctx.unique("lcgLoop");
  const noAdd = ctx.unique("lcgNoAdd");
  const done = ctx.unique("lcgDone");
  asm.label(loop);
  asm.lda(mem(multiplier));
  asm.ora(mem(multiplier, 2));
  ctx.far("eq", done);
  asm.lda(mem(multiplier));
  asm.and(imm16(1));
  ctx.far("eq", noAdd);
  add32(ctx, acc, term);
  asm.label(noAdd);
  asm.asl(mem(term));
  asm.rol(mem(term, 2));
  asm.lsr(mem(multiplier, 2));
  asm.ror(mem(multiplier));
  asm.jmp(loop);
  asm.label(done);
  addConst32(ctx, acc, ADD);
  copy32(ctx, rng, acc);
  ctx.ret();
}

/**
 * `t2 = t2 mod saved`, unsigned, by restoring division.
 *
 * Sixteen bits is enough: the value is the generator's high half and the count is
 * a span in cells, so neither can exceed a word. The quotient grows into `t2` as
 * the dividend shifts out of it, and the remainder — which is the answer — is in
 * the accumulator the whole way.
 */
function emitMod16(ctx: SnesCtx): void {
  const { asm } = ctx;
  const value = DP.t2;
  const divisor = DP.saved;
  const loop = ctx.unique("modLoop");
  const next = ctx.unique("modNext");
  const subtract = ctx.unique("modSub");
  const done = ctx.unique("modDone");

  asm.lda(mem(divisor));
  asm.beq(done);
  asm.ldx(imm16(16));
  asm.lda(imm16(0));
  asm.label(loop);
  asm.asl(mem(value));
  asm.rol();
  // The carry out of the rotate is the seventeenth bit of the remainder, which a
  // word cannot hold — and it always means the divisor fits.
  asm.bcs(subtract);
  asm.cmp(mem(divisor));
  asm.bcc(next);
  asm.label(subtract);
  asm.sec();
  asm.sbc(mem(divisor));
  asm.inc(mem(value));
  asm.label(next);
  asm.dex();
  ctx.far("ne", loop);
  asm.sta(mem(value));
  asm.label(done);
  ctx.ret();
}
