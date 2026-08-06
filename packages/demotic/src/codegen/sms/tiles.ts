/**
 * Levels, tile collision, and the grid lookup, for the Z80.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and the arithmetic is where the difference shows:
 * a cell coordinate is sixteen bits, and this CPU has sixteen-bit registers, so
 * a comparison is `sbc hl,de` and a multiply by the level's width is a chain of
 * `add hl,hl` with no memory traffic at all. The 6502 version of `mulConst16`
 * writes back to memory after every doubling because it has nowhere else to put
 * the accumulator.
 *
 * The one thing that is *not* better: the grid cursor. The 6502 keeps it in page
 * zero and reads a cell with `lda (ptr),y`; here it has to be reloaded into `hl`
 * each time round the inner loop, because the rule bodies in between use every
 * register there is — the same bargain the Game Boy backend makes.
 */

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

import type { SmsCtx } from "./ctx.js";
import { abs32, add32, branchLess32, clamp32, copy32, mem, neg32, set32, sub32 } from "./val.js";

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
export function copy16(ctx: SmsCtx, dst: number, src: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", src);
  asm.st16To(dst, "hl");
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: SmsCtx, addr: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", addr);
  asm.inc16("hl");
  asm.st16To(addr, "hl");
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: SmsCtx, addr: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", addr);
  asm.dec16("hl");
  asm.st16To(addr, "hl");
}

/**
 * `dst = src * value`, with the constant expanded into doublings and adds.
 *
 * The whole product lives in `hl` and the addend in `de`, so a level fifty cells
 * wide is six `add hl,hl` and two `add hl,de` — eight one-byte instructions,
 * against the 6502's shift-and-add over two memory bytes each time.
 */
export function mulConst16(ctx: SmsCtx, dst: number, src: number, value: number): void {
  const { asm } = ctx;
  if (value === 0) {
    asm.ld16("hl", 0);
    asm.st16To(dst, "hl");
    return;
  }
  let top = 15;
  while (top > 0 && (value & (1 << top)) === 0) top -= 1;
  asm.ld16From("hl", src);
  asm.ld16From("de", src);
  for (let bit = top - 1; bit >= 0; bit -= 1) {
    asm.addHL("hl");
    if ((value & (1 << bit)) !== 0) asm.addHL("de");
  }
  asm.st16To(dst, "hl");
}

/**
 * Jump to `target` when the unsigned word at `addr` is at least `value`.
 *
 * The borrow out of a full sixteen-bit subtract *is* the unsigned comparison, so
 * this is four instructions rather than the 6502's high-byte-then-low-byte
 * ladder. Getting it wrong means every tile lookup falls out of bounds and a
 * level simply has no tiles in it.
 */
export function branchAtLeast16(ctx: SmsCtx, addr: number, value: number, target: string): void {
  const { asm } = ctx;
  asm.ld16From("hl", addr);
  asm.ld16("de", value);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("nc", target);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: SmsCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  // (a - b) < 0, using the sign of the difference; cell counts are small enough
  // that this cannot overflow.
  asm.ld16From("hl", a);
  asm.ld16From("de", b);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("m", target);
}

/** Jump to `target` when the signed word at `addr` is negative. */
function branchNegative16(ctx: SmsCtx, addr: number, target: string): void {
  const { asm } = ctx;
  asm.lda(addr + 1);
  asm.aluN("or", 0);
  ctx.far("m", target);
}

/**
 * `A = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside the
 * grid — emitted once per level.
 */
export function emitTileAt(ctx: SmsCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const scratch = layout.words + W.temp * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap.
  branchNegative16(ctx, col, outside);
  branchAtLeast16(ctx, col, level.width, outside);
  branchNegative16(ctx, row, outside);
  branchAtLeast16(ctx, row, level.height, outside);

  // hl = grid + row * width + col
  mulConst16(ctx, scratch, row, level.width);
  asm.ld16From("hl", scratch);
  asm.ld16From("de", col);
  asm.addHL("de");
  asm.ld16("de", data.gridLabel);
  asm.addHL("de");
  asm.ld("a", "hlp");
  asm.ret();
  asm.label(outside);
  asm.ldn("a", GRID_EMPTY);
  asm.ret();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in `a` and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(ctx: SmsCtx, base: number, data: LevelData, body: () => void): void {
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
  asm.ld16From("hl", scratch);
  asm.ld16From("de", firstCol);
  asm.addHL("de");
  asm.ld16("de", data.gridLabel);
  asm.addHL("de");
  asm.st16To(layout.tilePtr, "hl");
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Reloaded rather than kept: `body` is a rule and uses every register.
  asm.ld16From("hl", layout.tilePtr);
  asm.ld("a", "hlp");
  body();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  asm.jp(colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  asm.jp(rowLoop);
  asm.label(rowDone);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: SmsCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.lda(addr + 1);
  asm.aluN("or", 0);
  ctx.far("p", done);
  asm.ld16("hl", 0);
  asm.st16To(addr, "hl");
  asm.label(done);
}

/** `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing. */
function clampHigh16(ctx: SmsCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  const tooBig = ctx.unique("clampSet16");
  branchNegative16(ctx, addr, done);
  branchAtLeast16(ctx, addr, limit + 1, tooBig);
  asm.jp(done);
  asm.label(tooBig);
  asm.ld16("hl", limit);
  asm.st16To(addr, "hl");
  asm.label(done);
}

/** `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in. */
function floorCell(ctx: SmsCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ld16From("hl", src + 2);
  asm.st16To(dst, "hl");
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: SmsCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  asm.ld16From("hl", src);
  asm.ld("a", "h");
  asm.alu("or", "l");
  ctx.far("nz", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: SmsCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    asm.jp(applied);
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
export function emitTileSide(ctx: SmsCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsideUseY");
    const negative = ctx.unique("tsideNeg");
    const below = ctx.unique("tsideBelow");
    const done = ctx.unique("tsideDone");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    asm.lda(pushX + 3);
    asm.aluN("or", 0);
    ctx.far("m", negative);
    asm.ldn("a", SIDE_BITS["right"] as number);
    asm.jp(done);
    asm.label(negative);
    asm.ldn("a", SIDE_BITS["left"] as number);
    asm.jp(done);
    asm.label(useY);
    asm.lda(pushY + 3);
    asm.aluN("or", 0);
    ctx.far("p", below);
    asm.ldn("a", SIDE_BITS["above"] as number);
    asm.jp(done);
    asm.label(below);
    asm.ldn("a", SIDE_BITS["below"] as number);
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
function emitTilePushes(ctx: SmsCtx, base: number, useY: string): { pushX: number; pushY: number } {
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
    asm.jp(done);
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
function cellToFixed(ctx: SmsCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ld16("hl", 0);
  asm.st16To(dst, "hl");
  asm.ld16From("hl", src);
  asm.st16To(mem(dst, 2), "hl");
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32 };
