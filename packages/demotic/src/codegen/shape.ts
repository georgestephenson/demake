/**
 * What both backends decide the same way.
 *
 * A backend is the only thing that knows an opcode (doc 14 §Runtime model), and
 * the N × M cost of one instruction encoder per family is accepted deliberately.
 * But most of what a backend *decides* is not about instructions at all: whether
 * a rule can fire in this scene, whether a caption can ever change, which cells a
 * tile rule may cache, how far a camera may travel, what a tick of movement comes
 * to. Those answers have to be identical on every console or the trace oracle
 * would be comparing two different games, so they live here and are computed once.
 *
 * The dividing line is exact and worth stating, because it is what stops this
 * file from becoming a fake common denominator: **anything that would emit an
 * instruction stays in the backend.** Everything here either returns a number, a
 * verdict or a name, or writes *data* — and data is shared because the two
 * machines really do carry the same tables, one byte per cell and one per legend
 * entry, whatever they do with them afterwards.
 */

import type { Ref } from "@demake/core";

import { applyBinary, applyBuiltin } from "../compile.js";
import { fromInt, ONE as FIXED_ONE } from "../fixed.js";
import { boundsOf } from "../level/scene.js";
import type { LevelFile } from "../level/parse.js";
import type { ConsoleProfile } from "../profiles.js";
import type {
  CExpr,
  EntityRef,
  InstanceDef,
  Program,
  PureBuiltinFn,
  RuleDef,
  SceneDef,
} from "../program.js";

import { isMutable, type Analysis } from "./analyze.js";
import { type Layout, PROP_SIZE, PROP_SLOT } from "./layout.js";

/**
 * What the shared helpers need of a compilation context.
 *
 * Structural rather than a base class, so both `Ctx` types satisfy it without
 * either knowing about this file.
 */
export interface ProgramShape {
  readonly program: Program;
  readonly analysis: Analysis;
  readonly layout: Layout;
  readonly profile: ConsoleProfile;
}

/** What a buffer must offer to receive the shared data tables. */
export interface DataBuffer {
  label(name: string): unknown;
  db(...values: number[]): unknown;
  dd(value: number): unknown;
}

// --- addresses and properties -------------------------------------------------

/** Where an entity's record is, as far as the emitted code is concerned. */
export type EntityAddr =
  /** A known instance: every property is an absolute address. */
  | { kind: "const"; id: number; base: number }
  /** A loop variable: the record's address is in this RAM word. */
  | { kind: "ptr"; ptr: number }
  /** Unbound — reads yield zero and writes are dropped, as in the interpreter. */
  | { kind: "none" };

/** What `subject` and `other` mean in the code being emitted. */
export interface Binding {
  subject: EntityAddr;
  other: EntityAddr;
}

/** No bindings at all — the context a control or an unbound rule runs in. */
export const UNBOUND: Binding = { subject: { kind: "none" }, other: { kind: "none" } };

/** A four-byte value, and whether the caller may clobber it. */
export interface Slot {
  addr: Ref;
  /** True when this is a temporary the caller owns. */
  temp: boolean;
}

/** Byte offset of a stored property within an entity record. */
export function propOffset(prop: string): number {
  const slot = PROP_SLOT[prop];
  if (slot === undefined) throw new Error(`'${prop}' is not a stored property`);
  return slot * PROP_SIZE;
}

/** The base and offset a derived property is computed from. */
export const DERIVED_PARTS: Readonly<
  Record<string, { base: string; add?: string; halve?: boolean }>
> = {
  centerx: { base: "x", add: "width", halve: true },
  centery: { base: "y", add: "height", halve: true },
  left: { base: "x" },
  right: { base: "x", add: "width" },
  top: { base: "y" },
  bottom: { base: "y", add: "height" },
};

/** Resolve a compiled entity reference against the current binding. */
export function resolveEntity(ctx: ProgramShape, ref: EntityRef, bind: Binding): EntityAddr {
  switch (ref.kind) {
    case "instance":
      return { kind: "const", id: ref.id, base: ctx.layout.entities[ref.id] as number };
    case "subject":
      return bind.subject;
    case "other":
      return bind.other;
  }
}

