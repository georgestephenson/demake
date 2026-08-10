/**
 * Levels, tile collision, and the grid lookup, for the V810.
 *
 * The *format* is not here — one byte per cell and one per legend entry, emitted
 * by `shape.ts` because every console carries the same tables. What is here is
 * how this machine reads them, and three things are worth stating:
 *
 *   - **The legend index travels in {@link T0}, zero-extended.** Every caller
 *     uses it as a table index straight afterwards, so it is loaded with `in.b`
 *     rather than `ld.b`: the two differ only in whether the byte is sign-
 *     extended, and `$FF` — which is {@link GRID_EMPTY}, the commonest value in
 *     any grid — becomes −1 under the wrong one and indexes four billion bytes
 *     backwards into a table.
 *   - **The row multiply is one instruction.** `mul` takes two whole registers,
 *     so `row × width` is a single opcode where the Z80 expands the constant
 *     into doublings and the 6502 runs a shift-and-add over two memory bytes.
 *     That matters because a tile walk does it once per row of every object's
 *     box, every tick.
 *   - **The grid cursor is an *offset*, not an address.** `layout.tilePtr` is two
 *     bytes on every console because the machines it was written for have
 *     sixteen-bit addresses; here a grid is in the cartridge at `$07xxxxxx`.
 *     Rather than widen a shared allocation — which would move every other
 *     console's memory map and re-baseline every checked-in trace for nothing —
 *     the cursor holds the offset into the grid and the base is re-formed per
 *     cell, which is two instructions on a machine that builds every constant.
 *
 * Everything below is otherwise the Neo Geo Pocket version's shape, because what
 * a tile walk *means* is `shape.ts`'s and not a machine's.
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
  SIDE_BITS,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "../shape.js";

import type { VbCtx } from "./ctx.js";
import { E0, LP, RAM, T0, T1, T2, ZERO, ramDisp } from "./regs.js";
import { abs32, add32, branchLess32, clamp32, copy32, neg32, set32, sub32 } from "./val.js";

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

/**
 * Where {@link emitTileSide} leaves its answer.
 *
 * A register rather than a memory byte, because the caller branches on it
 * immediately — and named rather than passed, because it is the one value that
 * crosses from this file into `rules.ts` in a register.
 */
export const SIDE_REG = E0;

/** `dst = src`, on a 16-bit word. */
export function copy16(ctx: VbCtx, dst: number, src: number): void {
  ctx.asm.ldh(ramDisp(src), RAM, T0);
  ctx.asm.sth(T0, ramDisp(dst), RAM);
}

/** `addr += 1`, on a 16-bit word. */
export function inc16(ctx: VbCtx, addr: number): void {
  ctx.asm.ldh(ramDisp(addr), RAM, T0);
  ctx.asm.addImm5(1, T0);
  ctx.asm.sth(T0, ramDisp(addr), RAM);
}

/** `addr -= 1`, on a 16-bit word. */
export function dec16(ctx: VbCtx, addr: number): void {
  ctx.asm.ldh(ramDisp(addr), RAM, T0);
  ctx.asm.addImm5(-1, T0);
  ctx.asm.sth(T0, ramDisp(addr), RAM);
}

/**
 * Look a byte table up by the legend index in {@link T0}, leaving the entry
 * there.
 *
 * Zero-extended on the way out for the reason the file header gives: the index
 * and the entry are both bytes a caller treats as unsigned, and `ld.b` would
 * make `$FF` negative.
 */
export function emitTableLookup(ctx: VbCtx, table: string): void {
  const { asm } = ctx;
  asm.movImm32(label(table), T1);
  asm.add(T0, T1);
  asm.inb(0, T1, T0);
}

/**
 * `T0 = the legend index at (word[tileCol], word[tileRow])`, or `$FF` outside
 * the grid — emitted once per level.
 *
 * One *unsigned* comparison covers both ends of each bound, because a negative
 * coordinate sign-extends to a very large unsigned one: a cell off the top or
 * left of the grid is empty rather than a wrap, and so is one past the end.
 */
