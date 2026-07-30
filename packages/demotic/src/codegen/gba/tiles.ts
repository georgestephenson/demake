/**
 * Levels, tile collision, and the grid lookup, for ARM.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and three things are worth stating:
 *
 *   - **The row multiply is one instruction and needs no widening.** `mul` takes
 *     two 32-bit registers, and a cell coordinate arrives sign-extended from
 *     `ldrsh` — so `row × width` has none of the Mega Drive's `ext.l` hazard,
 *     where a `move.w` leaves the high half as the last thing to touch the
 *     register left it.
 *   - **A byte lookup is one instruction with a register index.** `ldrb rd,
 *     [base, index]` is the whole of "the legend byte at this offset", which is
 *     what makes the inner loop of a tile walk a load, an add and a branch.
 *   - **The grid cursor is still an *offset*, not an address.** `layout.tilePtr`
 *     is two bytes on every console because the machines it was written for have
 *     sixteen-bit addresses; here an address is four. Rather than widen a shared
 *     allocation — which would move every other console's memory map and
 *     re-baseline every checked-in trace for nothing — the cursor holds the
 *     offset into the grid and the base is re-formed per cell, which is one
 *     pooled load.
 *
 * Everything below is otherwise the other backends' shape, because what a tile
 * walk *means* is `shape.ts`'s and not a machine's.
 */

import { armAsr, armAtIdx, armImm, armLsl, armReg, label } from "@demake/core";

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

import type { GbaCtx } from "./ctx.js";
import { A0, A1, A2 } from "./regs.js";
import {
  abs32,
  add32,
  at,
  branchLess32,
  clamp32,
  copy32,
  imm,
  mem,
  neg32,
  sub32,
} from "./val.js";

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
export function copy16(ctx: GbaCtx, dst: number, src: number): void {
  ctx.asm.ldrh(A0, mem(ctx, src));
  ctx.asm.strh(A0, mem(ctx, dst));
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: GbaCtx, addr: number): void {
  ctx.asm.ldrh(A0, mem(ctx, addr));
  ctx.asm.add(A0, A0, armImm(1));
  ctx.asm.strh(A0, mem(ctx, addr));
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: GbaCtx, addr: number): void {
  ctx.asm.ldrh(A0, mem(ctx, addr));
  ctx.asm.sub(A0, A0, armImm(1));
  ctx.asm.strh(A0, mem(ctx, addr));
}

/** Look a byte table up by the legend index in `r0`, leaving the entry in `r0`. */
export function emitTableLookup(ctx: GbaCtx, table: string): void {
  ctx.asm.ldrConst(A1, label(table));
  ctx.asm.ldrb(A0, armAtIdx(A1, A0));
}

/**
 * `r0 = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside the
 * grid — emitted once per level.
 *
 * The answer is zero-extended, because every caller uses it as a table index
 * straight afterwards; a sign-extended empty marker would index four billion
 * bytes into a table.
 */
