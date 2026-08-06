/**
 * The tick, compiled for the TLCS-900/H.
 *
 * `sim.ts` is the specification and this is a conformance implementation of it,
 * the same way every other backend is. The *order* of the steps is not here at
 * all — `emitTickSteps` runs them (see `codegen/backend.ts`) — and every decision
 * about which rule can fire where is `shape.ts`'s. What is left is this machine's
 * instructions, and four places where they are shaped differently from the
 * Mega Drive's:
 *
 *   - **A predicate answers in the carry flag.** `scf` and `rcf` are a byte each
 *     and `ret` does not disturb them, so a routine that decides something
 *     returns with the carry set for yes — and the caller's branch is the next
 *     instruction, with nothing in between that could clobber the answer. The
 *     68000 backend returns a value in `d0` and relies on `moveq` setting the
 *     codes; this is the same trick with one fewer moving part.
 *   - **Copying a box is one instruction.** `ldir` walks a run from `(XHL)` to
 *     `(XDE)` with `BC` counting, so staging a collision box is a block move
 *     rather than four loads and four stores — and the same instruction commits
 *     the two properties back afterwards.
 *   - **A byte test is a compare against memory.** A load sets no flags on this
 *     processor, so `cp (addr),#0` is the test, and `bit` puts the *inverse* of a
 *     bit into `Z` — which is why every button test below branches on `z` to
 *     skip rather than on `ne` to take.
 *   - **The cell an object sits in is the high word of its coordinate, at offset
 *     two.** This machine is little-endian, unlike the Mega Drive, so a backend
 *     that copied that one's `CELL_OFFSET = 0` would compare fractions in the
 *     cheap near test and cull everything.
 */

import { label, type Ref } from "@demake/core";

import { fromInt, ONE as FIXED_ONE } from "../../fixed.js";
import type { CAssignment, ControlDef, Edge, InstanceDef, RuleDef } from "../../program.js";
import { ACTIONS } from "../../program.js";
import { holdTargets, isMutable } from "../analyze.js";
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
  SIDE_BITS,
  sideMask,
  subjectBindings,
  type Binding,
  type EntityAddr,
  type SceneCtx,
} from "../shape.js";

import type { NgpcCtx } from "./ctx.js";
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
import { at as based } from "./ops.js";
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
  mul32,
  neg32,
  set32,
  sub32,
} from "./val.js";

export type { SceneCtx };

/**
 * Where a 16.16 value's whole-cell part is.
 *
 * Two, because this machine stores the low half first. Named rather than written
 * as a literal because the Mega Drive says zero and a reader moving between the
 * two needs to see that the difference is the byte order and not an accident.
 */
export const CELL_OFFSET = 2;

/** Named words in `layout.scratch`, which is eight bytes on every console. */
export const S = { w0: 0, w1: 2, w2: 4, w3: 6 } as const;

/** Test a byte and set the flags from it. A load would set none. */
function loadByte(ctx: NgpcCtx, address: Ref): void {
  ctx.asm.aluMemImm("cp", at(address), "b", 0);
}

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and
 * an object whose `visible` no assignment can reach is decided here rather than
 * every tick.
 */
function guardVisible(ctx: NgpcCtx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  branchZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"), skip);
  return "runtime";
}

