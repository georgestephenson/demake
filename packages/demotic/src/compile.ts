/**
 * Compiler: statements + a console profile → a {@link Program}.
 *
 * Resolution happens over symbol tables built up front, so declaration order
 * never matters: `loop play` may precede `scene play`, and an instance may name
 * a class declared further down the file.
 *
 * Two resolutions are *type-directed*, which is what lets the surface syntax
 * stay free of quoting ceremony:
 *
 *   - `sprite ball.png` — the parser sees a dotted name; because the `sprite`
 *     property is asset-typed, the compiler reads it as the literal string.
 *   - `(scene) as gameover` — `gameover` is a bare name; because the `scene`
 *     target is scene-typed, it resolves to a scene rather than an expression.
 *
 * Console-dependent constants (`screenwidth`, `centerx`, …) are folded here, so
 * the same source compiles to different numbers per target and the simulator
 * never needs the profile to evaluate an expression.
 */

import type { Diagnostic } from "./errors.js";
import { GameLangError } from "./errors.js";
import {
  clampFixed,
  type Fixed,
  fromDecimal,
  fromInt,
  ONE,
  roundToInt,
  toNumber,
} from "./fixed.js";
import type { Assignment, Expr, Prop, Stmt, Unit } from "./lang/ast.js";
import {
  CELL_QUANTISED,
  DERIVED_PROPS,
  knownPropertyNames,
  NUMBER_DEFAULTS,
  STRING_PROPS,
} from "./lang/spec.js";
import { parse } from "./lang/parse.js";
import { levelAssets, type LevelFile, parseLevel } from "./level/parse.js";
import { boundsOf } from "./level/scene.js";
import { type StreamChunk, streamLevel } from "./level/stream.js";
import type { ConsoleProfile } from "./profiles.js";
import type {
  Action,
  BudgetReport,
  BuiltinFn,
  CAssignment,
  CBinaryOp,
  CEvent,
  CExpr,
  ControlDef,
  Edge,
  EntityRef,
  InstanceDef,
  Program,
  PureBuiltinFn,
  RuleDef,
  SceneDef,
} from "./program.js";
import { ACTIONS, EDGES } from "./program.js";
import { DEFAULT_SEED } from "./rng.js";

const FIXED_DEFAULTS: Readonly<Record<string, Fixed>> = Object.fromEntries(
  Object.entries(NUMBER_DEFAULTS).map(([key, value]) => [key, fromInt(value)]),
);

/**
 * Compass names, as (xdirection, ydirection) pairs. Screen coordinates grow
 * downward, so `north` is negative y.
 *
 * Diagonals are deliberately *not* normalised: `speed` applies per axis, so a
 * northwest heading travels at `speed` on both axes rather than `speed/√2`.
 * That keeps the entire simulation inside exact integer arithmetic — no square
 * root, nothing subtle for a console runtime to reproduce bit-for-bit — at the
 * cost of diagonal movement being faster than axial. It is a real trade, and
 * the language states it rather than hiding it.
 */
const DIRECTIONS: Readonly<Record<string, readonly [number, number]>> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
};

/** Builtin classes rendered as glyphs from the background layer, not sprites. */
const TEXT_CLASSES = new Set(["number", "text"]);

const EDGE_SET = new Set<string>(EDGES);
const ACTION_SET = new Set<string>(ACTIONS);

/**
 * Turn a relative unit into cells against a playfield. One unit is one percent,
 * as in CSS. Unsuffixed numbers are already cells.
 *
 * Exported because the `.test.dmt` evaluator resolves the same literals against
 * the same profile — two implementations of this would be two dialects.
 */
export function resolveUnit(value: Fixed, unit: Unit | undefined, profile: ConsoleProfile): Fixed {
  if (unit === undefined || unit === "cells") return value;
  const { screenWidth, screenHeight } = profile;
  const dimension =
    unit === "vw"
      ? screenWidth
      : unit === "vh"
        ? screenHeight
        : unit === "vmin"
          ? Math.min(screenWidth, screenHeight)
          : Math.max(screenWidth, screenHeight);
  return clampFixed(Math.floor((value * dimension) / 100));
}

/** Console-dependent constants. Shared with the `.test.dmt` evaluator. */
export function screenConstant(name: string, profile: ConsoleProfile): Fixed | undefined {
  const { screenWidth, screenHeight, rawWidth, rawHeight, cellSize, fps } = profile;
  switch (name) {
    case "screenwidth":
      return fromInt(screenWidth);
    case "screenheight":
      return fromInt(screenHeight);
    case "rawscreenwidth":
      return fromInt(rawWidth / cellSize);
    case "rawscreenheight":
      return fromInt(rawHeight / cellSize);
    case "centerx":
      return fromInt(screenWidth) / 2;
    case "centery":
      return fromInt(screenHeight) / 2;
    case "screenleft":
    case "screentop":
      return 0;
    case "screenright":
      return fromInt(screenWidth);
    case "screenbottom":
      return fromInt(screenHeight);
    case "fps":
      return fromInt(fps);
    // A level rule needs a way to say "every tick" — a continuous assignment
    // rather than a conditional one. `when always` is that.
    case "always":
      return ONE;
    case "never":
      return 0;
    default:
      return undefined;
  }
}

/** Options for {@link compile}. */
export interface CompileOptions {
  /** Target console profile. */
  profile: ConsoleProfile;
  /**
   * `.dmtl` sources by filename.
   *
   * The compiler is platform-pure, so it never reads a file; whoever calls it
   * resolves paths and hands the text in, exactly as art assets work.
   */
  levels?: Readonly<Record<string, string>>;
}

interface ClassInfo {
  numbers: Record<string, Fixed>;
  strings: Record<string, string>;
}

interface Bindings {
  /** Names resolving to the rule's subject or its collision partner. */
  readonly map: ReadonlyMap<string, EntityRef>;
}

