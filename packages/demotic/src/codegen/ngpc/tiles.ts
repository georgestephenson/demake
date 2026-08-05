/**
 * Levels, tile collision, and the grid lookup, for the TLCS-900/H.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and three things are worth stating:
 *
 *   - **The legend index travels in `XWA`, zero-extended.** Every caller uses it
 *     as a table index straight afterwards, and this processor's byte loads
 *     leave the rest of a register alone — so a lookup that returned a byte
 *     without clearing the three above it would index four billion bytes into a
 *     table the first time the register held anything.
 *   - **The row multiply is one instruction.** `mul XWA,HL` takes `WA` by `HL`
 *     into `XWA`, so `row × width` is a single opcode where the Z80 expands the
 *     constant into doublings and the 6502 runs a shift-and-add over two memory
 *     bytes. That matters because a tile walk does it once per row of every
 *     object's box, every tick.
 *   - **The grid cursor is an *offset*, not an address.** `layout.tilePtr` is two
 *     bytes on every console because the machines it was written for have
 *     sixteen-bit addresses; here a grid is in the cartridge and its address is
 *     twenty-four. Rather than widen a shared allocation — which would move every
 *     other console's memory map and re-baseline every checked-in trace for
 *     nothing — the cursor holds the offset into the grid and the base is
 *     re-formed per cell, which is one immediate load.
 *
 * Everything below is otherwise the Mega Drive version's shape, because what a
 * tile walk *means* is `shape.ts`'s and not a machine's.
 */

import { label } from "@demake/core";

