/**
 * The tick, compiled.
 *
 * `sim.ts` is the specification and this is a *conformance implementation* of
 * it, which is why the order below is the order there — a runtime that reorders
 * these steps diverges within seconds, and the trace oracle exists to prove it
 * did not. What changes is not the semantics but what survives compilation:
 *
 *   - A rule's scene is known, so a rule that cannot fire in this scene emits
 *     nothing. An instance belongs to exactly one scene, so `isActive` is a
 *     compile-time fact rather than a test.
 *   - A rule's subjects and others are known, so the loops are unrolled and
 *     every property is an absolute address.
 *   - A contact — `(rule, subject, target)` — is a *bit index* known at compile
 *     time, so "did this contact exist last tick" is `bit n, [hl]`. The
 *     interpreter scanned a list for the same answer.
 *   - `when always` is the literal one, so it emits no test at all.
 *   - An object whose `speed` no rule writes and which starts at rest leaves
 *     the integrator entirely; one whose `visible` nothing writes never gets a
 *     visibility test.
 */

import { fromInt, ONE as FIXED_ONE } from "../fixed.js";
import type { CAssignment, ControlDef, Edge, InstanceDef, RuleDef } from "../program.js";
import { ACTIONS } from "../program.js";

import type { Ctx } from "./ctx.js";
import {
  emitExpr,
  emitTest,
  fold,
  propOffset,
  readProp,
  resolveEntity,
  UNBOUND,
  writeProp,
  type Binding,
  type EntityAddr,
} from "./expr.js";
import { holdTargets, isMutable } from "./analyze.js";
import { BOX_SIZE, PROP_SIZE } from "./layout.js";
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
  type SceneCtx,
} from "./shape.js";
import {
  add32,
  addConst32,
  clamp32,
  copy32,
  div32,
  isZero32,
  less32,
  mul32,
  neg32,
  set32,
  sub32,
} from "./val.js";

/**
 * Jump to `skip` when the object is not in play.
 *
 * `visible 0` is inert — not drawn, not collided with, not moved (doc 14) — and
 * an object whose `visible` no assignment can reach is decided here rather than
 * every tick. That removes the test from every rule in most games.
 */
function guardVisible(ctx: Ctx, id: number, skip: string): "always" | "never" | "runtime" {
  const instance = ctx.program.instances[id] as InstanceDef;
  if (!isMutable(ctx.analysis, id, "visible")) {
    return (instance.numbers["visible"] ?? 0) !== 0 ? "always" : "never";
  }
  isZero32(ctx, (ctx.layout.entities[id] as number) + propOffset("visible"));
  ctx.asm.jp(skip, "z");
  return "runtime";
}

export type { SceneCtx };

// --- assignments -------------------------------------------------------------

/**
 * Apply a list of assignments the way the interpreter does: every value is
 * computed against the pre-rule state, then the writes land together.
 *
 * Staging is skipped for a single assignment, because with one write there is
 * nothing for it to interfere with.
 */
export function emitAssignments(
  ctx: Ctx,
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
    asm.ldn("a", sceneTarget);
    asm.sta(layout.pending);
  }
}

/** A trigger emitter: jumps to `falseLabel` when the rule did not fire. */
type Trigger = (falseLabel: string) => "always" | "never" | "runtime";

/**
 * Fire a rule: its assignments when the trigger held and the guard passed, its
 * `else` when it was evaluated and did not.
 *
 * A trigger or guard the compiler can decide takes its branch out entirely, so
 * `when always` costs nothing and a rule that can never fire in this scene
 * shrinks to its `else`.
 */