const NO_BINDINGS: Bindings = { map: new Map() };

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  private readonly classes = new Map<string, ClassInfo>();
  private readonly instances: InstanceDef[] = [];
  private readonly instancesByName = new Map<string, InstanceDef>();
  private readonly instancesByClass = new Map<string, number[]>();
  private readonly sceneOrder: string[] = [];
  private readonly sceneSet = new Set<string>();
  private entry: string | undefined;

  private readonly levelsByScene = new Map<string, LevelFile>();
  private readonly cameraByScene = new Map<string, number>();
  private readonly tileNames = new Set<string>();
  private seed = DEFAULT_SEED;

  constructor(
    private readonly profile: ConsoleProfile,
    private readonly levelSources: Readonly<Record<string, string>> = {},
  ) {}

  /** The program's random seed, which `stream` also composes with. */
  collectSeed(statements: readonly Stmt[]): void {
    let seen = false;
    for (const statement of statements) {
      if (statement.kind !== "seed") continue;
      if (seen) {
        this.error(statement.line, "E_DUPLICATE_SEED", "a program has one `seed`");
        continue;
      }
      seen = true;
      // Kept in 32 bits, and away from zero: an LCG seeded at 0 is fine here
      // (the increment lifts it) but a negative seed would not survive the
      // unsigned round trip a console runtime does.
      this.seed = statement.value >>> 0;
    }
  }

  /**
   * Load each scene's playfield — hand-drawn (`level`) or composed (`stream`) —
   * and check it is big enough for this console.
   *
   * One pass over both, because "a scene has one playfield" is the rule being
   * enforced and it does not care which statement supplied it.
   */
  collectLevels(statements: readonly Stmt[]): void {
    let currentScene: string | undefined;
    // Streams draw from one generator run, in source order, so a program's whole
    // set of composed levels follows from its single `seed`.
    let state = this.seed;

    for (const statement of statements) {
      if (statement.kind === "scene") {
        currentScene = statement.name;
        continue;
      }
      if (statement.kind !== "level" && statement.kind !== "stream") continue;

      const scene = this.resolveScene(statement.scene, currentScene, statement.line);
      if (scene === undefined) continue;
      if (this.levelsByScene.has(scene)) {
        this.error(
          statement.line,
          "E_DUPLICATE_LEVEL",
          `scene '${scene}' already has a level`,
          "a scene has one playfield",
        );
        continue;
      }

      let level: LevelFile | undefined;
      let describedAs: string;

      if (statement.kind === "level") {
        level = this.loadLevel(statement.file, statement.line);
        describedAs = `'${statement.file}'`;
      } else {
        const chunks: StreamChunk[] = [];
        for (const file of statement.files) {
          const chunk = this.loadLevel(file, statement.line);
          if (chunk) chunks.push({ file, level: chunk });
        }
        if (chunks.length < statement.files.length) continue;

        const result = streamLevel(chunks, statement.count, statement.axis, state, statement.line);
        state = result.state;
        this.diagnostics.push(...result.diagnostics);
        if (result.diagnostics.some((d) => d.severity === "error")) continue;
        level = result.level;
        describedAs = `stream '${statement.name}'`;
      }

      if (!level) continue;

      // A level smaller than the viewport would leave part of the screen with
      // nothing in it — and it is per-console, so a level that fits a Game Boy
      // can still be too small for a Mega Drive.
      if (level.width < this.profile.screenWidth || level.height < this.profile.screenHeight) {
        this.error(
          statement.line,
          "E_LEVEL_TOO_SMALL",
          `${describedAs} is ${level.width}x${level.height} cells; ${this.profile.name} shows ${this.profile.screenWidth}x${this.profile.screenHeight}`,
          "a level must be at least as big as the largest screen it targets",
        );
        continue;
      }

      this.levelsByScene.set(scene, level);
      for (const tile of level.tiles) this.tileNames.add(tile.name);
    }
  }

  /** Parse one `.dmtl` source, reporting its diagnostics against this line. */
  private loadLevel(file: string, line: number): LevelFile | undefined {
    const source = this.levelSources[file];
    if (source === undefined) {
      this.error(
        line,
        "E_UNKNOWN_LEVEL",
        `no level file '${file}' was provided`,
        `available: ${Object.keys(this.levelSources).join(", ") || "none"}`,
      );
      return undefined;
    }

    const level = parseLevel(source);
    for (const diagnostic of level.diagnostics) {
      this.diagnostics.push({ ...diagnostic, message: `${file}: ${diagnostic.message}` });
    }
    return level.diagnostics.some((d) => d.severity === "error") ? undefined : level;
  }

  /** Resolve each scene's camera target. */
  collectCameras(statements: readonly Stmt[]): void {
    let currentScene: string | undefined;
    for (const statement of statements) {
      if (statement.kind === "scene") {
        currentScene = statement.name;
        continue;
      }
      if (statement.kind !== "camera") continue;

      const scene = this.resolveScene(statement.scene, currentScene, statement.line);
      if (scene === undefined) continue;
      const instance = this.instancesByName.get(statement.target);
      if (!instance) {
        this.error(statement.line, "E_UNKNOWN_INSTANCE", `no object named '${statement.target}'`);
        continue;
      }
      // A scene has one viewport for the same reason it has one playfield: the
      // second `camera follows` would silently win, and a view that tracks the
      // wrong object looks like a camera bug rather than a duplicated line.
      if (this.cameraByScene.has(scene)) {
        this.error(
          statement.line,
          "E_DUPLICATE_CAMERA",
          `scene '${scene}' already has a camera`,
          "a scene has one viewport; one `camera follows` decides what it tracks",
        );
        continue;
      }
      this.cameraByScene.set(scene, instance.id);
    }
  }

  /** The playfield of a scene: its level's size, or the screen's. */
  boundsFor(scene: string): { width: number; height: number } {
    return boundsOf(this.levelsByScene.get(scene), this.profile);
  }

  private error(line: number, code: string, message: string, hint?: string): void {
    this.diagnostics.push({
      severity: "error",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  private warn(line: number, code: string, message: string, hint?: string): void {
    this.diagnostics.push({
      severity: "warning",
      code,
      message,
      line,
      ...(hint === undefined ? {} : { hint }),
    });
  }

  private errorCount(): number {
    return this.diagnostics.reduce((n, d) => n + (d.severity === "error" ? 1 : 0), 0);
  }

  // --- declarations ----------------------------------------------------------

  collectScenes(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      if (statement.kind === "scene") {
        if (this.sceneSet.has(statement.name)) {
          this.error(
            statement.line,
            "E_DUPLICATE_SCENE",
            `scene '${statement.name}' is declared twice`,
          );
          continue;
        }
        this.sceneSet.add(statement.name);
        this.sceneOrder.push(statement.name);
      } else if (statement.kind === "start") {
        if (this.entry !== undefined) {
          this.error(
            statement.line,
            "E_DUPLICATE_START",
            "a program has exactly one `start` statement",
          );
          continue;
        }
        this.entry = statement.scene;
      }
    }

    if (this.entry === undefined) {
      this.error(
        1,
        "E_NO_ENTRY",
        "no `start <scene>` statement — the game has no entry point",
        "add `start <scene>` naming the scene the game begins on",
      );
    } else if (!this.sceneSet.has(this.entry)) {
      this.error(
        1,
        "E_UNKNOWN_SCENE",
        `\`start\` names scene '${this.entry}', which is never declared`,
      );
    }
  }

  collectClasses(statements: readonly Stmt[]): void {
    for (const statement of statements) {
      if (statement.kind !== "class") continue;
      if (TEXT_CLASSES.has(statement.name)) {
        this.error(
          statement.line,
          "E_RESERVED_CLASS",
          `'${statement.name}' is a builtin class and cannot be redeclared`,
        );
        continue;
      }
      if (this.classes.has(statement.name)) {
        this.error(
          statement.line,
          "E_DUPLICATE_CLASS",
          `class '${statement.name}' is declared twice`,
        );
        continue;
      }
      const info: ClassInfo = { numbers: {}, strings: {} };
      this.applyProps(statement.props, info.numbers, info.strings);
      this.classes.set(statement.name, info);
    }
  }

  collectInstances(statements: readonly Stmt[]): void {
    let currentScene: string | undefined;

    for (const statement of statements) {
      if (statement.kind === "scene") {
        currentScene = statement.name;
        continue;
      }
      if (statement.kind !== "instance") continue;

      const scene = this.resolveScene(statement.scene, currentScene, statement.line);
      if (scene === undefined) continue;

      const isBuiltin = TEXT_CLASSES.has(statement.className);
      const klass = this.classes.get(statement.className);
      if (!isBuiltin && !klass) {
        this.error(
          statement.line,
          "E_UNKNOWN_CLASS",
          `no class named '${statement.className}'`,
          "declare it with `create object <name> (...)`",
        );
        continue;
      }
      if (this.instancesByName.has(statement.name)) {
        this.error(
          statement.line,
          "E_DUPLICATE_INSTANCE",
          `'${statement.name}' is already defined`,
        );
        continue;
      }

      const numbers: Record<string, Fixed> = { ...FIXED_DEFAULTS, ...(klass?.numbers ?? {}) };
      const strings: Record<string, string> = { ...(klass?.strings ?? {}) };
      this.applyProps(statement.props, numbers, strings);

      const instance: InstanceDef = {
        id: this.instances.length,
        name: statement.name,
        className: statement.className,
        scene,
        numbers,
        strings,
        spriteCost: isBuiltin ? 0 : spriteCost(numbers),
        line: statement.line,
      };
      this.instances.push(instance);
      this.instancesByName.set(instance.name, instance);
      const siblings = this.instancesByClass.get(statement.className) ?? [];
      siblings.push(instance.id);
      this.instancesByClass.set(statement.className, siblings);
    }
  }

  private resolveScene(
    explicit: string | undefined,
    current: string | undefined,
    line: number,
  ): string | undefined {
    if (explicit !== undefined) {
      if (!this.sceneSet.has(explicit)) {
        this.error(line, "E_UNKNOWN_SCENE", `no scene named '${explicit}'`);
        return undefined;
      }
      return explicit;
    }
    if (current !== undefined) return current;
    if (this.sceneOrder.length === 1) return this.sceneOrder[0];
    this.error(
      line,
      "E_AMBIGUOUS_SCENE",
      "cannot tell which scene this belongs to",
      "add `in <scene>`, or put the statement below a `scene` declaration",
    );
    return undefined;
  }

  /** Fold a property list into number/string maps, expanding `direction`. */
  private applyProps(
    props: readonly Prop[],
    numbers: Record<string, Fixed>,
    strings: Record<string, string>,
  ): void {
    for (const prop of props) {
      if (prop.name === "direction") {
        const vector = this.directionVector(prop.value, prop.line);
        if (vector) {
          numbers["xdirection"] = fromInt(vector[0]);
          numbers["ydirection"] = fromInt(vector[1]);
        }
        continue;
      }

      if (STRING_PROPS[prop.name] !== undefined) {
        const text = this.literalString(prop.value, prop.line);
        if (text !== undefined) strings[prop.name] = text;
        continue;
      }

      if (!(prop.name in NUMBER_DEFAULTS)) {
        this.error(
          prop.line,
          "E_UNKNOWN_PROP",
          `no property named '${prop.name}'`,
          `known properties: ${knownPropList()}`,
        );
        continue;
      }

      const value = this.constantNumber(prop.value, prop.line);
      if (value === undefined) continue;
      if (!CELL_QUANTISED.has(prop.name)) {
        numbers[prop.name] = value;
        continue;
      }
      const quantised = fromInt(Math.max(1, roundToInt(value)));
      numbers[prop.name] = quantised;
      // Only relative sizes are worth flagging: an author who writes `width 2`
      // asked for exactly two cells, but `width 8vw` asked for a proportion and
      // may not realise the grid moved it a long way.
      const relative =
        prop.value.kind === "number" && prop.value.unit && prop.value.unit !== "cells";
      if (relative && value > 0 && Math.abs(quantised - value) * 4 > value) {
        this.warn(
          prop.line,
          "W_SIZE_ROUNDING",
          `${prop.name} ${formatCells(value)} rounds to ${formatCells(quantised)} on ${this.profile.name}`,
          "sizes land on whole 8x8 cells; pick a proportion that divides more evenly, or say it in cells",
        );
      }
    }

    this.warnOnMixedAxisUnits(props);
  }

  /**
   * `width 5vw, height 5vh` is almost always a mistake: the targets do not share
   * an aspect ratio, so a shape sized that way is square on none of them
   * consistently. `vmin` is the unit that keeps it square.
   */
  private warnOnMixedAxisUnits(props: readonly Prop[]): void {
    const unitOf = (name: string): Unit | undefined => {
      const prop = props.find((candidate) => candidate.name === name);
      return prop?.value.kind === "number" ? prop.value.unit : undefined;
    };
    const width = unitOf("width");
    const height = unitOf("height");
    if (!width || !height) return;
    if ((width === "vw" && height === "vh") || (width === "vh" && height === "vw")) {
      const line = props.find((p) => p.name === "height")?.line ?? 0;
      this.warn(
        line,
        "W_ASPECT_MISMATCH",
        "sizing width and height against different screen axes will not stay square",
        "use `vmin` for both — the consoles do not share an aspect ratio",
      );
    }
  }

  /** Initial property values must be constants — they are baked in at build time. */
  private constantNumber(expr: Expr, line: number): Fixed | undefined {
    const before = this.errorCount();
    const compiled = this.compileNumber(expr, NO_BINDINGS);
    if (this.errorCount() > before) return undefined;

    const folded = foldConstant(compiled);
    if (folded === undefined) {
      this.error(
        line,
        "E_NOT_CONSTANT",
        "initial values must be constants",
        "they are baked in at build time; use a `when` rule for values that change",
      );
      return undefined;
    }
    return folded;
  }

  private directionVector(expr: Expr, line: number): readonly [number, number] | undefined {
    if (expr.kind === "name" && expr.parts.length === 1) {
      const vector = DIRECTIONS[expr.parts[0] as string];
      if (vector) return vector;
    }
    this.error(
      line,
      "E_BAD_DIRECTION",
      "`direction` takes a compass name",
      `one of: ${Object.keys(DIRECTIONS).join(", ")} — or set xdirection/ydirection directly`,
    );
    return undefined;
  }

  private literalString(expr: Expr, line: number): string | undefined {
    if (expr.kind === "string") return expr.value;
    // `sprite ball.png` lexes as a dotted name; asset-typed slots read it literally.
    if (expr.kind === "name") return expr.raw;
    this.error(line, "E_BAD_VALUE", "expected a name or a quoted string");
    return undefined;
  }

  // --- behaviour -------------------------------------------------------------

  compileControls(statements: readonly Stmt[]): ControlDef[] {
    const controls: ControlDef[] = [];
    // Which line already binds a given (object, button, mode, property). Two
    // bindings that set *different* properties from one button are ordinary —
    // that is how a jump both rises and changes animation — so only the exact
    // repeat is an error.
    const bound = new Map<string, number>();
    for (const statement of statements) {
      if (statement.kind !== "control") continue;

      const instance = this.instancesByName.get(statement.entity);
      if (!instance) {
        this.error(
          statement.line,
          "E_UNKNOWN_INSTANCE",
          `no object named '${statement.entity}'`,
          "`control` binds a button to one specific object, not to a class",
        );
        continue;
      }
      if (!ACTION_SET.has(statement.action)) {
        this.error(
          statement.line,
          "E_UNKNOWN_ACTION",
          `'${statement.action}' is not a button`,
          `the portable button set is: ${ACTIONS.join(", ")}`,
        );
        continue;
      }
      if (statement.action === "start" && this.profile.startButton !== "dedicated") {
        this.warn(
          statement.line,
          "W_START_MAPPING",
          `${this.profile.name} has no dedicated Start button; \`start\` maps to ${
            this.profile.startButton === "pause-nmi"
              ? "the console-mounted Pause control"
              : "nothing at all"
          }`,
          "prefer `a` for anything the player must be able to press mid-game",
        );
      }

      // `on hold` snapshots the value it overwrites and restores it on release,
      // per binding. Two bindings on one button writing one property therefore
      // snapshot each other, and which value comes back depends on the order
      // they unwind in — a bug that only shows up on the *second* press.
      let repeated = false;
      for (const assignment of statement.assignments) {
        const key = `${instance.id} ${statement.action} ${statement.mode} ${
          assignment.target.entity ?? statement.entity
        }.${assignment.target.prop}`;
        const first = bound.get(key);
        if (first !== undefined) {
          this.error(
            statement.line,
            "E_DUPLICATE_CONTROL",
            `'${statement.entity}' already sets ${assignment.target.prop} on \`${statement.action}\` (line ${first})`,
            "one button sets a property once; `on hold` restores what each binding overwrote, and two of them cannot both be right",
          );
          repeated = true;
          break;
        }
        bound.set(key, statement.line);
      }
      if (repeated) continue;

      const self: EntityRef = { kind: "instance", id: instance.id };
      controls.push({
        instanceId: instance.id,
        action: statement.action as Action,
        mode: statement.mode,
        assignments: this.compileAssignments(
          statement.assignments,
          { map: new Map([[statement.entity, self]]) },
          self,
        ),
        line: statement.line,
      });
    }
    return controls;
  }

  compileRules(statements: readonly Stmt[]): RuleDef[] {
    const rules: RuleDef[] = [];
    for (const statement of statements) {
      if (statement.kind !== "when") continue;
      const rule = this.compileRule(statement, rules.length);
      if (rule) rules.push(rule);
    }
    return rules;
  }

  private compileRule(statement: Extract<Stmt, { kind: "when" }>, id: number): RuleDef | undefined {
    const line = statement.line;
    let event: CEvent;
    let bindings: Bindings = NO_BINDINGS;
    let defaultTarget: EntityRef | undefined;
    let sceneHint: string | undefined;

    // A level rule that names exactly one class runs once per instance of it,
    // with that instance bound as the subject — the same binding a `hits` rule
    // gets from its collision. This has to be settled before the trigger is
    // compiled, because the trigger's own expressions refer to that binding.
    let perInstance: number[] | undefined;
    if (statement.event.kind !== "hits") {
      const classes = this.classesNamedBy(statement);
      if (classes.length > 1) {
        this.error(
          line,
          "E_AMBIGUOUS_CLASS",
          `this rule names ${classes.length} classes (${classes.join(", ")}), so it has no single object to act on`,
          "name one class, or address objects individually",
        );
        return undefined;
      }
      const [only] = classes;
      if (only) {
        perInstance = [...(this.instancesByClass.get(only) ?? [])];
        bindings = { map: new Map([[only, { kind: "subject" } as EntityRef]]) };
        defaultTarget = { kind: "subject" };
      }
    }

    switch (statement.event.kind) {
      case "hits": {
        const subjects = this.resolveEntitySet(statement.event.subject, line);
        if (!subjects) return undefined;

        const others: number[] = [];
        const edges: Edge[] = [];
        const tiles: string[] = [];
        const map = new Map<string, EntityRef>([
          [statement.event.subject, { kind: "subject" } as EntityRef],
        ]);

        for (const name of statement.event.others) {
          if (EDGE_SET.has(name)) {
            edges.push(name as Edge);
            continue;
          }
          // A tile name from a level legend collides like an object does — which
          // is the whole point of naming tiles: `when player touches spikes`
          // reads as a sentence, and the level supplied the noun.
          if (this.tileNames.has(name)) {
            tiles.push(name);
            continue;
          }
          const resolved = this.resolveEntitySet(name, line);
          if (!resolved) return undefined;
          others.push(...resolved);
          map.set(name, { kind: "other" });
        }

        event = { kind: "hits", subjects, others, edges, tiles, level: statement.event.level };
        bindings = { map };
        defaultTarget = { kind: "subject" };
        sceneHint = this.sceneOf([...subjects, ...others]);
        break;
      }
      case "input": {
        if (!ACTION_SET.has(statement.event.action)) {
          this.error(
            line,
            "E_UNKNOWN_ACTION",
            `'${statement.event.action}' is not a button`,
            `the portable button set is: ${ACTIONS.join(", ")}`,
          );
          return undefined;
        }
        event = {
          kind: "input",
          action: statement.event.action as Action,
          edge: statement.event.edge,
        };
        break;
      }
      case "reaches": {
        event = {
          kind: "reaches",
          left: this.compileNumber(statement.event.left, bindings),
          right: this.compileNumber(statement.event.right, bindings),
        };
        sceneHint = this.sceneOfExprs([statement.event.left, statement.event.right]);
        break;
      }
      case "predicate": {
        event = { kind: "predicate", test: this.compileNumber(statement.event.test, bindings) };
        sceneHint = this.sceneOfExprs([statement.event.test]);
        break;
      }
    }

    if (statement.scene !== undefined && !this.sceneSet.has(statement.scene)) {
      this.error(line, "E_UNKNOWN_SCENE", `no scene named '${statement.scene}'`);
      return undefined;
    }

    if (perInstance) sceneHint = this.sceneOf(perInstance) ?? sceneHint;

    const scene = statement.scene ?? sceneHint;
    const guard =
      statement.guard === undefined ? undefined : this.compileNumber(statement.guard, bindings);
    const assignments = this.compileAssignments(statement.assignments, bindings, defaultTarget);
    const otherwise =
      statement.otherwise === undefined
        ? undefined
        : this.compileAssignments(statement.otherwise, bindings, defaultTarget);

    if (statement.assignments.length === 0) {
      this.warn(line, "W_EMPTY_RULE", "this rule triggers but assigns nothing");
    }

    // `else` means "the rule was evaluated and did not fire". A bare edge
    // trigger is only evaluated at the instant it happens, so its `else` would
    // mean every other tick of the game — almost never what was meant.
    const evaluatedEveryTick =
      event.kind === "predicate" || (event.kind === "hits" && event.level) || guard !== undefined;
    if (otherwise && !evaluatedEveryTick) {
      this.error(
        line,
        "E_ELSE_NOT_ALLOWED",
        "`else` needs a rule that is evaluated every tick",
        "use a level trigger (`touches`, or a plain condition), or add an `if` guard",
      );
      return undefined;
    }

    return {
      id,
      event,
      ...(scene === undefined ? {} : { scene }),
      ...(guard === undefined ? {} : { guard }),
      assignments,
      ...(otherwise === undefined ? {} : { otherwise }),
      ...(perInstance === undefined ? {} : { subjects: perInstance }),
      line,
    };
  }

  /** Class names a non-collision rule refers to, in its trigger or its actions. */
  private classesNamedBy(statement: Extract<Stmt, { kind: "when" }>): string[] {
    const found = new Set<string>();
    const noteName = (raw: string): void => {
      const owner = raw.includes(".") ? raw.slice(0, raw.lastIndexOf(".")) : raw;
      if (this.instancesByClass.has(owner) && !this.instancesByName.has(owner)) found.add(owner);
    };
    const visit = (expr: Expr): void => {
      switch (expr.kind) {
        case "name":
          if (expr.parts.length >= 2) noteName(expr.parts.join("."));
          break;
        case "binary":
          visit(expr.left);
          visit(expr.right);
          break;
        case "unary":
          visit(expr.operand);
          break;
        case "call":
          expr.args.forEach(visit);
          break;
        default:
          break;
      }
    };

    if (statement.event.kind === "predicate") visit(statement.event.test);
    if (statement.event.kind === "reaches") {
      visit(statement.event.left);
      visit(statement.event.right);
    }
    if (statement.guard) visit(statement.guard);
    for (const list of [statement.assignments, statement.otherwise ?? []]) {
      for (const assignment of list) {
        if (assignment.target.entity) noteName(assignment.target.entity);
        visit(assignment.value);
      }
    }
    return [...found].sort();
  }

  private compileAssignments(
    assignments: readonly Assignment[],
    bindings: Bindings,
    defaultTarget: EntityRef | undefined,
  ): CAssignment[] {
    const out: CAssignment[] = [];

    for (const { target, value } of assignments) {
      if (target.entity === undefined && target.prop === "scene") {
        const scene = this.sceneValue(value, target.line);
        if (scene !== undefined) {
          out.push({
            target: { kind: "scene" },
            value: { kind: "scene", scene },
            line: target.line,
          });
        }
        continue;
      }

      const entity = this.resolveTargetEntity(target.entity, bindings, defaultTarget, target.line);
      if (!entity) continue;

      if (target.prop === "direction") {
        const vector = this.directionVector(value, target.line);
        if (!vector) continue;
        out.push({
          target: { kind: "prop", entity, prop: "xdirection" },
          value: { kind: "const", value: fromInt(vector[0]) },
          line: target.line,
        });
        out.push({
          target: { kind: "prop", entity, prop: "ydirection" },
          value: { kind: "const", value: fromInt(vector[1]) },
          line: target.line,
        });
        continue;
      }

      if (STRING_PROPS[target.prop] !== undefined) {
        this.error(
          target.line,
          "E_READONLY_PROP",
          `'${target.prop}' can only be set when the object is created`,
          "swapping art at run time is not in this prototype",
        );
        continue;
      }

      if (!(target.prop in NUMBER_DEFAULTS)) {
        this.error(
          target.line,
          "E_UNKNOWN_PROP",
          DERIVED_PROPS.has(target.prop)
            ? `'${target.prop}' is derived from x/y/width/height and cannot be assigned`
            : `no property named '${target.prop}'`,
          DERIVED_PROPS.has(target.prop)
            ? "assign x or y instead"
            : `known properties: ${knownPropList()}`,
        );
        continue;
      }

      out.push({
        target: { kind: "prop", entity, prop: target.prop },
        value: this.compileNumber(value, bindings),
        line: target.line,
      });
    }

    return out;
  }

  private resolveTargetEntity(
    name: string | undefined,
    bindings: Bindings,
    defaultTarget: EntityRef | undefined,
    line: number,
  ): EntityRef | undefined {
    if (name === undefined) {
      if (defaultTarget) return defaultTarget;
      this.error(
        line,
        "E_UNQUALIFIED_TARGET",
        "this rule has no subject, so the property needs an owner",
        "write `<object>.<property>`, e.g. `paddle2.xdirection`",
      );
      return undefined;
    }
    const bound = bindings.map.get(name);
    if (bound) return bound;
    const instance = this.instancesByName.get(name);
    if (instance) return { kind: "instance", id: instance.id };
    this.error(line, "E_UNKNOWN_INSTANCE", `no object named '${name}'`);
    return undefined;
  }

  private sceneValue(expr: Expr, line: number): string | undefined {
    if (expr.kind === "name" && expr.parts.length === 1) {
      const name = expr.parts[0] as string;
      if (this.sceneSet.has(name)) return name;
      this.error(line, "E_UNKNOWN_SCENE", `no scene named '${name}'`);
      return undefined;
    }
    this.error(line, "E_BAD_VALUE", "`scene` takes the name of a scene");
    return undefined;
  }

  /** Instance ids named by a class name or by a single instance name. */
  private resolveEntitySet(name: string, line: number): number[] | undefined {
    const byClass = this.instancesByClass.get(name);
    if (byClass && byClass.length > 0) return [...byClass];
    const instance = this.instancesByName.get(name);
    if (instance) return [instance.id];
    if (this.classes.has(name)) {
      this.error(line, "E_NO_INSTANCES", `class '${name}' has no objects, so nothing can collide`);
      return undefined;
    }
    this.error(
      line,
      "E_UNKNOWN_ENTITY",
      `'${name}' is not an object, a class, or a screen edge`,
      `screen edges are: ${EDGES.join(", ")}`,
    );
    return undefined;
  }

  private sceneOf(ids: readonly number[]): string | undefined {
    const scenes = new Set(ids.map((id) => (this.instances[id] as InstanceDef).scene));
    return scenes.size === 1 ? [...scenes][0] : undefined;
  }

  private sceneOfExprs(exprs: readonly Expr[]): string | undefined {
    const scenes = new Set<string>();
    const visit = (expr: Expr): void => {
      switch (expr.kind) {
        case "name": {
          if (expr.parts.length >= 2) {
            const instance = this.instancesByName.get(expr.parts.slice(0, -1).join("."));
            if (instance) scenes.add(instance.scene);
          }
          break;
        }
        case "binary":
          visit(expr.left);
          visit(expr.right);
          break;
        case "unary":
          visit(expr.operand);
          break;
        default:
          break;
      }
    };
    for (const expr of exprs) visit(expr);
    return scenes.size === 1 ? [...scenes][0] : undefined;
  }

  // --- expressions -----------------------------------------------------------

  compileNumber(expr: Expr, bindings: Bindings): CExpr {
    switch (expr.kind) {
      case "number":
        return { kind: "const", value: this.resolveUnits(fromDecimal(expr.value), expr.unit) };
      case "string":
        this.error(expr.line, "E_BAD_VALUE", "a quoted string is not a number");
        return { kind: "const", value: 0 };
      case "unary":
        return { kind: "neg", operand: this.compileNumber(expr.operand, bindings) };
      case "binary":
        return {
          kind: "binary",
          op: expr.op,
          left: this.compileNumber(expr.left, bindings),
          right: this.compileNumber(expr.right, bindings),
        };
      case "name":
        return this.compileName(expr, bindings);
      case "call":
        return {
          kind: "call",
          fn: expr.name as BuiltinFn,
          args: expr.args.map((arg) => this.compileNumber(arg, bindings)),
        };
    }
  }

  private resolveUnits(value: Fixed, unit: Unit | undefined): Fixed {
    return resolveUnit(value, unit, this.profile);
  }

  private compileName(expr: Extract<Expr, { kind: "name" }>, bindings: Bindings): CExpr {
    if (expr.parts.length === 1) {
      const name = expr.parts[0] as string;
      if (name === "flip") return { kind: "flip" };

      const constant = this.screenConstant(name);
      if (constant !== undefined) return { kind: "const", value: constant };

      if (DIRECTIONS[name]) {
        this.error(
          expr.line,
          "E_BAD_VALUE",
          `'${name}' is a compass direction, which only sets the \`direction\` property`,
          "assign xdirection and ydirection separately for a partial heading",
        );
        return { kind: "const", value: 0 };
      }

      this.error(
        expr.line,
        "E_UNKNOWN_NAME",
        `'${expr.raw}' is not a value here`,
        "did you mean `<object>.<property>`?",
      );
      return { kind: "const", value: 0 };
    }

    const prop = expr.parts[expr.parts.length - 1] as string;
    const owner = expr.parts.slice(0, -1).join(".");

    // The camera is the one thing that is neither an object nor a constant: it
    // moves, but nothing owns it. A rule reads it to place something relative to
    // the view — a HUD, or an enemy spawned just off the right-hand edge.
    if (owner === "camera") {
      if (prop === "x" || prop === "y") return { kind: "camera", axis: prop };
      this.error(
        expr.line,
        "E_UNKNOWN_PROP",
        `the camera has no property '${prop}'`,
        "camera.x, camera.y",
      );
      return { kind: "const", value: 0 };
    }

    const bound = bindings.map.get(owner);
    const instance = this.instancesByName.get(owner);
    const entity: EntityRef | undefined =
      bound ?? (instance ? { kind: "instance", id: instance.id } : undefined);
    if (!entity) {
      this.error(expr.line, "E_UNKNOWN_INSTANCE", `no object named '${owner}'`);
      return { kind: "const", value: 0 };
    }

    if (!(prop in NUMBER_DEFAULTS) && !DERIVED_PROPS.has(prop)) {
      this.error(
        expr.line,
        "E_UNKNOWN_PROP",
        `objects have no readable property '${prop}'`,
        `readable: ${[...Object.keys(NUMBER_DEFAULTS), ...DERIVED_PROPS].sort().join(", ")}`,
      );
      return { kind: "const", value: 0 };
    }

    return { kind: "read", entity, prop };
  }

  /**
   * Console-dependent constants.
   *
   * `levelwidth`/`levelheight` are the playfield, which is the level's size when
   * a scene has one. They fold to the *entry* scene's bounds, because a constant
   * has to have one value at compile time; a game with differently-sized scenes
   * should read them per scene through the level itself.
   */
  private screenConstant(name: string): Fixed | undefined {
    if (name === "levelwidth" || name === "levelheight") {
      const bounds = this.boundsFor(this.entry ?? (this.sceneOrder[0] as string));
      return fromInt(name === "levelwidth" ? bounds.width : bounds.height);
    }
    return screenConstant(name, this.profile);
  }

  // --- assembly --------------------------------------------------------------

  finish(controls: ControlDef[], rules: RuleDef[]): Program {
    this.checkGeometry(rules);

    const scenes: SceneDef[] = this.sceneOrder.map((name) => {
      const level = this.levelsByScene.get(name);
      const cameraTarget = this.cameraByScene.get(name);
      return {
        name,
        instanceIds: this.instances.filter((i) => i.scene === name).map((i) => i.id),
        ...(level === undefined ? {} : { level }),
        bounds: boundsOf(level, this.profile),
        ...(cameraTarget === undefined ? {} : { cameraTarget }),
      };
    });

    const assets = [
      ...new Set([
        ...this.instances.map((i) => i.strings["sprite"]).filter((s): s is string => !!s),
        ...[...this.levelsByScene.values()].flatMap((level) => levelAssets(level)),
      ]),
    ].sort();

    const budget = this.computeBudget(scenes);

    return {
      profile: this.profile,
      entryScene: this.entry ?? (this.sceneOrder[0] as string),
      seed: this.seed,
      scenes,
      instances: this.instances,
      controls,
      rules,
      assets,
      budget,
      warnings: this.diagnostics.filter((d) => d.severity === "warning"),
    };
  }

  /**
   * Checks that need the finished instance table: things that are impossible or
   * near-certainly wrong on *this* console, caught here rather than discovered
   * in an emulator. Every one of them is a mistake the cell/tick model makes
   * easy to write and hard to see.
   */
  checkGeometry(rules: readonly RuleDef[]): void {
    const { name, fps } = this.profile;

    for (const instance of this.instances) {
      // Measured against the *playfield*, which is the scene's level when it has
      // one. A hero standing near the bottom of a 30-cell cavern is not
      // offscreen on a Game Boy; it is 12 cells below where the view starts.
      const { width: screenWidth, height: screenHeight } = this.boundsFor(instance.scene);
      const width = toNumber(instance.numbers["width"] ?? 0);
      const height = toNumber(instance.numbers["height"] ?? 0);
      const x = toNumber(instance.numbers["x"] ?? 0);
      const y = toNumber(instance.numbers["y"] ?? 0);
      const speed = instance.numbers["speed"] ?? 0;
      const isText = TEXT_CLASSES.has(instance.className);

      if (!isText && width > screenWidth) {
        this.error(
          instance.line,
          "E_OBJECT_TOO_WIDE",
          `'${instance.name}' is ${width} cells wide; ${name} is only ${screenWidth}`,
        );
      }
      if (!isText && height > screenHeight) {
        this.error(
          instance.line,
          "E_OBJECT_TOO_TALL",
          `'${instance.name}' is ${height} cells tall; ${name} is only ${screenHeight}`,
        );
      }

      if (isText) {
        const length = this.glyphWidth(instance);
        if (x + length > screenWidth) {
          this.warn(
            instance.line,
            "W_TEXT_TOO_WIDE",
            `'${instance.name}' runs ${Math.ceil(x + length - screenWidth)} cells past the right edge on ${name}`,
            "position it relative to `centerx`, or shorten the text",
          );
        }
      } else if (x < 0 || y < 0 || x + width > screenWidth || y + height > screenHeight) {
        this.warn(
          instance.line,
          "W_OFFSCREEN_START",
          `'${instance.name}' starts partly outside the ${screenWidth}x${screenHeight} playfield on ${name}`,
          "positions are in cells from the top-left; `screenwidth`/`screenheight` are the safe area",
        );
      }

      // A speed small enough that one tick of it floors to nothing leaves the
      // object frozen — the fixed-point equivalent of a silent divide to zero.
      if (speed > 0 && Math.floor((speed * ONE) / fromInt(fps)) === 0) {
        this.warn(
          instance.line,
          "W_SUBTICK_SPEED",
          `'${instance.name}' moves less than one fixed-point step per tick at ${fps} Hz and will not move at all`,
          "raise the speed, or express it relative to the playfield with vw/vh/vmin",
        );
      }
    }

    this.checkTunnelling(rules);
  }

  /**
   * A mover whose per-tick step is larger than the thing it collides with can
   * pass clean through it between ticks: the classic bullet-through-paper bug.
   * Collision is tested at tick boundaries only (doc 14 §Runtime model), so this
   * is a property of the numbers and is knowable now.
   */
  private checkTunnelling(rules: readonly RuleDef[]): void {
    const fps = this.profile.fps;
    for (const rule of rules) {
      if (rule.event.kind !== "hits" || rule.event.others.length === 0) continue;
      for (const subjectId of rule.event.subjects) {
        const subject = this.instances[subjectId] as InstanceDef;
        const step = toNumber(subject.numbers["speed"] ?? 0) / fps;
        if (step <= 0) continue;
        for (const otherId of rule.event.others) {
          const other = this.instances[otherId] as InstanceDef;
          const thinnest = Math.min(
            toNumber(other.numbers["width"] ?? 0),
            toNumber(other.numbers["height"] ?? 0),
          );
          if (thinnest > 0 && step >= thinnest) {
            this.warn(
              rule.line,
              "W_TUNNELLING",
              `'${subject.name}' moves ${step.toFixed(2)} cells per tick but '${other.name}' is only ${thinnest} cells thick — it can pass straight through`,
              "slow it down, or make the obstacle thicker than one tick of travel",
            );
          }
        }
      }
    }
  }

  /** Cells a text or number object occupies horizontally. */
  private glyphWidth(instance: InstanceDef): number {
    if (instance.className === "text") return (instance.strings["text"] ?? "").length;
    // A counter grows; two digits is the least that will not surprise anyone.
    const value = Math.abs(Math.trunc(toNumber(instance.numbers["value"] ?? 0)));
    return Math.max(2, String(value).length);
  }

  private computeBudget(scenes: readonly SceneDef[]): BudgetReport {
    let peakSprites = 0;
    let peakScene = scenes[0]?.name ?? "";

    for (const scene of scenes) {
      const cost = scene.instanceIds.reduce(
        (sum, id) => sum + (this.instances[id] as InstanceDef).spriteCost,
        0,
      );
      if (cost > peakSprites) {
        peakSprites = cost;
        peakScene = scene.name;
      }
    }

    const limit = this.profile.sprites.total;
    if (peakSprites > limit) {
      this.error(
        1,
        "E_SPRITE_BUDGET",
        `scene '${peakScene}' needs ${peakSprites} hardware sprites; ${this.profile.name} provides ${limit}`,
        "shrink objects, use fewer of them, or move static art to the background layer",
      );
    } else if (peakSprites * 4 > limit * 3) {
      this.warn(
        1,
        "W_SPRITE_BUDGET",
        `scene '${peakScene}' uses ${peakSprites} of ${limit} hardware sprites on ${this.profile.name}`,
      );
    }

    return {
      peakSprites,
      spriteLimit: limit,
      perLineLimit: this.profile.sprites.perLine,
      peakScene,
    };
  }
}

/** Format a fixed-point cell count for a diagnostic, without trailing zeroes. */
function formatCells(value: Fixed): string {
  const cells = toNumber(value);
  return Number.isInteger(cells) ? `${cells}` : cells.toFixed(2);
}

function knownPropList(): string {
  return knownPropertyNames().join(", ");
}

/** Constant-fold a compiled expression, or `undefined` if it reads state. */
function foldConstant(expr: CExpr): Fixed | undefined {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "neg": {
      const inner = foldConstant(expr.operand);
      return inner === undefined ? undefined : -inner;
    }
    case "call": {
      // `random` is a call whose value is not a function of its arguments, so it
      // never folds — and an initial property value, which must fold, therefore
      // cannot use it. That is the right answer: a starting position drawn at
      // build time would be the same on every play.
      if (expr.fn === "random") return undefined;
      const args = expr.args.map(foldConstant);
      if (args.some((arg) => arg === undefined)) return undefined;
      return applyBuiltin(expr.fn, args as number[]);
    }
    case "binary": {
      const left = foldConstant(expr.left);
      const right = foldConstant(expr.right);
      if (left === undefined || right === undefined) return undefined;
      return applyBinary(expr.op, left, right);
    }
    default:
      return undefined;
  }
}

