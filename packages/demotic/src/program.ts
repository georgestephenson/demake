/**
 * The compiled program — the hand-off between the front end and the simulator.
 *
 * Everything here is resolved and console-specific: names have become indices,
 * screen constants have become numbers, and every literal is already in 16.16
 * fixed point. Nothing downstream needs the AST, the source text, or the
 * profile to run a tick.
 *
 * That is deliberate, and it is the same shape a console runtime wants: this
 * structure is what a `gen`-style backend would serialise into ROM tables for a
 * fixed per-family interpreter, rather than compiling the language to Z80 or
 * 6502 directly. Adding a behaviour then means a new opcode in each runtime,
 * not a new code path in each code generator.
 */

import type { Diagnostic } from "./errors.js";
import type { Fixed } from "./fixed.js";
import type { ConsoleProfile } from "./profiles.js";

/** Abstract buttons — the lowest common denominator across the target set. */
export const ACTIONS = ["left", "right", "up", "down", "a", "b", "start"] as const;

/** One abstract button. */
export type Action = (typeof ACTIONS)[number];

/** Screen edges usable as collision targets. */
export const EDGES = ["screenleft", "screenright", "screentop", "screenbottom"] as const;

/** One screen edge. */
export type Edge = (typeof EDGES)[number];

/** Which instance a compiled reference resolves to at run time. */
export type EntityRef =
  /** A specific instance, known at compile time. */
  | { kind: "instance"; id: number }
  /** The instance that triggered the rule. */
  | { kind: "subject" }
  /** The instance it collided with. */
  | { kind: "other" };

/** A compiled, evaluable expression. */
export type CExpr =
  | { kind: "const"; value: Fixed }
  /** Negate the current value of the assignment target (`as flip`). */
  | { kind: "flip" }
  | { kind: "read"; entity: EntityRef; prop: string }
  | { kind: "scene"; scene: string }
  | { kind: "binary"; op: CBinaryOp; left: CExpr; right: CExpr }
  | { kind: "neg"; operand: CExpr }
  | { kind: "call"; fn: BuiltinFn; args: readonly CExpr[] };

/** Builtin functions available to expressions. */
export type BuiltinFn = "abs" | "min" | "max" | "clamp";

/** Compiled binary operators. Relational ops yield 1 (true) or 0 (false). */
export type CBinaryOp = "+" | "-" | "*" | "/" | "<" | ">" | "<=" | ">=" | "=" | "!=";

/** Where a compiled assignment writes. */
export type CTarget =
  | { kind: "prop"; entity: EntityRef; prop: string }
  /** The global scene switch. */
  | { kind: "scene" };

/** One compiled assignment. All assignments in a rule apply simultaneously. */
export interface CAssignment {
  target: CTarget;
  value: CExpr;
  line: number;
}

/** A compiled instance definition, including its initial property values. */
export interface InstanceDef {
  id: number;
  name: string;
  className: string;
  scene: string;
  /** Numeric properties, already in fixed point. */
  numbers: Readonly<Record<string, Fixed>>;
  /** String properties (`sprite`, `text`). */
  strings: Readonly<Record<string, string>>;
  /** Hardware sprites this instance occupies, for the budget report. */
  spriteCost: number;
  /** 1-indexed source line of the `create` statement, for diagnostics. */
  line: number;
}

/** A compiled `control` binding. */
export interface ControlDef {
  instanceId: number;
  action: Action;
  mode: "hold" | "press" | "release";
  assignments: readonly CAssignment[];
  line: number;
}

/** The compiled trigger half of a rule. */
export type CEvent =
  | {
      kind: "hits";
      subjects: readonly number[];
      others: readonly number[];
      edges: readonly Edge[];
      /** `touches`: fire every tick of overlap, not only on entry. */
      level: boolean;
    }
  | { kind: "input"; action: Action; edge: "pressed" | "released" }
  | { kind: "reaches"; left: CExpr; right: CExpr }
  | { kind: "predicate"; test: CExpr };

/** A compiled `when` rule. */
export interface RuleDef {
  id: number;
  event: CEvent;
  /** Restrict the rule to one scene; `undefined` means every scene. */
  scene?: string;
  assignments: readonly CAssignment[];
  line: number;
}

/** A compiled scene. */
export interface SceneDef {
  name: string;
  instanceIds: readonly number[];
}

/** Static budget findings, reported without running the game. */
export interface BudgetReport {
  /** Peak hardware sprites required by any single scene. */
  peakSprites: number;
  /** Sprite entries the console provides. */
  spriteLimit: number;
  /** Sprites the console draws per scanline. */
  perLineLimit: number;
  /** Scene name that produced `peakSprites`. */
  peakScene: string;
}

/** A fully compiled, console-specific program. */
export interface Program {
  profile: ConsoleProfile;
  /** Scene the game loop enters on. */
  entryScene: string;
  scenes: readonly SceneDef[];
  instances: readonly InstanceDef[];
  controls: readonly ControlDef[];
  rules: readonly RuleDef[];
  /** Asset paths referenced by `sprite` properties, deduplicated and sorted. */
  assets: readonly string[];
  budget: BudgetReport;
  /** Non-fatal findings: unused declarations, budget pressure, and so on. */
  warnings: readonly Diagnostic[];
}