export function emitTileAt(ctx: VbCtx, data: LevelData): void {
  const { asm, layout } = ctx;
  const level = data.file;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const outside = ctx.unique("tileOutside");

  asm.label(tileAtLabel(data));
  asm.ldh(ramDisp(col), RAM, T1);
  asm.movImm32(level.width, T2);
  asm.cmp(T2, T1);
  ctx.far("nl", outside);
  asm.ldh(ramDisp(row), RAM, T1);
  asm.movImm32(level.height, T2);
  asm.cmp(T2, T1);
  ctx.far("nl", outside);

  // offset = row × width + column. Both are inside their bounds by now, so the
  // multiply cannot be negative and its low half is the whole answer.
  asm.ldh(ramDisp(row), RAM, T1);
  asm.movImm32(level.width, T2);
  asm.mul(T2, T1);
  asm.ldh(ramDisp(col), RAM, T2);
  asm.add(T2, T1);
  asm.movImm32(label(data.gridLabel), T2);
  asm.add(T1, T2);
  asm.inb(0, T2, T0);
  asm.jmp(LP);
  asm.label(outside);
  asm.movImm32(GRID_EMPTY, T0);
  asm.jmp(LP);
}

/**
 * Walk every cell an object's box overlaps, running `body` with the legend index
 * in {@link T0} and the cell coordinates in the scratch words.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object overlap already works,
 * so an object resting against a wall is touching it and not inside it.
 */
export function emitTilesUnder(ctx: VbCtx, base: number, data: LevelData, body: () => void): void {
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
  asm.ldh(ramDisp(row), RAM, T1);
  asm.movImm32(level.width, T2);
  asm.mul(T2, T1);
  asm.ldh(ramDisp(firstCol), RAM, T2);
  asm.add(T2, T1);
  asm.sth(T1, ramDisp(layout.tilePtr), RAM);
  asm.label(colLoop);
  branchLess16(ctx, lastCol, col, colDone);
  // Re-formed rather than kept in a register: `body` is a rule and uses every
  // register there is.
  asm.movImm32(label(data.gridLabel), T1);
  // The cursor is an unsigned offset, so it is read zero-extended: a grid may be
  // larger than 32767 cells and a sign-extending load would index backwards.
  asm.inh(ramDisp(layout.tilePtr), RAM, T2);
  asm.add(T2, T1);
  asm.inb(0, T1, T0);
  body();
  inc16(ctx, layout.tilePtr);
  inc16(ctx, col);
  ctx.jump(colLoop);
  asm.label(colDone);
  inc16(ctx, row);
  ctx.jump(rowLoop);
  asm.label(rowDone);
}

/** Jump to `target` when the signed word at `a` is less than the one at `b`. */
export function branchLess16(ctx: VbCtx, a: number, b: number, target: string): void {
  const { asm } = ctx;
  asm.ldh(ramDisp(a), RAM, T0);
  asm.ldh(ramDisp(b), RAM, T1);
  asm.cmp(T1, T0);
  ctx.far("lt", target);
}

/** `addr = max(addr, 0)`, on a signed 16-bit cell coordinate. */
function clampLow16(ctx: VbCtx, addr: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampLow16");
  asm.ldh(ramDisp(addr), RAM, T0);
  asm.cmpImm5(0, T0);
  asm.bcond("ge", done);
  asm.sth(ZERO, ramDisp(addr), RAM);
  asm.label(done);
}

/**
 * `addr = min(addr, limit)`, leaving a negative coordinate alone so an object
 * entirely off the grid ends up with `last < first` and walks nothing.
 */
function clampHigh16(ctx: VbCtx, addr: number, limit: number): void {
  const { asm } = ctx;
  const done = ctx.unique("clampHigh16");
  asm.ldh(ramDisp(addr), RAM, T0);
  asm.cmpImm5(0, T0);
  asm.bcond("lt", done);
  asm.movImm32(limit, T1);
  asm.cmp(T1, T0);
  asm.bcond("le", done);
  asm.sth(T1, ramDisp(addr), RAM);
  asm.label(done);
}

/**
 * `dst16 = floor(value)` — the integer cell a 16.16 coordinate sits in.
 *
 * The high word of the value, which on this little-endian machine is the word at
 * offset two. The Mega Drive says zero; the difference is the byte order and not
 * a mistake.
 */
