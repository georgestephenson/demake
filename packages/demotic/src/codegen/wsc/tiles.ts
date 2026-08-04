/**
 * Levels, tile collision, and the grid lookup, for the V30MZ.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and two things about that are the architecture's:
 *
 *   - **The grid is in a different segment from the cursor that walks it.** A
 *     level's cells are cartridge data and a cell coordinate is a variable, so
 *     the lookup carries a `cs:` override and the arithmetic that produced the
 *     address does not. That is `ops.ts`'s `romAt`, and forgetting it reads a
 *     game's own state as though it were terrain.
 *   - **A multiply by the level's width is one instruction.** `mul` is 16×16→32,
 *     so `row × width` needs no expansion into doublings at all — the Z80
 *     backend's `mulConst16` and the 6502's shift-and-add are both absent, and
 *     the width can be any number rather than one whose bit pattern is cheap.
 *
 * The cursor is still memory rather than a register, and that is the same
 * bargain every backend but the 6502's makes: a rule body fires between one cell
 * and the next and helps itself to everything.
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
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "../shape.js";

import type { WscCtx } from "./ctx.js";
import { abs, at, romAt } from "./ops.js";
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
export function copy16(ctx: WscCtx, dst: number, src: number): void {
  const { asm } = ctx;
  asm.movm("ax", abs(src));
  asm.movmr(abs(dst), "ax");
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: WscCtx, addr: number): void {
  ctx.asm.incM(abs(addr));
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: WscCtx, addr: number): void {
  ctx.asm.decM(abs(addr));
}

/**
 * `dst = src * value`.
 *
 * One `mul`, which is why there is no expansion into doublings here and no
 * constraint on what the level's width may be. The high half is discarded: a
 * grid offset is under a cartridge's worth of cells by construction.
 */
export function mulConst16(ctx: WscCtx, dst: number, src: number, value: number): void {
  const { asm } = ctx;
  if (value === 0) {
    asm.movmi(abs(dst), 0);
    return;
  }
  asm.movm("ax", abs(src));
  asm.movi("cx", value);
  asm.unary("mul", "cx");
  asm.movmr(abs(dst), "ax");
}

/**
 * Jump to `target` when the unsigned word at `addr` is at least `value`.
 *
 * The carry out of a comparison *is* the unsigned answer, so this is two
 * instructions. Getting it wrong means every tile lookup falls out of bounds and
 * a level simply has no tiles in it.
 */
export function branchAtLeast16(ctx: WscCtx, addr: number, value: number, target: string): void {
  ctx.asm.aluMI("cmp", abs(addr), value);
  ctx.far("nb", target);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: WscCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  // (a - b) < 0, using the sign of the difference; cell counts are small enough
  // that this cannot overflow.
  asm.movm("ax", abs(a));
  asm.aluM("sub", "ax", abs(b));
  ctx.far("s", target);
}

/** Jump to `target` when the signed word at `addr` is negative. */
function branchNegative16(ctx: WscCtx, addr: number, target: string): void {
  ctx.asm.aluMI("cmp", abs(addr), 0);
  ctx.far("s", target);
}

/**
 * `AL = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside
 * the grid — emitted once per level.
 */
export function emitTileAt(ctx: WscCtx, data: LevelData): void {
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

  // bx = row * width + col, and the grid itself is in the code segment.
  mulConst16(ctx, scratch, row, level.width);
  asm.movm("bx", abs(scratch));
  asm.aluM("add", "bx", abs(col));
  asm.movm8("al", romAt("bx", data.gridLabel));
  asm.ret();
  asm.label(outside);
  asm.movi8("al", GRID_EMPTY);
  asm.ret();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in `al` and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(ctx: WscCtx, base: number, data: LevelData, body: () => void): void {
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
  // The cursor is row * width + firstCol, computed once for the row. It is an
  // *offset* rather than an address, because the grid it indexes is in the code
  // segment and the cursor is in the data one.
  mulConst16(ctx, scratch, row, level.width);
  asm.movm("ax", abs(scratch));
  asm.aluM("add", "ax", abs(firstCol));
  asm.movmr(abs(layout.tilePtr), "ax");
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Reloaded rather than kept: `body` is a rule and uses every register.
  asm.movm("bx", abs(layout.tilePtr));
  asm.movm8("al", romAt("bx", data.gridLabel));
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
function clampLow16(ctx: WscCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.aluMI("cmp", abs(addr), 0);
  ctx.far("ns", done);
  asm.movmi(abs(addr), 0);
  asm.label(done);
}

/** `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing. */
function clampHigh16(ctx: WscCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  const tooBig = ctx.unique("clampSet16");
  branchNegative16(ctx, addr, done);
  branchAtLeast16(ctx, addr, limit + 1, tooBig);
  asm.jmp(done);
  asm.label(tooBig);
  asm.movmi(abs(addr), limit);
  asm.label(done);
}

/** `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in. */
function floorCell(ctx: WscCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.movm("ax", abs(src + 2));
  asm.movmr(abs(dst), "ax");
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: WscCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  asm.aluMI("cmp", abs(src), 0);
  ctx.far("nz", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: WscCtx, base: number): void {
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
function cellToFixed(ctx: WscCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.movmi(abs(dst), 0);
  asm.movm("ax", abs(src));
  asm.movmr(abs(mem(dst, 2)), "ax");
}

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32, at };
