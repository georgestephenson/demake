/**
 * The tick, compiled for the V810.
 *
 * `sim.ts` is the specification and this is a conformance implementation of it,
 * the same way every other backend is. The *order* of the steps is not here at
 * all — `emitTickSteps` runs them (see `codegen/backend.ts`) — and every decision
 * about which rule can fire where is `shape.ts`'s. What is left is this machine's
 * instructions, and four places where they are shaped differently from the Neo
 * Geo Pocket's:
 *
 *   - **A predicate answers in a register, not in a flag.** This processor has
 *     no way to set or clear the carry directly, so the routines that decide
 *     something — does this pair overlap, are these two boxes near — leave 1 or 0
 *     in {@link ANSWER} and the caller tests it. Two instructions against the
 *     TLCS-900/H's one, and no hidden dependency on what `ret` does to the flags.
 *   - **Copying a box is eight instructions, not one.** There is no block move,
 *     so `CopyBox` is four loads and four stores — which is still a *routine*
 *     rather than inline, because a game stages a box hundreds of times and the
 *     call is two instructions.
 *   - **A byte test is a mask that sets the flags itself.** `andi` leaves `Z`,
 *     so a button test is a zero-extending load, an `andi` and a branch, with no
 *     separate comparison anywhere.
 *   - **The cell an object sits in is the high halfword of its coordinate, at
 *     offset two.** This machine is little-endian, like the Neo Geo Pocket and
 *     unlike the Mega Drive, so a backend that copied that one's `CELL_OFFSET`
 *     would compare fractions in the cheap near test and cull everything.
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

import type { VbCtx } from "./ctx.js";
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
import { ARG, E0, E2, E3, E4, E5, E6, E7, LP, RAM, T0, T1, T2, ZERO, ramDisp } from "./regs.js";
import { CELL_OFFSET } from "./tiles.js";
import {
  abs32,
  add32,
  addConst32,
  address,
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
export { CELL_OFFSET };

/** Named words in `layout.scratch`, which is eight bytes on every console. */
export const S = { w0: 0, w1: 2, w2: 4, w3: 6 } as const;

/**
 * Where a routine that decides something leaves its answer: 1 for yes, 0 for no.
 *
 * A register rather than the carry every other backend uses, because this
 * processor has no `scf`/`rcf` pair — the flags are only ever set as a side
 * effect of arithmetic. The cost is one comparison at each call site and the gain
 * is that nothing depends on what a return does to the condition codes.
 */
const ANSWER = E7;

/** Test a byte and set the flags from it. */
function loadByte(ctx: VbCtx, address: number): void {
  ctx.asm.inb(ramDisp(address), RAM, T0);
  ctx.asm.cmpImm5(0, T0);
}

/** Store a constant byte. */
function storeByte(ctx: VbCtx, address: number, value: number): void {
  if (value === 0) {
    ctx.asm.stb(ZERO, ramDisp(address), RAM);
    return;
  }
  ctx.asm.movImm32(value & 0xff, T0);
  ctx.asm.stb(T0, ramDisp(address), RAM);
}

/** Store a constant halfword. */
function storeWord(ctx: VbCtx, address: number, value: number): void {
  if (value === 0) {
    ctx.asm.sth(ZERO, ramDisp(address), RAM);
    return;
  }
  ctx.asm.movImm32(value & 0xffff, T0);
  ctx.asm.sth(T0, ramDisp(address), RAM);
}

/** Branch on the answer a decision routine left behind. */
function branchAnswer(ctx: VbCtx, target: string, when: "yes" | "no"): void {
  ctx.asm.cmpImm5(0, ANSWER);
  ctx.far(when === "yes" ? "ne" : "e", target);
}

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and
 * an object whose `visible` no assignment can reach is decided here rather than
 * every tick.
 */
function guardVisible(ctx: VbCtx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  branchZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"), skip);
  return "runtime";
}