function emitFire(ctx: Ctx, rule: RuleDef, bind: Binding, trigger?: Trigger): void {
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
 * on exactly the tick the interpreter says it does — which is the whole reason
 * a `sound` statement compiles to a rule rather than to something of its own.
 * The request is one byte because the driver reads it from an interrupt: a byte
 * is written atomically, and a pointer arriving half-written would play half of
 * one effect.
 */
export function emitSound(ctx: Ctx, rule: RuleDef): void {
  if (rule.sound === undefined || ctx.audio === undefined) return;
  const index = ctx.audio.effects[rule.sound] ?? -1;
  // A sound whose file was never supplied still records the request, so a trace
  // taken with the audio left out matches one taken with it in.
  if (ctx.audio.driver && index >= 0) {
    ctx.asm.ldn("a", index + 1);
    ctx.asm.stha(ctx.audio.request & 0xff);
  }
  if (ctx.audio.trace !== null) {
    ctx.asm.ldn("a", rule.sound);
    ctx.asm.sta(ctx.audio.trace);
  }
}

// --- 2. controls -------------------------------------------------------------

/**
 * Test an abstract button against one of the three input sets, and jump when it
 * is down (`set`) or when it is not (`clear`).
 */
function emitButton(
  ctx: Ctx,
  set: number,
  action: string,
  target: string,
  when: "set" | "clear",
): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.lda(set);
  ctx.asm.bit(bit, "a");
  ctx.asm.jp(target, when === "set" ? "nz" : "z");
}

/** Which input set a control's mode fires on. */
function inputSet(ctx: Ctx, mode: ControlDef["mode"]): number {
  const { layout } = ctx;
  if (mode === "press") return layout.pressed;
  return mode === "release" ? layout.released : layout.held;
}

export function emitControls(ctx: Ctx, scene: SceneCtx): void {
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
 * One slot per property rather than per binding: the value is saved when the
 * first button writing it goes down and put back when the last one comes up, so
 * left and right release in either order and leave the property exactly as they
 * found it. It runs before any binding applies, so releasing right while left is
 * still down hands over within the tick rather than standing still for one.
 *
 * The test is whether the button is *down*, not whether it was pressed this
 * tick, because a scene entered with the button already held never saw the press
 * — that edge belonged to the scene the player pressed A on, where this control
 * emits nothing. `sim.ts`'s `updateHolds` is the specification.
 */
function emitHoldEdges(ctx: Ctx, scene: SceneCtx): void {
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
    asm.lda(flag);
    asm.alu("or", "a");
    asm.jp(done, "z");
    asm.alu("xor", "a");
    asm.sta(flag);
    writeProp(ctx, entity, target.prop, value);
    asm.jp(done);

    // Something is: save what the property held before anything was.
    asm.label(down);
    asm.lda(flag);
    asm.alu("or", "a");
    asm.jp(done, "nz");
    asm.ldn("a", 1);
    asm.sta(flag);
    ctx.scoped(() => {
      const current = readProp(ctx, entity, target.prop);
      copy32(ctx, value, current.addr);
    });
    asm.label(done);
  }
}

// --- 3. level rules ----------------------------------------------------------

export function emitLevelRules(ctx: Ctx, scene: SceneCtx): void {
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

export function emitIntegrate(ctx: Ctx, scene: SceneCtx): void {
  const { asm } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = ctx.program.instances[id] as InstanceDef;
    const speedFixed = instance.numbers["speed"] ?? 0;
    const speedMutable = isMutable(ctx.analysis, id, "speed");
    // An object that starts at rest and that nothing can accelerate never
    // moves, so it is not in the integrator at all.
    if (!speedMutable && speedFixed === 0) continue;

    const skip = ctx.unique("intSkip");
    const base = ctx.layout.entities[id] as number;
    if (speedMutable) {
      isZero32(ctx, base + propOffset("speed"));
      asm.jp(skip, "z");
    }
    if (guardVisible(ctx, id, skip) === "never") {
      asm.label(skip);
      continue;
    }
    emitAxis(ctx, id, "x", "xdirection");
    emitAxis(ctx, id, "y", "ydirection");
    asm.label(skip);
  }
}

