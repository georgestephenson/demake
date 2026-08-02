/**
 * The tick, compiled for ARM.
 *
 * `sim.ts` is the specification and this is a conformance implementation of it,
 * the same way the other five backends are. The *order* of the steps is not here
 * at all — `emitTickSteps` runs them (see `codegen/backend.ts`) — and every
 * decision about which rule can fire where is `shape.ts`'s. What is left is this
 * machine's instructions, and four places where they are shaped differently from
 * the 68000's:
 *
 *   - **A box is one `ldm` and one `stm`.** Four words in, four words out, with
 *     no loop and no post-increment chain — so staging a collision box costs two
 *     instructions rather than four, which matters because a bullet against nine
 *     aliens stages one twenty-seven times a tick.
 *   - **The cell an object sits in is a signed halfword load.** `ldrsh` at offset
 *     two *is* the whole-cell part of a little-endian 16.16 value, signed, in one
 *     instruction — so the cheap "is it anywhere near" tests need no shift and no
 *     widening. The Mega Drive says offset zero because it is big-endian; the
 *     difference is the byte order and not a mistake.
 *   - **A predicate routine answers in `r0` and sets the flags itself**, because
 *     `movs` is a `mov` that does. There is nothing between the return and the
 *     caller's branch that could disturb them: `pop`/`bx` write no flags.
 *   - **A short conditional is predicated rather than branched.** `subs`/`bpl`
 *     pairs survive where the answer is a jump, but a two-instruction body — a
 *     clamp, an absolute value, a conditional move — has no label at all.
 */

import { armAt, armAtIdx, armImm, armReg, fitsArmImm, label, type Ref } from "@demake/core";

import { fromInt, ONE as FIXED_ONE } from "../../fixed.js";
import type { CAssignment, ControlDef, Edge, InstanceDef, RuleDef } from "../../program.js";
import { ACTIONS } from "../../program.js";
import { isMutable } from "../analyze.js";
import { PROP_SIZE } from "../layout.js";
import {
  boundMax,
  clampConst,
  entityOf,
  inScene,
  nearMargins,
  perTick,
  ruleInScene,
  sceneIndexOf,
  subjectBindings,
  type Binding,
  type EntityAddr,
  type SceneCtx,
} from "../shape.js";

import type { GbaCtx } from "./ctx.js";
import {
  copyFromPtr,
  copyToPtr,
  emitExpr,
  emitTest,
  fold,
  propOffset,
  readProp,
  resolveEntity,
  UNBOUND,
  writeProp,
} from "./expr.js";
import { A0, A1, A2, A3, ADDR, LR, PC, V0 } from "./regs.js";
import {
  abs32,
  add32,
  addConst32,
  at,
  branchLess32,
  branchUnlessConst32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  imm,
  loadHalf,
  loadHalfSigned,
  mem,
  mul32,
  neg32,
  set32,
  storeHalf,
  sub32,
  type Val,
} from "./val.js";

export type { SceneCtx };

/**
 * Where a 16.16 value's whole-cell part is.
 *
 * Two, because this machine stores the low half first — and because `ldrsh` at
 * that offset is the signed cell in a single instruction, which is what makes
 * the near tests and the tile-cell reads free. The Mega Drive says zero for the
 * same reason in the other direction; the difference is deliberate.
 */
export const CELL_OFFSET = 2;

/** Named words in `layout.scratch`, which is eight bytes on every console. */
export const S = { w0: 0, w1: 2, w2: 4, w3: 6 } as const;

/** Load a byte and set the flags from it. */
function loadByte(ctx: GbaCtx, address: number): void {
  ctx.asm.ldrb(A0, mem(ctx, address));
  ctx.asm.cmp(A0, armImm(0));
}

/** Store a byte constant. */
function storeByte(ctx: GbaCtx, address: number, value: number): void {
  ctx.asm.movImm32(A0, value & 0xff);
  ctx.asm.strb(A0, mem(ctx, address));
}

/** The whole-cell part of a 16.16 value in work RAM, signed, into `reg`. */
function cellAt(ctx: GbaCtx, reg: number, address: number): void {
  loadHalfSigned(ctx, reg, address + CELL_OFFSET);
}

/** Compare a register against a count, whether or not it is an ARM immediate. */
function cmpCount(ctx: GbaCtx, reg: number, count: number, scratch: number): void {
  if (fitsArmImm(count)) {
    ctx.asm.cmp(reg, armImm(count));
    return;
  }
  ctx.asm.movImm32(scratch, count);
  ctx.asm.cmp(reg, armReg(scratch));
}

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and
 * an object whose `visible` no assignment can reach is decided here rather than
 * every tick.
 */
function guardVisible(ctx: GbaCtx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  branchZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"), skip);
  return "runtime";
}

