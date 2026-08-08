/**
 * The tick, compiled for the 6502.
 *
 * `sim.ts` is the specification and this is a conformance implementation of it,
 * the same way the Game Boy backend is. The *order* of the steps is not here at
 * all — `emitTickSteps` runs them (see `codegen/backend.ts`) — and every decision
 * about which rule can fire where is `shape.ts`'s. What is left is this machine's
 * instructions, and three places where they are shaped differently from the SM83's:
 *
 *   - **A box is staged through a pointer.** The overlap test and the separation
 *     work on two fixed addresses, exactly as on the Game Boy, so that they can be
 *     routines rather than a copy of themselves per pair — a bullet against nine
 *     aliens is twenty-seven pairs. But the *source* is a different entity each
 *     time, and this CPU reaches a variable address only through page zero, so the
 *     copy is a pointer write and a call.
 *   - **A cheap rejection reads the other object through that same pointer.**
 *     `NearBox` compares whole cells — the high half of a 16.16 coordinate — and
 *     rounds its margins outward, so it may answer "maybe" when the truth is no and
 *     never the reverse.
 *   - **Every branch to a label the caller supplied is a long branch.** A rule body
 *     is routinely longer than 128 bytes, so `ctx.far` inverts and jumps; the short
 *     form is kept for loop heads and two-instruction skips inside one emitter.
 */

import { absX, absY, imm, indY, label, type Ref } from "@demake/core";

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

import type { MosCtx } from "./ctx.js";
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
  mul32,
  neg32,
  set32,
  sub32,
} from "./val.js";
import { mem, ZP } from "./zp.js";

export type { SceneCtx };

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and an
 * object whose `visible` no assignment can reach is decided here rather than every
 * tick. That removes the test from every rule in most games.
 */
function guardVisible(ctx: MosCtx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  branchZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"), skip);
  return "runtime";
}

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 */
export function emitAssignments(
  ctx: MosCtx,
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
      // The clamp happened at compile time, so this is four stores.
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
    asm.lda(imm(sceneTarget));
    asm.sta(mem(layout.pending));
  }
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 */
function emitFire(ctx: MosCtx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
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
    asm.jmp(done);
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
 * Emitted inside the fired branch, alongside the assignments, so a sound fires on
 * exactly the tick the interpreter says it does. The request is one byte because
 * the driver reads it from an interrupt: a byte is written atomically, and a
 * pointer arriving half-written would play half of one effect.
 */
export function emitSound(ctx: MosCtx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  // A sound whose file was never supplied still records the request, so a trace
  // taken with the audio left out matches one taken with it in.
  if (ctx.audio.driver && index >= 0) {
    ctx.asm.lda(imm(index + 1));
    ctx.asm.sta(mem(ctx.audio.request));
  }
  if (ctx.audio.trace !== null) {
    ctx.asm.lda(imm(rule.sound));
    ctx.asm.sta(mem(ctx.audio.trace));
  }
}

// --- 2. controls -------------------------------------------------------------

/**
 * Test an abstract button against one of the three input sets, and jump when it
 * is down (`set`) or when it is not (`clear`).
 */
function emitButton(
  ctx: MosCtx,
  set: number,
  action: string,
  target: string,
  when: "set" | "clear",
): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.lda(mem(set));
  ctx.asm.and(imm(1 << bit));
  ctx.far(when === "set" ? "ne" : "eq", target);
}

/** Which input set a control's mode fires on. */
function inputSet(ctx: MosCtx, mode: ControlDef["mode"]): number {
  const { layout } = ctx;
  if (mode === "press") return layout.pressed;
  return mode === "release" ? layout.released : layout.held;
}

