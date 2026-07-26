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
import type { LevelFile } from "./level/parse.js";
import type { ConsoleProfile } from "./profiles.js";

/**
 * Abstract buttons — the lowest common denominator across the target set.
 *
 * Written as a literal tuple rather than derived from the registry so the rest
 * of the engine keeps exhaustive switch checking on `Action` and `Edge`; a test
 * asserts these match `lang/spec.ts` exactly. That is the same bargain the man
 * pages strike with `cli-spec` (doc 05): keep the strong form, let a test stop
 * it drifting.
 */
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
  | { kind: "call"; fn: BuiltinFn; args: readonly CExpr[] }
  /** `camera.x` / `camera.y` — where the viewport sits, in cells. */
  | { kind: "camera"; axis: "x" | "y" };

/** Builtin functions available to expressions. */
export type BuiltinFn = "abs" | "min" | "max" | "clamp" | "random";

/**
 * The builtins that depend on nothing but their arguments.
 *
 * `random` is the exception, and the type keeps it out of every place that
 * assumes a call can be folded: drawing a number advances the generator, so
 * *when* it is evaluated is part of the game's behaviour.
 */
export type PureBuiltinFn = Exclude<BuiltinFn, "random">;

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
      /** Level tiles named as collision targets, by their legend name. */
      tiles: readonly string[];
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
  /** `if <expr>` — evaluated when the trigger fires; zero suppresses it. */
  guard?: CExpr;
  assignments: readonly CAssignment[];
  /** `else` — applied when the rule was evaluated and did not fire. */
  otherwise?: readonly CAssignment[];
  /**
   * Instances this rule runs once per, each bound as the subject.
   *
   * A level rule naming a class means "every instance of it", so
   * `when alien.right >= screenwidth then xdirection as -1` turns the line
   * around one alien at a time. `hits` rules already bind their subject from
   * the collision, so this is empty for them.
   */
  subjects?: readonly number[];
  line: number;
}

/** A compiled scene. */
export interface SceneDef {
  name: string;
  instanceIds: readonly number[];
  /** The level filling this scene's playfield, if it has one. */
  level?: LevelFile;
  /** Playfield size in cells: the level's, or the screen's. */
  bounds: { width: number; height: number };
  /** Instance the camera keeps centred, if any. */
  cameraTarget?: number;
  /**
   * Image filling this scene's background, if it has one.
   *
   * Scenery and nothing more: it has no cells anything can collide with and no
   * names any rule can reach. It is the file name the `.dmt` wrote, resolved to
   * pixels by the image pipeline at build time.
   */
  backdrop?: string;
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
  /**
   * The seed every `random` draw comes from, and that `stream` composed its
   * levels with. It lives in the program, not the Demakefile: a different seed
   * is a different game, and the Demakefile may never change how a game plays.
   */
  seed: number;
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
