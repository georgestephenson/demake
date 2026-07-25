/**
 * Levels, tile collision, and the tilemap.
 *
 * A `.dmtl` grid reaches the ROM as one byte per cell — a legend index, or
 * `$FF` for empty — and everything else about a tile is a small table indexed
 * by that byte: is it solid, which pattern draws it, and (per rule) is it one
 * of the tiles this rule names. Those tables are what turn `when player touches
 * spikes` into a single indexed load and a branch, rather than a string
 * comparison the machine could not afford.
 *
 * Tiles collide on the same two conditions objects do (doc 14 §Levels): a rule
 * has to name the pair, and separation happens only for `solid` ones. So a coin
 * scores without blocking and a wall blocks whether or not anything fired — one
 * model, and here, one pair of tables.
 */

import { fromInt } from "../fixed.js";
import { type LevelFile, tileAt } from "../level/parse.js";
import type { InstanceDef, RuleDef } from "../program.js";

import { label, type Ref } from "./asm.js";
import type { Ctx } from "./ctx.js";
import { propOffset, readProp, UNBOUND, type Binding } from "./expr.js";
import { W } from "./layout.js";
import { add32, clamp32, copy32, less32, neg32, set32, sub32 } from "./val.js";

/** Empty cell marker in an emitted grid. */
export const GRID_EMPTY = 0xff;

/** Level data, once per distinct level, with the labels its code refers to. */
export interface LevelData {
  index: number;
  file: LevelFile;
  gridLabel: string;
  solidLabel: string;
  tileLabel: string;
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
    };
    seen.set(scene.level, data);
    out.push(data);
  }
  return out;
}

