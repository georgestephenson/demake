/**
 * What the program actually needs — the analysis that lets the backend leave
 * things out.
 *
 * A fixed engine pays for every feature in every game: the divide routine ships
 * whether or not a rule divides, the entity table is sized for the worst case,
 * and `visible` is tested every tick even for an object nothing can hide. On a
 * 4 MHz machine with 8 KiB of RAM that is the whole budget, spent on absences.
 *
 * So the backend asks this module three kinds of question before emitting a
 * byte:
 *
 *   - **Which helpers are reachable?** No `random` in the source, no generator
 *     in the ROM. No division, no 48-bit divide loop.
 *   - **Which properties can change?** An object whose `visible` no rule ever
 *     writes cannot become invisible, so its visibility test folds away. An
 *     object whose `speed` starts at zero and is never written never moves, so
 *     it leaves the integrator entirely.
 *   - **Which entities can a rule bind?** A rule's subject and other come from
 *     compile-time lists, so "does anything write `ball1.x`" is decidable.
 *
 * Everything here is deliberately *conservative*: a "yes" may be wrong (the
 * cost is a few bytes), a "no" may not be (the cost is a wrong game). Where the
 * two could differ the analysis says yes.
 */

import type { CAssignment, CExpr, Program } from "../program.js";

/** Runtime helpers the emitted code may call. */
export type Helper =
  | "mul32"
  | "div32"
  | "divCells"
  | "rng"
  | "digits"
  | "drawText"
  | "tileAt"
  | "camera"
  | "scroll"
  | "tiles";

/** What a program uses, and what it therefore costs. */
export interface Analysis {
  /** Properties any rule, control or hold can write, per entity id. */
  writes: ReadonlyMap<number, ReadonlySet<string>>;
  /** True where a scene has a level, so the tile layer exists at all. */
  usesLevels: boolean;
  /** True where a rule names a tile, so tile collision exists. */
  usesTiles: boolean;
  /** True where a scene has a camera target. */
  usesCamera: boolean;
  /** True where any expression reads `camera.x`/`camera.y`. */
  readsCamera: boolean;
  /** True where any expression draws from the generator. */
  usesRandom: boolean;
  /** True where any expression multiplies by something that is not a constant. */
  usesMultiply: boolean;
  /** True where any expression divides. */
  usesDivide: boolean;
  /** True where an instance draws a `number`. */
  usesNumbers: boolean;
  /** True where an instance draws `text`. */
  usesText: boolean;
  /** True where any instance draws as a sprite. */
  usesSprites: boolean;
  /** Deepest expression stack any expression needs. */
  maxDepth: number;
  /** Most assignments any single rule or control applies at once. */
  maxAssignments: number;
  /** Properties `on hold` controls write, in the order slots are allocated. */
  holdSlots: number;
}

/** One property `on hold` controls write, and every binding that writes it. */
export interface HoldTarget {
  /** The instance the property belongs to. */
  instanceId: number;
  prop: string;
  /** Indices into `program.controls` of the hold bindings that write it. */
  controls: readonly number[];
}

/**
 * The properties `on hold` controls write, one entry per property.
 *
 * A snapshot belongs to the **property**, not to the binding that took it, and
 * that is the whole reason this list exists. Left and right both write
 * `xdirection`, so "the value before the button went down" means the value
 * before *either* went down — taken per binding, right's snapshot is whatever
 * left had already written, and releasing the two out of nesting order writes a
 * direction back that no button is asking for. Grouping the bindings here is
 * also what lets a release ask whether any *other* button still wants the
 * property, so handing over is immediate rather than a tick of standing still.
 *
 * A control's assignments run with its own object bound as both subject and
 * other, so every entity reference resolves to an instance without a layout.
 */
export function holdTargets(program: Program): HoldTarget[] {
  const slots: HoldTarget[] = [];
  const byKey = new Map<string, HoldTarget>();
  for (const [index, control] of program.controls.entries()) {
    if (control.mode !== "hold") continue;
    for (const assignment of control.assignments) {
      const target = assignment.target;
      if (target.kind !== "prop") continue;
      const instanceId = target.entity.kind === "instance" ? target.entity.id : control.instanceId;
      const key = `${instanceId}:${target.prop}`;
      let slot = byKey.get(key);
      if (slot === undefined) {
        slot = { instanceId, prop: target.prop, controls: [] };
        byKey.set(key, slot);
        slots.push(slot);
      }
      const bindings = slot.controls as number[];
      if (!bindings.includes(index)) bindings.push(index);
    }
  }
  return slots;
}

/** Everything a rule can bind as its subject, given the compile-time lists. */
function subjectsOf(program: Program, ruleId: number): readonly number[] {
  const rule = program.rules[ruleId];
  if (!rule) return [];
  if (rule.event.kind === "hits") return rule.event.subjects;
  return rule.subjects ?? [];
}

/** Everything a rule can bind as its `other`. */
function othersOf(program: Program, ruleId: number): readonly number[] {
  const rule = program.rules[ruleId];
  if (!rule || rule.event.kind !== "hits") return [];
  return rule.event.others;
}

