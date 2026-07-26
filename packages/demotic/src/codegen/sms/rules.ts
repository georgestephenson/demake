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

import { type Ref } from "@demake/core";

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

export function emitIntegrate(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = ctx.program.instances[id] as InstanceDef;
    const speedFixed = instance.numbers["speed"] ?? 0;
    const speedMutable = isMutable(ctx.analysis, id, "speed");
    // An object that starts at rest and that nothing can accelerate never moves,
    // so it is not in the integrator at all.
    if (!speedMutable && speedFixed === 0) continue;

    const skip = ctx.unique("intSkip");
    const base = ctx.layout.entities[id] as number;
    if (speedMutable) branchZero32(ctx, base + propOffset("speed"), skip);
    if (guardVisible(ctx, id, skip) === "never") {
      asm.label(skip);
      continue;
    }
    emitAxis(ctx, id, "x", "xdirection");
    emitAxis(ctx, id, "y", "ydirection");
    asm.label(skip);
  }
}

function emitAxis(ctx: SmsCtx, id: number, posProp: string, dirProp: string): void {
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
}

// --- 5. collisions -----------------------------------------------------------

/** Jump to `skip` when the subject is not touching this edge of the playfield. */
function emitEdgeTest(ctx: SmsCtx, id: number, edge: Edge, scene: SceneCtx, skip: string): void {
  const layout = ctx.layout;
  const base = layout.entities[id] as number;
  const x = base + propOffset("x");
  const y = base + propOffset("y");
  const w = base + propOffset("width");
  const h = base + propOffset("height");
  const zero = ctx.constant(0);

  switch (edge) {
    case "screenleft":
      // x <= 0 is "not (0 < x)".
      branchLess32(ctx, zero, x, skip);
      break;
    case "screentop":
      branchLess32(ctx, zero, y, skip);
      break;
    case "screenright":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, x);
        add32(ctx, temp, w);
        branchLess32(ctx, temp, ctx.constant(scene.boundsW), skip);
      });
      break;
    case "screenbottom":
      ctx.scoped(() => {
        const temp = ctx.pushTemp();
        copy32(ctx, temp, y);
        add32(ctx, temp, h);
        branchLess32(ctx, temp, ctx.constant(scene.boundsH), skip);
      });
      break;
  }
}

/** Push the subject back inside the playfield. The interpreter does not clamp
 * here, and neither does this. */
function emitEdgeSeparate(ctx: SmsCtx, id: number, edge: Edge, scene: SceneCtx): void {
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
 * Copy one entity's box into a staging slot.
 *
 * A load and a call: the source is a different entity each time, and `hl` is
 * where a block move takes its source. The destination is one of two fixed
 * addresses, so it is baked into the routine rather than passed — two routines
 * of nine bytes cost less than a second argument at every one of a game's
 * collision pairs.
 */
function emitStageBox(ctx: SmsCtx, src: number, slot: "a" | "b"): void {
  const { asm, layout } = ctx;
  const dst = (slot === "a" ? layout.pairA : layout.pairB) as number;
  const name = `CopyBox${slot.toUpperCase()}`;
  asm.ld16("hl", src);
  asm.call(
    ctx.need(name, (inner) => {
      inner.asm.ld16("de", dst);
      inner.asm.ld16("bc", BOX_SIZE);
      inner.asm.ldir();
      inner.asm.ret();
    }),
  );
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

export function emitCollisions(ctx: SmsCtx, scene: SceneCtx): void {
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
        // Separation re-tests, so a rule that teleported its subject away is not
        // dragged back to the wall it just left — or that hid it, because
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
      if (event.others.length > 0) emitStageBox(ctx, subjectBase, "a");

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