/** The same, for the record a loop is walking rather than one the compiler named. */
function guardVisiblePtr(ctx: NgpcCtx, skip: string): void {
  const { asm, layout } = ctx;
  asm.ldm("xix", at(layout.loop as number));
  asm.ldm("xwa", based("xix", propOffset("visible")));
  asm.alu("or", "xwa", "xwa");
  ctx.far("z", skip);
}

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 */
export function emitAssignments(
  ctx: NgpcCtx,
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

  if (sceneTarget !== undefined) {
    asm.stmi(at(layout.pending), "b", sceneTarget);
  }
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 */
function emitFire(ctx: NgpcCtx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
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
    ctx.far("t", done);
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
export function emitSound(ctx: NgpcCtx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  if (ctx.audio.driver && index >= 0) {
    ctx.asm.stmi(at(ctx.audio.request), "b", index + 1);
  }
  if (ctx.audio.trace !== null) {
    ctx.asm.stmi(at(ctx.audio.trace), "b", rule.sound);
  }
}

// --- 2. controls -------------------------------------------------------------

/**
 * Test an abstract button against one of the three input sets, and jump when it
 * is down (`set`) or when it is not (`clear`).
 *
 * `bit` puts the *inverse* of the bit into `Z`, so "the button is not down" is
 * `z` — the opposite spelling from the 68000's `btst`, and the same answer.
 */
function emitButton(
  ctx: NgpcCtx,
  set: number,
  action: string,
  target: string,
  when: "set" | "clear",
): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.bitMem(bit, at(set));
  ctx.far(when === "set" ? "nz" : "z", target);
}

/** Which input set a control's mode fires on. */
function inputSet(ctx: NgpcCtx, mode: ControlDef["mode"]): number {
  const { layout } = ctx;
  if (mode === "press") return layout.pressed;
  return mode === "release" ? layout.released : layout.held;
}

export function emitControls(ctx: NgpcCtx, scene: SceneCtx): void {
  const { asm } = ctx;

  emitHoldEdges(ctx, scene);

  for (const control of ctx.program.controls) {
    if (!inScene(ctx.program, scene, control.instanceId)) continue;
    const skip = ctx.unique("ctlSkip");
    emitButton(ctx, inputSet(ctx, control.mode), control.action, skip, "clear");
    emitAssignments(ctx, control.assignments, UNBOUND);
    asm.label(skip);
  }
}

/**
 * Save and restore the properties `on hold` controls write.
 *
 * One slot per property rather than per binding, and keyed on the button being
 * *down* rather than on its press edge. `sim.ts`'s `updateHolds` is the
 * specification and states why both of those are load-bearing.
 */
function emitHoldEdges(ctx: NgpcCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const [slot, target] of holdTargets(ctx.program).entries()) {
    const bindings = target.controls
      .map((index) => ctx.program.controls[index] as ControlDef)
      .filter((control) => inScene(ctx.program, scene, control.instanceId));
    if (bindings.length === 0) continue;

    const entity = entityOf(ctx, target.instanceId);
    const flag = layout.holdFlags + slot;
    const value = layout.holdValues + slot * PROP_SIZE;
    const down = ctx.unique("holdDown");
    const done = ctx.unique("holdDone");

    for (const control of bindings) {
      emitButton(ctx, layout.held, control.action, down, "set");
    }

    // Nothing is asking for the property: put back what was saved, once.
    loadByte(ctx, flag);
    ctx.far("z", done);
    asm.stmi(at(flag), "b", 0);
    writeProp(ctx, entity, target.prop, value);
    ctx.far("t", done);

    // Something is: save what the property held before anything was.
    asm.label(down);
    loadByte(ctx, flag);
    ctx.far("nz", done);
    asm.stmi(at(flag), "b", 1);
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, value, current.addr);
    });
    asm.label(done);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: NgpcCtx, scene: SceneCtx): void {
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
function moveShape(ctx: NgpcCtx, id: number): string {
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

export function emitIntegrate(ctx: NgpcCtx, scene: SceneCtx): void {
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
function emitMoveLoop(ctx: NgpcCtx, ids: readonly number[]): boolean {
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
 * close is nothing, so the unrolled form is byte-for-byte what it always was.
 */
function openProp(
  ctx: NgpcCtx,
  entity: EntityAddr,
  prop: string,
): { addr: Ref; close: () => void } {
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
  ctx: NgpcCtx,
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
    // Speed is fixed, so the step for a whole direction is a constant: the
    // common case becomes an add, with no multiply and no divide.
    const forward = perTick(FIXED_ONE, speedFixed, profile.fps);
    const backward = perTick(-FIXED_ONE, speedFixed, profile.fps);
    const notForward = ctx.unique("axisNotFwd");
    const notBackward = ctx.unique("axisNotBack");

    branchUnlessConst32(ctx, dirAddr, FIXED_ONE, notForward);
    if (forward !== 0) {
      addConst32(ctx, posAddr, forward);
      clamp32(ctx, posAddr);
    }
    ctx.far("t", done);
    asm.label(notForward);
    branchUnlessConst32(ctx, dirAddr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    ctx.far("t", done);
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

/** Fewest entries worth a loop rather than a copy each. */
const LOOP_PAIRS = 3;

/**
 * Open a loop over a table of record addresses, leaving the cursor set.
 *
 * `layout.loop` is a four-byte pointer and the word after it is the index. Both
 * are memory rather than registers because a rule body fires inside the loop and
 * may use every register the machine has.
 */
function emitLoopHead(ctx: NgpcCtx, table: string): string {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  const loop = ctx.unique("walkLoop");
  asm.stmi(at(ptr + 4), "w", 0);
  asm.label(loop);
  asm.ldm("wa", at(ptr + 4));
  // The index is a word in a four-byte register, and the shift that scales it to
  // a table entry would carry whatever was above it into the address.
  asm.extz("xwa");
  asm.shift("sla", 2, "xwa");
  asm.ldn("xhl", label(table));
  asm.alu("add", "xhl", "xwa");
  asm.ldm("xwa", based("xhl"));
  asm.stm(at(ptr), "xwa");
  return loop;
}

/** Step the cursor and go round again while entries remain. */
function emitLoopNext(ctx: NgpcCtx, loop: string, count: number): void {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  asm.incMem(1, at(ptr + 4), "w");
  asm.aluMemImm("cp", at(ptr + 4), "w", count);
  ctx.far("ult", loop);
}

/** The addresses a loop walks, emitted after the code with the other tables. */
function emitEntityTable(ctx: NgpcCtx, table: string, bases: readonly number[]): void {
  ctx.data((data) => {
    data.label(table);
    for (const base of bases) data.dd(base);
  });
}

/**
 * `B` = the contact byte's offset and `C` = its mask, for the current entry.
 *
 * A contact bit is a compile-time constant in the unrolled form; a loop knows
 * only an index, so the byte and the mask are tables rather than arithmetic. The
 * caller puts the two table addresses in `XIY` and `XIZ`.
 */
function needContactSlot(ctx: NgpcCtx): Ref {
  return ctx.need("ContactSlot", (inner) => {
    const { asm, layout } = inner;
    asm.ldm("wa", at((layout.loop as number) + 4));
    asm.extz("xwa");
    asm.alu("add", "xiy", "xwa");
    asm.alu("add", "xiz", "xwa");
    asm.ldm("b", based("xiy"));
    asm.ldm("c", based("xiz"));
    asm.ret();
  });
}

/** Test or set this entry's contact bit, whose number is only known at run time. */
function emitContactBitPtr(
  ctx: NgpcCtx,
  table: string,
  what: "seen" | "set",
  seen?: string,
  edge?: number,
): void {
  const { asm, layout } = ctx;
  const suffix = edge === undefined ? "" : String(edge);
  asm.ldn("xiy", label(`${table}Byte${suffix}`));
  asm.ldn("xiz", label(`${table}Mask${suffix}`));
  asm.call(needContactSlot(ctx));
  // The byte's address: the base plus the offset the table gave, which arrives
  // in `B` and is widened by clearing the register it goes into first.
  asm.ldn("xhl", what === "seen" ? layout.contactsPrev : layout.contacts);
  asm.ldn("xwa", 0);
  asm.ld("a", "b");
  asm.alu("add", "xhl", "xwa");
  if (what === "seen") {
    asm.ldm("a", based("xhl"));
    asm.alu("and", "a", "c");
    ctx.far("nz", seen as string);
    return;
  }
  asm.aluToMem("or", based("xhl"), "c");
}

/** The byte-and-mask tables one contact bit per entry needs. */
function emitContactTables(
  ctx: NgpcCtx,
  table: string,
  bits: readonly number[],
  suffix = "",
): void {
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
  ctx: NgpcCtx,
  entity: EntityAddr,
  edge: Edge,
  scene: SceneCtx,
  skip: string,
): void {
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

/**
 * Push the subject back inside the playfield. The interpreter does not clamp
 * here, and neither does this.
 */
function emitEdgeSeparate(ctx: NgpcCtx, entity: EntityAddr, edge: Edge, scene: SceneCtx): void {
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
 * The source goes in `XHL` and the destination is baked into the routine, which
 * is one `ldir` — a block move rather than the four loads and four stores the
 * 68000 unrolls.
 */
function emitStageBox(ctx: NgpcCtx, src: number, slot: "a" | "b"): void {
  const { asm } = ctx;
  asm.ldn("xhl", src);
  asm.call(needCopyBox(ctx, slot));
}

/** The routine that stages a box; it takes the record's address in `XHL`. */
function needCopyBox(ctx: NgpcCtx, slot: "a" | "b"): Ref {
  const dst = (slot === "a" ? ctx.layout.pairA : ctx.layout.pairB) as number;
  return ctx.need(`CopyBox${slot.toUpperCase()}`, (inner) => {
    const { asm } = inner;
    asm.ldn("xde", dst);
    asm.ldn("bc", BOX_SIZE);
    asm.ldir(based("xde"), "b");
    asm.ret();
  });
}

/** The same, for the record the loop pointer names. */
function emitStageBoxPtr(ctx: NgpcCtx, slot: "a" | "b"): void {
  const { asm, layout } = ctx;
  asm.ldm("xhl", at(layout.loop as number));
  asm.call(needCopyBox(ctx, slot));
}

function emitStagePair(ctx: NgpcCtx, a: number, b: number): void {
  emitStageBox(ctx, a, "a");
  emitStageBox(ctx, b, "b");
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * The carry is set when the staged boxes overlap and clear when they do not.
 *
 * A flag rather than a value, because `ret` leaves the flags alone and the
 * caller's branch is then the next instruction. Half-open on both axes, matching
 * the interpreter and matching tile contact.
 */
function needOverlapPair(ctx: NgpcCtx): Ref {
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
    asm.scf();
    asm.ret();
    asm.label(apart);
    asm.rcf();
    asm.ret();
  });
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 */
function needSeparatePair(ctx: NgpcCtx): Ref {
  return ctx.need("SeparatePair", (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const useY = inner.unique("sepUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
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
 * The push along each axis, branching to `useY` when the y axis is shallower.
 *
 * The half of separation that *decides*, split out from the half that applies —
 * because `from above` and the push that follows it are the same arithmetic read
 * twice (`level/scene.ts` §contactOf), and two copies of it could disagree.
 */
function emitPairPushes(ctx: NgpcCtx, useY: string): { xPush: number; yPush: number } {
  const { asm, layout } = ctx;
  const a = layout.pairA as number;
  const b = layout.pairB as number;
  const work = layout.pairWork as number;
  const xPush = work;
  const yPush = work + 4;
  const near = work + 8;
  const far = work + 12;

  const axis = (pos: string, size: string, push: number): void => {
    // near = a.pos + a.size - b.pos ; far = b.pos + b.size - a.pos
    copy32(ctx, near, boxProp(a, pos));
    add32(ctx, near, boxProp(a, size));
    sub32(ctx, near, boxProp(b, pos));
    copy32(ctx, far, boxProp(b, pos));
    add32(ctx, far, boxProp(b, size));
    sub32(ctx, far, boxProp(a, pos));
    const takeFar = ctx.unique("sepFar");
    const done = ctx.unique("sepDone");
    branchLess32(ctx, near, far, takeFar, false);
    copy32(ctx, push, near);
    neg32(ctx, push);
    ctx.far("t", done);
    asm.label(takeFar);
    copy32(ctx, push, far);
    asm.label(done);
  };

  axis("x", "width", xPush);
  axis("y", "height", yPush);

  // |xPush| < |yPush| decides the axis.
  copy32(ctx, near, xPush);
  abs32(ctx, near);
  copy32(ctx, far, yPush);
  abs32(ctx, far);
  branchLess32(ctx, near, far, useY, false);
  return { xPush, yPush };
}

/**
 * `A` = the {@link SIDE_BITS} bit for the side the staged pair sits on.
 *
 * Pulled only by a rule that says `from`, so a game without one ships none of
 * it — and a routine of its own rather than a return value bolted onto
 * `SeparatePair`, because the interpreter asks *before* the rule body runs and
 * separates *after* it (`sim.ts` §resolveCollisions). It answers in a register
 * rather than in the carry `OverlapPair` uses, because there are four answers
 * and a flag holds one.
 */
function needContactSide(ctx: NgpcCtx): Ref {
  return ctx.need("ContactSide", (inner) => {
    const { asm } = inner;
    const useY = inner.unique("sideUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
    const negative = inner.unique("sideNeg");
    const below = inner.unique("sideBelow");
    // A 16.16 value is a register here, so its sign is one `or` against itself.
    asm.ldm("xwa", at(xPush));
    asm.alu("or", "xwa", "xwa");
    inner.far("mi", negative);
    asm.ldn("a", SIDE_BITS["right"] as number);
    asm.ret();
    asm.label(negative);
    asm.ldn("a", SIDE_BITS["left"] as number);
    asm.ret();
    asm.label(useY);
    asm.ldm("xwa", at(yPush));
    asm.alu("or", "xwa", "xwa");
    inner.far("pl", below);
    asm.ldn("a", SIDE_BITS["above"] as number);
    asm.ret();
    asm.label(below);
    asm.ldn("a", SIDE_BITS["below"] as number);
    asm.ret();
  });
}

/**
 * Skip the whole contact when the staged pair is not on a side the rule named.
 *
 * The narrowing reaches the separation and the contact bit as well as the
 * firing: a side the rule did not name is a contact that never happened, so it
 * pushes nothing apart and records nothing either (`sim.ts` §resolveCollisions).
 * A rule with no `from` emits not one instruction.
 */
function emitSideGate(ctx: NgpcCtx, sides: readonly string[], skip: string): void {
  const mask = sideMask(sides);
  if (mask === 0) return;
  ctx.asm.call(needContactSide(ctx));
  ctx.asm.aluImm("and", "a", mask);
  ctx.far("z", skip);
}

/**
 * `XIY` = the other object's record, the margins in two scratch words → the
 * carry clear when the two boxes are certainly apart.
 *
 * Like the sprite cull this compares *cells* — the high word of a 16.16
 * coordinate, at offset two on this little-endian machine — so it is a subtract
 * and two sign tests per axis, against the several hundred cycles a staged box
 * and a full overlap test cost. Two boxes can only overlap if their cells are
 * within the wider of the two, so rounding the margin outward by one keeps it
 * conservative: it may say "maybe" when the answer is no, never the reverse.
 */
function needNearBox(ctx: NgpcCtx): Ref {
  return ctx.need("NearBox", (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");

    const axis = (offset: number, margin: number): void => {
      asm.ldm("hl", based("xiy", offset + CELL_OFFSET));
      asm.aluMem("sub", "hl", at(subject + offset + CELL_OFFSET));
      // delta + margin < 0, or delta - margin - 1 >= 0, means certainly apart.
      asm.ld("de", "hl");
      asm.aluMem("add", "de", at(margin));
      inner.far("mi", apart);
      asm.ld("de", "hl");
      asm.aluMem("sub", "de", at(margin));
      asm.dec(1, "de");
      inner.far("pl", apart);
    };
    axis(propOffset("x"), layout.scratch + S.w2);
    axis(propOffset("y"), layout.scratch + S.w3);

    asm.scf();
    asm.ret();
    asm.label(apart);
    asm.rcf();
    asm.ret();
  });
}

/** Put the two near-test margins where {@link needNearBox} expects them. */
function emitNearMargins(ctx: NgpcCtx, margins: { x: number; y: number }): void {
  const { asm, layout } = ctx;
  asm.stmi(at(layout.scratch + S.w2), "w", margins.x);
  asm.stmi(at(layout.scratch + S.w3), "w", margins.y);
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: NgpcCtx, entity: number): void {
  const { asm, layout } = ctx;
  asm.ldn("xhl", layout.pairA as number);
  asm.ldn("xde", entity);
  asm.ldn("bc", 2 * PROP_SIZE);
  asm.ldir(based("xde"), "b");
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: NgpcCtx, bit: number, seen: string): void {
  ctx.asm.bitMem(bit & 7, at(ctx.layout.contactsPrev + (bit >> 3)));
  ctx.far("nz", seen);
}

function emitContactSet(ctx: NgpcCtx, bit: number): void {
  ctx.asm.setMem(bit & 7, at(ctx.layout.contacts + (bit >> 3)));
}

/**
 * One pair of objects, looped over the others rather than copied per pair.
 *
 * The reasoning is every other backend's, arrived at here for the same reason:
 * three shots against nine aliens is twenty-seven pairs, and twenty-seven copies
 * of a near test, a staging, an overlap, a rule body, a separation and a contact
 * bit is most of a cartridge. It is only taken where the pairs agree about what
 * an unrolled copy would have baked in.
 */
function emitPairLoop(
  ctx: NgpcCtx,
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
    asm.ldm("xiy", at(layout.loop));
    emitNearMargins(ctx, margins);
    asm.call(needNearBox(ctx));
    ctx.far("nc", next);
  }
  emitStageBoxPtr(ctx, "b");
  asm.call(needOverlapPair(ctx));
  ctx.far("nc", next);
  emitSideGate(ctx, event.sides, next);

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
  asm.call(needOverlapPair(ctx));
  ctx.far("nc", noSeparate);
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

/** The other half of the same idea: many subjects against the screen's edges. */
function emitEdgeLoop(
  ctx: NgpcCtx,
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

export function emitCollisions(ctx: NgpcCtx, scene: SceneCtx): void {
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
          asm.ldn("xiy", otherBase);
          emitNearMargins(ctx, margins);
          asm.call(needNearBox(ctx));
          ctx.far("nc", skip);
        }
        emitStageBox(ctx, otherBase, "b");
        asm.call(needOverlapPair(ctx));
        ctx.far("nc", skip);
        emitSideGate(ctx, event.sides, skip);
        const afterFire = ctx.unique("otherFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: entityOf(ctx, otherId) });
        asm.label(afterFire);
        const noSeparate = ctx.unique("otherNoSep");
        emitStagePair(ctx, subjectBase, otherBase);
        guardVisible(ctx, subjectId, noSeparate);
        guardVisible(ctx, otherId, noSeparate);
        asm.call(needOverlapPair(ctx));
        ctx.far("nc", noSeparate);
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

export function emitEdgeRules(ctx: NgpcCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (!ruleInScene(rule, scene)) continue;

    if (rule.event.kind === "input") {
      const set = rule.event.edge === "pressed" ? layout.pressed : layout.released;
      const action = rule.event.action;
      const bit = ACTIONS.indexOf(action);
      const skip = ctx.unique("inputSkip");
      if (rule.guard === undefined) {
        asm.bitMem(bit, at(set));
        ctx.far("z", skip);
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        const notFired = ctx.unique("inputNo");
        const fired = ctx.unique("inputYes");
        asm.bitMem(bit, at(set));
        ctx.far("z", notFired);
        asm.stmi(at(layout.scratch + S.w0), "b", 1);
        ctx.far("t", fired);
        asm.label(notFired);
        asm.stmi(at(layout.scratch + S.w0), "b", 0);
        asm.label(fired);
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
  ctx: NgpcCtx,
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
function emitReaches(ctx: NgpcCtx, rule: RuleDef, scene: SceneCtx): void {
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
  asm.stmi(at(flagAddr), "b", 1);
  ctx.far("t", done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the sign
  // changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  branchZero32(ctx, previous, notFired);
  branchZero32(ctx, delta, fired);
  asm.ldm("xwa", at(delta));
  asm.ldm("xbc", at(previous));
  asm.alu("xor", "xwa", "xbc");
  ctx.far("pl", notFired);
  asm.label(fired);
  asm.stmi(at(firedFlag), "b", 1);
  const run = ctx.unique("reachRun");
  ctx.far("t", run);
  asm.label(notFired);
  asm.stmi(at(firedFlag), "b", 0);
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
export function emitCamera(ctx: NgpcCtx, scene: SceneCtx): void {
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
    ctx.far("t", done);
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