/** Emit a level's grid and its per-legend tables. */
export function emitLevelData(
  ctx: Ctx,
  data: LevelData,
  tileForLegend: (index: number) => number,
): void {
  const { asm } = ctx;
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

export function emitRuleTileTable(ctx: Ctx, rule: RuleDef, data: LevelData): void {
  if (rule.event.kind !== "hits") return;
  const names = new Set(rule.event.tiles);
  ctx.asm.label(ruleTileTableLabel(rule, data));
  for (const tile of data.file.tiles) ctx.asm.db(names.has(tile.name) ? 1 : 0);
}

/**
 * `A = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside
 * the grid — emitted once per level.
 *
 * The row-times-width multiply is by a constant, so it unrolls into doublings
 * and adds with no multiply routine involved.
 */
export function tileAtLabel(data: LevelData): string {
  return `TileAt_${data.index}`;
}

export function emitTileAt(ctx: Ctx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap.
  asm.lda(col + 1);
  asm.bit(7, "a");
  asm.jp(outside, "nz");
  emitAtLeast16(ctx, col, level.width, outside);
  asm.lda(row + 1);
  asm.bit(7, "a");
  asm.jp(outside, "nz");
  emitAtLeast16(ctx, row, level.height, outside);

  // hl = row * width + col
  asm.lda(row);
  asm.ld("l", "a");
  asm.lda(row + 1);
  asm.ld("h", "a");
  emitMulConst16(ctx, level.width);
  asm.lda(col);
  asm.ld("e", "a");
  asm.lda(col + 1);
  asm.ld("d", "a");
  asm.addHL("de");
  asm.ld16("de", label(data.gridLabel));
  asm.addHL("de");
  asm.ld("a", "hlp");
  asm.ret();
  asm.label(outside);
  asm.ldn("a", GRID_EMPTY);
  asm.ret();
}

/**
 * Jump to `target` when the unsigned word at `addr` is at least `value`.
 *
 * The high bytes decide it unless they are equal, and only then do the low
 * bytes matter — the ordinary two-byte comparison, written out because getting
 * it wrong here means every tile lookup falls out of bounds and a level simply
 * has no tiles in it.
 */
function emitAtLeast16(ctx: Ctx, addr: number, value: number, target: string): void {
  const { asm } = ctx;
  const below = ctx.unique("below16");
  asm.lda(addr + 1);
  asm.aluN("cp", (value >> 8) & 0xff);
  asm.jp(below, "c");
  asm.jp(target, "nz");
  asm.lda(addr);
  asm.aluN("cp", value & 0xff);
  asm.jp(target, "nc");
  asm.label(below);
}

/** `hl *= value`, with the constant expanded into doublings and adds. */
function emitMulConst16(ctx: Ctx, value: number): void {
  const { asm } = ctx;
  if (value === 0) {
    asm.ld16("hl", 0);
    return;
  }
  const bits: number[] = [];
  for (let bit = 15; bit >= 0; bit -= 1) if (value & (1 << bit)) bits.push(bit);
  const top = bits[0] as number;
  // Start from the highest set bit and shift down, adding the original where a
  // bit is set — the classic constant-multiply expansion.
  asm.ld("d", "h");
  asm.ld("e", "l");
  for (let bit = top - 1; bit >= 0; bit -= 1) {
    asm.addHL("hl");
    if (value & (1 << bit)) asm.addHL("de");
  }
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend
 * index in A and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already
 * works, so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(ctx: Ctx, base: number, data: LevelData, body: () => void): void {
  const { asm, layout } = ctx;
  const w = layout.words;
  const firstCol = w + W.firstCol * 2;
  const lastCol = w + W.lastCol * 2;
  const firstRow = w + W.firstRow * 2;
  const lastRow = w + W.lastRow * 2;
  const col = w + W.tileCol * 2;
  const row = w + W.tileRow * 2;

  emitFloorCell(ctx, base + propOffset("x"), firstCol);
  emitFloorCell(ctx, base + propOffset("y"), firstRow);
  ctx.scoped(() => {
    const edge = ctx.pushTemp();
    copy32(ctx, edge, base + propOffset("x"));
    add32(ctx, edge, base + propOffset("width"));
    emitCeilOpen(ctx, edge, lastCol);
    copy32(ctx, edge, base + propOffset("y"));
    add32(ctx, edge, base + propOffset("height"));
    emitCeilOpen(ctx, edge, lastRow);
  });

  const rowLoop = ctx.unique("tileRowLoop");
  const colLoop = ctx.unique("tileColLoop");
  const rowDone = ctx.unique("tileRowDone");
  const colDone = ctx.unique("tileColDone");

  copy16(ctx, row, firstRow);
  asm.label(rowLoop);
  emitLess16Signed(ctx, lastRow, row, rowDone);
  copy16(ctx, col, firstCol);
  asm.label(colLoop);
  emitLess16Signed(ctx, lastCol, col, colDone);
  asm.call(tileAtLabel(data));
  body();
  inc16At(ctx, col);
  asm.jp(colLoop);
  asm.label(colDone);
  inc16At(ctx, row);
  asm.jp(rowLoop);
  asm.label(rowDone);
}

/** `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in. */
function emitFloorCell(ctx: Ctx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(src + 2);
  asm.sta(dst);
  asm.lda(src + 3);
  asm.sta(dst + 1);
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the
 * edge lands exactly on a boundary.
 */
function emitCeilOpen(ctx: Ctx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  emitFloorCell(ctx, src, dst);
  asm.lda(src);
  asm.ld16("hl", src + 1);
  asm.alu("or", "hlp");
  asm.jp(notExact, "nz");
  dec16At(ctx, dst);
  asm.label(notExact);
}

function copy16(ctx: Ctx, dst: number, src: number): void {
  const { asm } = ctx;
  asm.lda(src);
  asm.sta(dst);
  asm.lda(src + 1);
  asm.sta(dst + 1);
}

function inc16At(ctx: Ctx, addr: number): void {
  const { asm } = ctx;
  asm.lda(addr);
  asm.ld("l", "a");
  asm.lda(addr + 1);
  asm.ld("h", "a");
  asm.inc16("hl");
  asm.ld("a", "l");
  asm.sta(addr);
  asm.ld("a", "h");
  asm.sta(addr + 1);
}

function dec16At(ctx: Ctx, addr: number): void {
  const { asm } = ctx;
  asm.lda(addr);
  asm.ld("l", "a");
  asm.lda(addr + 1);
  asm.ld("h", "a");
  asm.dec16("hl");
  asm.ld("a", "l");
  asm.sta(addr);
  asm.ld("a", "h");
  asm.sta(addr + 1);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
function emitLess16Signed(ctx: Ctx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  asm.lda(a);
  asm.ld("e", "a");
  asm.lda(a + 1);
  asm.ld("d", "a");
  asm.lda(b);
  asm.ld("l", "a");
  asm.lda(b + 1);
  asm.ld("h", "a");
  // (a - b) < 0, using the sign of the difference; cell counts are small
  // enough that this cannot overflow.
  asm.ld("a", "e");
  asm.alu("sub", "l");
  asm.ld("a", "d");
  asm.alu("sbc", "h");
  asm.rla();
  asm.jp(target, "c");
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: Ctx, base: number): void {
  const { asm, layout } = ctx;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  ctx.scoped(() => {
    const cellX = ctx.pushTemp();
    const cellY = ctx.pushTemp();
    const near = ctx.pushTemp();
    const far = ctx.pushTemp();
    const pushX = ctx.pushTemp();
    const pushY = ctx.pushTemp();

    cellToFixed(ctx, col, cellX);
    cellToFixed(ctx, row, cellY);

    const axis = (pos: string, size: string, cell: number, push: number): void => {
      // near = pos + size - cell ; far = (cell + 1) - pos
      copy32(ctx, near, base + propOffset(pos));
      add32(ctx, near, base + propOffset(size));
      sub32(ctx, near, cell);
      copy32(ctx, far, cell);
      add32(ctx, far, ctx.constant(fromInt(1)));
      sub32(ctx, far, base + propOffset(pos));
      const takeFar = ctx.unique("tsepFar");
      const done = ctx.unique("tsepDone");
      less32(ctx, near, far);
      asm.jp(takeFar, "nc");
      copy32(ctx, push, near);
      neg32(ctx, push);
      asm.jp(done);
      asm.label(takeFar);
      copy32(ctx, push, far);
      asm.label(done);
    };
    axis("x", "width", cellX, pushX);
    axis("y", "height", cellY, pushY);

    copy32(ctx, near, pushX);
    absAt(ctx, near);
    copy32(ctx, far, pushY);
    absAt(ctx, far);
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    less32(ctx, near, far);
    asm.jp(useY, "nc");
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    asm.jp(applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), pushY);
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/** Widen a signed 16-bit cell coordinate into 16.16. */
function cellToFixed(ctx: Ctx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.alu("xor", "a");
  asm.sta(dst);
  asm.sta(dst + 1);
  asm.lda(src);
  asm.sta(dst + 2);
  asm.lda(src + 1);
  asm.sta(dst + 3);
}

function absAt(ctx: Ctx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("tabsDone");
  asm.lda(addr + 3);
  asm.bit(7, "a");
  asm.jp(done, "z");
  neg32(ctx, addr);
  asm.label(done);
}

/** The tile contact list for one `(rule, subject)` pair. */
export function tileSlot(ctx: Ctx, ruleId: number, subject: number): number {
  const index = ctx.layout.tileContactSlots.get(`${ruleId}:${subject}`);
  if (index === undefined) throw new Error(`no tile contact slot for rule ${ruleId}`);
  return ctx.layout.tileContacts + index * ctx.layout.tileContactStride;
}

/** Silence the unused-import checker for helpers referenced by the emitters. */
export const TILE_HELPERS = { tileAt, set32, readProp, UNBOUND } as unknown as {
  tileAt: typeof tileAt;
  set32: typeof set32;
  readProp: typeof readProp;
  UNBOUND: Binding;
};

/** Re-exported for the scene emitter's convenience. */
export type { InstanceDef, Ref };
