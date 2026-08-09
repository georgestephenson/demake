/**
 * Levels, tile collision, and the grid lookup, for the 68000.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and two things are worth stating:
 *
 *   - **The row multiply is one instruction.** `muls.w` takes a signed word by a
 *     signed word into a long, so `row × width` is a single opcode where the Z80
 *     expands the constant into doublings and the 6502 runs a shift-and-add over
 *     two memory bytes. That matters because a tile walk does it once per row of
 *     every object's box, every tick.
 *   - **The grid cursor is an *offset*, not an address.** `layout.tilePtr` is two
 *     bytes on every console because the machines it was written for have
 *     sixteen-bit addresses; here an address is four. Rather than widen a shared
 *     allocation — which would move every other console's memory map and
 *     re-baseline every checked-in trace for nothing — the cursor holds the
 *     offset into the grid and the base is re-formed with a `lea` per cell.
 *
 * Everything below is otherwise the Sega version's shape, because what a tile
 * walk *means* is `shape.ts`'s and not a machine's.
 */

import { eaAbs, eaD, eaIdx, eaImm, eaInd, label } from "@demake/core";

import { fromInt } from "../../fixed.js";
import { W } from "../layout.js";
import {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  GRID_EMPTY,
  propOffset,
  ruleTileTableLabel,
  SIDE_BITS,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "../shape.js";

import type { M68kCtx } from "./ctx.js";
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
export function copy16(ctx: M68kCtx, dst: number, src: number): void {
  ctx.asm.move("w", at(src), at(dst));
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: M68kCtx, addr: number): void {
  ctx.asm.addq("w", 1, at(addr));
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: M68kCtx, addr: number): void {
  ctx.asm.subq("w", 1, at(addr));
}

/** `d0 = the zero-extended byte at `table + d0`. */
function indexByte(ctx: M68kCtx, table: string): void {
  const { asm } = ctx;
  asm.lea(eaAbs(label(table)), 0);
  asm.move("b", eaIdx(0, 0, 0), eaD(1));
  asm.moveq(0, 0);
  asm.move("b", eaD(1), eaD(0));
}

/** Look a byte table up by the legend index in `d0`, leaving the entry in `d0`. */
export function emitTableLookup(ctx: M68kCtx, table: string): void {
  indexByte(ctx, table);
}

/**
 * `A = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside the
 * grid — emitted once per level.
 *
 * The answer arrives in `d0`, zero-extended to a long, because every caller uses
 * it as a table index straight afterwards. Returning a sign-extended byte would
 * make the empty marker index four billion bytes into a table.
 */
export function emitTileAt(ctx: M68kCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap. One
  // unsigned comparison covers both ends, because a negative word is a very
  // large unsigned one.
  asm.move("w", at(col), eaD(0));
  asm.cmpi("w", level.width, eaD(0));
  ctx.far("cc", outside);
  asm.move("w", at(row), eaD(1));
  asm.cmpi("w", level.height, eaD(1));
  ctx.far("cc", outside);

  // offset = row × width + column, then the byte at the grid's base. The column
  // has to be widened first: `move.w` leaves the register's high half alone, so
  // a long add of it would carry in whatever the last thing to use `d0` left
  // there — which is a lookup that is right until it is not.
  asm.ext("l", 0);
  asm.muls(eaImm(level.width), 1);
  asm.add("l", eaD(0), 1);
  asm.lea(eaAbs(label(data.gridLabel)), 0);
  asm.adda("l", eaD(1), 0);
  asm.moveq(0, 0);
  asm.move("b", eaInd(0), eaD(0));
  asm.rts();
  asm.label(outside);
  asm.moveq(0, 0);
  asm.move("b", eaImm(GRID_EMPTY), eaD(0));
  asm.rts();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in `d0` and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(
  ctx: M68kCtx,
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
  asm.move("w", at(row), eaD(0));
  asm.muls(eaImm(level.width), 0);
  asm.move("w", at(firstCol), eaD(1));
  asm.ext("l", 1);
  asm.add("l", eaD(1), 0);
  asm.move("w", eaD(0), at(layout.tilePtr));
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Re-formed rather than kept in a register: `body` is a rule and uses every
  // register there is.
  asm.lea(eaAbs(label(data.gridLabel)), 0);
  asm.moveq(0, 1);
  asm.move("w", at(layout.tilePtr), eaD(1));
  asm.adda("l", eaD(1), 0);
  asm.moveq(0, 0);
  asm.move("b", eaInd(0), eaD(0));
  body();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  asm.bra(colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  asm.bra(rowLoop);
  asm.label(rowDone);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: M68kCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  asm.move("w", at(a), eaD(0));
  asm.cmp("w", at(b), 0);
  ctx.far("lt", target);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: M68kCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.tst("w", at(addr));
  ctx.far("pl", done);
  asm.clr("w", at(addr));
  asm.label(done);
}

/** `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing. */
function clampHigh16(ctx: M68kCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  asm.tst("w", at(addr));
  ctx.far("mi", done);
  asm.cmpi("w", limit, at(addr));
  ctx.far("le", done);
  asm.move("w", eaImm(limit), at(addr));
  asm.label(done);
}

/**
 * `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in.
 *
 * The high word of the value, which on this machine is the word at offset zero.
 * Every other backend says `+2`; the difference is the byte order and not a
 * mistake.
 */
function floorCell(ctx: M68kCtx, src: number, dst: number): void {
  ctx.asm.move("w", at(src), at(dst));
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: M68kCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  asm.tst("w", at(src, 2));
  ctx.far("ne", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: M68kCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    asm.bra(applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), pushY);
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/**
 * `A` = the {@link SIDE_BITS} bit for the side of the cell the object sat on.
 *
 * The tile half of `from`, and the same split the pair path makes: this decides
 * and {@link emitTileSeparate} applies, both off {@link emitTilePushes}, so a
 * rule that takes footing from a landing cannot disagree with the push that
 * follows it. Inline rather than a routine because the cell it is asked about
 * lives in the walk's own render words, which a call would have to be handed.
 */
export function emitTileSide(ctx: M68kCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsideUseY");
    const negative = ctx.unique("tsideNeg");
    const below = ctx.unique("tsideBelow");
    const done = ctx.unique("tsideDone");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    // A whole 16.16 value is one long here, so a `tst.l` is the sign test.
    asm.tst("l", at(pushX));
    ctx.far("mi", negative);
    asm.moveq(SIDE_BITS["right"] as number, 0);
    asm.bra(done);
    asm.label(negative);
    asm.moveq(SIDE_BITS["left"] as number, 0);
    asm.bra(done);
    asm.label(useY);
    asm.tst("l", at(pushY));
    ctx.far("pl", below);
    asm.moveq(SIDE_BITS["above"] as number, 0);
    asm.bra(done);
    asm.label(below);
    asm.moveq(SIDE_BITS["below"] as number, 0);
    asm.label(done);
  });
}

/**
 * The push out of the walk's current cell along each axis, branching to `useY`
 * when the y axis is the shallower one.
 *
 * The other box is a one-cell square at integer coordinates, which is the only
 * thing that makes this a different function from the pair version rather than a
 * call to it. The two temporaries live for as long as the caller's scope.
 */
function emitTilePushes(
  ctx: M68kCtx,
  base: number,
  useY: string,
): { pushX: number; pushY: number } {
  const { asm, layout } = ctx;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

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
    asm.bra(done);
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
  branchLess32(ctx, near, far, useY, false);
  return { pushX, pushY };
}

/** Widen a signed 16-bit cell coordinate into 16.16. */
function cellToFixed(ctx: M68kCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.move("w", at(src), eaD(0));
  asm.ext("l", 0);
  asm.swap(0);
  asm.clr("w", eaD(0));
  asm.move("l", eaD(0), at(dst));
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32 };