function emitAxis(ctx: Ctx, id: number, posProp: string, dirProp: string): void {
  const { asm, layout, profile } = ctx;
  const instance = ctx.program.instances[id] as InstanceDef;
  const base = layout.entities[id] as number;
  const posAddr = base + propOffset(posProp);
  const dirAddr = base + propOffset(dirProp);
  const speedAddr = base + propOffset("speed");

  const dirFixed = instance.numbers[dirProp] ?? 0;
  const speedFixed = instance.numbers["speed"] ?? 0;
  const dirMutable = isMutable(ctx.analysis, id, dirProp);
  const speedMutable = isMutable(ctx.analysis, id, "speed");

  // Nothing on this axis can ever be non-zero.
  if (!dirMutable && dirFixed === 0) return;

  if (!dirMutable && !speedMutable) {
    const step = perTick(dirFixed, speedFixed, profile.fps);
    if (step === 0) return;
    addConst32(ctx, posAddr, step);
    clamp32(ctx, posAddr);
    return;
  }

  const done = ctx.unique("axisDone");
  if (!speedMutable) {
    // Speed is fixed, so the step for a whole direction is a constant: the
    // common case becomes an add, with no multiply and no divide.
    const forward = perTick(FIXED_ONE, speedFixed, profile.fps);
    const backward = perTick(-FIXED_ONE, speedFixed, profile.fps);
    const notForward = ctx.unique("axisNotFwd");
    const notBackward = ctx.unique("axisNotBack");

    emitIsConst(ctx, dirAddr, FIXED_ONE, notForward);
    if (forward !== 0) {
      addConst32(ctx, posAddr, forward);
      clamp32(ctx, posAddr);
    }
    asm.jp(done);
    asm.label(notForward);
    emitIsConst(ctx, dirAddr, -FIXED_ONE, notBackward);
    if (backward !== 0) {
      addConst32(ctx, posAddr, backward);
      clamp32(ctx, posAddr);
    }
    asm.jp(done);
    asm.label(notBackward);
  }

  const skipZero = ctx.unique("axisZero");
  isZero32(ctx, dirAddr);
  asm.jp(skipZero, "z");
  ctx.scoped(() => {
    const step = ctx.pushTemp();
    copy32(ctx, step, dirAddr);
    // velocity = direction × speed, then step = velocity ÷ fps. Speeds are
    // authored per second precisely so the frame rate enters only here.
    mul32(ctx, step, speedAddr);
    div32(ctx, step, ctx.constant(fromInt(profile.fps)));
    const noMove = ctx.unique("axisNoMove");
    isZero32(ctx, step);
    asm.jp(noMove, "z");
    add32(ctx, posAddr, step);
    clamp32(ctx, posAddr);
    asm.label(noMove);
  });
  asm.label(skipZero);
  asm.label(done);
}

/** Jump to `no` unless the four bytes hold exactly this constant. */
function emitIsConst(ctx: Ctx, addr: number, value: number, no: string): void {
  const { asm } = ctx;
  const bytes = [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
  for (let index = 0; index < 4; index += 1) {
    asm.lda(addr + index);
    const byte = bytes[index] as number;
    if (byte === 0) asm.alu("or", "a");
    else asm.aluN("cp", byte);
    asm.jp(no, "nz");
  }
}

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(ctx: Ctx, id: number, edge: Edge, scene: SceneCtx, skip: string): void {
  const { asm, layout } = ctx;
  const base = layout.entities[id] as number;
  const x = base + propOffset("x");
  const y = base + propOffset("y");
  const w = base + propOffset("width");
  const h = base + propOffset("height");
  const zero = ctx.constant(0);

  switch (edge) {
    case "screenleft":
      // x <= 0 is "not (0 < x)".
      less32(ctx, zero, x);
      asm.jp(skip, "c");
      break;
    case "screentop":
      less32(ctx, zero, y);
      asm.jp(skip, "c");
      break;
    case "screenright":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, x);
        add32(ctx, temp, w);
        less32(ctx, temp, ctx.constant(scene.boundsW));
        asm.jp(skip, "c");
      });
      break;
    case "screenbottom":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, y);
        add32(ctx, temp, h);
        less32(ctx, temp, ctx.constant(scene.boundsH));
        asm.jp(skip, "c");
      });
      break;
  }
}

/** Push the subject back inside the playfield. The interpreter does not clamp
 * here, and neither does this. */
function emitEdgeSeparate(ctx: Ctx, id: number, edge: Edge, scene: SceneCtx): void {
  const base = ctx.layout.entities[id] as number;
  switch (edge) {
    case "screenleft":
      set32(ctx, base + propOffset("x"), 0);
      break;
    case "screentop":
      set32(ctx, base + propOffset("y"), 0);
      break;
    case "screenright":
      set32(ctx, base + propOffset("x"), scene.boundsW);
      sub32(ctx, base + propOffset("x"), base + propOffset("width"));
      break;
    case "screenbottom":
      set32(ctx, base + propOffset("y"), scene.boundsH);
      sub32(ctx, base + propOffset("y"), base + propOffset("height"));
      break;
  }
}

