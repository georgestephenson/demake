/**
 * The tick, compiled for the Z80.
 *
 * `sim.ts` is the specification and this is a conformance implementation of it,
 * the same way the other two backends are. The *order* of the steps is not here
 * at all — `emitTickSteps` runs them (see `codegen/backend.ts`) — and every
 * decision about which rule can fire where is `shape.ts`'s. What is left is this
 * machine's instructions, and three places where they are shaped differently
 * from the 6502's:
 *
 *   - **A box is staged by `ldir`.** The overlap test and the separation work on
 *     two fixed addresses, exactly as on the other consoles, so that they can be
 *     routines rather than a copy of themselves per pair — a bullet against nine
 *     aliens is twenty-seven pairs. The *source* is a different entity each time,
 *     which the 6502 can only reach through a page-zero pointer; here it is `hl`,
 *     so a staging call is a load and a call.
 *   - **A cheap rejection reads the other object through `ix`.** `NearBox`
 *     compares whole cells — the high half of a 16.16 coordinate — and rounds its
 *     margins outward, so it may answer "maybe" when the truth is no and never
 *     the reverse. The margins are compile-time constants, so they arrive in `bc`
 *     rather than in memory.
 *   - **A predicate routine answers in the zero flag, not in the accumulator.**
 *     `ld a,1` sets no flags on this CPU, so a caller that tested the returned
 *     byte would be branching on whatever the *call* left behind. Returning the
 *     answer as a flag makes the hazard unrepresentable rather than merely
 *     avoided.
 */

import { label, type Ref } from "@demake/core";

import { fromInt, ONE as FIXED_ONE } from "../../fixed.js";
import type { CAssignment, ControlDef, Edge, InstanceDef, RuleDef } from "../../program.js";
import { ACTIONS } from "../../program.js";
import { isMutable } from "../analyze.js";
import { BOX_SIZE, PROP_SIZE } from "../layout.js";
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

import type { SmsCtx } from "./ctx.js";
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
import { S } from "./scratch.js";
import {
  abs32,
  add32,
  addConst32,
  branchLess32,
  branchUnlessConst32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  mem,
  mul32,
  neg32,
  set32,
  sub32,
} from "./val.js";

export type { SceneCtx };

/** Load a byte and set the flags from it — two instructions on this CPU. */
function loadByte(ctx: SmsCtx, address: Ref): void {
  ctx.asm.lda(address);
  ctx.asm.aluN("or", 0);
}

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and
 * an object whose `visible` no assignment can reach is decided here rather than
 * every tick. That removes the test from every rule in most games.
 */
function guardVisible(ctx: SmsCtx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  branchZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"), skip);
  return "runtime";
}

/**
 * The same, for the record a loop is walking rather than one the compiler named.
 *
 * Four bytes out of the record and a test, because there is no address to branch
 * on. The caller has already decided that every object in the loop answers
 * `isMutable` the same way, so this is emitted exactly when the unrolled form
 * would have emitted its run-time guard.
 */
