/**
 * Expressions become straight-line SM83.
 *
 * The interpreter walked a postfix bytecode with an explicit stack; a rule that
 * read one property paid a dispatch, a push and a pop for it. Here an
 * expression is compiled once, against addresses that are constants, and the
 * arithmetic is emitted in place.
 *
 * Three things fall out of doing it at compile time, and they matter more than
 * the dispatch saving:
 *
 *   - **Constants fold.** `when always` is the literal 1, so a rule guarded by
 *     it emits no test at all. `screenheight - 1` was folded by the front end;
 *     anything the front end left is folded here.
 *   - **Comparisons never build a number.** A relational operator feeding a
 *     branch — which is every guard, every predicate trigger, every `if` —
 *     lowers to a subtraction and a conditional jump. The 16.16 one-or-zero
 *     only appears when a rule genuinely stores a boolean.
 *   - **A property read is an address, not a copy.** `emit` returns where a
 *     value *is*, so adding a property to a temporary reads the entity record
 *     directly. Copies happen only when something must be modified.
 */

import type { Ref } from "@demake/core";

import type { CBinaryOp, CExpr } from "../program.js";

import type { Ctx } from "./ctx.js";
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
} from "./shape.js";
import {
  add32,
  addConst32,
  asr32,
  clamp32,
  copy32,
  div32,
  equal32,
  isZero32,
  less32,
  mul32,
  neg32,
  ONE,
  set32,
  sub32,
} from "./val.js";

/** Copy four bytes from `[ptr] + offset` to an absolute address. */
export function copyFromPtr(ctx: Ctx, ptr: number, offset: number, dst: Ref): void {
  const { asm } = ctx;
  asm.lda(ptr);
  asm.ld("l", "a");
  asm.lda(ptr + 1);
  asm.ld("h", "a");
  if (offset !== 0) {
    asm.ld16("de", offset);
    asm.addHL("de");
  }
  asm.ld16("de", dst);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.staDE();
    if (index < 3) asm.inc16("de");
  }
}

/** Copy four bytes from an absolute address to `[ptr] + offset`. */
export function copyToPtr(ctx: Ctx, ptr: number, offset: number, src: Ref): void {
  const { asm } = ctx;
  asm.lda(ptr);
  asm.ld("e", "a");
  asm.lda(ptr + 1);
  asm.ld("d", "a");
  if (offset !== 0) {
    asm.ld("h", "d");
    asm.ld("l", "e");
    asm.ld16("de", offset);
    asm.addHL("de");
    asm.ld("d", "h");
    asm.ld("e", "l");
  }
  asm.ld16("hl", src);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.staDE();
    if (index < 3) asm.inc16("de");
  }
}

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