/**
 * Copy both boxes of a pair into the shared staging area.
 *
 * `x`, `y`, `width`, `height` are the first four slots of an entity record, so
 * each box is one block copy of sixteen bytes. Everything downstream then works
 * on *fixed* addresses, which is what lets the overlap test and the separation
 * be routines instead of one copy of themselves per pair.
 */
function emitStageBox(ctx: Ctx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ld16("hl", src);
  asm.ld16("de", dst);
  asm.call(needCopyBox(ctx));
}

function emitStagePair(ctx: Ctx, a: number, b: number): void {
  emitStageBox(ctx, a, ctx.layout.pairA as number);
  emitStageBox(ctx, b, ctx.layout.pairB as number);
}

/**
 * Copy one box, unrolled.
 *
 * `CopyBytes` costs fifty-six clocks a byte because it counts; sixteen is a
 * known length, so this costs twenty-four. It runs once per pair per tick —
 * every pair, every tick, whether or not anything is touching — so the loop
 * overhead was the single largest line in the profile of a game with a dozen
 * collectibles in it.
 */
function needCopyBox(ctx: Ctx): string {
  const name = "CopyBox";
  ctx.need(name, (inner) => {
    const { asm } = inner;
    for (let index = 0; index < BOX_SIZE; index += 1) {
      asm.ldaHLI();
      asm.staDE();
      if (index + 1 < BOX_SIZE) asm.inc16("de");
    }
    asm.ret();
  });
  return name;
}

/** Address of a staged box's property. */
function boxProp(base: number, prop: string): number {
  return base + propOffset(prop);
}

/**
 * `A = 1` when the staged boxes overlap, `0` when they do not. Half-open on
 * both axes, matching the interpreter and matching tile contact.
 */
function needOverlapPair(ctx: Ctx): string {
  const name = "OverlapPair";
  ctx.need(name, (inner) => {
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
      less32(inner, boxProp(a, pos), temp);
      asm.jp(apart, "nc");
      copy32(inner, temp, boxProp(a, pos));
      add32(inner, temp, boxProp(a, size));
      less32(inner, boxProp(b, pos), temp);
      asm.jp(apart, "nc");
    }
    asm.ldn("a", 1);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
  return name;
}

/**
 * Push the staged subject clear of the staged other along the axis of least
 * penetration — the same rule the interpreter uses, because resolving the deeper
 * axis would teleport a walking object over something it merely brushed.
 *
 * The result lands in the staged box, so a caller that separated copies `x` and
 * `y` back and one that did not touches nothing.
 */
function needSeparatePair(ctx: Ctx): string {
  const name = "SeparatePair";
  ctx.need(name, (inner) => {
    const { asm, layout } = inner;
    const a = layout.pairA as number;
    const { xPush, yPush } = emitPairPushes(inner);
    const useY = inner.unique("sepUseY");
    const done = inner.unique("sepApplied");
    asm.jp(useY, "nc");
    add32(inner, boxProp(a, "x"), xPush);
    clamp32(inner, boxProp(a, "x"));
    asm.ret();
    asm.label(useY);
    add32(inner, boxProp(a, "y"), yPush);
    clamp32(inner, boxProp(a, "y"));
    asm.label(done);
    asm.ret();
  });
  return name;
}

/**
 * The push along each axis, and the carry saying which of the two is shallower.
 *
 * The half of separation that *decides*, split out from the half that applies —
 * because `from above` and the push that follows it are the same arithmetic read
 * twice (`level/scene.ts` §contactOf), and two copies of it could disagree. On
 * return the carry is set when `|xPush| < |yPush|`, which is the x axis winning.
 */
function emitPairPushes(ctx: Ctx): { xPush: number; yPush: number } {
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
    less32(ctx, near, far);
    asm.jp(takeFar, "nc");
    copy32(ctx, push, near);
    neg32(ctx, push);
    asm.jp(done);
    asm.label(takeFar);
    copy32(ctx, push, far);
    asm.label(done);
  };

  axis("x", "width", xPush);
  axis("y", "height", yPush);

  // |xPush| < |yPush| decides the axis.
  copy32(ctx, near, xPush);
  emitAbs(ctx, near);
  copy32(ctx, far, yPush);
  emitAbs(ctx, far);
  less32(ctx, near, far);
  return { xPush, yPush };
}