function guardVisiblePtr(ctx: SmsCtx, skip: string): void {
  ctx.scoped(() => {
    const temp = ctx.pushTemp();
    copyFromPtr(ctx, ctx.layout.loop as number, propOffset("visible"), temp);
    branchZero32(ctx, temp, skip);
  });
}

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 */
export function emitAssignments(
  ctx: SmsCtx,
  assignments: readonly CAssignment[],
  bind: Binding,
): void {
  if (assignments.length === 0) return;
  const { asm, layout } = ctx;

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
        copy32(ctx, slot, current.addr);
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
      // The clamp happened at compile time, so this is two stores.
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

  if (sceneTarget !== undefined) {
    asm.ldn("a", sceneTarget);
    asm.sta(layout.pending);
  }
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 */
function emitFire(ctx: SmsCtx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
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
  if (!branched) return;
  if (rule.otherwise && rule.otherwise.length > 0) {
    asm.jp(done);
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
 * Emitted inside the fired branch, alongside the assignments, so a sound fires
 * on exactly the tick the interpreter says it does. The request is one byte
 * because the driver reads it from an interrupt: a byte is written atomically,
 * and a pointer arriving half-written would play half of one effect.
 */
export function emitSound(ctx: SmsCtx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  // A sound whose file was never supplied still records the request, so a trace
  // taken with the audio left out matches one taken with it in.
  if (ctx.audio.driver && index >= 0) {
    ctx.asm.ldn("a", index + 1);
    ctx.asm.sta(ctx.audio.request);
  }
  if (ctx.audio.trace !== null) {
    ctx.asm.ldn("a", rule.sound);
    ctx.asm.sta(ctx.audio.trace);
  }
}

// --- 2. controls -------------------------------------------------------------

/** Test an abstract button against one of the three input sets. */
function emitButton(ctx: SmsCtx, set: number, action: string, skip: string): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.lda(set);
  ctx.asm.aluN("and", 1 << bit);
  ctx.far("z", skip);
}

export function emitControls(ctx: SmsCtx, scene: SceneCtx): void {
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

function emitSnapshot(ctx: SmsCtx, control: ControlDef, bind: Binding, base: number): void {
  const { asm, layout } = ctx;
  for (const [index, assignment] of control.assignments.entries()) {
    const target = assignment.target;
    if (target.kind !== "prop") continue;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const slot = layout.holdValues + (base + index) * 4;
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, slot, current.addr);
    });
    asm.ldn("a", 1);
    asm.sta(layout.holdFlags + base + index);
  }
}