/** The same, for the record a loop is walking rather than one the compiler named. */
function guardVisiblePtr(ctx: GbaCtx, skip: string): void {
  const { asm, layout } = ctx;
  asm.ldr(A0, mem(ctx, layout.loop as number));
  asm.ldr(A0, armAt(A0, propOffset("visible")));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", skip);
}

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 */
export function emitAssignments(
  ctx: GbaCtx,
  assignments: readonly CAssignment[],
  bind: Binding,
): void {
  if (assignments.length === 0) return;
  const { layout } = ctx;

  interface Staged {
    entity: EntityAddr;
    prop: string;
    slot: number;
    /** A constant the compiler already clamped, needing no runtime work. */
    constant?: number;
  }
  const staged: Staged[] = [];
  let sceneTarget: number | undefined;

  for (const [index, assignment] of assignments.entries()) {
    if (assignment.target.kind === "scene") {
      if (assignment.value.kind === "scene") {
        sceneTarget = sceneIndexOf(ctx.program, assignment.value.scene);
      }
      continue;
    }
    const target = assignment.target;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const prop = target.prop;
    const slot = layout.staging[index] as number;

    if (assignment.value.kind === "flip") {
      // `flip` negates the target's current value, read before any write.
      ctx.scoped(() => {
        const current = readProp(ctx, entity, prop);
        copy32(ctx, slot, current.val);
      });
      neg32(ctx, slot);
      staged.push({ entity, prop, slot });
      continue;
    }

    const constant = fold(assignment.value);
    if (constant !== undefined) {
      staged.push({ entity, prop, slot, constant: clampConst(constant) });
      continue;
    }
    ctx.scoped(() => {
      emitExpr(ctx, assignment.value, bind, slot);
    });
    staged.push({ entity, prop, slot });
  }

  for (const write of staged) {
    if (write.constant !== undefined) {
      // The clamp happened at compile time, so this is one store.
      if (write.entity.kind === "const") {
        set32(ctx, write.entity.base + propOffset(write.prop), write.constant);
      } else {
        set32(ctx, write.slot, write.constant);
        writeProp(ctx, write.entity, write.prop, write.slot);
      }
      continue;
    }
    writeProp(ctx, write.entity, write.prop, write.slot);
  }

  if (sceneTarget !== undefined) storeByte(ctx, layout.pending, sceneTarget);
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 */
function emitFire(ctx: GbaCtx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
  const { asm } = ctx;
  const elseLabel = ctx.unique("ruleElse");
  const done = ctx.unique("ruleDone");
  let branched = false;

  const fallToElse = (): void => {
    if (rule.otherwise && rule.otherwise.length > 0) {
      emitAssignments(ctx, rule.otherwise, bind);
    }
  };

  if (trigger) {
    const verdict = trigger(elseLabel);
    if (verdict === "never") return fallToElse();
    if (verdict === "runtime") branched = true;
  }
  if (rule.guard) {
    const verdict = emitTest(ctx, rule.guard, bind, elseLabel);
    if (verdict === "never") return fallToElse();
    if (verdict === "runtime") branched = true;
  }

  emitSound(ctx, rule);
  emitAssignments(ctx, rule.assignments, bind);
  // A rule body is where a program grows, and the pool that serves it reaches
  // four kilobytes; this is the safe point between one and the next.
  ctx.poolCheck();
  if (!branched) return;
  if (rule.otherwise && rule.otherwise.length > 0) {
    asm.b(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/**
 * Ask for this rule's sound, if it has one.
 *
 * There is no driver on this console yet, so what is emitted is the *record* of
 * the request and nothing else — one byte a trace reads. That is not a stub: a
 * build whose audio could not be played still has to trace identically to one
 * that could (doc 14 §Conformance), and this is where that is kept true.
 */
export function emitSound(ctx: GbaCtx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  if (ctx.audio.driver && index >= 0) storeByte(ctx, ctx.audio.request, index + 1);
  if (ctx.audio.trace !== null) storeByte(ctx, ctx.audio.trace, rule.sound);
}

// --- 2. controls -------------------------------------------------------------

/** Test an abstract button against one of the three input sets. */
function emitButton(ctx: GbaCtx, set: number, action: string, skip: string): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.ldrb(A0, mem(ctx, set));
  ctx.asm.tst(A0, armImm(1 << bit));
  ctx.far("eq", skip);
}

export function emitControls(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  let holdBase = 0;
  for (const control of ctx.program.controls) {
    const base = holdBase;
    if (control.mode === "hold") holdBase += control.assignments.length;
    if (!inScene(ctx.program, scene, control.instanceId)) continue;

    // A control's own object is the fallback target for an unbound assignment,
    // which is what the interpreter's snapshot and restore do.
    const own = entityOf(ctx, control.instanceId);
    const fallback: Binding = { subject: own, other: own };

    if (control.mode === "press" || control.mode === "release") {
      const skip = ctx.unique("ctlSkip");
      emitButton(
        ctx,
        control.mode === "press" ? layout.pressed : layout.released,
        control.action,
        skip,
      );
      emitAssignments(ctx, control.assignments, UNBOUND);
      asm.label(skip);
      continue;
    }

    // `on hold`: snapshot on the press, apply while down, restore on release.
    const noPress = ctx.unique("holdNoPress");
    emitButton(ctx, layout.pressed, control.action, noPress);
    emitSnapshot(ctx, control, fallback, base);
    asm.label(noPress);

    const noHold = ctx.unique("holdNoHold");
    emitButton(ctx, layout.held, control.action, noHold);
    emitAssignments(ctx, control.assignments, UNBOUND);
    asm.label(noHold);

    const noRelease = ctx.unique("holdNoRelease");
    emitButton(ctx, layout.released, control.action, noRelease);
    emitRestore(ctx, control, fallback, base);
    asm.label(noRelease);
  }
}

function emitSnapshot(ctx: GbaCtx, control: ControlDef, bind: Binding, base: number): void {
  const { layout } = ctx;
  for (const [index, assignment] of control.assignments.entries()) {
    const target = assignment.target;
    if (target.kind !== "prop") continue;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const slot = layout.holdValues + (base + index) * 4;
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, slot, current.val);
    });
    storeByte(ctx, layout.holdFlags + base + index, 1);
  }
}

