/**
 * Levels, tile collision, and the grid lookup, for the 65816.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and two things about that are worth stating:
 *
 *   - **A cell coordinate is a word, so the arithmetic is one instruction each.**
 *     A bounds test is `lda col; cmp #width; bcs outside`, where the 6502 needs
 *     four instructions and a spare byte for the same question. The grid offset
 *     is a sixteen-bit index the whole way and never becomes a pointer at all.
 *   - **A byte table is read as a word and masked.** The index registers are
 *     sixteen bits and so is the accumulator, so `lda Table,x` fetches the entry
 *     *and* the one after it; `and #$00FF` throws the second away. That is a byte
 *     cheaper and a cycle faster than narrowing the accumulator round the load,
 *     and it is safe because these tables are ROM — the byte past the end is the
 *     next table, not an unmapped address.
 */

import { imm16 } from "@demake/core";

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

import type { SnesCtx } from "./ctx.js";
import { abs, absX, mem } from "./ops.js";
import { add32, branchLess32, clamp32, copy32, neg32, set32, sub32, abs32 } from "./val.js";

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

/** `A = the byte at `table[X]`, with the byte above it masked away. */
export function loadTableByte(ctx: SnesCtx, table: string): void {
  ctx.asm.lda(absX(table));
  ctx.asm.and(imm16(0x00ff));
}

/** `dst = src`, on a 16-bit word — which is what a cell coordinate is. */
export function copy16(ctx: SnesCtx, dst: number, src: number): void {
  ctx.asm.lda(mem(src));
  ctx.asm.sta(mem(dst));
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: SnesCtx, addr: number): void {
  ctx.asm.inc(mem(addr));
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: SnesCtx, addr: number): void {
  ctx.asm.dec(mem(addr));
}

/** `dst = src * value`, with the constant expanded into doublings and adds. */
export function mulConst16(ctx: SnesCtx, dst: number, src: number, value: number): void {
  const { asm } = ctx;
  if (value === 0) {
    asm.stz(mem(dst));
    return;
  }
  let top = 15;
  while (top > 0 && (value & (1 << top)) === 0) top -= 1;
  copy16(ctx, dst, src);
  for (let bit = top - 1; bit >= 0; bit -= 1) {
    asm.asl(mem(dst));
    if ((value & (1 << bit)) === 0) continue;
    asm.clc();
    asm.lda(mem(dst));
    asm.adc(mem(src));
    asm.sta(mem(dst));
  }
}

/** Jump to `target` when the unsigned word at `addr` is at least `value`. */
export function branchAtLeast16(ctx: SnesCtx, addr: number, value: number, target: string): void {
  ctx.asm.lda(mem(addr));
  ctx.asm.cmp(imm16(value & 0xffff));
  ctx.far("cs", target);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: SnesCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  // The sign of the difference decides it; cell counts are small enough that the
  // subtraction cannot overflow.
  asm.sec();
  asm.lda(mem(a));
  asm.sbc(mem(b));
  ctx.far("mi", target);
}

/**
 * `A = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside the
 * grid — emitted once per level.
 */
export function emitTileAt(ctx: SnesCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const scratch = layout.words + W.temp * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap.
  asm.lda(mem(col));
  ctx.far("mi", outside);
  asm.cmp(imm16(level.width));
  ctx.far("cs", outside);
  asm.lda(mem(row));
  ctx.far("mi", outside);
  asm.cmp(imm16(level.height));
  ctx.far("cs", outside);

  // index = row * width + col, which is what the grid is indexed by.
  mulConst16(ctx, scratch, row, level.width);
  asm.clc();
  asm.lda(mem(scratch));
  asm.adc(mem(col));
  asm.tax();
  loadTableByte(ctx, data.gridLabel);
  asm.rts();
  asm.label(outside);
  asm.lda(imm16(GRID_EMPTY));
  asm.rts();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in A and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(
  ctx: SnesCtx,
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
  const scratch = w + W.temp * 2;
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
  // single cell is inside it. Cells outside contribute nothing either way — the
  // lookup would return "empty" — so the two are equivalent, and this way the
  // inner loop is a load and an increment.
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
  // The cursor is `row * width + firstCol`, computed once for the row. It is an
  // *index* rather than an address, because `$nnnn,x` adds the base for free.
  mulConst16(ctx, scratch, row, level.width);
  asm.clc();
  asm.lda(mem(scratch));
  asm.adc(mem(firstCol));
  asm.sta(mem(layout.tilePtr));
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  asm.ldx(mem(layout.tilePtr));
  loadTableByte(ctx, data.gridLabel);
  body();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  asm.jmp(colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  asm.jmp(rowLoop);
  asm.label(rowDone);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: SnesCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.lda(mem(addr));
  asm.bpl(done);
  asm.stz(mem(addr));
  asm.label(done);
}

/** `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing. */
function clampHigh16(ctx: SnesCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  asm.lda(mem(addr));
  asm.bmi(done);
  asm.cmp(imm16(limit + 1));
  asm.bcc(done);
  asm.lda(imm16(limit));
  asm.sta(mem(addr));
  asm.label(done);
}

/** `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in. */
function floorCell(ctx: SnesCtx, src: number, dst: number): void {
  ctx.asm.lda(mem(src, 2));
  ctx.asm.sta(mem(dst));
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: SnesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  asm.lda(mem(src));
  asm.bne(notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: SnesCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    asm.jmp(applied);
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
export function emitTileSide(ctx: SnesCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsideUseY");
    const negative = ctx.unique("tsideNeg");
    const below = ctx.unique("tsideBelow");
    const done = ctx.unique("tsideDone");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    // The sign of a 16.16 value is bit 15 of its high word, which is what a
    // sixteen-bit load of the top half puts in the N flag.
    asm.lda(mem(pushX, 2));
    ctx.far("mi", negative);
    asm.lda(imm16(SIDE_BITS["right"] as number));
    asm.jmp(done);
    asm.label(negative);
    asm.lda(imm16(SIDE_BITS["left"] as number));
    asm.jmp(done);
    asm.label(useY);
    asm.lda(mem(pushY, 2));
    ctx.far("pl", below);
    asm.lda(imm16(SIDE_BITS["above"] as number));
    asm.jmp(done);
    asm.label(below);
    asm.lda(imm16(SIDE_BITS["below"] as number));
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
  ctx: SnesCtx,
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
    asm.jmp(done);
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
function cellToFixed(ctx: SnesCtx, src: number, dst: number): void {
  ctx.asm.stz(mem(dst));
  ctx.asm.lda(mem(src));
  ctx.asm.sta(mem(dst, 2));
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32, abs };