/** The same, for the record a loop is walking rather than one the compiler named. */
function guardVisiblePtr(ctx: VbCtx, skip: string): void {
  const { asm, layout } = ctx;
  asm.ldw(ramDisp(layout.loop as number), RAM, T2);
  asm.ldw(propOffset("visible"), T2, T0);
  asm.cmpImm5(0, T0);
  ctx.far("e", skip);
}

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 */
export function emitAssignments(
  ctx: VbCtx,
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

  if (sceneTarget !== undefined) storeByte(ctx, layout.pending, sceneTarget);
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 */
function emitFire(ctx: VbCtx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
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
    ctx.jump(done);
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
export function emitSound(ctx: VbCtx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  if (ctx.audio.driver && index >= 0) storeByte(ctx, ctx.audio.request, index + 1);
  if (ctx.audio.trace !== null) storeByte(ctx, ctx.audio.trace, rule.sound);
}

// --- 2. controls -------------------------------------------------------------

/**
 * Test an abstract button against one of the three input sets, and jump when it
 * is down (`set`) or when it is not (`clear`).
 *
 * `andi` sets `Z` from what it computed, so there is no comparison between the
 * mask and the branch — which is the one place this machine is shorter than the
 * TLCS-900/H's `bit`, whose answer is the *inverse* of the bit.
 */
function emitButton(
  ctx: VbCtx,
  set: number,
  action: string,
  target: string,
  when: "set" | "clear",
): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.inb(ramDisp(set), RAM, T0);
  ctx.asm.andi(1 << bit, T0, T0);
  ctx.far(when === "set" ? "ne" : "e", target);
}

/** Which input set a control's mode fires on. */
function inputSet(ctx: VbCtx, mode: ControlDef["mode"]): number {
  const { layout } = ctx;
  if (mode === "press") return layout.pressed;
  return mode === "release" ? layout.released : layout.held;
}

export function emitControls(ctx: VbCtx, scene: SceneCtx): void {
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
function emitHoldEdges(ctx: VbCtx, scene: SceneCtx): void {
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
    ctx.far("e", done);
    storeByte(ctx, flag, 0);
    writeProp(ctx, entity, target.prop, value);
    ctx.jump(done);

    // Something is: save what the property held before anything was.
    asm.label(down);
    loadByte(ctx, flag);
    ctx.far("ne", done);
    storeByte(ctx, flag, 1);
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, value, current.addr);
    });
    asm.label(done);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: VbCtx, scene: SceneCtx): void {
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
function moveShape(ctx: VbCtx, id: number): string {
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

export function emitIntegrate(ctx: VbCtx, scene: SceneCtx): void {
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
function emitMoveLoop(ctx: VbCtx, ids: readonly number[]): boolean {
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
function openProp(ctx: VbCtx, entity: EntityAddr, prop: string): { addr: Ref; close: () => void } {
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
  ctx: VbCtx,
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
    ctx.jump(done);
    asm.label(notForward);
    branchUnlessConst32(ctx, dirAddr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    ctx.jump(done);
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
 * `layout.loop` is a four-byte pointer and the halfword after it is the index.
 * Both are memory rather than registers because a rule body fires inside the
 * loop and may use every register the machine has.
 */
function emitLoopHead(ctx: VbCtx, table: string): string {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  const loop = ctx.unique("walkLoop");
  asm.sth(ZERO, ramDisp(ptr + 4), RAM);
  asm.label(loop);
  // Zero-extended: the index is a count, and a sign-extending load would scale a
  // negative into an address a long way from the table.
  asm.inh(ramDisp(ptr + 4), RAM, T0);
  asm.shlImm5(2, T0);
  asm.movImm32(label(table), T1);
  asm.add(T0, T1);
  asm.ldw(0, T1, T0);
  asm.stw(T0, ramDisp(ptr), RAM);
  return loop;
}

/** Step the cursor and go round again while entries remain. */
function emitLoopNext(ctx: VbCtx, loop: string, count: number): void {
  const { asm, layout } = ctx;
  const ptr = layout.loop as number;
  asm.inh(ramDisp(ptr + 4), RAM, T0);
  asm.addImm5(1, T0);
  asm.sth(T0, ramDisp(ptr + 4), RAM);
  asm.movImm32(count, T1);
  asm.cmp(T1, T0);
  ctx.far("l", loop);
}

/** The addresses a loop walks, emitted after the code with the other tables. */
function emitEntityTable(ctx: VbCtx, table: string, bases: readonly number[]): void {
  ctx.data((data) => {
    data.align(4);
    data.label(table);
    for (const base of bases) data.dd(base);
  });
}

/**
 * {@link E4} = the contact byte's offset and {@link E5} = its mask, for the
 * current entry.
 *
 * A contact bit is a compile-time constant in the unrolled form; a loop knows
 * only an index, so the byte and the mask are tables rather than arithmetic. The
 * caller puts the two table addresses in {@link E2} and {@link E3}.
 */
function needContactSlot(ctx: VbCtx): Ref {
  return ctx.need("ContactSlot", (inner) => {
    const { asm, layout } = inner;
    asm.inh(ramDisp((layout.loop as number) + 4), RAM, T0);
    asm.add(T0, E2);
    asm.add(T0, E3);
    asm.inb(0, E2, E4);
    asm.inb(0, E3, E5);
    asm.jmp(LP);
  });
}

/** Test or set this entry's contact bit, whose number is only known at run time. */
function emitContactBitPtr(
  ctx: VbCtx,
  table: string,
  what: "seen" | "set",
  seen?: string,
  edge?: number,
): void {
  const { asm, layout } = ctx;
  const suffix = edge === undefined ? "" : String(edge);
  asm.movImm32(label(`${table}Byte${suffix}`), E2);
  asm.movImm32(label(`${table}Mask${suffix}`), E3);
  asm.jal(needContactSlot(ctx));
  asm.movImm32(what === "seen" ? layout.contactsPrev : layout.contacts, E6);
  asm.add(E4, E6);
  asm.inb(0, E6, T0);
  if (what === "seen") {
    asm.and(E5, T0);
    ctx.far("ne", seen as string);
    return;
  }
  asm.or(E5, T0);
  asm.stb(T0, 0, E6);
}

/** The byte-and-mask tables one contact bit per entry needs. */
function emitContactTables(ctx: VbCtx, table: string, bits: readonly number[], suffix = ""): void {
  ctx.data((data) => {
    data.label(`${table}Byte${suffix}`);
    data.db(...bits.map((bit) => bit >> 3));
    data.label(`${table}Mask${suffix}`);
    data.db(...bits.map((bit) => 1 << (bit & 7)));
    // A run of bytes leaves the stream at whatever length it was; everything
    // after it — another table, the constant pool — is read a word at a time,
    // and an unaligned `ld.w` on this machine reads four bytes that begin
    // somewhere else rather than faulting.
    data.align(4);
  });
}

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(
  ctx: VbCtx,
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
function emitEdgeSeparate(ctx: VbCtx, entity: EntityAddr, edge: Edge, scene: SceneCtx): void {
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
 * The source address goes in {@link ARG} and the destination is baked into the
 * routine. Four loads and four stores rather than the Neo Geo Pocket's one
 * `ldir` — this processor has no block move — but still a routine rather than
 * inline, because a game with any collisions in it stages a box hundreds of
 * times and the call is two instructions.
 */
function emitStageBox(ctx: VbCtx, src: number, slot: "a" | "b"): void {
  address(ctx, src, ARG);
  ctx.asm.jal(needCopyBox(ctx, slot));
}

/** The routine that stages a box; it takes the record's address in {@link ARG}. */
function needCopyBox(ctx: VbCtx, slot: "a" | "b"): Ref {
  const dst = (slot === "a" ? ctx.layout.pairA : ctx.layout.pairB) as number;
  return ctx.need(`CopyBox${slot.toUpperCase()}`, (inner) => {
    const { asm } = inner;
    for (let offset = 0; offset < BOX_SIZE; offset += 4) {
      asm.ldw(offset, ARG, T0);
      asm.stw(T0, ramDisp(dst + offset), RAM);
    }
    asm.jmp(LP);
  });
}

/** The same, for the record the loop pointer names. */
function emitStageBoxPtr(ctx: VbCtx, slot: "a" | "b"): void {
  const { asm, layout } = ctx;
  asm.ldw(ramDisp(layout.loop as number), RAM, ARG);
  asm.jal(needCopyBox(ctx, slot));
}

function emitStagePair(ctx: VbCtx, a: number, b: number): void {
  emitStageBox(ctx, a, "a");
  emitStageBox(ctx, b, "b");
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * {@link ANSWER} is 1 when the staged boxes overlap and 0 when they do not.
 *
 * Half-open on both axes, matching the interpreter and matching tile contact.
 */
function needOverlapPair(ctx: VbCtx): Ref {
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
    asm.movImm5(1, ANSWER);
    asm.jmp(LP);
    asm.label(apart);
    asm.mov(ZERO, ANSWER);
    asm.jmp(LP);
  });
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 */
function needSeparatePair(ctx: VbCtx): Ref {
  return ctx.need("SeparatePair", (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const useY = inner.unique("sepUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
    add32(inner, boxProp(a, "x"), xPush);
    clamp32(inner, boxProp(a, "x"));
    asm.jmp(LP);
    asm.label(useY);
    add32(inner, boxProp(a, "y"), yPush);
    clamp32(inner, boxProp(a, "y"));
    asm.jmp(LP);
  });
}

/**
 * The push along each axis, branching to `useY` when the y axis is shallower.
 *
 * The half of separation that *decides*, split out from the half that applies —
 * because `from above` and the push that follows it are the same arithmetic read
 * twice (`level/scene.ts` §contactOf), and two copies of it could disagree.
 */
function emitPairPushes(ctx: VbCtx, useY: string): { xPush: number; yPush: number } {
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
    ctx.jump(done);
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
 * {@link E0} = the {@link SIDE_BITS} bit for the side the staged pair sits on.
 *
 * Pulled only by a rule that says `from`, so a game without one ships none of
 * it — and a routine of its own rather than a return value bolted onto
 * `SeparatePair`, because the interpreter asks *before* the rule body runs and
 * separates *after* it (`sim.ts` §resolveCollisions).
 */
function needContactSide(ctx: VbCtx): Ref {
  return ctx.need("ContactSide", (inner) => {
    const { asm } = inner;
    const useY = inner.unique("sideUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
    const negative = inner.unique("sideNeg");
    const below = inner.unique("sideBelow");
    asm.ldw(ramDisp(xPush), RAM, T0);
    asm.cmpImm5(0, T0);
    inner.far("lt", negative);
    asm.movImm32(SIDE_BITS["right"] as number, E0);
    asm.jmp(LP);
    asm.label(negative);
    asm.movImm32(SIDE_BITS["left"] as number, E0);
    asm.jmp(LP);
    asm.label(useY);
    asm.ldw(ramDisp(yPush), RAM, T0);
    asm.cmpImm5(0, T0);
    inner.far("ge", below);
    asm.movImm32(SIDE_BITS["above"] as number, E0);
    asm.jmp(LP);
    asm.label(below);
    asm.movImm32(SIDE_BITS["below"] as number, E0);
    asm.jmp(LP);
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
function emitSideGate(ctx: VbCtx, sides: readonly string[], skip: string): void {
  const mask = sideMask(sides);
  if (mask === 0) return;
  ctx.asm.jal(needContactSide(ctx));
  ctx.asm.andi(mask, E0, T0);
  ctx.far("e", skip);
}

/**
 * {@link E6} = the other object's record, the margins in two scratch words →
 * {@link ANSWER} 0 when the two boxes are certainly apart.
 *
 * Like the sprite cull this compares *cells* — the high halfword of a 16.16
 * coordinate, at offset two on this little-endian machine — so it is a subtract
 * and two sign tests per axis, against the several hundred cycles a staged box
 * and a full overlap test cost. Two boxes can only overlap if their cells are
 * within the wider of the two, so rounding the margin outward by one keeps it
 * conservative: it may say "maybe" when the answer is no, never the reverse.
 */
function needNearBox(ctx: VbCtx): Ref {
  return ctx.need("NearBox", (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");

    const axis = (offset: number, margin: number): void => {
      asm.ldh(offset + CELL_OFFSET, E6, T0);
      asm.ldh(ramDisp(subject + offset + CELL_OFFSET), RAM, T1);
      asm.sub(T1, T0); // delta, in whole cells
      asm.ldh(ramDisp(margin), RAM, T1);
      // delta + margin < 0, or delta - margin - 1 >= 0, means certainly apart.
      asm.mov(T0, T2);
      asm.add(T1, T2);
      asm.cmpImm5(0, T2);
      inner.far("lt", apart);
      asm.mov(T0, T2);
      asm.sub(T1, T2);
      asm.addImm5(-1, T2);
      asm.cmpImm5(0, T2);
      inner.far("ge", apart);
    };
    axis(propOffset("x"), layout.scratch + S.w2);
    axis(propOffset("y"), layout.scratch + S.w3);

    asm.movImm5(1, ANSWER);
    asm.jmp(LP);
    asm.label(apart);
    asm.mov(ZERO, ANSWER);
    asm.jmp(LP);
  });
}

/** Put the two near-test margins where {@link needNearBox} expects them. */
function emitNearMargins(ctx: VbCtx, margins: { x: number; y: number }): void {
  storeWord(ctx, ctx.layout.scratch + S.w2, margins.x);
  storeWord(ctx, ctx.layout.scratch + S.w3, margins.y);
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: VbCtx, entity: number): void {
  const { asm, layout } = ctx;
  const src = layout.pairA as number;
  for (let offset = 0; offset < 2 * PROP_SIZE; offset += 4) {
    asm.ldw(ramDisp(src + offset), RAM, T0);
    asm.stw(T0, ramDisp(entity + offset), RAM);
  }
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: VbCtx, bit: number, seen: string): void {
  ctx.asm.inb(ramDisp(ctx.layout.contactsPrev + (bit >> 3)), RAM, T0);
  ctx.asm.andi(1 << (bit & 7), T0, T0);
  ctx.far("ne", seen);
}

function emitContactSet(ctx: VbCtx, bit: number): void {
  const address = ctx.layout.contacts + (bit >> 3);
  ctx.asm.inb(ramDisp(address), RAM, T0);
  ctx.asm.ori(1 << (bit & 7), T0, T0);
  ctx.asm.stb(T0, ramDisp(address), RAM);
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
  ctx: VbCtx,
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
    asm.ldw(ramDisp(layout.loop), RAM, E6);
    emitNearMargins(ctx, margins);
    asm.jal(needNearBox(ctx));
    branchAnswer(ctx, next, "no");
  }
  emitStageBoxPtr(ctx, "b");
  asm.jal(needOverlapPair(ctx));
  branchAnswer(ctx, next, "no");
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
  asm.jal(needOverlapPair(ctx));
  branchAnswer(ctx, noSeparate, "no");
  asm.jal(needSeparatePair(ctx));
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
  ctx: VbCtx,
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

export function emitCollisions(ctx: VbCtx, scene: SceneCtx): void {
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
          asm.movImm32(otherBase, E6);
          emitNearMargins(ctx, margins);
          asm.jal(needNearBox(ctx));
          branchAnswer(ctx, skip, "no");
        }
        emitStageBox(ctx, otherBase, "b");
        asm.jal(needOverlapPair(ctx));
        branchAnswer(ctx, skip, "no");
        emitSideGate(ctx, event.sides, skip);
        const afterFire = ctx.unique("otherFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: entityOf(ctx, otherId) });
        asm.label(afterFire);
        const noSeparate = ctx.unique("otherNoSep");
        emitStagePair(ctx, subjectBase, otherBase);
        guardVisible(ctx, subjectId, noSeparate);
        guardVisible(ctx, otherId, noSeparate);
        asm.jal(needOverlapPair(ctx));
        branchAnswer(ctx, noSeparate, "no");
        asm.jal(needSeparatePair(ctx));
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

export function emitEdgeRules(ctx: VbCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (!ruleInScene(rule, scene)) continue;

    if (rule.event.kind === "input") {
      const set = rule.event.edge === "pressed" ? layout.pressed : layout.released;
      const action = rule.event.action;
      const bit = ACTIONS.indexOf(action);
      const skip = ctx.unique("inputSkip");
      if (rule.guard === undefined) {
        asm.inb(ramDisp(set), RAM, T0);
        asm.andi(1 << bit, T0, T0);
        ctx.far("e", skip);
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        const notFired = ctx.unique("inputNo");
        const fired = ctx.unique("inputYes");
        asm.inb(ramDisp(set), RAM, T0);
        asm.andi(1 << bit, T0, T0);
        ctx.far("e", notFired);
        storeByte(ctx, layout.scratch + S.w0, 1);
        ctx.jump(fired);
        asm.label(notFired);
        storeByte(ctx, layout.scratch + S.w0, 0);
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
  ctx: VbCtx,
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
      ctx.far("e", falseLabel);
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
function emitReaches(ctx: VbCtx, rule: RuleDef, scene: SceneCtx): void {
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
  ctx.far("ne", hadHistory);
  storeByte(ctx, flagAddr, 1);
  ctx.jump(done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the sign
  // changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  branchZero32(ctx, previous, notFired);
  branchZero32(ctx, delta, fired);
  asm.ldw(ramDisp(delta), RAM, T0);
  asm.ldw(ramDisp(previous), RAM, T1);
  // The exclusive-or's sign bit is set exactly when the two disagree, and `xor`
  // sets `S` from it — so the crossing test is one instruction and a branch.
  asm.xor(T1, T0);
  ctx.far("p", notFired);
  asm.label(fired);
  storeByte(ctx, firedFlag, 1);
  const run = ctx.unique("reachRun");
  ctx.jump(run);
  asm.label(notFired);
  storeByte(ctx, firedFlag, 0);
  asm.label(run);

  if (rule.guard === undefined) {
    const skip = ctx.unique("reachSkip");
    loadByte(ctx, firedFlag);
    ctx.far("e", skip);
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
export function emitCamera(ctx: VbCtx, scene: SceneCtx): void {
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
    ctx.jump(done);
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
