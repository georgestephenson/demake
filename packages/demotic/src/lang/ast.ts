/**
 * The AST — a flat list of statements, in source order.
 *
 * Declaration order does not matter: `loop scene1` may precede `scene scene1`,
 * and an instance may name a class declared later in the file. The compiler
 * does a full pass to build symbol tables before resolving anything, so the
 * language stays order-free the way the sketch intended.
 */

/**
 * Units a numeric literal may carry.
 *
 * `cells` is the substrate — one 8x8 hardware cell — and is what an unsuffixed
 * number means. The rest are *relative* units, resolved against the target's
 * playfield at compile time, and they exist because absolute units alone cannot
 * express game balance: a 3-cell paddle covers 15% of a Game Boy screen and 7.5%
 * of a Mega Drive one, so the same game is twice as easy on the bigger machine.
 *
 * `vw`/`vh`/`vmin`/`vmax` follow CSS: one unit is one *percent* of the named
 * dimension. `vmin` is the one to reach for when a shape must stay square, since
 * the targets do not share an aspect ratio.
 */
export type Unit = "cells" | "vw" | "vh" | "vmin" | "vmax";

/** An expression node. */
export type Expr =
  | { kind: "number"; value: number; unit?: Unit; line: number }
  /** A builtin call, e.g. `abs(paddle.centerx - ball.centerx)`. */
  | { kind: "call"; name: string; args: readonly Expr[]; line: number }
  | { kind: "string"; value: string; line: number }
  /** A bare or dotted name — resolved by the compiler against context. */
  | { kind: "name"; parts: readonly string[]; raw: string; line: number }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; line: number }
  | { kind: "unary"; op: "-"; operand: Expr; line: number };

/** Binary operators, arithmetic and relational. */
export type BinaryOp = "+" | "-" | "*" | "/" | "<" | ">" | "<=" | ">=" | "=" | "!=";

/** One `name value` pair, or one column of a `(cols) as (values)` pair-up. */
export interface Prop {
  name: string;
  value: Expr;
  line: number;
}

/** An assignment target: an optional entity qualifier plus a property name. */
export interface TargetRef {
  /** Unqualified targets bind to the rule's subject (see `sim.ts`). */
  entity?: string;
  prop: string;
  line: number;
}

/** One `target = value` assignment inside a `when` or `control` action. */
export interface Assignment {
  target: TargetRef;
  value: Expr;
}

/** How a `control` binding behaves over the lifetime of a button press. */
export type ControlMode = "hold" | "press" | "release";

/** The trigger half of a `when` statement. */
export type Event =
  /**
   * `when ball hits paddle` — edge-triggered on overlap start.
   * `when hero touches ledge` — level-triggered, every tick they overlap.
   *
   * Both are needed and neither substitutes for the other: a bounce must happen
   * once per contact, and resting contact must be re-asserted every tick or the
   * state that contact suppresses (gravity, say) accumulates unseen while the
   * object appears to sit still.
   */
  | { kind: "hits"; subject: string; others: readonly string[]; level: boolean }
  /** `when start pressed` / `when a released` — input edges. */
  | { kind: "input"; action: string; edge: "pressed" | "released" }
  /** `when score1.value reaches 10` — edge-triggered when the test turns true. */
  | { kind: "reaches"; left: Expr; right: Expr }
  /** `when ball1.x < paddle2.x` — level-triggered, fires every tick it holds. */
  | { kind: "predicate"; test: Expr };

/** A parsed statement. */
export type Stmt =
  | { kind: "start"; scene: string; line: number }
  | { kind: "scene"; name: string; line: number }
  | { kind: "level"; name: string; scene?: string; file: string; line: number }
  | {
      kind: "stream";
      name: string;
      scene?: string;
      files: readonly string[];
      count: number;
      axis: "wide" | "tall";
      line: number;
    }
  | { kind: "seed"; value: number; line: number }
  | { kind: "camera"; target: string; scene?: string; line: number }
  | { kind: "backdrop"; file: string; scene?: string; line: number }
  | { kind: "music"; file: string; scene?: string; line: number }
  /**
   * `sound blip.wav on ball hits paddle` — an effect on one of `when`'s triggers.
   *
   * It carries a trigger and no assignments, which is the whole reason it is a
   * statement of its own rather than a value a rule could assign: "play this"
   * is not a property of anything, and the rule form has nowhere to put it that
   * would not also allow half a dozen readings nobody wants.
   */
  | {
      kind: "sound";
      file: string;
      event: Event;
      scene?: string;
      guard?: Expr;
      line: number;
    }
  | { kind: "class"; name: string; props: readonly Prop[]; line: number }
  | {
      kind: "instance";
      className: string;
      name: string;
      scene?: string;
      props: readonly Prop[];
      line: number;
    }
  | {
      kind: "control";
      entity: string;
      action: string;
      assignments: readonly Assignment[];
      mode: ControlMode;
      line: number;
    }
  | {
      kind: "when";
      event: Event;
      scene?: string;
      /** `if <expr>` — the trigger fired, but only act when this holds too. */
      guard?: Expr;
      /** Applied when the rule fires (and its guard, if any, holds). */
      assignments: readonly Assignment[];
      /** `else` — applied when the rule was evaluated and did not fire. */
      otherwise?: readonly Assignment[];
      line: number;
    };

/** A parsed program: statements plus any diagnostics the parser recovered from. */
export interface ParsedProgram {
  statements: readonly Stmt[];
}