/**
 * `A` = the {@link SIDE_BITS} bit for the side the staged pair sits on.
 *
 * Pulled only by a rule that says `from`, so a game without one ships none of
 * it — and it is a routine of its own rather than a return value bolted onto
 * `SeparatePair`, because the interpreter asks *before* the rule body runs and
 * separates *after* it (`sim.ts` §resolveCollisions). Sharing
 * {@link emitPairPushes} is what keeps the two answers the same arithmetic.
 */
function needContactSide(ctx: Ctx): string {
  const name = "ContactSide";
  ctx.need(name, (inner) => {
    const { asm } = inner;
    const { xPush, yPush } = emitPairPushes(inner);
    const useY = inner.unique("sideUseY");
    const negative = inner.unique("sideNeg");
    asm.jp(useY, "nc");
    asm.lda(xPush + 3);
    asm.bit(7, "a");
    asm.jp(negative, "nz");
    asm.ldn("a", SIDE_BITS["right"] as number);
    asm.ret();
    asm.label(negative);
    asm.ldn("a", SIDE_BITS["left"] as number);
    asm.ret();
    asm.label(useY);
    const below = inner.unique("sideBelow");
    asm.lda(yPush + 3);
    asm.bit(7, "a");
    asm.jp(below, "z");
    asm.ldn("a", SIDE_BITS["above"] as number);
    asm.ret();
    asm.label(below);
    asm.ldn("a", SIDE_BITS["below"] as number);
    asm.ret();
  });
  return name;
}

/**
 * `HL` = the other object's base, `B`/`C` = the margins in cells → `A` is zero
 * when the two boxes are certainly apart.
 *
 * The subject is whatever is staged in `pairA`, which every path through a pair
 * keeps current. Like the OAM cull this compares *cells* — the high half of a
 * 16.16 coordinate — so it is a sixteen-bit subtract and two sign tests per
 * axis, against the ~900 clocks a staged box and a full overlap test cost. Two
 * boxes can only overlap if their cells are within the wider of the two, so
 * rounding the margin outward by one keeps it conservative: it may say "maybe"
 * when the answer is no, never the reverse.
 */