/** Depth of the value stack an expression needs. */
export function exprDepth(expr: CExpr): number {
  switch (expr.kind) {
    case "binary":
      return Math.max(exprDepth(expr.left), exprDepth(expr.right) + 1);
    case "neg":
      return exprDepth(expr.operand);
    case "call": {
      let depth = 0;
      for (const [index, arg] of expr.args.entries()) {
        depth = Math.max(depth, exprDepth(arg) + index);
      }
      return Math.max(1, depth);
    }
    default:
      return 1;
  }
}

/** Walk every node of an expression. */
export function walkExpr(expr: CExpr, visit: (node: CExpr) => void): void {
  visit(expr);
  switch (expr.kind) {
    case "binary":
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case "neg":
      walkExpr(expr.operand, visit);
      break;
    case "call":
      for (const arg of expr.args) walkExpr(arg, visit);
      break;
    default:
      break;
  }
}

/** Every expression the program evaluates, in no particular order. */
function allExpressions(program: Program): CExpr[] {
  const out: CExpr[] = [];
  const fromAssignments = (assignments: readonly CAssignment[] | undefined) => {
    for (const assignment of assignments ?? []) out.push(assignment.value);
  };
  for (const control of program.controls) fromAssignments(control.assignments);
  for (const rule of program.rules) {
    fromAssignments(rule.assignments);
    fromAssignments(rule.otherwise);
    if (rule.guard) out.push(rule.guard);
    if (rule.event.kind === "predicate") out.push(rule.event.test);
    if (rule.event.kind === "reaches") {
      out.push(rule.event.left);
      out.push(rule.event.right);
    }
  }
  return out;
}

/** Study a compiled program. */
export function analyze(program: Program): Analysis {
  const writes = new Map<number, Set<string>>();
  const note = (id: number, prop: string): void => {
    let set = writes.get(id);
    if (!set) {
      set = new Set();
      writes.set(id, set);
    }
    set.add(prop);
  };

  const record = (
    assignments: readonly CAssignment[] | undefined,
    subjects: readonly number[],
    others: readonly number[],
  ): void => {
    for (const assignment of assignments ?? []) {
      if (assignment.target.kind !== "prop") continue;
      const { entity, prop } = assignment.target;
      // `direction` is write-only sugar the compiler has already expanded, so
      // every target here is a stored property or a rejected derived one.
      switch (entity.kind) {
        case "instance":
          note(entity.id, prop);
          break;
        case "subject":
          for (const id of subjects) note(id, prop);
          break;
        case "other":
          for (const id of others) note(id, prop);
          break;
      }
    }
  };

  for (const control of program.controls) {
    // A control's unbound target falls back to its own object.
    record(control.assignments, [control.instanceId], []);
  }
  for (const rule of program.rules) {
    const subjects = subjectsOf(program, rule.id);
    const others = othersOf(program, rule.id);
    record(rule.assignments, subjects, others);
    record(rule.otherwise, subjects, others);
  }

  let usesRandom = false;
  let usesMultiply = false;
  let usesDivide = false;
  let readsCamera = false;
  let maxDepth = 1;

  for (const expr of allExpressions(program)) {
    maxDepth = Math.max(maxDepth, exprDepth(expr));
    walkExpr(expr, (node) => {
      if (node.kind === "call" && node.fn === "random") usesRandom = true;
      if (node.kind === "camera") readsCamera = true;
      if (node.kind !== "binary") return;
      // A multiply or divide by a constant power of two is a shift, and by one
      // is nothing at all; only the general cases pull in a helper.
      if (node.op === "*" && !isTrivialFactor(node.right) && !isTrivialFactor(node.left)) {
        usesMultiply = true;
      }
      if (node.op === "/" && !isTrivialFactor(node.right)) usesDivide = true;
    });
  }

  let maxAssignments = 0;
  for (const control of program.controls) {
    maxAssignments = Math.max(maxAssignments, control.assignments.length);
  }
  for (const rule of program.rules) {
    maxAssignments = Math.max(maxAssignments, rule.assignments.length);
    maxAssignments = Math.max(maxAssignments, rule.otherwise?.length ?? 0);
  }

  const usesLevels = program.scenes.some((scene) => scene.level !== undefined);
  const usesTiles = program.rules.some(
    (rule) => rule.event.kind === "hits" && rule.event.tiles.length > 0,
  );
  const usesCamera = program.scenes.some((scene) => scene.cameraTarget !== undefined);

  let usesNumbers = false;
  let usesText = false;
  let usesSprites = false;
  for (const instance of program.instances) {
    if (instance.className === "number") usesNumbers = true;
    else if (instance.className === "text") usesText = true;
    else if (instance.strings["sprite"] !== undefined) usesSprites = true;
  }

  const holdSlots = holdTargets(program).length;

  return {
    writes,
    usesLevels,
    usesTiles,
    usesCamera,
    readsCamera,
    usesRandom,
    usesMultiply,
    usesDivide,
    usesNumbers,
    usesText,
    usesSprites,
    maxDepth,
    maxAssignments,
    holdSlots,
  };
}

/** A factor of exactly 1.0, which makes a multiply or divide a no-op. */
function isTrivialFactor(expr: CExpr): boolean {
  return expr.kind === "const" && expr.value === 0x10000;
}

/** Can this entity's property ever change after the scene resets it? */
export function isMutable(analysis: Analysis, entityId: number, prop: string): boolean {
  return analysis.writes.get(entityId)?.has(prop) === true;
}