function emitRestore(ctx: SmsCtx, control: ControlDef, bind: Binding, base: number): void {
  const { asm, layout } = ctx;
  for (const [index, assignment] of control.assignments.entries()) {
    const target = assignment.target;
    if (target.kind !== "prop") continue;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const skip = ctx.unique("restoreSkip");
    loadByte(ctx, layout.holdFlags + base + index);
    ctx.far("z", skip);
    asm.alu("xor", "a");
    asm.sta(layout.holdFlags + base + index);
    const slot = layout.holdValues + (base + index) * 4;
    writeProp(ctx, entity, target.prop, slot);
    asm.label(skip);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: SmsCtx, scene: SceneCtx): void {
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
 * running them through one loop rather than a copy each (see
 * {@link emitMoveLoop}).
 */
function moveShape(ctx: SmsCtx, id: number): string {
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

export function emitIntegrate(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  // Group first: an object's movement reads and writes only its own record, so
  // objects that compile the same way can share one body without reordering
  // anything observable.
  const groups = new Map<string, number[]>();
  for (const id of scene.def.instanceIds) {
    const instance = ctx.program.instances[id] as InstanceDef;
    const speedFixed = instance.numbers["speed"] ?? 0;
    // An object that starts at rest and that nothing can accelerate never moves,
    // so it is not in the integrator at all.
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

/**
 * One movement body for every object that moves the same way.
 *
 * Nine aliens with one speed and a direction they flip compiled to nine copies of
 * the same two hundred bytes. They go through the pair loop's pointer instead,
 * and by now nothing here knows or cares whether the record it is stepping
 * belongs to an instance the compiler named.
 *
 * The group key is every compile-time question `emitAxis` asks, so a shared body
 * is a proof rather than a hope: two objects in one group would have produced the
 * same instructions anyway.
 */
function emitMoveLoop(ctx: SmsCtx, ids: readonly number[]): boolean {
  const { asm } = ctx;
  if (ctx.layout.loop === null) return false;
  const first = ids[0] as number;
  const table = ctx.unique("moveTable");
  const next = ctx.unique("moveNext");
  const entity: EntityAddr = { kind: "ptr", ptr: ctx.layout.loop };

  const loop = emitLoopHead(ctx, table);
  if (isMutable(ctx.analysis, first, "speed")) {
    ctx.scoped(() => branchZero32(ctx, readProp(ctx, entity, "speed").addr, next));
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
 * close is nothing, so the unrolled form is byte-for-byte what it always was. For
 * one behind a pointer it is a temporary, staged in and copied back — the four
 * bytes each way that make a shared body possible at all.
 */
function openProp(ctx: SmsCtx, entity: EntityAddr, prop: string): { addr: Ref; close: () => void } {
  if (entity.kind === "const") {
    return { addr: entity.base + propOffset(prop), close: () => undefined };
  }
  const temp = ctx.pushTemp();
  if (entity.kind === "ptr") copyFromPtr(ctx, entity.ptr, propOffset(prop), temp);
  else set32(ctx, temp, 0);
  return {
    addr: temp,
    close: () => {
      if (entity.kind === "ptr") copyToPtr(ctx, entity.ptr, propOffset(prop), temp);
      ctx.popTemp();
    },
  };
}

function emitAxis(
  ctx: SmsCtx,
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
  // Read-only, so they are the record's own addresses for a named instance and
  // staged copies for a looped one.
  const dirAddr = readProp(ctx, entity, dirProp).addr;
  const speedAddr = readProp(ctx, entity, "speed").addr;
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

    branchUnlessConst32(ctx, dirAddr, FIXED_ONE, notForward);
    if (forward !== 0) {
      addConst32(ctx, posAddr, forward);
      clamp32(ctx, posAddr);
    }
    asm.jp(done);
    asm.label(notForward);
    branchUnlessConst32(ctx, dirAddr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    asm.jp(done);
    asm.label(notBackward);
  }

  const skipZero = ctx.unique("axisZero");
  branchZero32(ctx, dirAddr, skipZero);
  ctx.scoped(() => {
    const step = ctx.pushTemp();
    copy32(ctx, step, dirAddr);
    // velocity = direction × speed, then step = velocity ÷ fps. Speeds are
    // authored per second precisely so the frame rate enters only here.
    mul32(ctx, step, speedAddr);
    div32(ctx, step, ctx.constant(fromInt(profile.fps)));
    const noMove = ctx.unique("axisNoMove");
    branchZero32(ctx, step, noMove);
    add32(ctx, posAddr, step);
    clamp32(ctx, posAddr);
    asm.label(noMove);
  });
  asm.label(skipZero);
  asm.label(done);
  finish();
}

// --- walking a list of entities ----------------------------------------------

/**
 * Fewest entries worth a loop rather than a copy each.
 *
 * A looped body costs its own setup — the table, the cursor, the two indirect
 * reads a run-time contact bit needs — against a few hundred bytes for an
 * unrolled one. Three is where the arithmetic turns, and it is deliberately not
 * two: a game with a player and two coins reads better unrolled in the symbol
 * table, and nothing in the library is near its budget.
 */
const LOOP_PAIRS = 3;

/**
 * Open a loop over a table of record addresses, leaving the cursor set.
 *
 * `layout.loop` is a two-byte pointer and the byte after it is the index. Both
 * are memory rather than registers because a rule body fires inside the loop and
 * may use every register the Z80 has — the same reason the 6502 backend keeps
 * them in page zero rather than in `X`.
 *
 * Returns the label the matching {@link emitLoopNext} branches back to.
 */
function emitLoopHead(ctx: SmsCtx, table: string): string {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  const loop = ctx.unique("walkLoop");
  asm.alu("xor", "a");
  asm.sta(ptr + 2);
  asm.label(loop);
  // hl = table + index × 2, and the entry is the record's address.
  asm.lda(ptr + 2);
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.addHL("hl");
  asm.ld16("de", label(table));
  asm.addHL("de");
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.st16To(ptr, "de");
  return loop;
}

/** Step the cursor and go round again while entries remain. */
function emitLoopNext(ctx: SmsCtx, loop: string, count: number): void {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  asm.lda(ptr + 2);
  asm.inc("a");
  asm.sta(ptr + 2);
  asm.aluN("cp", count);
  ctx.far("c", loop);
}

/** The addresses a loop walks, emitted after the code with the other tables. */
function emitEntityTable(ctx: SmsCtx, table: string, bases: readonly number[]): void {
  ctx.data((data) => {
    data.label(table);
    for (const base of bases) data.dw(base);
  });
}

/**
 * `hl` = the contact byte's offset and `c` = its mask, for the current entry.
 *
 * A contact bit is a compile-time constant in the unrolled form; a loop knows
 * only an index, so the byte and the mask are tables rather than arithmetic —
 * working a bit number out at run time would cost a shift loop per entry.
 */
function needContactSlot(ctx: SmsCtx): Ref {
  return ctx.need("ContactSlot", (inner) => {
    const { asm, layout } = inner;
    // hl = byte table, de = mask table, index in memory.
    asm.lda((layout.loop as number) + 2);
    asm.ld("c", "a");
    asm.ldn("b", 0);
    asm.addHL("bc");
    asm.ld("a", "hlp");
    asm.exDEHL();
    asm.addHL("bc");
    asm.ld("c", "hlp");
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.ret();
  });
}

/** Test or set this entry's contact bit, whose number is only known at run time. */
function emitContactBitPtr(
  ctx: SmsCtx,
  table: string,
  what: "seen" | "set",
  seen?: string,
  edge?: number,
): void {
  const { asm, layout } = ctx;
  const suffix = edge === undefined ? "" : String(edge);
  asm.ld16("hl", label(`${table}Byte${suffix}`));
  asm.ld16("de", label(`${table}Mask${suffix}`));
  asm.call(needContactSlot(ctx));
  asm.ld16("de", what === "seen" ? layout.contactsPrev : layout.contacts);
  asm.addHL("de");
  asm.ld("a", "hlp");
  if (what === "seen") {
    asm.alu("and", "c");
    ctx.far("nz", seen as string);
    return;
  }
  asm.alu("or", "c");
  asm.ld("hlp", "a");
}

/** The byte-and-mask tables one contact bit per entry needs. */
function emitContactTables(ctx: SmsCtx, table: string, bits: readonly number[], suffix = ""): void {
  ctx.data((data) => {
    data.label(`${table}Byte${suffix}`);
    data.db(...bits.map((bit) => bit >> 3));
    data.label(`${table}Mask${suffix}`);
    data.db(...bits.map((bit) => 1 << (bit & 7)));
  });
}

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(
  ctx: SmsCtx,
  entity: EntityAddr,
  edge: Edge,
  scene: SceneCtx,
  skip: string,
): void {
  // Through `readProp` rather than an address, so one emitter serves an instance
  // the compiler knows and a subject a loop is walking: for the first it *is* the
  // address, and for the second it is four bytes copied out of a record the
  // pointer names.
  const read = (prop: string): Ref => readProp(ctx, entity, prop).addr;
  const zero = ctx.constant(0);

  switch (edge) {
    case "screenleft":
      // x <= 0 is "not (0 < x)".
      ctx.scoped(() => branchLess32(ctx, zero, read("x"), skip));
      break;
    case "screentop":
      ctx.scoped(() => branchLess32(ctx, zero, read("y"), skip));
      break;
    case "screenright":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, read("x"));
        add32(ctx, temp, read("width"));
        branchLess32(ctx, temp, ctx.constant(scene.boundsW), skip);
      });
      break;
    case "screenbottom":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, read("y"));
        add32(ctx, temp, read("height"));
        branchLess32(ctx, temp, ctx.constant(scene.boundsH), skip);
      });
      break;
  }
}

/** Push the subject back inside the playfield. The interpreter does not clamp
 * here, and neither does this. */
function emitEdgeSeparate(ctx: SmsCtx, entity: EntityAddr, edge: Edge, scene: SceneCtx): void {
  if (entity.kind === "none") return;
  const axis = edge === "screenleft" || edge === "screenright" ? "x" : "y";
  const span = axis === "x" ? "width" : "height";
  const near = edge === "screenleft" || edge === "screentop";
  const bound = axis === "x" ? scene.boundsW : scene.boundsH;
  // Not `writeProp`: that clamps, and the interpreter does not clamp here. An
  // instance the compiler knows is written in place exactly as it always was; a
  // subject a loop is walking is staged and copied back through its pointer.
  if (entity.kind === "const") {
    const addr = entity.base + propOffset(axis);
    if (near) {
      set32(ctx, addr, 0);
      return;
    }
    set32(ctx, addr, bound);
    sub32(ctx, addr, entity.base + propOffset(span));
    return;
  }
  ctx.scoped(() => {
    const temp = ctx.pushTemp();
    if (near) {
      set32(ctx, temp, 0);
    } else {
      set32(ctx, temp, bound);
      sub32(ctx, temp, readProp(ctx, entity, span).addr);
    }
    copyToPtr(ctx, entity.ptr, propOffset(axis), temp);
  });
}

/**
 * Copy one entity's box into a staging slot.
 *
 * A load and a call: the source is a different entity each time, and `hl` is
 * where a block move takes its source. The destination is one of two fixed
 * addresses, so it is baked into the routine rather than passed — two routines
 * of nine bytes cost less than a second argument at every one of a game's
 * collision pairs.
 */
function emitStageBox(ctx: SmsCtx, src: number, slot: "a" | "b"): void {
  const { asm } = ctx;
  asm.ld16("hl", src);
  asm.call(needCopyBox(ctx, slot));
}

/** The routine that stages a box; it takes the record's address in `hl`. */
function needCopyBox(ctx: SmsCtx, slot: "a" | "b"): Ref {
  const dst = (slot === "a" ? ctx.layout.pairA : ctx.layout.pairB) as number;
  return ctx.need(`CopyBox${slot.toUpperCase()}`, (inner) => {
    inner.asm.ld16("de", dst);
    inner.asm.ld16("bc", BOX_SIZE);
    inner.asm.ldir();
    inner.asm.ret();
  });
}

/** The same, for the record the loop pointer names. */
function emitStageBoxPtr(ctx: SmsCtx, slot: "a" | "b"): void {
  const { asm, layout } = ctx;
  asm.ld16From("hl", layout.loop as number);
  asm.call(needCopyBox(ctx, slot));
}

function emitStagePair(ctx: SmsCtx, a: number, b: number): void {
  emitStageBox(ctx, a, "a");
  emitStageBox(ctx, b, "b");
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * Z clear when the staged boxes overlap, Z set when they do not.
 *
 * Half-open on both axes, matching the interpreter and matching tile contact.
 * The answer is a flag rather than a byte because `ld a,1` sets no flags here:
 * a caller that tested the returned byte would be branching on whatever the
 * `call` happened to leave behind.
 */
function needOverlapPair(ctx: SmsCtx): Ref {
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
      copy32(inner, temp, boxProp(b, pos));
      add32(inner, temp, boxProp(b, size));
      branchLess32(inner, boxProp(a, pos), temp, apart, false);
      copy32(inner, temp, boxProp(a, pos));
      add32(inner, temp, boxProp(a, size));
      branchLess32(inner, boxProp(b, pos), temp, apart, false);
    }
    asm.ldn("a", 1);
    asm.aluN("or", 0);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 */
function needSeparatePair(ctx: SmsCtx): Ref {
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
      copy32(inner, near, boxProp(a, pos));
      add32(inner, near, boxProp(a, size));
      sub32(inner, near, boxProp(b, pos));
      copy32(inner, far, boxProp(b, pos));
      add32(inner, far, boxProp(b, size));
      sub32(inner, far, boxProp(a, pos));
      const takeFar = inner.unique("sepFar");
      const done = inner.unique("sepDone");
      branchLess32(inner, near, far, takeFar, false);
      copy32(inner, push, near);
      neg32(inner, push);
      asm.jp(done);
      asm.label(takeFar);
      copy32(inner, push, far);
      asm.label(done);
    };

    axis("x", "width", xPush);
    axis("y", "height", yPush);

    // |xPush| < |yPush| decides the axis.
    copy32(inner, near, xPush);
    abs32(inner, near);
    copy32(inner, far, yPush);
    abs32(inner, far);
    const useY = inner.unique("sepUseY");
    branchLess32(inner, near, far, useY, false);
    add32(inner, boxProp(a, "x"), xPush);
    clamp32(inner, boxProp(a, "x"));
    asm.ret();
    asm.label(useY);
    add32(inner, boxProp(a, "y"), yPush);
    clamp32(inner, boxProp(a, "y"));
    asm.ret();
  });
}