export function emitControls(ctx: MosCtx, scene: SceneCtx): void {
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
function emitHoldEdges(ctx: MosCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const [slot, target] of holdTargets(ctx.program).entries()) {
    const bindings = target.controls
      .map((index) => ctx.program.controls[index] as ControlDef)
      .filter((control) => inScene(ctx.program, scene, control.instanceId));
    if (bindings.length === 0) continue;

    const entity = entityOf(ctx, target.instanceId);
    const flag = mem(layout.holdFlags + slot);
    const value = layout.holdValues + slot * PROP_SIZE;
    const down = ctx.unique("holdDown");
    const done = ctx.unique("holdDone");

    for (const control of bindings) {
      emitButton(ctx, layout.held, control.action, down, "set");
    }

    // Nothing is asking for the property: put back what was saved, once.
    asm.lda(flag);
    ctx.far("eq", done);
    asm.lda(imm(0));
    asm.sta(flag);
    writeProp(ctx, entity, target.prop, value);
    asm.jmp(done);

    // Something is: save what the property held before anything was.
    asm.label(down);
    asm.lda(flag);
    ctx.far("ne", done);
    asm.lda(imm(1));
    asm.sta(flag);
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, value, current.addr);
    });
    asm.label(done);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: MosCtx, scene: SceneCtx): void {
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
 * running them through one loop rather than a copy each (see {@link emitMoveLoop}).
 */
function moveShape(ctx: MosCtx, id: number): string {
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

export function emitIntegrate(ctx: MosCtx, scene: SceneCtx): void {
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
 * the same two hundred bytes. They go through the pair loop's pointer instead —
 * the third emitter to use it, and by now nothing here knows or cares whether the
 * record it is stepping belongs to an instance the compiler named.
 *
 * The group key is every compile-time question `emitAxis` asks, so a shared body
 * is a proof rather than a hope: two objects in one group would have produced the
 * same instructions anyway.
 */
function emitMoveLoop(ctx: MosCtx, ids: readonly number[]): boolean {
  const { asm } = ctx;
  const first = ids[0] as number;
  const table = ctx.unique("moveTable");
  const loop = ctx.unique("moveLoop");
  const next = ctx.unique("moveNext");
  const entity: EntityAddr = { kind: "ptr", ptr: ZP.pair };

  asm.lda(imm(0));
  asm.sta(mem(ZP.pairIndex));
  asm.label(loop);
  asm.ldx(mem(ZP.pairIndex));
  asm.lda(absX(label(`${table}Lo`)));
  asm.sta(mem(ZP.pair));
  asm.lda(absX(label(`${table}Hi`)));
  asm.sta(mem(ZP.pair, 1));

  if (isMutable(ctx.analysis, first, "speed")) {
    ctx.scoped(() => branchZero32(ctx, readProp(ctx, entity, "speed").addr, next));
  }
  if (isMutable(ctx.analysis, first, "visible")) emitGuardVisiblePtr(ctx, next);
  emitAxis(ctx, entity, first, "x", "xdirection");
  emitAxis(ctx, entity, first, "y", "ydirection");

  asm.label(next);
  asm.inc(mem(ZP.pairIndex));
  asm.lda(mem(ZP.pairIndex));
  asm.cmp(imm(ids.length));
  ctx.far("cc", loop);

  ctx.data((data) => {
    const bases = ids.map((id) => ctx.layout.entities[id] as number);
    data.label(`${table}Lo`);
    data.db(...bases.map((base) => base & 0xff));
    data.label(`${table}Hi`);
    data.db(...bases.map((base) => (base >> 8) & 0xff));
  });
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
function openProp(ctx: MosCtx, entity: EntityAddr, prop: string): { addr: Ref; close: () => void } {
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
  ctx: MosCtx,
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
  const finish = (): void => {
    position.close();
  };

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
    asm.jmp(done);
    asm.label(notForward);
    branchUnlessConst32(ctx, dirAddr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    asm.jmp(done);
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

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(
  ctx: MosCtx,
  entity: EntityAddr,
  edge: Edge,
  scene: SceneCtx,
  skip: string,
): void {
  // Through `readProp` rather than an address, so the same emitter serves an
  // instance the compiler knows and a subject a loop is walking: for the first it
  // *is* the address, and for the second it is four bytes copied out of a record
  // the pointer names.
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
function emitEdgeSeparate(ctx: MosCtx, entity: EntityAddr, edge: Edge, scene: SceneCtx): void {
  const axis = edge === "screenleft" || edge === "screenright" ? "x" : "y";
  const span = axis === "x" ? "width" : "height";
  const near = edge === "screenleft" || edge === "screentop";
  const bound = axis === "x" ? scene.boundsW : scene.boundsH;
  // Not `writeProp`: that clamps, and the interpreter does not clamp here. An
  // instance the compiler knows is written in place exactly as before; a subject
  // a loop is walking is staged and copied through its pointer.
  if (entity.kind === "none") return;
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
 * A pointer write and a call, because the source is a different entity each time
 * and this CPU reaches a variable address only through page zero. The destination
 * is one of two fixed addresses, so it is baked into the routine rather than
 * passed: two routines of nineteen bytes cost less than a second pointer at every
 * one of a game's collision pairs.
 */
/** The routine that stages a box; it takes the record's address in `p0`. */
function needCopyBox(ctx: MosCtx, slot: "a" | "b"): Ref {
  const dst = (slot === "a" ? ctx.layout.pairA : ctx.layout.pairB) as number;
  return ctx.need(`CopyBox${slot.toUpperCase()}`, (inner) => {
    const loop = inner.unique("boxLoop");
    inner.asm.ldy(imm(BOX_SIZE - 1));
    inner.asm.label(loop);
    inner.asm.lda(indY(ZP.p0));
    inner.asm.sta(absY(dst));
    inner.asm.dey();
    inner.asm.bpl(loop);
    inner.asm.rts();
  });
}

function emitStageBox(ctx: MosCtx, src: number, slot: "a" | "b"): void {
  ctx.pointer(ZP.p0, src);
  ctx.asm.jsr(needCopyBox(ctx, slot));
}

function emitStagePair(ctx: MosCtx, a: number, b: number): void {
  emitStageBox(ctx, a, "a");
  emitStageBox(ctx, b, "b");
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * `A = 1` when the staged boxes overlap, `0` when they do not. Half-open on both
 * axes, matching the interpreter and matching tile contact.
 */
function needOverlapPair(ctx: MosCtx): Ref {
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
    asm.lda(imm(1));
    asm.rts();
    asm.label(apart);
    asm.lda(imm(0));
    asm.rts();
  });
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 */
function needSeparatePair(ctx: MosCtx): Ref {
  return ctx.need("SeparatePair", (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const useY = inner.unique("sepUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
    add32(inner, boxProp(a, "x"), xPush);
    clamp32(inner, boxProp(a, "x"));
    asm.rts();
    asm.label(useY);
    add32(inner, boxProp(a, "y"), yPush);
    clamp32(inner, boxProp(a, "y"));
    asm.rts();
  });
}

/**
 * The push along each axis, branching to `useY` when the y axis is shallower.
 *
 * The half of separation that *decides*, split out from the half that applies —
 * because `from above` and the push that follows it are the same arithmetic read
 * twice (`level/scene.ts` §contactOf), and two copies of it could disagree.
 */
function emitPairPushes(ctx: MosCtx, useY: string): { xPush: number; yPush: number } {
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
    asm.jmp(done);
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
 * Skip the whole contact when the staged pair is not on a side the rule named.
 *
 * The narrowing reaches the separation and the contact bit as well as the
 * firing: a side the rule did not name is a contact that never happened, so it
 * pushes nothing apart and records nothing either (`sim.ts` §resolveCollisions).
 * A rule with no `from` emits not one instruction.
 */
function emitSideGate(ctx: MosCtx, sides: readonly string[], skip: string): void {
  const mask = sideMask(sides);
  if (mask === 0) return;
  ctx.asm.jsr(needContactSide(ctx));
  ctx.asm.and(imm(mask));
  ctx.far("eq", skip);
}

/**
 * `A` = the {@link SIDE_BITS} bit for the side the staged pair sits on.
 *
 * Pulled only by a rule that says `from`, so a game without one ships none of
 * it — and a routine of its own rather than a return value bolted onto
 * `SeparatePair`, because the interpreter asks *before* the rule body runs and
 * separates *after* it (`sim.ts` §resolveCollisions).
 */
function needContactSide(ctx: MosCtx): Ref {
  return ctx.need("ContactSide", (inner) => {
    const { asm } = inner;
    const useY = inner.unique("sideUseY");
    const { xPush, yPush } = emitPairPushes(inner, useY);
    const negative = inner.unique("sideNeg");
    const below = inner.unique("sideBelow");
    asm.lda(mem(xPush, 3));
    asm.bmi(negative);
    asm.lda(imm(SIDE_BITS["right"] as number));
    asm.rts();
    asm.label(negative);
    asm.lda(imm(SIDE_BITS["left"] as number));
    asm.rts();
    asm.label(useY);
    asm.lda(mem(yPush, 3));
    asm.bpl(below);
    asm.lda(imm(SIDE_BITS["above"] as number));
    asm.rts();
    asm.label(below);
    asm.lda(imm(SIDE_BITS["below"] as number));
    asm.rts();
  });
}

/**
 * `p0` = the other object's base, `t0`/`t1` = the margins in cells → `A` is zero
 * when the two boxes are certainly apart.
 *
 * The subject is whatever is staged in `pairA`, which every path through a pair
 * keeps current. Like the sprite cull this compares *cells* — the high half of a
 * 16.16 coordinate — so it is a sixteen-bit subtract and two sign tests per axis,
 * against the several hundred cycles a staged box and a full overlap test cost.
 * Two boxes can only overlap if their cells are within the wider of the two, so
 * rounding the margin outward by one keeps it conservative: it may say "maybe"
 * when the answer is no, never the reverse.
 */
function needNearBox(ctx: MosCtx): Ref {
  return ctx.need("NearBox", (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");
    const delta = ZP.spare;

    const axis = (offset: number, margin: number): void => {
      // delta = other.cell - subject.cell, sixteen bits.
      asm.sec();
      asm.ldy(imm(offset + 2));
      asm.lda(indY(ZP.p0));
      asm.sbc(mem(subject + offset + 2));
      asm.sta(mem(delta));
      asm.ldy(imm(offset + 3));
      asm.lda(indY(ZP.p0));
      asm.sbc(mem(subject + offset + 3));
      asm.sta(mem(delta, 1));
      // delta + margin < 0 — the other is that far to the near side.
      asm.clc();
      asm.lda(mem(delta));
      asm.adc(mem(margin));
      asm.lda(mem(delta, 1));
      asm.adc(imm(0));
      inner.far("mi", apart);
      // delta − margin − 1 >= 0 — that far to the far side. `clc` rather than
      // `sec` is what subtracts the extra one: on this CPU a clear carry into
      // `sbc` *is* a borrow.
      asm.clc();
      asm.lda(mem(delta));
      asm.sbc(mem(margin));
      asm.lda(mem(delta, 1));
      asm.sbc(imm(0));
      inner.far("pl", apart);
    };
    axis(propOffset("x"), ZP.t0);
    axis(propOffset("y"), ZP.t1);

    asm.lda(imm(1));
    asm.rts();
    asm.label(apart);
    asm.lda(imm(0));
    asm.rts();
  });
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: MosCtx, entity: number): void {
  const { asm, layout } = ctx;
  const source = layout.pairA as number;
  ctx.pointer(ZP.p1, entity);
  asm.jsr(
    ctx.need("CommitPair", (inner) => {
      const loop = inner.unique("commitLoop");
      inner.asm.ldy(imm(2 * PROP_SIZE - 1));
      inner.asm.label(loop);
      inner.asm.lda(absY(source));
      inner.asm.sta(indY(ZP.p1));
      inner.asm.dey();
      inner.asm.bpl(loop);
      inner.asm.rts();
    }),
  );
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: MosCtx, bit: number, seen: string): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.contactsPrev + (bit >> 3)));
  asm.and(imm(1 << (bit & 7)));
  ctx.far("ne", seen);
}

function emitContactSet(ctx: MosCtx, bit: number): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.contacts + (bit >> 3)));
  asm.ora(imm(1 << (bit & 7)));
  asm.sta(mem(layout.contacts + (bit >> 3)));
}

/**
 * Fewest others worth a loop rather than a copy each.
 *
 * A looped pair costs its own setup — the tables, the index, the two indirect
 * reads a run-time contact bit needs — against about three hundred bytes for an
 * unrolled one. Three is where the arithmetic turns, and it is deliberately not
 * two: a game with a player and two coins reads better unrolled in the symbol
 * table, and nothing in the library is near its budget.
 */
const LOOP_PAIRS = 3;

/**
 * One pair of objects, looped over the others rather than copied per pair.
 *
 * This is where a game like the shooter lives or dies. Three shots against nine
 * aliens is twenty-seven pairs, and each pair's *code* — the near test, the
 * staging, the overlap, the rule body, the separation, the contact bit — came to
 * about three hundred and fifty bytes. Twenty-seven of those is ten kilobytes of
 * a thirty-two kilobyte cartridge, spent on twenty-seven copies of the same
 * program with a different address baked into each.
 *
 * So the other object's record goes in a page-zero pointer and the body is
 * emitted once. `EntityAddr` has had a `ptr` case since the interface was
 * written and `expr.ts` implements it, so a rule body needs no special handling
 * at all: `alien.visible as 0` becomes an indirect store instead of an absolute
 * one and everything else is unchanged. What the loop adds is the *table* — the
 * other's address and its contact bit, four bytes an entry — and the arithmetic
 * to read a bit whose number is no longer a constant.
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
 * Returns whether it took the loop.
 */
function emitPairLoop(
  ctx: MosCtx,
  rule: RuleDef,
  subject: EntityAddr,
  subjectId: number,
  subjectBase: number,
  pairs: readonly { id: number; base: number; bit: number }[],
): boolean {
  const { asm } = ctx;
  if (pairs.length < LOOP_PAIRS) return false;
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
  const loop = ctx.unique("pairLoop");
  const next = ctx.unique("pairNext");
  const other: EntityAddr = { kind: "ptr", ptr: ZP.pair };

  asm.lda(imm(0));
  asm.sta(mem(ZP.pairIndex));
  asm.label(loop);
  asm.ldx(mem(ZP.pairIndex));
  asm.lda(absX(label(`${table}Lo`)));
  asm.sta(mem(ZP.pair));
  asm.lda(absX(label(`${table}Hi`)));
  asm.sta(mem(ZP.pair, 1));

  if (guarded) emitGuardVisiblePtr(ctx, next);
  if (margins) {
    emitCopyPointer(ctx, ZP.p0, ZP.pair);
    asm.lda(imm(margins.x));
    asm.sta(mem(ZP.t0));
    asm.lda(imm(margins.y));
    asm.sta(mem(ZP.t1));
    asm.jsr(needNearBox(ctx));
    ctx.far("eq", next);
  }
  emitStageBoxPtr(ctx, "b");
  asm.jsr(needOverlapPair(ctx));
  ctx.far("eq", next);
  emitSideGate(ctx, event.sides, next);

  const afterFire = ctx.unique("pairFired");
  if (!event.level) emitContactBitPtr(ctx, table, "seen", afterFire);
  emitFire(ctx, rule, { subject, other });
  asm.label(afterFire);

  const noSeparate = ctx.unique("pairNoSep");
  emitStageBox(ctx, subjectBase, "a");
  emitStageBoxPtr(ctx, "b");
  guardVisible(ctx, subjectId, noSeparate);
  if (guarded) emitGuardVisiblePtr(ctx, noSeparate);
  asm.jsr(needOverlapPair(ctx));
  ctx.far("eq", noSeparate);
  asm.jsr(needSeparatePair(ctx));
  emitCommitPair(ctx, subjectBase);
  emitStageBox(ctx, subjectBase, "a");
  emitContactBitPtr(ctx, table, "set");
  asm.label(noSeparate);

  asm.label(next);
  asm.inc(mem(ZP.pairIndex));
  asm.lda(mem(ZP.pairIndex));
  asm.cmp(imm(pairs.length));
  ctx.far("cc", loop);

  ctx.data((data) => {
    data.label(`${table}Lo`);
    data.db(...pairs.map((pair) => pair.base & 0xff));
    data.label(`${table}Hi`);
    data.db(...pairs.map((pair) => (pair.base >> 8) & 0xff));
    // The bit's byte and its mask rather than its number: a contact bit is a
    // constant in the unrolled form, and working one out from an index at run
    // time would cost a shift loop per pair.
    data.label(`${table}Byte`);
    data.db(...pairs.map((pair) => pair.bit >> 3));
    data.label(`${table}Mask`);
    data.db(...pairs.map((pair) => 1 << (pair.bit & 7)));
  });
  return true;
}

/** `p0`-style copy between two page-zero pointers. */
function emitCopyPointer(ctx: MosCtx, dst: number, src: number): void {
  const { asm } = ctx;
  asm.lda(mem(src));
  asm.sta(mem(dst));
  asm.lda(mem(src, 1));
  asm.sta(mem(dst, 1));
}

/** The looped other's `visible`, which is four bytes behind a pointer. */
function emitGuardVisiblePtr(ctx: MosCtx, skip: string): void {
  const { asm } = ctx;
  const offset = propOffset("visible");
  asm.ldy(imm(offset));
  asm.lda(indY(ZP.pair));
  for (let byte = 1; byte < 4; byte += 1) {
    asm.ldy(imm(offset + byte));
    asm.ora(indY(ZP.pair));
  }
  ctx.far("eq", skip);
}

/** Stage the looped other's box, which `CopyBoxB` already reads through `p0`. */
function emitStageBoxPtr(ctx: MosCtx, slot: "a" | "b"): void {
  emitCopyPointer(ctx, ZP.p0, ZP.pair);
  ctx.asm.jsr(needCopyBox(ctx, slot));
}

/**
 * Test or set this pair's contact bit, whose number the loop only knows at run
 * time. `X` holds the loop index throughout, so both tables are read from it.
 */
function emitContactBitPtr(
  ctx: MosCtx,
  table: string,
  what: "seen" | "set",
  seen?: string,
  edge?: number,
): void {
  const { asm, layout } = ctx;
  const suffix = edge === undefined ? "" : String(edge);
  asm.ldx(mem(ZP.pairIndex));
  asm.ldy(absX(label(`${table}Byte${suffix}`)));
  if (what === "seen") {
    asm.lda(absY(layout.contactsPrev));
    asm.and(absX(label(`${table}Mask${suffix}`)));
    ctx.far("ne", seen as string);
    return;
  }
  asm.lda(absY(layout.contacts));
  asm.ora(absX(label(`${table}Mask${suffix}`)));
  asm.sta(absY(layout.contacts));
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
  ctx: MosCtx,
  rule: RuleDef,
  scene: SceneCtx,
  subjects: readonly { id: number; base: number; bit: number }[],
  edges: readonly Edge[],
  level: boolean,
): boolean {
  const { asm } = ctx;
  if (subjects.length < LOOP_PAIRS) return false;
  const guarded = isMutable(ctx.analysis, subjects[0]?.id as number, "visible");
  for (const one of subjects) {
    if (isMutable(ctx.analysis, one.id, "visible") !== guarded) return false;
  }

  const table = ctx.unique("edgeTable");
  const loop = ctx.unique("edgeLoop");
  const next = ctx.unique("edgeNext");
  const subject: EntityAddr = { kind: "ptr", ptr: ZP.pair };

  asm.lda(imm(0));
  asm.sta(mem(ZP.pairIndex));
  asm.label(loop);
  asm.ldx(mem(ZP.pairIndex));
  asm.lda(absX(label(`${table}Lo`)));
  asm.sta(mem(ZP.pair));
  asm.lda(absX(label(`${table}Hi`)));
  asm.sta(mem(ZP.pair, 1));
  if (guarded) emitGuardVisiblePtr(ctx, next);

  for (const [edgeIndex, edge] of edges.entries()) {
    const skip = ctx.unique("edgeLoopSkip");
    emitEdgeTest(ctx, subject, edge, scene, skip);
    const afterFire = ctx.unique("edgeLoopFired");
    if (!level) emitContactBitPtr(ctx, table, "seen", afterFire, edgeIndex);
    emitFire(ctx, rule, { subject, other: { kind: "none" } });
    asm.label(afterFire);
    const noSeparate = ctx.unique("edgeLoopNoSep");
    if (guarded) emitGuardVisiblePtr(ctx, noSeparate);
    emitEdgeTest(ctx, subject, edge, scene, noSeparate);
    emitEdgeSeparate(ctx, subject, edge, scene);
    emitContactBitPtr(ctx, table, "set", undefined, edgeIndex);
    asm.label(noSeparate);
    asm.label(skip);
  }

  asm.label(next);
  asm.inc(mem(ZP.pairIndex));
  asm.lda(mem(ZP.pairIndex));
  asm.cmp(imm(subjects.length));
  ctx.far("cc", loop);

  ctx.data((data) => {
    data.label(`${table}Lo`);
    data.db(...subjects.map((one) => one.base & 0xff));
    data.label(`${table}Hi`);
    data.db(...subjects.map((one) => (one.base >> 8) & 0xff));
    // One byte-and-mask pair per edge, because a subject's edges are consecutive
    // bits and the loop's index says which subject rather than which bit.
    for (const [edgeIndex] of edges.entries()) {
      data.label(`${table}Byte${edgeIndex}`);
      data.db(...subjects.map((one) => (one.bit + edgeIndex) >> 3));
      data.label(`${table}Mask${edgeIndex}`);
      data.db(...subjects.map((one) => 1 << ((one.bit + edgeIndex) & 7)));
    }
  });
  return true;
}

export function emitCollisions(ctx: MosCtx, scene: SceneCtx): void {
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
      // through a pair leaves it current, so a pair that touches nothing costs one
      // copy rather than two.
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
        // nowhere near each other — in a scrolling level, most of them are not even
        // on the same screen — and this answers that in a few dozen cycles instead
        // of staging a box and running the full overlap test.
        const margins = nearMargins(ctx, subjectId, otherId);
        if (margins) {
          ctx.pointer(ZP.p0, otherBase);
          asm.lda(imm(margins.x));
          asm.sta(mem(ZP.t0));
          asm.lda(imm(margins.y));
          asm.sta(mem(ZP.t1));
          asm.jsr(needNearBox(ctx));
          ctx.far("eq", skip);
        }
        // Only the other box is staged here: the subject's was staged before the
        // loop and every path below leaves it current.
        emitStageBox(ctx, otherBase, "b");
        asm.jsr(needOverlapPair(ctx));
        ctx.far("eq", skip);
        emitSideGate(ctx, event.sides, skip);
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
        // `visible 0` is inert — not drawn, *not collided with*, not moved — and a
        // rule that collected a coin by hiding it has said so by now.
        guardVisible(ctx, subjectId, noSeparate);
        guardVisible(ctx, otherId, noSeparate);
        asm.jsr(needOverlapPair(ctx));
        ctx.far("eq", noSeparate);
        asm.jsr(needSeparatePair(ctx));
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

export function emitEdgeRules(ctx: MosCtx, scene: SceneCtx): void {
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
        asm.lda(mem(set));
        asm.and(imm(1 << bit));
        ctx.far("eq", skip);
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        const notFired = ctx.unique("inputNo");
        const fired = ctx.unique("inputYes");
        asm.lda(mem(set));
        asm.and(imm(1 << bit));
        ctx.far("eq", notFired);
        asm.lda(imm(1));
        asm.jmp(fired);
        asm.label(notFired);
        asm.lda(imm(0));
        asm.label(fired);
        asm.sta(mem(layout.scratch));
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, layout.scratch);
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
  ctx: MosCtx,
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
      asm.lda(mem(firedFlag));
      ctx.far("eq", falseLabel);
      return "runtime";
    });
  }
  asm.label(skip);
}

/**
 * `reaches` is a crossing detector, not a threshold: it fires when the value lands
 * exactly on its target or crosses it from either side, and a value that *starts*
 * on its target has not reached it.
 */
function emitReaches(ctx: MosCtx, rule: RuleDef, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  if (rule.event.kind !== "reaches") return;
  const slot = layout.reachSlots.get(rule.id);
  if (slot === undefined) return;
  const valueAddr = layout.reachValues + slot * 4;
  const flagAddr = layout.reachFlags + slot;
  const previous = layout.temps[layout.temps.length - 1] as number;
  const delta = layout.temps[layout.temps.length - 2] as number;

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
  asm.lda(mem(flagAddr));
  ctx.far("ne", hadHistory);
  asm.lda(imm(1));
  asm.sta(mem(flagAddr));
  asm.jmp(done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the sign
  // changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  branchZero32(ctx, previous, notFired);
  branchZero32(ctx, delta, fired);
  asm.lda(mem(delta, 3));
  asm.eor(mem(previous, 3));
  asm.and(imm(0x80));
  ctx.far("eq", notFired);
  asm.label(fired);
  asm.lda(imm(1));
  asm.sta(mem(layout.scratch));
  const run = ctx.unique("reachRun");
  asm.jmp(run);
  asm.label(notFired);
  asm.lda(imm(0));
  asm.sta(mem(layout.scratch));
  asm.label(run);

  if (rule.guard === undefined) {
    const skip = ctx.unique("reachSkip");
    asm.lda(mem(layout.scratch));
    ctx.far("eq", skip);
    for (const subject of subjectBindings(ctx, rule, scene)) {
      emitSubjectFire(ctx, rule, subject, undefined);
    }
    asm.label(skip);
  } else {
    for (const subject of subjectBindings(ctx, rule, scene)) {
      emitSubjectFire(ctx, rule, subject, layout.scratch);
    }
  }
  asm.label(done);
}

// --- 8. camera ---------------------------------------------------------------

/**
 * Centre the viewport on the scene's camera target and hold it inside the
 * playfield. The clamp is load-bearing twice: it stops the view running off the
 * end of a level, and it means a level no bigger than the screen never scrolls, so
 * a non-scrolling game needs no special case anywhere.
 */
export function emitCamera(ctx: MosCtx, scene: SceneCtx): void {
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
    asm.jmp(done);
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