/**
 * Evaluate one binary operator. Shared by the constant folder here and the
 * simulator, so a folded expression and a live one can never disagree.
 */
export function applyBinary(op: CBinaryOp, left: Fixed, right: Fixed): Fixed {
  switch (op) {
    case "+":
      return clampFixed(left + right);
    case "-":
      return clampFixed(left - right);
    case "*":
      return clampFixed(Math.floor((left * right) / ONE));
    case "/":
      return right === 0 ? 0 : clampFixed(Math.floor((left * ONE) / right));
    case "<":
      return left < right ? ONE : 0;
    case ">":
      return left > right ? ONE : 0;
    case "<=":
      return left <= right ? ONE : 0;
    case ">=":
      return left >= right ? ONE : 0;
    case "=":
      return left === right ? ONE : 0;
    case "!=":
      return left !== right ? ONE : 0;
  }
}

/**
 * Evaluate one builtin. Shared by the constant folder here and the simulator, so
 * a folded call and a live one can never disagree.
 */
export function applyBuiltin(fn: PureBuiltinFn, args: readonly Fixed[]): Fixed {
  const [a = 0, b = 0, c = 0] = args;
  switch (fn) {
    case "abs":
      return a < 0 ? -a : a;
    case "min":
      return a < b ? a : b;
    case "max":
      return a > b ? a : b;
    case "clamp":
      return a < b ? b : a > c ? c : a;
  }
}

