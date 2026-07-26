/**
 * Levels, tile collision, and the grid lookup, for the 6502.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because both consoles carry the same tables. What is here is how
 * this machine reads them, and the one place it is genuinely better at it: the
 * cursor into the grid is a page-zero pointer, so walking a row is
 * `lda (tilePtr),y` and an increment, where the Game Boy has to reload `HL` from
 * RAM between cells because the rule bodies in between use every register it has.
 */

import { imm, indY } from "@demake/core";

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

import type { NesCtx } from "./ctx.js";
import { add32, branchLess32, clamp32, copy32, neg32, set32, sub32, abs32 } from "./val.js";
import { mem, ZP } from "./zp.js";

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
export function copy16(ctx: NesCtx, dst: number, src: number): void {
  const { asm } = ctx;
  asm.lda(mem(src));
  asm.sta(mem(dst));
  asm.lda(mem(src, 1));
  asm.sta(mem(dst, 1));
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: NesCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("inc16");
  asm.inc(mem(addr));
  asm.bne(done);
  asm.inc(mem(addr, 1));
  asm.label(done);
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: NesCtx, addr: number): void {
  const { asm } = ctx;
  const high = ctx.unique("dec16");
  const done = ctx.unique("dec16done");
  asm.lda(mem(addr));
  asm.bne(high);
  asm.dec(mem(addr, 1));
  asm.label(high);
  asm.dec(mem(addr));
  asm.label(done);
}

/** `dst = src * value`, with the constant expanded into doublings and adds. */
export function mulConst16(ctx: NesCtx, dst: number, src: number, value: number): void {
  const { asm } = ctx;
  if (value === 0) {
    asm.lda(imm(0));
    asm.sta(mem(dst));
    asm.sta(mem(dst, 1));
    return;
  }
  let top = 15;
  while (top > 0 && (value & (1 << top)) === 0) top -= 1;
  copy16(ctx, dst, src);
  for (let bit = top - 1; bit >= 0; bit -= 1) {
    asm.asl(mem(dst));
    asm.rol(mem(dst, 1));
    if ((value & (1 << bit)) === 0) continue;
    asm.clc();
    asm.lda(mem(dst));
    asm.adc(mem(src));
    asm.sta(mem(dst));
    asm.lda(mem(dst, 1));
    asm.adc(mem(src, 1));
    asm.sta(mem(dst, 1));
  }
}

/**
 * Jump to `target` when the unsigned word at `addr` is at least `value`.
 *
 * The high bytes decide it unless they are equal, and only then do the low bytes
 * matter — the ordinary two-byte comparison, written out because getting it wrong
 * here means every tile lookup falls out of bounds and a level simply has no tiles
 * in it.
 */
export function branchAtLeast16(ctx: NesCtx, addr: number, value: number, target: string): void {
  const { asm } = ctx;
  const below = ctx.unique("below16");
  asm.lda(mem(addr, 1));
  asm.cmp(imm((value >> 8) & 0xff));
  asm.bcc(below);
  ctx.far("ne", target);
  asm.lda(mem(addr));
  asm.cmp(imm(value & 0xff));
  ctx.far("cs", target);
  asm.label(below);
}

/**
 * `A = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside the
 * grid — emitted once per level.
 */
export function emitTileAt(ctx: NesCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const scratch = layout.words + W.temp * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap.
  asm.lda(mem(col, 1));
  ctx.far("mi", outside);
  branchAtLeast16(ctx, col, level.width, outside);
  asm.lda(mem(row, 1));
  ctx.far("mi", outside);
  branchAtLeast16(ctx, row, level.height, outside);

  // pointer = grid + row * width + col
  mulConst16(ctx, scratch, row, level.width);
  asm.clc();
  asm.lda(mem(scratch));
  asm.adc(mem(col));
  asm.sta(mem(ZP.p0));
  asm.lda(mem(scratch, 1));
  asm.adc(mem(col, 1));
  asm.sta(mem(ZP.p0, 1));
  ctx.addPointer(ZP.p0, data.gridLabel);
  asm.ldy(imm(0));
  asm.lda(indY(ZP.p0));
  asm.rts();
  asm.label(outside);
  asm.lda(imm(GRID_EMPTY));
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
export function emitTilesUnder(ctx: NesCtx, base: number, data: LevelData, body: () => void): void {
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
  // The cursor is grid + row * width + firstCol, computed once for the row.
  mulConst16(ctx, scratch, row, level.width);
  asm.clc();
  asm.lda(mem(scratch));
  asm.adc(mem(firstCol));
  asm.sta(mem(layout.tilePtr));
  asm.lda(mem(scratch, 1));
  asm.adc(mem(firstCol, 1));
  asm.sta(mem(layout.tilePtr, 1));
  ctx.addPointer(layout.tilePtr, data.gridLabel);
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  asm.ldy(imm(0));
  asm.lda(indY(layout.tilePtr));
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
function clampLow16(ctx: NesCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.lda(mem(addr, 1));
  asm.bpl(done);
  asm.lda(imm(0));
  asm.sta(mem(addr));
  asm.sta(mem(addr, 1));
  asm.label(done);
}

/** `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing. */
function clampHigh16(ctx: NesCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  const tooBig = ctx.unique("clampSet16");
  asm.lda(mem(addr, 1));
  ctx.far("mi", done);
  branchAtLeast16(ctx, addr, limit + 1, tooBig);
  asm.jmp(done);
  asm.label(tooBig);
  asm.lda(imm(limit & 0xff));
  asm.sta(mem(addr));
  asm.lda(imm((limit >> 8) & 0xff));
  asm.sta(mem(addr, 1));
  asm.label(done);
}

/** `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in. */
function floorCell(ctx: NesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(mem(src, 2));
  asm.sta(mem(dst));
  asm.lda(mem(src, 3));
  asm.sta(mem(dst, 1));
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: NesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  asm.lda(mem(src));
  asm.ora(mem(src, 1));
  ctx.far("ne", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: NesCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  // (a - b) < 0, using the sign of the difference; cell counts are small enough
  // that this cannot overflow.
  asm.sec();
  asm.lda(mem(a));
  asm.sbc(mem(b));
  asm.lda(mem(a, 1));
  asm.sbc(mem(b, 1));
  ctx.far("mi", target);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: NesCtx, base: number): void {
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
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    branchLess32(ctx, near, far, useY, false);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    asm.jmp(applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), pushY);
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/** Widen a signed 16-bit cell coordinate into 16.16. */
function cellToFixed(ctx: NesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(imm(0));
  asm.sta(mem(dst));
  asm.sta(mem(dst, 1));
  asm.lda(mem(src));
  asm.sta(mem(dst, 2));
  asm.lda(mem(src, 1));
  asm.sta(mem(dst, 3));
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32 };