/** The compile-time entity address of a known instance. */
export function entityOf(ctx: ProgramShape, id: number): EntityAddr {
  return { kind: "const", id, base: ctx.layout.entities[id] as number };
}

// --- constant folding ---------------------------------------------------------

/** Fold an expression to a constant, or `undefined` if it depends on state. */
export function fold(expr: CExpr): number | undefined {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "flip":
    case "scene":
      return 0;
    case "neg": {
      const operand = fold(expr.operand);
      return operand === undefined ? undefined : -operand;
    }
    case "binary": {
      const left = fold(expr.left);
      const right = fold(expr.right);
      if (left === undefined || right === undefined) return undefined;
      return applyBinary(expr.op, left, right);
    }
    case "call": {
      if (expr.fn === "random") return undefined;
      const args: number[] = [];
      for (const arg of expr.args) {
        const value = fold(arg);
        if (value === undefined) return undefined;
        args.push(value);
      }
      return applyBuiltin(expr.fn as PureBuiltinFn, args);
    }
    default:
      return undefined;
  }
}

/** What a test decided at compile time, when it could. */
export type TestVerdict = "always" | "never" | "runtime";

/** The interpreter clamps every write; a constant can be clamped here instead. */
export function clampConst(value: number): number {
  const limit = 1024 * FIXED_ONE;
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

/** One tick of movement: `direction × speed ÷ fps`, floored, in that order. */
export function perTick(direction: number, speed: number, fps: number): number {
  const velocity = Math.floor((direction * speed) / FIXED_ONE);
  return Math.floor((velocity * FIXED_ONE) / fromInt(fps));
}

/** How far the camera may travel before the view leaves the playfield. */
export function boundMax(boundsFixed: number, screenCells: number): number {
  const cells = boundsFixed / FIXED_ONE;
  return fromInt(Math.max(0, cells - screenCells));
}

// --- scenes -------------------------------------------------------------------

/** Everything the emitters need about the scene being compiled. */
export interface SceneCtx {
  index: number;
  def: SceneDef;
  /** Playfield in 16.16 cells: the level's size, or the screen's. */
  boundsW: number;
  boundsH: number;
  level: LevelFile | undefined;
}

/** Scene index by name. */
export function sceneIndexOf(program: Program, name: string): number {
  const index = program.scenes.findIndex((scene) => scene.name === name);
  return index < 0 ? 0 : index;
}

/** Build the per-scene view the rule emitters work against. */
export function sceneContexts(ctx: ProgramShape): SceneCtx[] {
  return ctx.program.scenes.map((def: SceneDef, index: number) => {
    const bounds = boundsOf(def.level, ctx.profile);
    return {
      index,
      def,
      boundsW: fromInt(bounds.width),
      boundsH: fromInt(bounds.height),
      level: def.level,
    };
  });
}

/** Is this instance part of the scene being compiled? */
export function inScene(program: Program, scene: SceneCtx, id: number): boolean {
  const instance = program.instances[id];
  return instance !== undefined && instance.scene === scene.def.name;
}

/** A rule runs in this scene when it names it, or names none at all. */
export function ruleInScene(rule: RuleDef, scene: SceneCtx): boolean {
  return rule.scene === undefined || rule.scene === scene.def.name;
}

/** The subject bindings a rule runs under, filtered to this scene. */
export function subjectBindings(
  ctx: ProgramShape,
  rule: RuleDef,
  scene: SceneCtx,
): (number | null)[] {
  if (!rule.subjects) return [null];
  return rule.subjects.filter((id) => inScene(ctx.program, scene, id));
}

/**
 * Does this scene's view move?
 *
 * It is the one question that decides where the HUD is drawn, because the
 * background layer scrolls as one piece: a cell of it can be *put* anywhere,
 * but it cannot be held still while everything around it slides, and the seven
 * pixels it slides before the next whole cell comes round are exactly the jitter
 * a score in the corner must not have. Sprites are positioned in screen pixels,
 * so a HUD pinned to `camera.x` lands on the same pixel every frame.
 */
export function scrolls(ctx: ProgramShape, scene: SceneCtx): boolean {
  return scene.def.cameraTarget !== undefined && ctx.layout.camera !== null;
}

// --- objects -------------------------------------------------------------------

/**
 * Can anything about this HUD object ever change?
 *
 * A caption is the common case: fixed text at a fixed cell that no rule writes.
 * Erasing and repainting it sixty times a second costs more than everything else
 * a small game does — and it is the *labels* that made it worth finding, because
 * "score:" is six cells against a counter's one or two. A static object is
 * painted once, with the background it sits on, and then left alone.
 */
export function hudIsStatic(ctx: ProgramShape, id: number): boolean {
  const instance = ctx.program.instances[id] as InstanceDef;
  const fixed = (prop: string): boolean => !isMutable(ctx.analysis, id, prop);
  if (!fixed("x") || !fixed("y") || !fixed("visible")) return false;
  return instance.className === "text" || fixed("value");
}

/**
 * Is this object's footprint a compile-time constant?
 *
 * The cheap culls work in whole cells and need a margin wide enough to cover the
 * object, so they only apply where the size cannot change under them. Nothing in
 * the example library resizes anything; the test is here so that the day
 * something does, it gets the slow, always-correct path instead of being quietly
 * culled while half on screen.
 */
export function fixedCells(ctx: ProgramShape, id: number): boolean {
  return !isMutable(ctx.analysis, id, "width") && !isMutable(ctx.analysis, id, "height");
}

/** An instance's size in whole cells, which is its sprite's footprint. */
export function instanceCells(instance: InstanceDef, prop: string): number {
  return Math.max(1, Math.round((instance.numbers[prop] ?? 0) / FIXED_ONE));
}

/**
 * Margins for the cheap "is it anywhere near" pair test, or `undefined` where a
 * size can change and the test therefore cannot be trusted.
 */
export function nearMargins(
  ctx: ProgramShape,
  a: number,
  b: number,
): { x: number; y: number } | undefined {
  const cells = (id: number, prop: string): number | undefined => {
    if (isMutable(ctx.analysis, id, prop)) return undefined;
    const value = (ctx.program.instances[id] as InstanceDef).numbers[prop] ?? 0;
    return Math.max(1, Math.ceil(value / FIXED_ONE));
  };
  const width = [cells(a, "width"), cells(b, "width")];
  const height = [cells(a, "height"), cells(b, "height")];
  if (width.some((v) => v === undefined) || height.some((v) => v === undefined)) return undefined;
  const x = Math.max(...(width as number[]));
  const y = Math.max(...(height as number[]));
  // The margin goes in a byte and a sane object is nowhere near that big.
  return x > 120 || y > 120 ? undefined : { x, y };
}

/**
 * Can this object's overlapped cells be walked once and read by every rule?
 *
 * Only if nothing in the tile phase can move it: the interpreter recomputes the
 * list per rule, so caching it is equivalent exactly when the answer cannot have
 * changed in between. That is a compile-time question — which assignments a tile
 * rule makes — so it is asked here rather than guessed.
 */
export function tileCellsCacheable(ctx: ProgramShape, scene: SceneCtx, subjectId: number): boolean {
  const box = new Set(["x", "y", "width", "height"]);
  for (const rule of ctx.program.rules) {
    if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;
    if (rule.scene !== undefined && rule.scene !== scene.def.name) continue;
    for (const assignment of [...rule.assignments, ...(rule.otherwise ?? [])]) {
      if (assignment.target.kind !== "prop" || !box.has(assignment.target.prop)) continue;
      const entity = assignment.target.entity;
      if (entity.kind === "instance" && entity.id === subjectId) return false;
      if (entity.kind === "subject" && rule.event.subjects.includes(subjectId)) return false;
      if (entity.kind === "other") return false;
    }
  }
  return true;
}

// --- art ----------------------------------------------------------------------

/**
 * How converted art is looked up: by the file the game named *and* the box it
 * fills.
 *
 * The box is part of the key because it is part of the art. Two objects of one
 * class with different `width`s are two different pictures, and drawing the
 * larger one for both is how a five-cell shelf came to be painted eleven cells
 * wide with nothing under six of them.
 */
export function artKey(name: string, cellsWide: number, cellsHigh: number): string {
  return `${name}@${cellsWide}x${cellsHigh}`;
}

/** Art for one asset, already converted by the image pipeline. */
export interface SpriteArt {
  /** First tile index in the bank. */
  tile: number;
  /** Size in cells, which is the collision box's size (doc 15 §art). */
  width: number;
  height: number;
  /** Sub-palette the fit chose, where the hardware has them; 0 otherwise. */
  palette?: number;
}

// --- levels -------------------------------------------------------------------

/** Empty cell marker in an emitted grid. */
export const GRID_EMPTY = 0xff;

/** Level data, once per distinct level, with the labels its code refers to. */
export interface LevelData {
  index: number;
  file: LevelFile;
  gridLabel: string;
  solidLabel: string;
  tileLabel: string;
  /** Parallel to {@link tileLabel}: the attribute each legend entry draws with.
   * Emitted only where the hardware attributes a cell at a time. */
  attrLabel: string;
}

/** Collect the distinct levels a program uses, in scene order. */
export function collectLevels(scenes: readonly { level?: LevelFile }[]): LevelData[] {
  const out: LevelData[] = [];
  const seen = new Map<LevelFile, LevelData>();
  for (const scene of scenes) {
    if (!scene.level || seen.has(scene.level)) continue;
    const data: LevelData = {
      index: out.length,
      file: scene.level,
      gridLabel: `LevelGrid_${out.length}`,
      solidLabel: `LevelSolid_${out.length}`,
      tileLabel: `LevelTiles_${out.length}`,
      attrLabel: `LevelAttrs_${out.length}`,
    };
    seen.set(scene.level, data);
    out.push(data);
  }
  return out;
}

/**
 * Emit a level's grid and its per-legend tables.
 *
 * One byte per cell, one byte per legend entry, on every console — so this writes
 * the bytes and takes the buffer rather than a context. The tables are what turn
 * `when player touches spikes` into an indexed load and a branch on either CPU.
 */
export function emitLevelData(
  asm: DataBuffer,
  data: LevelData,
  tileForLegend: (index: number) => number,
  attrForLegend?: (index: number) => number,
): void {
  const level = data.file;

  asm.label(data.gridLabel);
  for (let row = 0; row < level.height; row += 1) {
    const line = level.rows[row] ?? "";
    for (let column = 0; column < level.width; column += 1) {
      const character = line[column] ?? " ";
      const legend = level.tiles.findIndex((tile) => tile.char === character);
      asm.db(legend < 0 ? GRID_EMPTY : legend);
    }
  }

  asm.label(data.solidLabel);
  for (const tile of level.tiles) asm.db(tile.solid ? 1 : 0);

  asm.label(data.tileLabel);
  for (const [index] of level.tiles.entries()) asm.db(tileForLegend(index));

  if (!attrForLegend) return;
  asm.label(data.attrLabel);
  for (const [index] of level.tiles.entries()) asm.db(attrForLegend(index));
}

/**
 * A per-rule table: for each legend index, is this tile one the rule names?
 *
 * Emitted once per (rule, level) pair that needs it, which is how a rule's tile
 * list becomes an indexed load instead of a search.
 */
export function ruleTileTableLabel(rule: RuleDef, data: LevelData): string {
  return `RuleTiles_${rule.id}_${data.index}`;
}

export function emitRuleTileTable(asm: DataBuffer, rule: RuleDef, data: LevelData): void {
  if (rule.event.kind !== "hits") return;
  const names = new Set(rule.event.tiles);
  asm.label(ruleTileTableLabel(rule, data));
  for (const tile of data.file.tiles) asm.db(names.has(tile.name) ? 1 : 0);
}

/** The label of the routine that reads one level's grid. */
export function tileAtLabel(data: LevelData): string {
  return `TileAt_${data.index}`;
}

/** The tile contact list for one `(rule, subject)` pair. */
export function tileSlot(ctx: ProgramShape, ruleId: number, subject: number): number {
  const index = ctx.layout.tileContactSlots.get(`${ruleId}:${subject}`);
  if (index === undefined) throw new Error(`no tile contact slot for rule ${ruleId}`);
  return ctx.layout.tileContacts + index * ctx.layout.tileContactStride;
}

/** Every entity's declared starting values, four bytes a property. */
export function emitInstanceDefaults(asm: DataBuffer, program: Program, props: readonly string[]) {
  for (const instance of program.instances) {
    asm.label(`Defaults_${instance.id}`);
    for (const prop of props) asm.dd(instance.numbers[prop] ?? 0);
  }
}
