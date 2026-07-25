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
import type { LevelFile } from "../level/parse.js";
import type {
  CAssignment,
  ControlDef,
  Edge,
  InstanceDef,
  Program,
  RuleDef,
  SceneDef,
} from "../program.js";
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
import { isMutable } from "./analyze.js";
import { BOX_SIZE, PROP_SIZE } from "./layout.js";
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

/** Everything the emitters need about the scene being compiled. */
export interface SceneCtx {
  index: number;
  def: SceneDef;
  /** Playfield in 16.16 cells: the level's size, or the screen's. */
  boundsW: number;
  boundsH: number;
  level: LevelFile | undefined;
}

/** The scene an instance belongs to, as an index. */
function sceneIndexOf(program: Program, name: string): number {
  const index = program.scenes.findIndex((scene) => scene.name === name);
  return index < 0 ? 0 : index;
}

/** Is this instance part of the scene being compiled? */
function inScene(program: Program, scene: SceneCtx, id: number): boolean {
  const instance = program.instances[id];
  return instance !== undefined && instance.scene === scene.def.name;
}

/** A rule runs in this scene when it names it, or names none at all. */
function ruleInScene(rule: RuleDef, scene: SceneCtx): boolean {
  return rule.scene === undefined || rule.scene === scene.def.name;
}

/** The compile-time entity address of a known instance. */
function entityOf(ctx: Ctx, id: number): EntityAddr {
  return { kind: "const", id, base: ctx.layout.entities[id] as number };
}

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

/** The interpreter clamps every write; a constant can be clamped here instead. */
function clampConst(value: number): number {
  const limit = 1024 * FIXED_ONE;
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
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

// --- 2. controls -------------------------------------------------------------

/** Test an abstract button against one of the three input sets. */
function emitButton(ctx: Ctx, set: number, action: string, skip: string): void {
  const bit = ACTIONS.indexOf(action as (typeof ACTIONS)[number]);
  ctx.asm.lda(set);
  ctx.asm.bit(bit, "a");
  ctx.asm.jp(skip, "z");
}

export function emitControls(ctx: Ctx, scene: SceneCtx): void {
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

function emitSnapshot(ctx: Ctx, control: ControlDef, bind: Binding, base: number): void {
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

function emitRestore(ctx: Ctx, control: ControlDef, bind: Binding, base: number): void {
  const { asm, layout } = ctx;
  for (const [index, assignment] of control.assignments.entries()) {
    const target = assignment.target;
    if (target.kind !== "prop") continue;
    const entity = resolveEntity(ctx, target.entity, bind);
    if (entity.kind === "none") continue;
    const skip = ctx.unique("restoreSkip");
    asm.lda(layout.holdFlags + base + index);
    asm.alu("or", "a");
    asm.jp(skip, "z");
    asm.alu("xor", "a");
    asm.sta(layout.holdFlags + base + index);
    const slot = layout.holdValues + (base + index) * 4;
    writeProp(ctx, entity, target.prop, slot);
    asm.label(skip);
  }
}

// --- 3. level rules ----------------------------------------------------------

/** The subject bindings a rule runs under, filtered to this scene. */
function subjectBindings(ctx: Ctx, rule: RuleDef, scene: SceneCtx): (number | null)[] {
  if (!rule.subjects) return [null];
  return rule.subjects.filter((id) => inScene(ctx.program, scene, id));
}

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

/** One tick of movement: `direction × speed ÷ fps`, floored, in that order. */
function perTick(direction: number, speed: number, fps: number): number {
  const velocity = Math.floor((direction * speed) / FIXED_ONE);
  return Math.floor((velocity * FIXED_ONE) / fromInt(fps));
}

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
      less32(inner, near, far);
      asm.jp(takeFar, "nc");
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
    emitAbs(inner, near);
    copy32(inner, far, yPush);
    emitAbs(inner, far);
    const useY = inner.unique("sepUseY");
    const done = inner.unique("sepApplied");
    less32(inner, near, far);
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
        // Only the other box is staged here: the subject's was staged before the
        // loop and every path below leaves it current, so the per-tick cost of a
        // pair that is not touching anything is one box copy and a call.
        emitStageBox(ctx, otherBase, layout.pairB as number);
        asm.call(needOverlapPair(ctx));
        asm.alu("or", "a");
        asm.jp(skip, "z");
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

function boundMax(boundsFixed: number, screenCells: number): number {
  const cells = boundsFixed / FIXED_ONE;
  return fromInt(Math.max(0, cells - screenCells));
}