export function emitTileAt(ctx: GbaCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  // Bounds: a negative or past-the-end coordinate is empty, not a wrap. One
  // unsigned comparison covers both ends, because a negative halfword read as
  // signed is a very large unsigned one — which is why these are `ldrsh` and the
  // comparison is `cc`.
  asm.ldrsh(A0, mem(ctx, col));
  asm.movImm32(A2, level.width);
  asm.cmp(A0, armReg(A2));
  ctx.far("cs", outside);
  asm.ldrsh(A1, mem(ctx, row));
  asm.movImm32(A2, level.height);
  asm.cmp(A1, armReg(A2));
  ctx.far("cs", outside);

  // offset = row × width + column, then the byte at the grid's base.
  asm.movImm32(A2, level.width);
  asm.mul(A2, A1, A2);
  asm.add(A0, A0, armReg(A2));
  asm.ldrConst(A1, label(data.gridLabel));
  asm.ldrb(A0, armAtIdx(A1, A0));
  asm.ret();
  asm.label(outside);
  asm.movImm32(A0, GRID_EMPTY);
  asm.ret();
  asm.ltorg();
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in `r0` and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(ctx: GbaCtx, base: number, data: LevelData, body: () => void): void {
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
    copy32(ctx, edge, at(base + propOffset("x")));
    add32(ctx, edge, at(base + propOffset("width")));
    ceilOpen(ctx, edge, lastCol);
    copy32(ctx, edge, at(base + propOffset("y")));
    add32(ctx, edge, at(base + propOffset("height")));
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
  asm.ldrsh(A0, mem(ctx, row));
  asm.movImm32(A1, level.width);
  asm.mul(A2, A0, A1);
  asm.ldrsh(A0, mem(ctx, firstCol));
  asm.add(A0, A0, armReg(A2));
  asm.strh(A0, mem(ctx, layout.tilePtr));
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Re-formed rather than kept in a register: `body` is a rule and uses every
  // register there is.
  asm.ldrConst(A1, label(data.gridLabel));
  asm.ldrh(A0, mem(ctx, layout.tilePtr));
  asm.ldrb(A0, armAtIdx(A1, A0));
  body();
  // A rule body can be a kilobyte, and the grid's address above it is a pooled
  // load that reaches four. This costs nothing at run time — the check happens
  // while the loop is being *emitted*, not while it runs — and it is what keeps a
  // game that grew from failing to assemble.
  ctx.poolCheck();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  asm.b(colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  asm.b(rowLoop);
  asm.label(rowDone);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: GbaCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  asm.ldrsh(A0, mem(ctx, a));
  asm.ldrsh(A1, mem(ctx, b));
  asm.cmp(A0, armReg(A1));
  ctx.far("lt", target);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: GbaCtx, addr: number): void {
  const { asm } = ctx;
  asm.ldrsh(A0, mem(ctx, addr));
  asm.cmp(A0, armImm(0));
  asm.mov(A0, armImm(0), "lt");
  asm.strh(A0, mem(ctx, addr));
}

/**
 * `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing.
 */
function clampHigh16(ctx: GbaCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  asm.ldrsh(A0, mem(ctx, addr));
  asm.movImm32(A1, limit);
  asm.cmp(A0, armReg(A1));
  // No guard against pulling a *negative* coordinate up, unlike the Mega Drive's
  // — a signed comparison cannot find one greater than a limit that is at least
  // zero, so the predicate is the whole test and the branch the other backends
  // need is simply absent.
  asm.mov(A0, armReg(A1), "gt");
  asm.strh(A0, mem(ctx, addr));
}

/**
 * `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in.
 *
 * An arithmetic shift rather than a half-word read, which is what makes this the
 * one place in the project where the byte order does not appear: every other
 * backend names an offset of 0 or 2 into the value and has to be right about
 * which.
 */
function floorCell(ctx: GbaCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldr(A0, mem(ctx, src));
  asm.mov(A0, armAsr(A0, 16));
  asm.strh(A0, mem(ctx, dst));
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: GbaCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldr(A0, mem(ctx, src));
  // The fractional part, tested by shifting it into the whole register: zero
  // means the edge is exactly on a boundary and the cell before it is the last.
  asm.movs(A1, armLsl(A0, 16));
  asm.mov(A0, armAsr(A0, 16));
  asm.sub(A0, A0, armImm(1), "eq");
  asm.strh(A0, mem(ctx, dst));
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: GbaCtx, base: number): void {
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
      copy32(ctx, near, at(base + propOffset(pos)));
      add32(ctx, near, at(base + propOffset(size)));
      sub32(ctx, near, at(cell));
      copy32(ctx, far, at(cell));
      add32(ctx, far, imm(fromInt(1)));
      sub32(ctx, far, at(base + propOffset(pos)));
      const takeFar = ctx.unique("tsepFar");
      const done = ctx.unique("tsepDone");
      branchLess32(ctx, at(near), at(far), takeFar, false);
      copy32(ctx, push, at(near));
      neg32(ctx, push);
      asm.b(done);
      asm.label(takeFar);
      copy32(ctx, push, at(far));
      asm.label(done);
    };
    axis("x", "width", cellX, pushX);
    axis("y", "height", cellY, pushY);

    copy32(ctx, near, at(pushX));
    abs32(ctx, near);
    copy32(ctx, far, at(pushY));
    abs32(ctx, far);
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    branchLess32(ctx, at(near), at(far), useY, false);
    add32(ctx, base + propOffset("x"), at(pushX));
    clamp32(ctx, base + propOffset("x"));
    asm.b(applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), at(pushY));
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/** Widen a signed 16-bit cell coordinate into 16.16. */
function cellToFixed(ctx: GbaCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldrsh(A0, mem(ctx, src));
  asm.mov(A0, armLsl(A0, 16));
  asm.str(A0, mem(ctx, dst));
}