function emitRestore(ctx: GbaCtx, control: ControlDef, bind: Binding, base: number): void {
  const { asm, layout } = ctx;
  for (const [index, assignment] of control.assignments.entries()) {
    const target = assignment.target;
    if (target.kind !== "prop") continue;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const skip = ctx.unique("restoreSkip");
    loadByte(ctx, layout.holdFlags + base + index);
    ctx.far("eq", skip);
    storeByte(ctx, layout.holdFlags + base + index, 0);
    const slot = layout.holdValues + (base + index) * 4;
    writeProp(ctx, entity, target.prop, slot);
    asm.label(skip);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  for (const rule of ctx.program.rules) {
    if (rule.event.kind !== "predicate" || !ruleInScene(rule, scene)) continue;
    const test = rule.event.test;
    for (const subject of subjectBindings(ctx, rule, scene)) {
      const skip = ctx.unique("levelSkip");
      let bind: Binding = UNBOUND;
      if (subject !== null) {
        if (guardVisible(ctx, subject, skip) === "never") {
          asm.label(skip);
          continue;
        }
        bind = { subject: entityOf(ctx, subject), other: { kind: "none" } };
      }
      emitFire(ctx, rule, bind, (falseLabel) => emitTest(ctx, test, bind, falseLabel));
      asm.label(skip);
    }
  }
}

// --- 4. integration ----------------------------------------------------------

/**
 * What the integrator compiles a moving object into.
 *
 * Every branch of `emitAxis` is chosen from these, so two objects that answer
 * them identically compile to identical code — which is the whole condition for
 * running them through one loop rather than a copy each.
 */
function moveShape(ctx: GbaCtx, id: number): string {
  const instance = ctx.program.instances[id] as InstanceDef;
  const mutable = (prop: string): string => (isMutable(ctx.analysis, id, prop) ? "m" : "f");
  const fixed = (prop: string): string =>
    isMutable(ctx.analysis, id, prop) ? "" : String(instance.numbers[prop] ?? 0);
  return [
    mutable("speed"),
    fixed("speed"),
    mutable("xdirection"),
    fixed("xdirection"),
    mutable("ydirection"),
    fixed("ydirection"),
    mutable("visible"),
    fixed("visible"),
  ].join(":");
}

export function emitIntegrate(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  const groups = new Map<string, number[]>();
  for (const id of scene.def.instanceIds) {
    const instance = ctx.program.instances[id] as InstanceDef;
    const speedFixed = instance.numbers["speed"] ?? 0;
    if (!isMutable(ctx.analysis, id, "speed") && speedFixed === 0) continue;
    if (!isMutable(ctx.analysis, id, "visible") && (instance.numbers["visible"] ?? 0) === 0) {
      continue;
    }
    const shape = moveShape(ctx, id);
    const group = groups.get(shape);
    if (group) group.push(id);
    else groups.set(shape, [id]);
  }

  for (const ids of groups.values()) {
    if (ids.length >= LOOP_PAIRS && emitMoveLoop(ctx, ids)) continue;
    for (const id of ids) {
      const skip = ctx.unique("intSkip");
      const entity = entityOf(ctx, id);
      const base = ctx.layout.entities[id] as number;
      if (isMutable(ctx.analysis, id, "speed")) {
        branchZero32(ctx, base + propOffset("speed"), skip);
      }
      guardVisible(ctx, id, skip);
      emitAxis(ctx, entity, id, "x", "xdirection");
      emitAxis(ctx, entity, id, "y", "ydirection");
      asm.label(skip);
    }
  }
}

/** One movement body for every object that moves the same way. */
function emitMoveLoop(ctx: GbaCtx, ids: readonly number[]): boolean {
  const { asm } = ctx;
  if (ctx.layout.loop === null) return false;
  const first = ids[0] as number;
  const table = ctx.unique("moveTable");
  const next = ctx.unique("moveNext");
  const entity: EntityAddr = { kind: "ptr", ptr: ctx.layout.loop };

  const loop = emitLoopHead(ctx, table);
  if (isMutable(ctx.analysis, first, "speed")) {
    ctx.scoped(() => {
      const speed = readProp(ctx, entity, "speed");
      if (speed.val.k === "at") branchZero32(ctx, speed.val.addr, next);
    });
  }
  if (isMutable(ctx.analysis, first, "visible")) guardVisiblePtr(ctx, next);
  ctx.scoped(() => {
    emitAxis(ctx, entity, first, "x", "xdirection");
    emitAxis(ctx, entity, first, "y", "ydirection");
  });
  asm.label(next);
  emitLoopNext(ctx, loop, ids.length);

  emitEntityTable(
    ctx,
    table,
    ids.map((id) => ctx.layout.entities[id] as number),
  );
  return true;
}

/**
 * A property this emitter reads *and* writes, wherever the record lives.
 *
 * For an instance the compiler named it is the property's own address and the
 * close is nothing, so the unrolled form is byte-for-byte what it always was.
 */
function openProp(
  ctx: GbaCtx,
  entity: EntityAddr,
  prop: string,
): { addr: number; close: () => void } {
  if (entity.kind === "const") {
    return { addr: entity.base + propOffset(prop), close: () => undefined };
  }
  const temp = ctx.pushTemp();
  if (entity.kind === "ptr") copyFromPtr(ctx, entity.ptr, propOffset(prop), temp);
  else set32(ctx, temp, 0);
  return {
    addr: temp,
    close: () => {
      if (entity.kind === "ptr") copyToPtr(ctx, entity.ptr, propOffset(prop), at(temp));
      ctx.popTemp();
    },
  };
}

function emitAxis(
  ctx: GbaCtx,
  entity: EntityAddr,
  id: number,
  posProp: string,
  dirProp: string,
): void {
  const { asm, profile } = ctx;
  const instance = ctx.program.instances[id] as InstanceDef;

  const dirFixed = instance.numbers[dirProp] ?? 0;
  const speedFixed = instance.numbers["speed"] ?? 0;
  const dirMutable = isMutable(ctx.analysis, id, dirProp);
  const speedMutable = isMutable(ctx.analysis, id, "speed");

  // Nothing on this axis can ever be non-zero.
  if (!dirMutable && dirFixed === 0) return;

  const position = openProp(ctx, entity, posProp);
  const posAddr = position.addr;
  const dirVal = readProp(ctx, entity, dirProp).val;
  const speedVal = readProp(ctx, entity, "speed").val;
  const finish = (): void => position.close();

  if (!dirMutable && !speedMutable) {
    const step = perTick(dirFixed, speedFixed, profile.fps);
    if (step === 0) return finish();
    addConst32(ctx, posAddr, step);
    clamp32(ctx, posAddr);
    return finish();
  }

  const done = ctx.unique("axisDone");
  if (!speedMutable) {
    // Speed is fixed, so the step for a whole direction is a constant: the common
    // case becomes an add, with no multiply and no divide.
    const forward = perTick(FIXED_ONE, speedFixed, profile.fps);
    const backward = perTick(-FIXED_ONE, speedFixed, profile.fps);
    const notForward = ctx.unique("axisNotFwd");
    const notBackward = ctx.unique("axisNotBack");

    if (dirVal.k !== "at") throw new Error("a mutable direction has no address");
    branchUnlessConst32(ctx, dirVal.addr, FIXED_ONE, notForward);
    if (forward !== 0) {
      addConst32(ctx, posAddr, forward);
      clamp32(ctx, posAddr);
    }
    asm.b(done);
    asm.label(notForward);
    branchUnlessConst32(ctx, dirVal.addr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    asm.b(done);
    asm.label(notBackward);
  }

  const skipZero = ctx.unique("axisZero");
  if (dirVal.k !== "at") throw new Error("a mutable direction has no address");
  branchZero32(ctx, dirVal.addr, skipZero);
  ctx.scoped(() => {
    const step = ctx.pushTemp();
    copy32(ctx, step, dirVal);
    // velocity = direction × speed, then step = velocity ÷ fps. Speeds are
    // authored per second precisely so the frame rate enters only here.
    mul32(ctx, step, speedVal);
    div32(ctx, step, imm(fromInt(profile.fps)));
    const noMove = ctx.unique("axisNoMove");
    branchZero32(ctx, step, noMove);
    add32(ctx, posAddr, at(step));
    clamp32(ctx, posAddr);
    asm.label(noMove);
  });
  asm.label(skipZero);
  asm.label(done);
  finish();
}

// --- walking a list of entities ----------------------------------------------

/** Fewest entries worth a loop rather than a copy each. */
const LOOP_PAIRS = 3;

/**
 * Open a loop over a table of record addresses, leaving the cursor set.
 *
 * `layout.loop` is a four-byte pointer and the halfword after it is the index.
 * Both are memory rather than registers because a rule body fires inside the loop
 * and may use every register the machine has.
 */
function emitLoopHead(ctx: GbaCtx, table: string): string {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  const loop = ctx.unique("walkLoop");
  asm.mov(A0, armImm(0));
  storeHalf(ctx, A0, ptr + 4);
  asm.label(loop);
  loadHalf(ctx, A0, ptr + 4);
  asm.ldrConst(A1, label(table));
  // A table entry is a word, so the index scales in the addressing mode.
  asm.ldr(A0, armAtIdx(A1, A0, "lsl", 2));
  asm.str(A0, mem(ctx, ptr));
  return loop;
}

/** Step the cursor and go round again while entries remain. */
function emitLoopNext(ctx: GbaCtx, loop: string, count: number): void {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  loadHalf(ctx, A0, ptr + 4);
  asm.add(A0, A0, armImm(1));
  storeHalf(ctx, A0, ptr + 4);
  cmpCount(ctx, A0, count, A1);
  ctx.far("cc", loop);
}

/** The addresses a loop walks, emitted after the code with the other tables. */
function emitEntityTable(ctx: GbaCtx, table: string, bases: readonly number[]): void {
  ctx.data((data) => {
    data.align(4);
    data.label(table);
    for (const base of bases) data.dw(base);
  });
}

/**
 * `r1` = the contact byte's offset and `r2` = its mask, for the current entry.
 *
 * A contact bit is a compile-time constant in the unrolled form; a loop knows
 * only an index, so the byte and the mask are tables rather than arithmetic. The
 * caller puts the two table addresses in `r1` and `r2`, which this then replaces
 * with what it read out of them.
 */
function needContactSlot(ctx: GbaCtx): Ref {
  return ctx.need("ContactSlot", (inner) => {
    const { asm, layout } = inner;
    loadHalf(inner, A0, (layout.loop as number) + 4);
    asm.ldrb(A3, armAtIdx(A1, A0));
    asm.ldrb(A2, armAtIdx(A2, A0));
    asm.mov(A1, armReg(A3));
    asm.ret();
    asm.ltorg();
  });
}

/** Test or set this entry's contact bit, whose number is only known at run time. */
function emitContactBitPtr(
  ctx: GbaCtx,
  table: string,
  what: "seen" | "set",
  seen?: string,
  edge?: number,
): void {
  const { asm, layout } = ctx;
  const suffix = edge === undefined ? "" : String(edge);
  asm.ldrConst(A1, label(`${table}Byte${suffix}`));
  asm.ldrConst(A2, label(`${table}Mask${suffix}`));
  asm.bl(needContactSlot(ctx));
  asm.movImm32(A0, what === "seen" ? layout.contactsPrev : layout.contacts);
  asm.add(A0, A0, armReg(A1));
  asm.ldrb(A3, armAt(A0));
  if (what === "seen") {
    asm.tst(A3, armReg(A2));
    ctx.far("ne", seen as string);
    return;
  }
  asm.orr(A3, A3, armReg(A2));
  asm.strb(A3, armAt(A0));
}

/** The byte-and-mask tables one contact bit per entry needs. */
function emitContactTables(ctx: GbaCtx, table: string, bits: readonly number[], suffix = ""): void {
  ctx.data((data) => {
    data.label(`${table}Byte${suffix}`);
    data.db(...bits.map((bit) => bit >> 3));
    data.align(4);
    data.label(`${table}Mask${suffix}`);
    data.db(...bits.map((bit) => 1 << (bit & 7)));
    data.align(4);
  });
}

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(
  ctx: GbaCtx,
  entity: EntityAddr,
  edge: Edge,
  scene: SceneCtx,
  skip: string,
): void {
  const read = (prop: string): Val => readProp(ctx, entity, prop).val;

  switch (edge) {
    case "screenleft":
      // x <= 0 is "not (0 < x)".
      ctx.scoped(() => branchLess32(ctx, imm(0), read("x"), skip));
      break;
    case "screentop":
      ctx.scoped(() => branchLess32(ctx, imm(0), read("y"), skip));
      break;
    case "screenright":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, read("x"));
        add32(ctx, temp, read("width"));
        branchLess32(ctx, at(temp), imm(scene.boundsW), skip);
      });
      break;
    case "screenbottom":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, read("y"));
        add32(ctx, temp, read("height"));
        branchLess32(ctx, at(temp), imm(scene.boundsH), skip);
      });
      break;
  }
}