function needNearBox(ctx: Ctx): string {
  const name = "NearBox";
  ctx.need(name, (inner) => {
    const { asm, layout } = inner;
    const subject = layout.pairA as number;
    const apart = inner.unique("nearNo");

    asm.ld("a", "l");
    asm.sta(layout.cull);
    asm.ld("a", "h");
    asm.sta(layout.cull + 1);

    const axis = (offset: number, margin: "b" | "c"): void => {
      asm.lda(layout.cull);
      asm.ld("l", "a");
      asm.lda(layout.cull + 1);
      asm.ld("h", "a");
      asm.ld16("de", offset + 2);
      asm.addHL("de");
      asm.ldaHLI();
      asm.ld("e", "a");
      asm.ld("a", "hlp");
      asm.ld("d", "a");
      asm.ld16("hl", subject + offset + 2);
      asm.ld("a", "e");
      asm.alu("sub", "hlp");
      asm.ld("e", "a");
      asm.inc16("hl");
      asm.ld("a", "d");
      asm.alu("sbc", "hlp");
      asm.ld("d", "a");
      asm.ld("h", "d");
      asm.ld("l", "e");
      // delta + margin < 0 — the other is that far to the near side.
      asm.ldn("d", 0);
      asm.ld("e", margin);
      asm.push("hl");
      asm.addHL("de");
      asm.ld("a", "h");
      asm.pop("hl");
      asm.bit(7, "a");
      asm.jp(apart, "nz");
      // delta − margin − 1 >= 0 — that far to the far side.
      asm.ld("a", margin);
      asm.cpl();
      asm.ld("e", "a");
      asm.ldn("d", 0xff);
      asm.addHL("de");
      asm.bit(7, "h");
      asm.jp(apart, "z");
    };
    axis(propOffset("x"), "b");
    axis(propOffset("y"), "c");

    asm.ldn("a", 1);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
  return name;
}

/** Write the staged subject's position back to the entity it came from. */
function emitCommitPair(ctx: Ctx, a: number): void {
  const { asm, layout } = ctx;
  asm.ld16("hl", layout.pairA as number);
  asm.ld16("de", a);
  asm.ld16("bc", 2 * PROP_SIZE);
  asm.call("CopyBytes");
}

function emitAbs(ctx: Ctx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("absDone");
  asm.lda(addr + 3);
  asm.bit(7, "a");
  asm.jp(done, "z");
  neg32(ctx, addr);
  asm.label(done);
}

/** Test a contact bit from last tick; jump to `seen` when it was set. */
function emitContactSeen(ctx: Ctx, bit: number, seen: string): void {
  const { asm, layout } = ctx;
  asm.lda(layout.contactsPrev + (bit >> 3));
  asm.bit(bit & 7, "a");
  asm.jp(seen, "nz");
}

function emitContactSet(ctx: Ctx, bit: number): void {
  const { asm, layout } = ctx;
  asm.lda(layout.contacts + (bit >> 3));
  asm.aluN("or", 1 << (bit & 7));
  asm.sta(layout.contacts + (bit >> 3));
}

export function emitCollisions(ctx: Ctx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (rule.event.kind !== "hits" || !ruleInScene(rule, scene)) continue;
    const range = layout.contactRanges.get(rule.id);
    if (!range) continue;
    const event = rule.event;

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
        emitEdgeTest(ctx, subjectId, edge, scene, skip);
        const bit = bitBase + edgeIndex;
        const afterFire = ctx.unique("edgeFired");
        if (!event.level) emitContactSeen(ctx, bit, afterFire);
        emitFire(ctx, rule, { subject, other: { kind: "none" } });
        asm.label(afterFire);
        // Separation re-tests, so a rule that teleported its subject away is
        // not dragged back to the wall it just left — or that hid it, because
        // `visible 0` is not collided with either.
        const noSeparate = ctx.unique("edgeNoSep");
        guardVisible(ctx, subjectId, noSeparate);
        emitEdgeTest(ctx, subjectId, edge, scene, noSeparate);
        emitEdgeSeparate(ctx, subjectId, edge, scene);
        emitContactSet(ctx, bit);
        asm.label(noSeparate);
        asm.label(skip);
      }

      // Stage the subject's box once for the whole `others` loop; every path
      // through a pair leaves it current, so a pair that touches nothing costs
      // one copy rather than two.
      if (event.others.length > 0) emitStageBox(ctx, subjectBase, layout.pairA as number);

      for (const [otherIndex, otherId] of event.others.entries()) {
        if (otherId === subjectId) continue;
        if (!inScene(ctx.program, scene, otherId)) continue;
        const skip = ctx.unique("otherSkip");
        if (guardVisible(ctx, otherId, skip) === "never") {
          asm.label(skip);
          continue;
        }
        const otherBase = layout.entities[otherId] as number;
        // Reject the pair on whole cells first. Most pairs in most games are
        // nowhere near each other — in a scrolling level, most of them are not
        // even on the same screen — and this answers that in a couple of dozen
        // clocks instead of staging a box and running the full overlap test.
        const margins = nearMargins(ctx, subjectId, otherId);
        if (margins) {
          asm.ld16("hl", otherBase);
          asm.ldn("b", margins.x);
          asm.ldn("c", margins.y);
          asm.call(needNearBox(ctx));
          asm.alu("or", "a");
          asm.jp(skip, "z");
        }
        // Only the other box is staged here: the subject's was staged before the
        // loop and every path below leaves it current, so the per-tick cost of a
        // pair that is not touching anything is one box copy and a call.
        emitStageBox(ctx, otherBase, layout.pairB as number);
        asm.call(needOverlapPair(ctx));
        asm.alu("or", "a");
        asm.jp(skip, "z");
        // `from above` narrows the whole contact and not only the firing: a
        // side the rule did not name is a contact that never happened, so it
        // takes no separation and records no bit either (`sim.ts` §resolveCollisions).
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          asm.call(needContactSide(ctx));
          asm.aluN("and", mask);
          asm.jp(skip, "z");
        }
        const bit = bitBase + event.edges.length + otherIndex;
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
        asm.alu("or", "a");
        asm.jp(noSeparate, "z");
        asm.call(needSeparatePair(ctx));
        emitCommitPair(ctx, subjectBase);
        emitStageBox(ctx, subjectBase, layout.pairA as number);
        emitContactSet(ctx, bit);
        asm.label(noSeparate);
        asm.label(skip);
      }
      asm.label(subjectSkip);
    }
  }
}