/**
 * `ix` = the other object's base, `c`/`b` = the margins in cells → Z set when the
 * two boxes are certainly apart.
 *
 * The subject is whatever is staged in `pairA`, which every path through a pair
 * keeps current. Like the sprite cull this compares *cells* — the high half of a
 * 16.16 coordinate — so it is a sixteen-bit subtract and two sign tests per axis,
 * against the several hundred cycles a staged box and a full overlap test cost.
 * Two boxes can only overlap if their cells are within the wider of the two, so
 * rounding the margin outward by one keeps it conservative: it may say "maybe"
 * when the answer is no, never the reverse.
 *
 * `adc hl,de` rather than `add hl,de` for the near test, and that is the whole
 * reason it is spelled that way: the plain sixteen-bit add sets no sign flag, so
 * the branch after it would read a sign left over from something else.
 */
function needNearBox(ctx: SmsCtx): Ref {
  return ctx.need("NearBox", (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");
    const delta = layout.scratch + S.w0;

    const axis = (offset: number, margin: "b" | "c"): void => {
      // delta = other.cell - subject.cell, sixteen bits.
      asm.ldIdx("l", "ix", offset + 2);
      asm.ldIdx("h", "ix", offset + 3);
      asm.ld16From("de", subject + offset + 2);
      asm.aluN("or", 0);
      asm.sbcHL("de");
      asm.st16To(delta, "hl");
      // delta + margin < 0 — the other is that far to the near side.
      asm.ld("e", margin);
      asm.ldn("d", 0);
      asm.aluN("or", 0);
      asm.adcHL("de");
      inner.far("m", apart);
      // delta − margin − 1 >= 0 — that far to the far side.
      asm.ld16From("hl", delta);
      asm.ld("e", margin);
      asm.ldn("d", 0);
      asm.inc16("de");
      asm.aluN("or", 0);
      asm.sbcHL("de");
      inner.far("p", apart);
    };
    axis(propOffset("x"), "c");
    axis(propOffset("y"), "b");

    asm.ldn("a", 1);
    asm.aluN("or", 0);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: SmsCtx, entity: number): void {
  const { asm, layout } = ctx;
  const source = layout.pairA as number;
  asm.ld16("de", entity);
  asm.call(
    ctx.need("CommitPair", (inner) => {
      inner.asm.ld16("hl", source);
      inner.asm.ld16("bc", 2 * PROP_SIZE);
      inner.asm.ldir();
      inner.asm.ret();
    }),
  );
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: SmsCtx, bit: number, seen: string): void {
  const { asm, layout } = ctx;
  asm.lda(layout.contactsPrev + (bit >> 3));
  asm.aluN("and", 1 << (bit & 7));
  ctx.far("nz", seen);
}

function emitContactSet(ctx: SmsCtx, bit: number): void {
  const { asm, layout } = ctx;
  asm.lda(layout.contacts + (bit >> 3));
  asm.aluN("or", 1 << (bit & 7));
  asm.sta(layout.contacts + (bit >> 3));
}

/**
 * One pair of objects, looped over the others rather than copied per pair.
 *
 * This is where a game like the shooter lives or dies. Three shots against nine
 * aliens is twenty-seven pairs, and each pair's *code* — the near test, the
 * staging, the overlap, the rule body, the separation, the contact bit — came to
 * about three hundred and fifty bytes here. Twenty-seven of those is nine
 * kilobytes of a thirty-two kilobyte cartridge, spent on twenty-seven copies of
 * the same program with a different address baked into each.
 *
 * So the other object's record goes in the loop pointer and the body is emitted
 * once. `EntityAddr` has had a `ptr` case since the interface was written and
 * `expr.ts` implements it, so a rule body needs no special handling at all:
 * `alien.visible as 0` becomes four bytes through a pointer instead of four
 * absolute stores. What the loop adds is the *table* — the other's address, and
 * the byte and mask of its contact bit — and a call to read a bit whose number is
 * no longer a constant.
 *
 * It is not always available, and the conditions are all "the pairs must agree
 * about something the unrolled form baked in":
 *
 *   - **The near-test margins**, which come from the pair's sizes in whole cells.
 *     Nine aliens of one class agree; an alien and a boss do not.
 *   - **Whether `visible` can change**, because a class whose visibility is fixed
 *     is guarded at compile time and one whose is not is guarded at run time.
 *
 * Where they disagree the caller unrolls, which is the same answer as before.
 */
function emitPairLoop(
  ctx: SmsCtx,
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

  // Everything the unrolled form decided per pair has to be one answer here.
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
    asm.ld16IdxFrom("ix", layout.loop);
    asm.ld16("bc", (margins.y << 8) | margins.x);
    asm.call(needNearBox(ctx));
    ctx.far("z", next);
  }
  emitStageBoxPtr(ctx, "b");
  asm.call(needOverlapPair(ctx));
  ctx.far("z", next);

  const afterFire = ctx.unique("pairFired");
  if (!event.level) emitContactBitPtr(ctx, table, "seen", afterFire);
  emitFire(ctx, rule, { subject, other });
  asm.label(afterFire);

  const noSeparate = ctx.unique("pairNoSep");
  // Re-stage before separating, because the rule that just fired may have moved
  // either box. This also restores the subject staging for the next entry, which
  // is why it comes before the visibility guards rather than after them.
  emitStageBox(ctx, subjectBase, "a");
  emitStageBoxPtr(ctx, "b");
  guardVisible(ctx, subjectId, noSeparate);
  if (guarded) guardVisiblePtr(ctx, noSeparate);
  asm.call(needOverlapPair(ctx));
  ctx.far("z", noSeparate);
  asm.call(needSeparatePair(ctx));
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

/**
 * The other half of the same idea: many subjects against the screen's edges.
 *
 * `when alien hits screenleft, screenright then xdirection as flip` is one rule
 * and nine objects, and unrolled it was nine copies of a test, a rule body, a
 * re-test and a push-back. The subject goes in the same pointer the pair loop
 * uses and the body is emitted once — `emitEdgeTest` and `emitEdgeSeparate` read
 * and write through an `EntityAddr` for exactly this reason, so neither has a
 * second version for the looped case.
 *
 * Only for a rule with edges and no others: a rule with both would need two
 * pointers and a two-dimensional contact table, and nothing in the library asks
 * for it. Visibility has to be one answer across the subjects, as it does there.
 */
function emitEdgeLoop(
  ctx: SmsCtx,
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
  // One byte-and-mask pair per edge, because a subject's edges are consecutive
  // bits and the loop's index says which subject rather than which bit.
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

export function emitCollisions(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (rule.event.kind !== "hits" || !ruleInScene(rule, scene)) continue;
    const range = layout.contactRanges.get(rule.id);
    if (!range) continue;
    const event = rule.event;

    // A rule that only meets the screen's edges is looped over its subjects; one
    // with others is looped over those instead, per subject.
    if (event.others.length === 0 && event.edges.length > 0) {
      const subjects: { id: number; base: number; bit: number }[] = [];
      let uniform = true;
      for (const [subjectIndex, subjectId] of event.subjects.entries()) {
        if (!inScene(ctx.program, scene, subjectId)) continue;
        if (!isMutable(ctx.analysis, subjectId, "visible")) {
          const instance = ctx.program.instances[subjectId] as InstanceDef;
          if ((instance.numbers["visible"] ?? 0) === 0) continue;
        }
        // The edge test reads the subject's size, so a class whose instances were
        // created at different sizes is not one loop.
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

      // Stage the subject's box once for the whole `others` loop; every path
      // through a pair leaves it current, so a pair that touches nothing costs
      // one copy rather than two.
      if (event.others.length > 0) emitStageBox(ctx, subjectBase, "a");

      // The others this subject really pairs with, and the contact bit each one
      // owns. Taken as a list first because a long one is *looped* rather than
      // unrolled — see {@link emitPairLoop}.
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
        // Reject the pair on whole cells first. Most pairs in most games are
        // nowhere near each other — in a scrolling level, most of them are not
        // even on the same screen — and this answers that in a few dozen cycles
        // instead of staging a box and running the full overlap test.
        const margins = nearMargins(ctx, subjectId, otherId);
        if (margins) {
          asm.ld16Idx("ix", otherBase);
          asm.ld16("bc", (margins.y << 8) | margins.x);
          asm.call(needNearBox(ctx));
          ctx.far("z", skip);
        }
        // Only the other box is staged here: the subject's was staged before the
        // loop and every path below leaves it current.
        emitStageBox(ctx, otherBase, "b");
        asm.call(needOverlapPair(ctx));
        ctx.far("z", skip);
        const afterFire = ctx.unique("otherFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: entityOf(ctx, otherId) });
        asm.label(afterFire);
        // Re-stage before separating, because the rule that just fired may have
        // moved either box. This also restores the subject staging for the next
        // pair, which is why it comes before the visibility guards rather than
        // after them.
        const noSeparate = ctx.unique("otherNoSep");
        emitStagePair(ctx, subjectBase, otherBase);
        // `visible 0` is inert — not drawn, *not collided with*, not moved — and
        // a rule that collected a coin by hiding it has said so by now.
        guardVisible(ctx, subjectId, noSeparate);
        guardVisible(ctx, otherId, noSeparate);
        asm.call(needOverlapPair(ctx));
        ctx.far("z", noSeparate);
        asm.call(needSeparatePair(ctx));
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

export function emitEdgeRules(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (!ruleInScene(rule, scene)) continue;

    if (rule.event.kind === "input") {
      const set = rule.event.edge === "pressed" ? layout.pressed : layout.released;
      const action = rule.event.action;
      // An unguarded input rule has nothing to say unless the edge happened; a
      // guarded one is evaluated every tick so its `else` can run.
      const bit = ACTIONS.indexOf(action);
      const skip = ctx.unique("inputSkip");
      if (rule.guard === undefined) {
        asm.lda(set);
        asm.aluN("and", 1 << bit);
        ctx.far("z", skip);
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        const notFired = ctx.unique("inputNo");
        const fired = ctx.unique("inputYes");
        asm.lda(set);
        asm.aluN("and", 1 << bit);
        ctx.far("z", notFired);
        asm.ldn("a", 1);
        asm.jp(fired);
        asm.label(notFired);
        asm.alu("xor", "a");
        asm.label(fired);
        asm.sta(layout.scratch + S.w0);
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

/** Run one subject binding of an edge rule, with the trigger's verdict in a byte
 * when it is not statically known. */
function emitSubjectFire(
  ctx: SmsCtx,
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
      ctx.far("z", falseLabel);
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
function emitReaches(ctx: SmsCtx, rule: RuleDef, scene: SceneCtx): void {
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
      sub32(ctx, delta, right.addr);
    });
  });

  copy32(ctx, previous, valueAddr);
  copy32(ctx, valueAddr, delta);
  const hadHistory = ctx.unique("reachHistory");
  const done = ctx.unique("reachDone");
  loadByte(ctx, flagAddr);
  ctx.far("nz", hadHistory);
  asm.ldn("a", 1);
  asm.sta(flagAddr);
  asm.jp(done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the sign
  // changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  branchZero32(ctx, previous, notFired);
  branchZero32(ctx, delta, fired);
  asm.lda(mem(delta, 3));
  asm.ld16("hl", mem(previous, 3));
  asm.alu("xor", "hlp");
  asm.aluN("and", 0x80);
  ctx.far("z", notFired);
  asm.label(fired);
  asm.ldn("a", 1);
  asm.sta(firedFlag);
  const run = ctx.unique("reachRun");
  asm.jp(run);
  asm.label(notFired);
  asm.alu("xor", "a");
  asm.sta(firedFlag);
  asm.label(run);

  if (rule.guard === undefined) {
    const skip = ctx.unique("reachSkip");
    loadByte(ctx, firedFlag);
    ctx.far("z", skip);
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
export function emitCamera(ctx: SmsCtx, scene: SceneCtx): void {
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
      copy32(ctx, camera + offset, value.addr);
    });
    addConst32(ctx, camera + offset, -half);
    const clampHigh = ctx.unique("camHigh");
    const done = ctx.unique("camDone");
    branchLess32(ctx, camera + offset, ctx.constant(0), clampHigh, false);
    set32(ctx, camera + offset, 0);
    asm.jp(done);
    asm.label(clampHigh);
    branchLess32(ctx, ctx.constant(max), camera + offset, done, false);
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