/**
 * Push the subject back inside the playfield. The interpreter does not clamp
 * here, and neither does this.
 */
function emitEdgeSeparate(ctx: GbaCtx, entity: EntityAddr, edge: Edge, scene: SceneCtx): void {
  if (entity.kind === "none") return;
  const axis = edge === "screenleft" || edge === "screenright" ? "x" : "y";
  const span = axis === "x" ? "width" : "height";
  const near = edge === "screenleft" || edge === "screentop";
  const bound = axis === "x" ? scene.boundsW : scene.boundsH;
  if (entity.kind === "const") {
    const addr = entity.base + propOffset(axis);
    if (near) {
      set32(ctx, addr, 0);
      return;
    }
    set32(ctx, addr, bound);
    sub32(ctx, addr, at(entity.base + propOffset(span)));
    return;
  }
  ctx.scoped(() => {
    const temp = ctx.pushTemp();
    if (near) {
      set32(ctx, temp, 0);
    } else {
      set32(ctx, temp, bound);
      sub32(ctx, temp, readProp(ctx, entity, span).val);
    }
    copyToPtr(ctx, entity.ptr, propOffset(axis), at(temp));
  });
}

/**
 * Copy one entity's box into a staging slot.
 *
 * Four words, and on this machine that is *two instructions*: `ldm` and `stm`
 * move a whole box with no loop and no post-increment chain. The source is a
 * different entity each time and arrives in `r1`; the destination is one of two
 * fixed addresses, so it is baked into the routine rather than passed.
 */
