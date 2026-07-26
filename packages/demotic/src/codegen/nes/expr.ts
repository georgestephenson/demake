/**
 * Expressions become straight-line 6502.
 *
 * The same three properties the Game Boy backend gets, for the same reasons
 * (constants fold, comparisons never build a number, a property read is an
 * address rather than a copy) — and every decision about *which* of those applies
 * is `shape.ts`'s, so the two backends cannot disagree about what an expression
 * means. What is here is only how it is spelled.
 *
 * One difference is worth naming. On the SM83 a property of an entity reached
 * through a pointer costs a four-byte copy into a temporary, because the
 * instruction set cannot use `[hl]` as an ALU operand and an address at the same
 * time. Here `($nn),y` reads a pointer's byte directly, so the copy exists for
 * the same reason it does there — the caller wants an *address* it can hand to
 * the arithmetic — rather than because the CPU forced it.
 */

import { imm, indY, type Ref } from "@demake/core";

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

import type { NesCtx } from "./ctx.js";
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
import { mem, ZP } from "./zp.js";

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
export function copyFromPtr(ctx: NesCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  for (let index = 0; index < 4; index += 1) {
    asm.ldy(imm(offset + index));
    asm.lda(indY(ptr));
    asm.sta(mem(dst, index));
  }
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: NesCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  for (let index = 0; index < 4; index += 1) {
    asm.lda(mem(src, index));
    asm.ldy(imm(offset + index));
    asm.sta(indY(ptr));
  }
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: NesCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: NesCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: NesCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: NesCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: NesCtx,
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

function emitCall(ctx: NesCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
  const { asm } = ctx;
  const target = into ?? ctx.pushTemp();
  const args = expr.args;

  switch (expr.fn) {
    case "abs": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      const done = ctx.unique("absDone");
      asm.lda(mem(target, 3));
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
 * `invert` swaps the sense, which is what lets a caller ask for "jump when false"
 * and get the same code with one flag changed.
 */
export function emitCompare(
  ctx: NesCtx,
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
  ctx: NesCtx,
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
function emitRngPick(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  // The count and the low bound outlive the call to `RngAdvance`, so they live in
  // the helper scratch rather than in registers this CPU does not have.
  const count = ZP.saved;
  const bound = ZP.count;
  const low = ctx.unique("rngLow");
  const store = ctx.unique("rngStore");

  // count = floor(hi) - floor(lo) + 1, in whole cells.
  asm.lda(mem(lo, 2));
  asm.sta(mem(bound));
  asm.lda(mem(lo, 3));
  asm.sta(mem(bound, 1));
  asm.sec();
  asm.lda(mem(hi, 2));
  asm.sbc(mem(bound));
  asm.sta(mem(count));
  asm.lda(mem(hi, 3));
  asm.sbc(mem(bound, 1));
  asm.sta(mem(count, 1));
  // A count of zero or less means the bounds crossed: the low bound is the answer.
  ctx.far("mi", low);
  asm.lda(mem(count));
  asm.ora(mem(count, 1));
  ctx.far("eq", low);
  asm.inc(mem(count));
  const noCarry = ctx.unique("rngNoCarry");
  asm.bne(noCarry);
  asm.inc(mem(count, 1));
  asm.label(noCarry);

  asm.jsr(ctx.need("RngAdvance", emitRngAdvance));
  // The draw is the generator's high half, modulo the count.
  asm.lda(mem(rng, 2));
  asm.sta(mem(ZP.t2));
  asm.lda(mem(rng, 3));
  asm.sta(mem(ZP.t3));
  asm.jsr(ctx.need("Mod16", emitMod16));
  asm.clc();
  asm.lda(mem(ZP.t2));
  asm.adc(mem(bound));
  asm.sta(mem(ZP.t2));
  asm.lda(mem(ZP.t3));
  asm.adc(mem(bound, 1));
  asm.sta(mem(ZP.t3));
  asm.jmp(store);

  asm.label(low);
  asm.lda(mem(bound));
  asm.sta(mem(ZP.t2));
  asm.lda(mem(bound, 1));
  asm.sta(mem(ZP.t3));
  asm.label(store);
  asm.lda(imm(0));
  asm.sta(mem(lo, 0));
  asm.sta(mem(lo, 1));
  asm.lda(mem(ZP.t2));
  asm.sta(mem(lo, 2));
  asm.lda(mem(ZP.t3));
  asm.sta(mem(lo, 3));
  asm.rts();
}

/** `rng = rng * 1664525 + 1013904223`, modulo 2^32. */
function emitRngAdvance(ctx: NesCtx): void {
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
  asm.lda(mem(multiplier, 0));
  for (let index = 1; index < 4; index += 1) asm.ora(mem(multiplier, index));
  ctx.far("eq", done);
  asm.lda(mem(multiplier, 0));
  asm.and(imm(1));
  ctx.far("eq", noAdd);
  add32(ctx, acc, term);
  asm.label(noAdd);
  asm.asl(mem(term, 0));
  for (let index = 1; index < 4; index += 1) asm.rol(mem(term, index));
  asm.lsr(mem(multiplier, 3));
  for (let index = 2; index >= 0; index -= 1) asm.ror(mem(multiplier, index));
  asm.jmp(loop);
  asm.label(done);
  addConst32(ctx, acc, ADD);
  copy32(ctx, rng, acc);
  asm.rts();
}

/**
 * `t2:t3 = t2:t3 mod saved`, unsigned, by restoring division.
 *
 * Sixteen bits is enough: the value is the generator's high half and the count is
 * a span in cells, so neither can exceed a word.
 */
function emitMod16(ctx: NesCtx): void {
  const { asm } = ctx;
  const value = ZP.t2;
  const divisor = ZP.saved;
  const rem = ZP.t0;
  const loop = ctx.unique("modLoop");
  const skip = ctx.unique("modSkip");

  asm.lda(mem(divisor));
  asm.ora(mem(divisor, 1));
  const go = ctx.unique("modGo");
  asm.bne(go);
  asm.rts();
  asm.label(go);
  asm.lda(imm(0));
  asm.sta(mem(rem));
  asm.sta(mem(rem, 1));
  asm.ldx(imm(16));
  asm.label(loop);
  asm.asl(mem(value));
  asm.rol(mem(value, 1));
  asm.rol(mem(rem));
  asm.rol(mem(rem, 1));
  asm.sec();
  asm.lda(mem(rem));
  asm.sbc(mem(divisor));
  asm.sta(mem(ZP.spare));
  asm.lda(mem(rem, 1));
  asm.sbc(mem(divisor, 1));
  asm.bcc(skip);
  asm.sta(mem(rem, 1));
  asm.lda(mem(ZP.spare));
  asm.sta(mem(rem));
  asm.label(skip);
  asm.dex();
  ctx.far("ne", loop);
  // The quotient grew into `value`; the remainder is the answer.
  asm.lda(mem(rem));
  asm.sta(mem(value));
  asm.lda(mem(rem, 1));
  asm.sta(mem(value, 1));
  asm.rts();
}