function floorCell(ctx: VbCtx, src: number, dst: number): void {
  ctx.asm.ldh(ramDisp(src + CELL_OFFSET), RAM, T0);
  ctx.asm.sth(T0, ramDisp(dst), RAM);
}

/**
 * The last cell a half-open span touches: `floor(edge)`, minus one when the edge
 * lands exactly on a boundary.
 */
function ceilOpen(ctx: VbCtx, src: number, dst: number): void {
  const { asm } = ctx;
  const notExact = ctx.unique("ceilOpen");
  floorCell(ctx, src, dst);
  // The fraction is the *low* word here, at offset zero. Sign extension does not
  // change whether it is zero, so the ordinary load is the right one.
  asm.ldh(ramDisp(src), RAM, T0);
  asm.cmpImm5(0, T0);
  asm.bcond("ne", notExact);
  dec16(ctx, dst);
  asm.label(notExact);
}

/**
 * Push an object out of a solid cell along its shallower axis — the same rule
 * object separation uses, and for the same reason: resolving the deeper axis
 * would teleport a walking object over a wall it merely brushed.
 */
export function emitTileSeparate(ctx: VbCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsepUseY");
    const applied = ctx.unique("tsepApplied");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    add32(ctx, base + propOffset("x"), pushX);
    clamp32(ctx, base + propOffset("x"));
    ctx.jump(applied);
    asm.label(useY);
    add32(ctx, base + propOffset("y"), pushY);
    clamp32(ctx, base + propOffset("y"));
    asm.label(applied);
  });
}

/**
 * {@link SIDE_REG} = the {@link SIDE_BITS} bit for the side of the cell the
 * object sat on.
 *
 * The tile half of `from`, and the same split the pair path makes: this decides
 * and {@link emitTileSeparate} applies, both off {@link emitTilePushes}, so a
 * rule that takes footing from a landing cannot disagree with the push that
 * follows it. Inline rather than a routine because the cell it is asked about
 * lives in the walk's own render words, which a call would have to be handed.
 */
export function emitTileSide(ctx: VbCtx, base: number): void {
  const { asm } = ctx;
  ctx.scoped(() => {
    const useY = ctx.unique("tsideUseY");
    const negative = ctx.unique("tsideNeg");
    const below = ctx.unique("tsideBelow");
    const done = ctx.unique("tsideDone");
    const { pushX, pushY } = emitTilePushes(ctx, base, useY);
    // A 16.16 value is a register here, so its sign is one comparison.
    asm.ldw(ramDisp(pushX), RAM, T0);
    asm.cmpImm5(0, T0);
    ctx.far("lt", negative);
    asm.movImm32(SIDE_BITS["right"] as number, SIDE_REG);
    ctx.jump(done);
    asm.label(negative);
    asm.movImm32(SIDE_BITS["left"] as number, SIDE_REG);
    ctx.jump(done);
    asm.label(useY);
    asm.ldw(ramDisp(pushY), RAM, T0);
    asm.cmpImm5(0, T0);
    ctx.far("ge", below);
    asm.movImm32(SIDE_BITS["above"] as number, SIDE_REG);
    ctx.jump(done);
    asm.label(below);
    asm.movImm32(SIDE_BITS["below"] as number, SIDE_REG);
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
function emitTilePushes(ctx: VbCtx, base: number, useY: string): { pushX: number; pushY: number } {
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
    ctx.jump(done);
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

/**
 * Widen a signed 16-bit cell coordinate into 16.16.
 *
 * Shifting the halfword into the register's high half is the whole conversion:
 * the fraction becomes zero and the coordinate's sign bit lands on bit 31, so a
 * negative cell stays negative and whatever the load's own sign extension left
 * above it is shifted away.
 */
function cellToFixed(ctx: VbCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldh(ramDisp(src), RAM, T0);
  asm.shlImm5(16, T0);
  asm.stw(T0, ramDisp(dst), RAM);
}

/**
 * Which half of a 16.16 value is its whole-cell part.
 *
 * Two, because this machine is little-endian. The Mega Drive says zero, and a
 * backend that copied that one's would compare fractions in the cheap near test
 * and cull everything.
 */
export const CELL_OFFSET = 2;

/** Silence the unused-import checker for helpers the emitters reach for. */
export const TILE_HELPERS = { set32 };