// --- 7. edge rules -----------------------------------------------------------

export function emitEdgeRules(ctx: Ctx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  for (const rule of ctx.program.rules) {
    if (!ruleInScene(rule, scene)) continue;

    if (rule.event.kind === "input") {
      const set = rule.event.edge === "pressed" ? layout.pressed : layout.released;
      const action = rule.event.action;
      // An unguarded input rule has nothing to say unless the edge happened;
      // a guarded one is evaluated every tick so its `else` can run.
      const bit = ACTIONS.indexOf(action);
      const skip = ctx.unique("inputSkip");
      if (rule.guard === undefined) {
        asm.lda(set);
        asm.bit(bit, "a");
        asm.jp(skip, "z");
        for (const subject of subjectBindings(ctx, rule, scene)) {
          emitSubjectFire(ctx, rule, subject, undefined);
        }
        asm.label(skip);
      } else {
        const notFired = ctx.unique("inputNo");
        const fired = ctx.unique("inputYes");
        asm.lda(set);
        asm.bit(bit, "a");
        asm.jp(notFired, "z");
        asm.ldn("a", 1);
        asm.jp(fired);
        asm.label(notFired);
        asm.alu("xor", "a");
        asm.label(fired);
        asm.sta(layout.scratch);
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

/** Run one subject binding of an edge rule, with the trigger's verdict in a
 * byte when it is not statically known. */
function emitSubjectFire(
  ctx: Ctx,
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
      asm.lda(firedFlag);
      asm.alu("or", "a");
      asm.jp(falseLabel, "z");
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
function emitReaches(ctx: Ctx, rule: RuleDef, scene: SceneCtx): void {
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
  asm.lda(flagAddr);
  asm.alu("or", "a");
  asm.jp(hadHistory, "nz");
  asm.ldn("a", 1);
  asm.sta(flagAddr);
  asm.jp(done);
  asm.label(hadHistory);

  // landed = delta == 0 && previous != 0 ; crossed = both non-zero and the
  // sign changed.
  const fired = ctx.unique("reachFired");
  const notFired = ctx.unique("reachNot");
  isZero32(ctx, previous);
  asm.jp(notFired, "z");
  isZero32(ctx, delta);
  asm.jp(fired, "z");
  asm.lda(delta + 3);
  asm.ld("b", "a");
  asm.lda(previous + 3);
  asm.alu("xor", "b");
  asm.aluN("and", 0x80);
  asm.jp(notFired, "z");
  asm.label(fired);
  asm.ldn("a", 1);
  asm.sta(layout.scratch);
  const run = ctx.unique("reachRun");
  asm.jp(run);
  asm.label(notFired);
  asm.alu("xor", "a");
  asm.sta(layout.scratch);
  asm.label(run);

  if (rule.guard === undefined) {
    const skip = ctx.unique("reachSkip");
    asm.lda(layout.scratch);
    asm.alu("or", "a");
    asm.jp(skip, "z");
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
 * end of a level, and it means a level no bigger than the screen never scrolls,
 * so a non-scrolling game needs no special case anywhere.
 */
export function emitCamera(ctx: Ctx, scene: SceneCtx): void {
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
    less32(ctx, camera + offset, ctx.constant(0));
    asm.jp(clampHigh, "nc");
    set32(ctx, camera + offset, 0);
    asm.jp(done);
    asm.label(clampHigh);
    less32(ctx, ctx.constant(max), camera + offset);
    asm.jp(done, "nc");
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