/** Hardware sprites an object of this size occupies, in 8×8 units. */
function spriteCost(numbers: Readonly<Record<string, Fixed>>): number {
  const w = Math.max(1, Math.ceil(toNumber(numbers["width"] ?? ONE)));
  const h = Math.max(1, Math.ceil(toNumber(numbers["height"] ?? ONE)));
  return w * h;
}

/**
 * Compile source text for one console.
 *
 * Throws {@link GameLangError} carrying *every* diagnostic if anything fails —
 * syntax errors included, because the parser recovers per line rather than
 * stopping at the first problem.
 */
export function compile(source: string, options: CompileOptions): Program {
  const parsed = parse(source);
  const compiler = new Compiler(options.profile, options.levels ?? {});
  compiler.diagnostics.push(...parsed.diagnostics);

  compiler.collectScenes(parsed.statements);
  compiler.collectSeed(parsed.statements);
  compiler.collectLevels(parsed.statements);
  compiler.collectClasses(parsed.statements);
  compiler.collectInstances(parsed.statements);
  compiler.collectCameras(parsed.statements);
  const controls = compiler.compileControls(parsed.statements);
  const rules = compiler.compileRules(parsed.statements);
  const program = compiler.finish(controls, rules);

  if (compiler.diagnostics.some((d) => d.severity === "error")) {
    throw new GameLangError(compiler.diagnostics);
  }
  return program;
}

/**
 * Compile without throwing — returns the program (when it compiled) alongside
 * every diagnostic. This is what an editor, a preview pane, or an agent loop
 * wants: the full problem list, not just the first failure.
 */
export function check(
  source: string,
  options: CompileOptions,
): { program?: Program; diagnostics: readonly Diagnostic[] } {
  try {
    const program = compile(source, options);
    return { program, diagnostics: program.warnings };
  } catch (error) {
    if (error instanceof GameLangError) return { diagnostics: error.diagnostics };
    throw error;
  }
}