/** Read a stored property into a slot, without copying where possible. */
function readStored(ctx: Ctx, entity: EntityAddr, prop: string): Slot {
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
export function readProp(ctx: Ctx, entity: EntityAddr, prop: string): Slot {
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
export function writeProp(ctx: Ctx, entity: EntityAddr, prop: string, value: Ref): void {
  if (entity.kind === "none") return;
  // The interpreter clamps on write, so the value is clamped in the staging
  // slot it already owns rather than copied first.
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
export function emitExpr(ctx: Ctx, expr: CExpr, bind: Binding, into?: number): Slot {
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
  ctx: Ctx,
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
    ctx.asm.jr(done);
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

function emitCall(ctx: Ctx, expr: CExpr & { kind: "call" }, bind: Binding, into?: number): Slot {
  const { asm } = ctx;
  const target = into ?? ctx.pushTemp();
  const args = expr.args;

  switch (expr.fn) {
    case "abs": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      const done = ctx.unique("absDone");
      asm.lda(target + 3);
      asm.bit(7, "a");
      asm.jr(done, "z");
      neg32(ctx, target);
      asm.label(done);
      break;
    }
    case "min":
    case "max": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      const other = ctx.scoped(() => emitExpr(ctx, args[1] as CExpr, bind));
      const keep = ctx.unique("pickKeep");
      less32(ctx, target, other.addr);
      // `min` keeps the left when it is smaller; `max` keeps it when it is not.
      asm.jr(keep, expr.fn === "min" ? "c" : "nc");
      copy32(ctx, target, other.addr);
      asm.label(keep);
      break;
    }
    case "clamp": {
      emitExpr(ctx, args[0] as CExpr, bind, target);
      ctx.scoped(() => {
        const low = emitExpr(ctx, args[1] as CExpr, bind);
        const aboveLow = ctx.unique("clampLow");
        less32(ctx, target, low.addr);
        asm.jr(aboveLow, "nc");
        copy32(ctx, target, low.addr);
        asm.label(aboveLow);
      });
      ctx.scoped(() => {
        const high = emitExpr(ctx, args[2] as CExpr, bind);
        const belowHigh = ctx.unique("clampHigh");
        less32(ctx, high.addr, target);
        asm.jr(belowHigh, "nc");
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
  ctx: Ctx,
  op: CBinaryOp,
  leftExpr: CExpr,
  rightExpr: CExpr,
  bind: Binding,
  target: string,
  invert: boolean,
): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const left = emitExpr(ctx, leftExpr, bind);
    const right = ctx.scoped(() => emitExpr(ctx, rightExpr, bind));
    switch (op) {
      case "=":
        equal32(ctx, left.addr, right.addr);
        asm.jp(target, invert ? "nz" : "z");
        break;
      case "!=":
        equal32(ctx, left.addr, right.addr);
        asm.jp(target, invert ? "z" : "nz");
        break;
      case "<":
        less32(ctx, left.addr, right.addr);
        asm.jp(target, invert ? "nc" : "c");
        break;
      case ">":
        less32(ctx, right.addr, left.addr);
        asm.jp(target, invert ? "nc" : "c");
        break;
      case "<=":
        // `a <= b` is `!(b < a)`.
        less32(ctx, right.addr, left.addr);
        asm.jp(target, invert ? "c" : "nc");
        break;
      case ">=":
        less32(ctx, left.addr, right.addr);
        asm.jp(target, invert ? "c" : "nc");
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
export function emitTest(ctx: Ctx, expr: CExpr, bind: Binding, falseTarget: string): TestVerdict {
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
    isZero32(ctx, value.addr);
    ctx.asm.jp(falseTarget, "z");
  });
  return "runtime";
}

/**
 * The game's generator, drawn from `mathA`..`mathB` into `mathA`.
 *
 * A 32-bit LCG with Numerical Recipes' constants, reproduced bit for bit from
 * `rng.ts`. It is part of the language, not a convenience: two implementations
 * that disagree about it cannot be compared at all. The low bits of an LCG
 * cycle short, so a draw comes from the high half.
 */
function emitRngPick(ctx: Ctx): void {
  const { asm, layout } = ctx;
  const rng = layout.rng;
  if (rng === null) throw new Error("random() without a generator allocated");
  const lo = layout.mathA;
  const hi = layout.mathB;
  const low = ctx.unique("rngLow");
  const store = ctx.unique("rngStore");

  // count = floor(hi) - floor(lo) + 1, in whole cells.
  asm.lda(hi + 2);
  asm.ld("c", "a");
  asm.lda(hi + 3);
  asm.ld("b", "a");
  asm.lda(lo + 2);
  asm.ld("e", "a");
  asm.lda(lo + 3);
  asm.ld("d", "a");
  asm.ld("a", "c");
  asm.alu("sub", "e");
  asm.ld("l", "a");
  asm.ld("a", "b");
  asm.alu("sbc", "d");
  asm.ld("h", "a");
  asm.bit(7, "h");
  asm.jr(low, "nz");
  asm.ld("a", "h");
  asm.alu("or", "l");
  asm.jr(low, "z");
  asm.inc16("hl");
  asm.push("de");
  asm.push("hl");
  asm.call(ctx.need("RngAdvance", emitRngAdvance));
  asm.pop("bc"); // the count
  asm.lda(rng + 2);
  asm.ld("l", "a");
  asm.lda(rng + 3);
  asm.ld("h", "a");
  asm.call(ctx.need("ModHLBC", emitModHLBC));
  asm.pop("de"); // the low bound, which the modulo clobbered
  asm.addHL("de");
  asm.jr(store);
  asm.label(low);
  asm.ld("h", "d");
  asm.ld("l", "e");
  asm.label(store);
  asm.alu("xor", "a");
  asm.sta(lo);
  asm.sta(lo + 1);
  asm.ld("a", "l");
  asm.sta(lo + 2);
  asm.ld("a", "h");
  asm.sta(lo + 3);
  asm.ret();
}

/** `rng = rng * 1664525 + 1013904223`, modulo 2^32. */
function emitRngAdvance(ctx: Ctx): void {
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
  isZero32(ctx, multiplier);
  asm.jr(done, "z");
  asm.lda(multiplier);
  asm.aluN("and", 1);
  asm.jr(noAdd, "z");
  add32(ctx, acc, term);
  asm.label(noAdd);
  asm.ld16("hl", term);
  asm.shift("sla", "hlp");
  for (let index = 0; index < 3; index += 1) {
    asm.inc16("hl");
    asm.shift("rl", "hlp");
  }
  asm.ld16("hl", multiplier + 3);
  asm.shift("srl", "hlp");
  for (let index = 0; index < 3; index += 1) {
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
  asm.jr(loop);
  asm.label(done);
  addConst32(ctx, acc, ADD);
  copy32(ctx, rng, acc);
  asm.ret();
}

/** `hl = hl mod bc`, unsigned, by restoring division. */
function emitModHLBC(ctx: Ctx): void {
  const { asm } = ctx;
  const loop = ctx.unique("modLoop");
  const skip = ctx.unique("modSkip");
  asm.ld("a", "b");
  asm.alu("or", "c");
  asm.ret("z");
  asm.ldn("d", 0);
  asm.ldn("e", 0);
  asm.ldn("a", 16);
  asm.label(loop);
  asm.push("af");
  asm.addHL("hl");
  asm.shift("rl", "e");
  asm.shift("rl", "d");
  asm.ld("a", "e");
  asm.alu("sub", "c");
  asm.ld("a", "d");
  asm.alu("sbc", "b");
  asm.jr(skip, "c");
  asm.ld("a", "e");
  asm.alu("sub", "c");
  asm.ld("e", "a");
  asm.ld("a", "d");
  asm.alu("sbc", "b");
  asm.ld("d", "a");
  asm.label(skip);
  asm.pop("af");
  asm.dec("a");
  asm.jr(loop, "nz");
  asm.ld("h", "d");
  asm.ld("l", "e");
  asm.ret();
}