function emitStageBox(ctx: GbaCtx, src: number, slot: "a" | "b"): void {
  const { asm } = ctx;
  asm.movImm32(A1, src);
  asm.bl(needCopyBox(ctx, slot));
}

/** The routine that stages a box; it takes the record's address in `r1`. */
function needCopyBox(ctx: GbaCtx, slot: "a" | "b"): Ref {
  const dst = (slot === "a" ? ctx.layout.pairA : ctx.layout.pairB) as number;
  return ctx.need(`CopyBox${slot.toUpperCase()}`, (inner) => {
    const { asm } = inner;
    const regs = [A0, A2, A3, ADDR];
    asm.ldm(A1, regs);
    asm.movImm32(A1, dst);
    asm.stm(A1, regs);
    asm.ret();
    asm.ltorg();
  });
}

/** The same, for the record the loop pointer names. */
function emitStageBoxPtr(ctx: GbaCtx, slot: "a" | "b"): void {
  const { asm, layout } = ctx;
  asm.ldr(A1, mem(ctx, layout.loop as number));
  asm.bl(needCopyBox(ctx, slot));
}

function emitStagePair(ctx: GbaCtx, a: number, b: number): void {
  emitStageBox(ctx, a, "a");
  emitStageBox(ctx, b, "b");
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * `r0` non-zero when the staged boxes overlap, zero when they do not — and the
 * flags say so, because `movs` is a `mov` that sets them.
 *
 * Half-open on both axes, matching the interpreter and matching tile contact.
 */
function needOverlapPair(ctx: GbaCtx): Ref {
  return ctx.need("OverlapPair", (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const b = layout.pairB as number;
    const temp = layout.pairWork as number;
    const apart = inner.unique("olNo");
    for (const [pos, size] of [
      ["x", "width"],
      ["y", "height"],
    ] as const) {
      // a.pos < b.pos + b.size, and b.pos < a.pos + a.size.
      copy32(inner, temp, at(boxProp(b, pos)));
      add32(inner, temp, at(boxProp(b, size)));
      branchLess32(inner, at(boxProp(a, pos)), at(temp), apart, false);
      copy32(inner, temp, at(boxProp(a, pos)));
      add32(inner, temp, at(boxProp(a, size)));
      branchLess32(inner, at(boxProp(b, pos)), at(temp), apart, false);
    }
    asm.movs(A0, armImm(1));
    asm.ret();
    asm.label(apart);
    asm.movs(A0, armImm(0));
    asm.ret();
    asm.ltorg();
  });
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 */
function needSeparatePair(ctx: GbaCtx): Ref {
  return ctx.need("SeparatePair", (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const b = layout.pairB as number;
    const work = layout.pairWork as number;
    const xPush = work;
    const yPush = work + 4;
    const near = work + 8;
    const far = work + 12;

    const axis = (pos: string, size: string, push: number): void => {
      // near = a.pos + a.size - b.pos ; far = b.pos + b.size - a.pos
      copy32(inner, near, at(boxProp(a, pos)));
      add32(inner, near, at(boxProp(a, size)));
      sub32(inner, near, at(boxProp(b, pos)));
      copy32(inner, far, at(boxProp(b, pos)));
      add32(inner, far, at(boxProp(b, size)));
      sub32(inner, far, at(boxProp(a, pos)));
      const takeFar = inner.unique("sepFar");
      const done = inner.unique("sepDone");
      branchLess32(inner, at(near), at(far), takeFar, false);
      copy32(inner, push, at(near));
      neg32(inner, push);
      asm.b(done);
      asm.label(takeFar);
      copy32(inner, push, at(far));
      asm.label(done);
    };

    axis("x", "width", xPush);
    axis("y", "height", yPush);

    // |xPush| < |yPush| decides the axis.
    copy32(inner, near, at(xPush));
    abs32(inner, near);
    copy32(inner, far, at(yPush));
    abs32(inner, far);
    const useY = inner.unique("sepUseY");
    branchLess32(inner, at(near), at(far), useY, false);
    add32(inner, boxProp(a, "x"), at(xPush));
    clamp32(inner, boxProp(a, "x"));
    asm.ret();
    asm.label(useY);
    add32(inner, boxProp(a, "y"), at(yPush));
    clamp32(inner, boxProp(a, "y"));
    asm.ret();
    asm.ltorg();
  });
}

/**
 * `r1` = the other object's record, `r2`/`r3` = the margins in cells → `r0` zero
 * when the two boxes are certainly apart.
 *
 * Like the sprite cull this compares *cells* — one `ldrsh` per coordinate, which
 * on this machine is the whole-cell part of a 16.16 value, signed, in a single
 * instruction. Two boxes can only overlap if their cells are within the wider of
 * the two, so rounding the margin outward by one keeps it conservative: it may
 * say "maybe" when the answer is no, never the reverse.
 */
function needNearBox(ctx: GbaCtx): Ref {
  return ctx.need("NearBox", (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");

    // `r4` rather than `r12`, because reaching a work-RAM address past the base
    // register's window materialises into `r12` — so nothing may be held there
    // across a `mem()`.
    asm.push([V0, LR]);
    const axis = (offset: number, margin: number): void => {
      asm.ldrsh(A0, armAt(A1, offset + CELL_OFFSET));
      cellAt(inner, V0, subject + offset);
      asm.sub(A0, A0, armReg(V0));
      asm.adds(V0, A0, armReg(margin));
      inner.far("mi", apart);
      asm.sub(V0, A0, armReg(margin));
      asm.subs(V0, V0, armImm(1));
      inner.far("pl", apart);
    };
    axis(propOffset("x"), A2);
    axis(propOffset("y"), A3);

    asm.movs(A0, armImm(1));
    asm.pop([V0, PC]);
    asm.label(apart);
    asm.movs(A0, armImm(0));
    asm.pop([V0, PC]);
    asm.ltorg();
  });
}

/** Put the two near-test margins where {@link needNearBox} expects them. */
function emitNearMargins(ctx: GbaCtx, margins: { x: number; y: number }): void {
  ctx.asm.movImm32(A2, margins.x);
  ctx.asm.movImm32(A3, margins.y);
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: GbaCtx, entity: number): void {
  const { asm, layout } = ctx;
  const source = layout.pairA as number;
  asm.movImm32(A1, entity);
  asm.bl(
    ctx.need("CommitPair", (inner) => {
      const regs = [A2, A3];
      inner.asm.movImm32(A0, source);
      inner.asm.ldm(A0, regs);
      inner.asm.stm(A1, regs);
      inner.asm.ret();
      inner.asm.ltorg();
    }),
  );
  void PROP_SIZE;
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: GbaCtx, bit: number, seen: string): void {
  ctx.asm.ldrb(A0, mem(ctx, ctx.layout.contactsPrev + (bit >> 3)));
  ctx.asm.tst(A0, armImm(1 << (bit & 7)));
  ctx.far("ne", seen);
}

function emitContactSet(ctx: GbaCtx, bit: number): void {
  const { asm } = ctx;
  const address = ctx.layout.contacts + (bit >> 3);
  asm.ldrb(A0, mem(ctx, address));
  asm.orr(A0, A0, armImm(1 << (bit & 7)));
  asm.strb(A0, mem(ctx, address));
}

/**
 * One pair of objects, looped over the others rather than copied per pair.
 *
 * The reasoning is the Sega backend's, the NES's and the Mega Drive's, arrived at
 * here for the same reason: three shots against nine aliens is twenty-seven
 * pairs, and twenty-seven copies of a near test, a staging, an overlap, a rule
 * body, a separation and a contact bit is most of a cartridge. It is only taken
 * where the pairs agree about what an unrolled copy would have baked in.
 */
function emitPairLoop(
  ctx: GbaCtx,
  rule: RuleDef,
  subject: EntityAddr,
  subjectId: number,
  subjectBase: number,
  pairs: readonly { id: number; base: number; bit: number }[],
): boolean {
  const { asm, layout } = ctx;
  if (pairs.length < LOOP_PAIRS || layout.loop === null) return false;
  const event = rule.event;
  if (event.kind !== "hits") return false;

  const margins = nearMargins(ctx, subjectId, pairs[0]?.id as number);
  const guarded = isMutable(ctx.analysis, pairs[0]?.id as number, "visible");
  for (const pair of pairs) {
    const theirs = nearMargins(ctx, subjectId, pair.id);
    if (theirs?.x !== margins?.x || theirs?.y !== margins?.y) return false;
    if (isMutable(ctx.analysis, pair.id, "visible") !== guarded) return false;
  }

  const table = ctx.unique("pairTable");
  const next = ctx.unique("pairNext");
  const other: EntityAddr = { kind: "ptr", ptr: layout.loop };

  const loop = emitLoopHead(ctx, table);
  if (guarded) guardVisiblePtr(ctx, next);
  if (margins) {
    asm.ldr(A1, mem(ctx, layout.loop));
    emitNearMargins(ctx, margins);
    asm.bl(needNearBox(ctx));
    ctx.far("eq", next);
  }
  emitStageBoxPtr(ctx, "b");
  asm.bl(needOverlapPair(ctx));
  ctx.far("eq", next);

  const afterFire = ctx.unique("pairFired");
  if (!event.level) emitContactBitPtr(ctx, table, "seen", afterFire);
  emitFire(ctx, rule, { subject, other });
  asm.label(afterFire);

  const noSeparate = ctx.unique("pairNoSep");
  // Re-stage before separating, because the rule that just fired may have moved
  // either box. This also restores the subject staging for the next entry.
  emitStageBox(ctx, subjectBase, "a");
  emitStageBoxPtr(ctx, "b");
  guardVisible(ctx, subjectId, noSeparate);
  if (guarded) guardVisiblePtr(ctx, noSeparate);
  asm.bl(needOverlapPair(ctx));
  ctx.far("eq", noSeparate);
  asm.bl(needSeparatePair(ctx));
  emitCommitPair(ctx, subjectBase);
  emitStageBox(ctx, subjectBase, "a");
  emitContactBitPtr(ctx, table, "set");
  asm.label(noSeparate);

  asm.label(next);
  emitLoopNext(ctx, loop, pairs.length);

  emitEntityTable(
    ctx,
    table,
    pairs.map((pair) => pair.base),
  );
  emitContactTables(
    ctx,
    table,
    pairs.map((pair) => pair.bit),
  );
  return true;
}

/** The other half of the same idea: many subjects against the screen's edges. */
function emitEdgeLoop(
  ctx: GbaCtx,
  rule: RuleDef,
  scene: SceneCtx,
  subjects: readonly { id: number; base: number; bit: number }[],
  edges: readonly Edge[],
  level: boolean,
): boolean {
  const { asm, layout } = ctx;
  if (subjects.length < LOOP_PAIRS || layout.loop === null) return false;
  const guarded = isMutable(ctx.analysis, subjects[0]?.id as number, "visible");
  for (const one of subjects) {
    if (isMutable(ctx.analysis, one.id, "visible") !== guarded) return false;
  }

  const table = ctx.unique("edgeTable");
  const next = ctx.unique("edgeNext");
  const subject: EntityAddr = { kind: "ptr", ptr: layout.loop };

  const loop = emitLoopHead(ctx, table);
  if (guarded) guardVisiblePtr(ctx, next);

  for (const [edgeIndex, edge] of edges.entries()) {
    const skip = ctx.unique("edgeLoopSkip");
    emitEdgeTest(ctx, subject, edge, scene, skip);
    const afterFire = ctx.unique("edgeLoopFired");
    if (!level) emitContactBitPtr(ctx, table, "seen", afterFire, edgeIndex);
    emitFire(ctx, rule, { subject, other: { kind: "none" } });
    asm.label(afterFire);
    const noSeparate = ctx.unique("edgeLoopNoSep");
    if (guarded) guardVisiblePtr(ctx, noSeparate);
    emitEdgeTest(ctx, subject, edge, scene, noSeparate);
    emitEdgeSeparate(ctx, subject, edge, scene);
    emitContactBitPtr(ctx, table, "set", undefined, edgeIndex);
    asm.label(noSeparate);
    asm.label(skip);
  }

  asm.label(next);
  emitLoopNext(ctx, loop, subjects.length);

  emitEntityTable(
    ctx,
    table,
    subjects.map((one) => one.base),
  );
  for (const [edgeIndex] of edges.entries()) {
    emitContactTables(
      ctx,
      table,
      subjects.map((one) => one.bit + edgeIndex),
      String(edgeIndex),
    );
  }
  return true;
}

export function emitCollisions(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (rule.event.kind !== "hits" || !ruleInScene(rule, scene)) continue;
    const range = layout.contactRanges.get(rule.id);
    if (!range) continue;
    const event = rule.event;

    if (event.others.length === 0 && event.edges.length > 0) {
      const subjects: { id: number; base: number; bit: number }[] = [];
      let uniform = true;
      for (const [subjectIndex, subjectId] of event.subjects.entries()) {
        if (!inScene(ctx.program, scene, subjectId)) continue;
        if (!isMutable(ctx.analysis, subjectId, "visible")) {
          const instance = ctx.program.instances[subjectId] as InstanceDef;
          if ((instance.numbers["visible"] ?? 0) === 0) continue;
        }
        const first = ctx.program.instances[subjects[0]?.id ?? subjectId] as InstanceDef;
        const instance = ctx.program.instances[subjectId] as InstanceDef;
        for (const prop of ["width", "height"]) {
          if (instance.numbers[prop] !== first.numbers[prop]) uniform = false;
        }
        subjects.push({
          id: subjectId,
          base: layout.entities[subjectId] as number,
          bit: range.base + subjectIndex * range.stride,
        });
      }
      if (uniform && emitEdgeLoop(ctx, rule, scene, subjects, event.edges, event.level)) continue;
    }

    for (const [subjectIndex, subjectId] of event.subjects.entries()) {
      if (!inScene(ctx.program, scene, subjectId)) continue;
      const subjectSkip = ctx.unique("hitSubjSkip");
      if (guardVisible(ctx, subjectId, subjectSkip) === "never") {
        asm.label(subjectSkip);
        continue;
      }
      const subject = entityOf(ctx, subjectId);
      const subjectBase = layout.entities[subjectId] as number;
      const bitBase = range.base + subjectIndex * range.stride;

      for (const [edgeIndex, edge] of event.edges.entries()) {
        const skip = ctx.unique("edgeSkip");
        emitEdgeTest(ctx, subject, edge, scene, skip);
        const bit = bitBase + edgeIndex;
        const afterFire = ctx.unique("edgeFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: { kind: "none" } });
        asm.label(afterFire);
        // Separation re-tests, so a rule that teleported its subject away is not
        // dragged back to the wall it just left — or that hid it, because
        // `visible 0` is not collided with either.
        const noSeparate = ctx.unique("edgeNoSep");
        guardVisible(ctx, subjectId, noSeparate);
        emitEdgeTest(ctx, subject, edge, scene, noSeparate);
        emitEdgeSeparate(ctx, subject, edge, scene);
        emitContactSet(ctx, bit);
        asm.label(noSeparate);
        asm.label(skip);
      }

      if (event.others.length > 0) emitStageBox(ctx, subjectBase, "a");

      const pairs: { id: number; base: number; bit: number }[] = [];
      for (const [otherIndex, otherId] of event.others.entries()) {
        if (otherId === subjectId) continue;
        if (!inScene(ctx.program, scene, otherId)) continue;
        if (!isMutable(ctx.analysis, otherId, "visible")) {
          if (((ctx.program.instances[otherId] as InstanceDef).numbers["visible"] ?? 0) === 0) {
            continue;
          }
        }
        pairs.push({
          id: otherId,
          base: layout.entities[otherId] as number,
          bit: bitBase + event.edges.length + otherIndex,
        });
      }

      if (emitPairLoop(ctx, rule, subject, subjectId, subjectBase, pairs)) {
        asm.label(subjectSkip);
        continue;
      }

      for (const { id: otherId, base: otherBase, bit } of pairs) {
        const skip = ctx.unique("otherSkip");
        guardVisible(ctx, otherId, skip);
        const margins = nearMargins(ctx, subjectId, otherId);
        if (margins) {
          asm.movImm32(A1, otherBase);
          emitNearMargins(ctx, margins);
          asm.bl(needNearBox(ctx));
          ctx.far("eq", skip);
        }
        emitStageBox(ctx, otherBase, "b");
        asm.bl(needOverlapPair(ctx));
        ctx.far("eq", skip);
        const afterFire = ctx.unique("otherFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: entityOf(ctx, otherId) });
        asm.label(afterFire);
        const noSeparate = ctx.unique("otherNoSep");
        emitStagePair(ctx, subjectBase, otherBase);
        guardVisible(ctx, subjectId, noSeparate);
        guardVisible(ctx, otherId, noSeparate);
        asm.bl(needOverlapPair(ctx));
        ctx.far("eq", noSeparate);
        asm.bl(needSeparatePair(ctx));
        emitCommitPair(ctx, subjectBase);
        emitStageBox(ctx, subjectBase, "a");
        emitContactSet(ctx, bit);
        asm.label(noSeparate);
        asm.label(skip);
      }
      asm.label(subjectSkip);
    }
  }
}

// --- 7. edge rules -----------------------------------------------------------

export function emitEdgeRules(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (!ruleInScene(rule, scene)) continue;

    if (rule.event.kind === "input") {
      const set = rule.event.edge === "pressed" ? layout.pressed : layout.released;
      const action = rule.event.action;
      const bit = ACTIONS.indexOf(action);
      const skip = ctx.unique("inputSkip");
      if (rule.guard === undefined) {
        asm.ldrb(A0, mem(ctx, set));
        asm.tst(A0, armImm(1 << bit));
        ctx.far("eq", skip);
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        // The trigger's answer outlives the guard, so it goes in a byte — and
        // here it is a predicated pair rather than the two branches every other
        // backend needs.
        asm.ldrb(A0, mem(ctx, set));
        asm.tst(A0, armImm(1 << bit));
        asm.mov(A0, armImm(0), "eq");
        asm.mov(A0, armImm(1), "ne");
        asm.strb(A0, mem(ctx, layout.scratch + S.w0));
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, layout.scratch + S.w0);
        }
      }
      continue;
    }

    if (rule.event.kind !== "reaches") continue;
    emitReaches(ctx, rule, scene);
  }
}