import { fromInt } from "../../fixed.js";
import { W } from "../layout.js";
import {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  GRID_EMPTY,
  propOffset,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "../shape.js";

import type { NgpcCtx } from "./ctx.js";
import { at as based } from "./ops.js";
import { CELL_OFFSET } from "./rules.js";
import { abs32, add32, at, branchLess32, clamp32, copy32, neg32, set32, sub32 } from "./val.js";

export {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  GRID_EMPTY,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
};

/** `dst = src`, on a 16-bit word. */
export function copy16(ctx: NgpcCtx, dst: number, src: number): void {
  ctx.asm.ldm("wa", at(src));
  ctx.asm.stm(at(dst), "wa");
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: NgpcCtx, addr: number): void {
  ctx.asm.incMem(1, at(addr), "w");
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: NgpcCtx, addr: number): void {
  ctx.asm.decMem(1, at(addr), "w");
}

/**
 * Look a byte table up by the legend index in `XWA`, leaving the entry there.
 *
 * The zeroing is not decoration: a byte load leaves the register's upper three
 * bytes as they were, so the index has to be rebuilt rather than narrowed.
 */
export function emitTableLookup(ctx: NgpcCtx, table: string): void {
  const { asm } = ctx;
  asm.ldn("xhl", label(table));
  asm.alu("add", "xhl", "xwa");
  asm.ldn("xwa", 0);
  asm.ldm("a", based("xhl"));
}

/**
 * `XWA = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside
 * the grid — emitted once per level.
 *
 * One unsigned comparison covers both ends of each bound, because a negative
 * word is a very large unsigned one: a coordinate off the top or left of the
 * grid is empty rather than a wrap, and so is one past the end.
 */
export function emitTileAt(ctx: NgpcCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  asm.ldm("hl", at(col));
  asm.aluImm("cp", "hl", level.width);
  ctx.far("uge", outside);
  asm.ldm("hl", at(row));
  asm.aluImm("cp", "hl", level.height);
  ctx.far("uge", outside);

  // offset = row × width + column. Both are inside their bounds by now, so the
  // multiply is unsigned and the widening is a zero-extend.
  asm.ldm("wa", at(row));
  asm.extz("xwa");
  asm.ldn("hl", level.width);
  asm.mul("xwa", "hl");
  asm.ldm("hl", at(col));
  asm.extz("xhl");
  asm.alu("add", "xwa", "xhl");

  asm.ldn("xhl", label(data.gridLabel));
  asm.alu("add", "xhl", "xwa");
  asm.ldn("xwa", 0);
  asm.ldm("a", based("xhl"));
  asm.ret();
  asm.label(outside);
  asm.ldn("xwa", GRID_EMPTY);
  asm.ret();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in `XWA` and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(
  ctx: NgpcCtx,
  base: number,
  data: LevelData,
  body: () => void,
): void {
  const { asm, layout } = ctx;
  const w = layout.words;
  const firstCol = w + W.firstCol * 2;
  const lastCol = w + W.lastCol * 2;
  const firstRow = w + W.firstRow * 2;
  const lastRow = w + W.lastRow * 2;
  const col = w + W.tileCol * 2;
  const row = w + W.tileRow * 2;
  const level = data.file;

  floorCell(ctx, base + propOffset("x"), firstCol);
  floorCell(ctx, base + propOffset("y"), firstRow);
  ctx.scoped(() => {
    const edge = ctx.pushTemp();
    copy32(ctx, edge, base + propOffset("x"));
    add32(ctx, edge, base + propOffset("width"));
    ceilOpen(ctx, edge, lastCol);
    copy32(ctx, edge, base + propOffset("y"));
    add32(ctx, edge, base + propOffset("height"));
    ceilOpen(ctx, edge, lastRow);
  });

  // Clip the walk to the grid *once*, rather than asking `TileAt` whether every
  // single cell is inside it. Cells outside contribute nothing either way, so
  // the two are equivalent and the inner loop is a load and an increment.
  clampLow16(ctx, firstCol);
  clampLow16(ctx, firstRow);
  clampHigh16(ctx, lastCol, level.width - 1);
  clampHigh16(ctx, lastRow, level.height - 1);

  const rowLoop = ctx.unique("tileRowLoop");
  const colLoop = ctx.unique("tileColLoop");
  const rowDone = ctx.unique("tileRowDone");
  const colDone = ctx.unique("tileColDone");

  copy16(ctx, row, firstRow);
  asm.label(rowLoop);
  branchLess16(ctx, lastRow, row, rowDone);
  copy16(ctx, col, firstCol);
  // The cursor is `row × width + firstCol`, computed once for the row and kept
  // as an offset rather than an address; see the file header.
  asm.ldm("wa", at(row));
  asm.extz("xwa");
  asm.ldn("hl", level.width);
  asm.mul("xwa", "hl");
  asm.ldm("hl", at(firstCol));
  asm.extz("xhl");
  asm.alu("add", "xwa", "xhl");
  asm.stm(at(layout.tilePtr), "wa");
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Re-formed rather than kept in a register: `body` is a rule and uses every
  // register there is.
  asm.ldn("xhl", label(data.gridLabel));
  asm.ldm("wa", at(layout.tilePtr));
  asm.extz("xwa");
  asm.alu("add", "xhl", "xwa");
  asm.ldn("xwa", 0);
  asm.ldm("a", based("xhl"));
  body();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  ctx.far("t", colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  ctx.far("t", rowLoop);
  asm.label(rowDone);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: NgpcCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  asm.ldm("hl", at(a));
  asm.aluMem("cp", "hl", at(b));
  ctx.far("lt", target);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: NgpcCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.aluMemImm("cp", at(addr), "w", 0);
  ctx.far("pl", done);
  asm.stmi(at(addr), "w", 0);
  asm.label(done);
}

/**
 * `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing.
 */
function clampHigh16(ctx: NgpcCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  asm.aluMemImm("cp", at(addr), "w", 0);
  ctx.far("mi", done);
  asm.aluMemImm("cp", at(addr), "w", limit);
  ctx.far("le", done);
  asm.stmi(at(addr), "w", limit);
  asm.label(done);
}

/**
 * `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in.
 *
 * The high word of the value, which on this little-endian machine is the word at
 * offset two. The Mega Drive says zero; the difference is the byte order and not
 * a mistake.
 */
function floorCell(ctx: NgpcCtx, src: number, dst: number): void {
  ctx.asm.ldm("wa", at(src, CELL_OFFSET));
  ctx.asm.stm(at(dst), "wa");
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: NgpcCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  // The fraction is the *low* word here, at offset zero.
  asm.aluMemImm("cp", at(src), "w", 0);
  ctx.far("nz", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: NgpcCtx, base: number): void {
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
      branchLess32(ctx, near, far, takeFar, false);
      copy32(ctx, push, near);
      neg32(ctx, push);
      ctx.far("t", done);
      asm.label(takeFar);
      copy32(ctx, push, far);
      asm.label(done);
    };
    axis("x", "width", cellX, pushX);
    axis("y", "height", cellY, pushY);

    copy32(ctx, near, pushX);
    abs32(ctx, near);
    copy32(ctx, far, pushY);
    abs32(ctx, far);
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    branchLess32(ctx, near, far, useY, false);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    ctx.far("t", applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), pushY);
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/**
 * Widen a signed 16-bit cell coordinate into 16.16.
 *
 * Shifting the word into the register's high half is the whole conversion: the
 * fraction becomes zero and the coordinate's sign bit lands on bit 31, so a
 * negative cell stays negative without a sign-extend instruction.
 */
function cellToFixed(ctx: NgpcCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldm("hl", at(src));
  asm.shift("sll", 16, "xhl");
  asm.stm(at(dst), "xhl");
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32 };
