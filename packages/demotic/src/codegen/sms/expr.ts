/**
 * Expressions become straight-line Z80.
 *
 * The same three properties the other two backends get, for the same reasons
 * (constants fold, comparisons never build a number, a property read is an
 * address rather than a copy) — and every decision about *which* of those applies
 * is `shape.ts`'s, so no two backends can disagree about what an expression
 * means. What is here is only how it is spelled.
 *
 * Two things this CPU spells better than either of the others:
 *
 *   - **A pointer dereference is a register pair.** The 6502 has to write an
 *     address into page zero before a routine can follow it and the SM83 has to
 *     funnel it through `hl`; here `ld hl,(ptr)` loads the entity base and `ldir`
 *     copies the four bytes, so reading a property through `self` is fifteen
 *     bytes rather than twelve instructions.
 *   - **The generator's modulo is sixteen bits at a time.** `add hl,hl` and
 *     `adc hl,hl` shift a value and a remainder in one instruction each, so
 *     `Mod16` is a twenty-one-byte loop against the 6502's byte-at-a-time
 *     version — and `djnz` counts it without touching a flag.
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

import type { SmsCtx } from "./ctx.js";
import { S } from "./scratch.js";
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

/** Load `hl` with the address a pointer holds, offset into the record. */
function pointerTo(ctx: SmsCtx, ptr: number, offset: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", ptr);
  if (offset !== 0) {
    asm.ld16("bc", offset);
    asm.addHL("bc");
  }
}

/** Copy four bytes from `[ptr] + offset` to an absolute address. Clobbers `bc`. */
export function copyFromPtr(ctx: SmsCtx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  pointerTo(ctx, ptr, offset);
  asm.ld16("de", dst);
  asm.ld16("bc", 4);
  asm.ldir();
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. Clobbers `bc`. */
export function copyToPtr(ctx: SmsCtx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  pointerTo(ctx, ptr, offset);
  asm.exDEHL();
  asm.ld16("hl", src);
  asm.ld16("bc", 4);
  asm.ldir();
}

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: SmsCtx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: SmsCtx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: SmsCtx, entity: EntityAddr, prop: string, value: Ref): void {
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
export function emitExpr(ctx: SmsCtx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: SmsCtx,
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
    ctx.asm.jp(done);
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

function emitCall(ctx: SmsCtx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
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
  ctx: SmsCtx,
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
  ctx: SmsCtx,
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
function emitRngPick(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  // The bound and the count outlive the call to `Mod16`, which uses the other
  // half of the same block — which is why the two are numbered rather than named
  // after what they hold.
  const bound = layout.scratch + S.w0;
  const count = layout.scratch + S.w1;
  const low = ctx.unique("rngLow");
  const store = ctx.unique("rngStore");

  // The generator advances first, and unconditionally — `rng.ts`'s `draw` is the
  // definition, and the advance is not conditional on the bounds. At the top of
  // the routine nothing is live yet, so the call costs no saves.
  asm.call(ctx.need("RngAdvance", emitRngAdvance));

  // count = floor(hi) - floor(lo), in whole cells, and then one more.
  asm.ld16From("hl", mem(lo, 2));
  asm.st16To(bound, "hl");
  asm.ld16From("de", mem(hi, 2));
  asm.exDEHL();
  asm.aluN("or", 0);
  asm.sbcHL("de");
  // A count of zero or less means the bounds met or crossed: the low bound is
  // the answer.
  ctx.far("m", low);
  asm.ld("a", "h");
  asm.alu("or", "l");
  ctx.far("z", low);
  asm.inc16("hl");
  asm.st16To(count, "hl");

  // The draw is the generator's high half, modulo the count.
  asm.ld16From("hl", mem(rng, 2));
  asm.ld16From("de", count);
  asm.call(ctx.need("Mod16", emitMod16));
  asm.ld16From("de", bound);
  asm.addHL("de");
  asm.jp(store);

  asm.label(low);
  asm.ld16From("hl", bound);
  asm.label(store);
  asm.ld16("de", 0);
  asm.st16To(mem(lo, 0), "de");
  asm.st16To(mem(lo, 2), "hl");
  asm.ret();
}

/** `rng = rng * 1664525 + 1013904223`, modulo 2^32. */
function emitRngAdvance(ctx: SmsCtx): void {
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
  asm.ld16From("hl", multiplier);
  asm.ld("a", "h");
  asm.alu("or", "l");
  asm.ld16From("hl", mem(multiplier, 2));
  asm.alu("or", "h");
  asm.alu("or", "l");
  ctx.far("z", done);
  asm.lda(multiplier);
  asm.aluN("and", 1);
  ctx.far("z", noAdd);
  add32(ctx, acc, term);
  asm.label(noAdd);
  shiftLeft32(ctx, term);
  shiftRight32(ctx, multiplier);
  asm.jp(loop);
  asm.label(done);
  addConst32(ctx, acc, ADD);
  copy32(ctx, rng, acc);
  asm.ret();
}

/** `addr <<= 1`, four bytes. */
function shiftLeft32(ctx: SmsCtx, addr: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr);
  asm.shift("sla", "hlp");
  for (let index = 1; index < 4; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
}

/** `addr >>= 1`, four bytes, logical. */
function shiftRight32(ctx: SmsCtx, addr: number): void {
  const { asm } = ctx;
  asm.ld16("hl", addr + 3);
  asm.shift("srl", "hlp");
  for (let index = 2; index >= 0; index -= 1) {
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
}

/**
 * `hl = hl mod de`, unsigned, by restoring division.
 *
 * Sixteen bits is enough: the value is the generator's high half and the count
 * is a span in cells, so neither can exceed a word. `add hl,hl` shifts the
 * dividend and `adc hl,hl` shifts the remainder with the bit that left it — two
 * instructions where the 6502 needs four, and `djnz` counts the sixteen
 * iterations without touching a flag the loop depends on.
 */
function emitMod16(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const value = layout.scratch + S.w2;
  const divisor = layout.scratch + S.w3;
  const loop = ctx.unique("modLoop");
  const keep = ctx.unique("modKeep");
  const out = ctx.unique("modOut");

  asm.ld("a", "d");
  asm.alu("or", "e");
  ctx.far("z", out); // a zero divisor leaves the value alone
  asm.st16To(value, "hl");
  asm.st16To(divisor, "de");
  asm.ld16("hl", 0); // the remainder
  asm.ldn("b", 16);
  asm.label(loop);
  asm.push("hl");
  asm.ld16From("hl", value);
  asm.addHL("hl"); // value <<= 1; the bit that leaves is the carry
  asm.st16To(value, "hl");
  asm.pop("hl"); // neither the push, the loads nor the pop touches the carry
  asm.adcHL("hl"); // remainder = remainder * 2 + that bit
  asm.ld16From("de", divisor);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  asm.jr(keep, "nc");
  asm.addHL("de"); // it did not fit: put it back
  asm.label(keep);
  asm.djnz(loop);
  asm.label(out);
  asm.ret();
}