/**
 * Run one subject binding of an edge rule, with the trigger's verdict in a byte
 * when it is not statically known.
 */
function emitSubjectFire(
  ctx: GbaCtx,
  rule: RuleDef,
  subject: number | null,
  firedFlag: number | undefined,
): void {
  const { asm } = ctx;
  const skip = ctx.unique("subjSkip");
  let bind: Binding = UNBOUND;
  if (subject !== null) {
    if (guardVisible(ctx, subject, skip) === "never") {
      asm.label(skip);
      return;
    }
    bind = { subject: entityOf(ctx, subject), other: { kind: "none" } };
  }
  if (firedFlag === undefined) {
    emitFire(ctx, rule, bind);
  } else {
    emitFire(ctx, rule, bind, (falseLabel) => {
      loadByte(ctx, firedFlag);
      ctx.far("eq", falseLabel);
      return "runtime";
    });
  }
  asm.label(skip);
}

/**
 * `reaches` is a crossing detector, not a threshold: it fires when the value
 * lands exactly on its target or crosses it from either side, and a value that
 * *starts* on its target has not reached it.
 */
function emitReaches(ctx: GbaCtx, rule: RuleDef, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  if (rule.event.kind !== "reaches") return;
  const slot = layout.reachSlots.get(rule.id);
  if (slot === undefined) return;
  const valueAddr = layout.reachValues + slot * 4;
  const flagAddr = layout.reachFlags + slot;
  const previous = layout.temps[layout.temps.length - 1] as number;
  const delta = layout.temps[layout.temps.length - 2] as number;
  const firedFlag = layout.scratch + S.w0;

  const event = rule.event;
  ctx.scoped(() => {
    emitExpr(ctx, event.left, UNBOUND, delta);
    ctx.scoped(() => {
      const right = emitExpr(ctx, event.right, UNBOUND);
      sub32(ctx, delta, right.val);
    });
  });

  copy32(ctx, previous, at(valueAddr));
  copy32(ctx, valueAddr, at(delta));
  const hadHistory = ctx.unique("reachHistory");
  const done = ctx.unique("reachDone");
  loadByte(ctx, flagAddr);
  ctx.far("ne", hadHistory);
  storeByte(ctx, flagAddr, 1);
  asm.b(done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the sign
  // changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  branchZero32(ctx, previous, notFired);
  branchZero32(ctx, delta, fired);
  asm.ldr(A0, mem(ctx, delta));
  asm.ldr(A1, mem(ctx, previous));
  asm.eors(A0, A0, armReg(A1));
  ctx.far("pl", notFired);
  asm.label(fired);
  storeByte(ctx, firedFlag, 1);
  const run = ctx.unique("reachRun");
  asm.b(run);
  asm.label(notFired);
  storeByte(ctx, firedFlag, 0);
  asm.label(run);

  if (rule.guard === undefined) {
    const skip = ctx.unique("reachSkip");
    loadByte(ctx, firedFlag);
    ctx.far("eq", skip);
    for (const subject of subjectBindings(ctx, rule, scene)) {
      emitSubjectFire(ctx, rule, subject, undefined);
    }
    asm.label(skip);
  } else {
    for (const subject of subjectBindings(ctx, rule, scene)) {
      emitSubjectFire(ctx, rule, subject, firedFlag);
    }
  }
  asm.label(done);
}

// --- 8. camera ---------------------------------------------------------------

/**
 * Centre the viewport on the scene's camera target and hold it inside the
 * playfield. The clamp is load-bearing twice: it stops the view running off the
 * end of a level, and it means a level no bigger than the screen never scrolls,
 * so a non-scrolling game needs no special case anywhere.
 */
export function emitCamera(ctx: GbaCtx, scene: SceneCtx): void {
  const { asm, layout, profile } = ctx;
  const camera = layout.camera;
  if (camera === null) return;
  const target = scene.def.cameraTarget;
  if (target === undefined) {
    set32(ctx, camera, 0);
    set32(ctx, camera + 4, 0);
    return;
  }
  const axis = (offset: number, prop: string, half: number, max: number): void => {
    ctx.scoped(() => {
      const value = readProp(ctx, entityOf(ctx, target), prop);
      copy32(ctx, camera + offset, value.val);
    });
    addConst32(ctx, camera + offset, -half);
    const clampHigh = ctx.unique("camHigh");
    const done = ctx.unique("camDone");
    branchLess32(ctx, at(camera + offset), imm(0), clampHigh, false);
    set32(ctx, camera + offset, 0);
    asm.b(done);
    asm.label(clampHigh);
    branchLess32(ctx, imm(max), at(camera + offset), done, false);
    set32(ctx, camera + offset, max);
    asm.label(done);
  };
  axis(
    0,
    "centerx",
    fromInt(profile.screenWidth) / 2,
    boundMax(scene.boundsW, profile.screenWidth),
  );
  axis(
    4,
    "centery",
    fromInt(profile.screenHeight) / 2,
    boundMax(scene.boundsH, profile.screenHeight),
  );
}
