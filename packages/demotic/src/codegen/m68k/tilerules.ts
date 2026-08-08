/**
 * Step 6 of the tick — the tile walk, tile rules and tile contacts — for the
 * 68000.
 *
 * The *processor's* rather than one console's, which is `mos/tilerules.ts`'s
 * position for the 6502 family one architecture along. Nothing in this file
 * touches a video register, a tilemap address or a palette: an object's cells
 * are worked out from the level's own grid and the contacts land in bytes the
 * RAM allocator placed, so a Mega Drive and a Neo Geo run these instructions
 * unchanged despite sharing nothing about how a cell is *drawn*.
 *
 * Two things about the shape are worth keeping, and both are `shape.ts`'s rules
 * arriving here rather than decisions this file makes.
 *
 *   - **The cells are walked once per object, not once per rule.**
 *     {@link emitFillCells} records the overlap into a list and every tile rule
 *     and the separation pass reads it, which is only valid where no tile rule
 *     can move its subject — a question `tileCellsCacheable` answers at compile
 *     time. The interpreter recomputes per rule, so caching is equivalent exactly
 *     when the answer cannot have changed.
 *   - **The walk is clipped to the grid once, not per cell.** Cells outside a
 *     level contribute nothing either way, so bounding the walk up front is
 *     equivalent to asking about every cell — and it is the difference between a
 *     load-and-increment inner loop and four bounds comparisons and a multiply.
 */

import { eaAbs, eaD, eaDisp, eaIdx, eaInd, eaPost, label } from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import { isMutable } from "../analyze.js";
import { TILE_CONTACT_MAX, W } from "../layout.js";
import { sideMask, tileCellsCacheable, type SceneCtx } from "../shape.js";

import type { M68kCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { emitAssignments, emitSound } from "./rules.js";
import {
  emitTileSeparate,
  emitTileSide,
  emitTilesUnder,
  GRID_EMPTY,
  ruleTileTableLabel,
  tileSlot,
  type LevelData,
} from "./tiles.js";
import { at, branchZero32 } from "./val.js";

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: M68kCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: M68kCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.clr("b", at(list));
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.cmpi("w", GRID_EMPTY, eaD(0));
    ctx.far("eq", next);
    asm.move("w", eaD(0), eaD(3)); // the legend index, held across the arithmetic
    asm.moveq(0, 1);
    asm.move("b", at(list), eaD(1));
    asm.cmpi("w", TILE_CONTACT_MAX, eaD(1));
    ctx.far("cc", next);
    // The entry is five bytes: the column, the row, and the legend index.
    asm.move("l", eaD(1), eaD(2));
    asm.lsl("l", 2, 2);
    asm.add("l", eaD(1), 2);
    asm.lea(at(list + 1), 0);
    asm.adda("l", eaD(2), 0);
    // A byte at a time, because a five-byte entry after a count byte lands on an
    // odd address every other time — and a word access to an odd address is an
    // address error on this CPU. The shared stride is what it is because three
    // other consoles read a word from anywhere at all.
    asm.move("b", at(col), eaInd(0));
    asm.move("b", at(col, 1), eaDisp(0, 1));
    asm.move("b", at(row), eaDisp(0, 2));
    asm.move("b", at(row, 1), eaDisp(0, 3));
    asm.move("b", eaD(3), eaDisp(0, 4));
    asm.addq("b", 1, at(list));
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `d0`. */
function emitOverCells(ctx: M68kCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.tst("b", at(list));
  ctx.far("eq", done);
  asm.clr("w", at(cursor));
  asm.label(loop);
  asm.lea(at(list + 1), 0);
  asm.moveq(0, 1);
  asm.move("w", at(cursor), eaD(1));
  asm.adda("l", eaD(1), 0);
  asm.move("b", eaInd(0), at(col));
  asm.move("b", eaDisp(0, 1), at(col, 1));
  asm.move("b", eaDisp(0, 2), at(row));
  asm.move("b", eaDisp(0, 3), at(row, 1));
  asm.moveq(0, 0);
  asm.move("b", eaDisp(0, 4), eaD(0));
  body();
  // Five bytes on, and stop when the count is reached. The cursor is in memory
  // because a rule body uses every register there is.
  asm.addi("w", 5, at(cursor));
  asm.moveq(0, 1);
  asm.move("b", at(list), eaD(1));
  asm.move("l", eaD(1), eaD(2));
  asm.lsl("l", 2, 2);
  asm.add("l", eaD(1), 2);
  asm.cmp("w", at(cursor), 2);
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
export function emitTileRules(ctx: M68kCtx, scene: SceneCtx, level: LevelData): void {
  const { asm, layout, program } = ctx;
  const blockers = new Map<number, Set<string>>();

  // Objects whose overlapped cells are the same for every rule this tick get
  // walked once, here, and every pass below reads the list instead of the grid.
  const cached = new Set<number>();
  for (const rule of program.rules) {
    if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;
    if (rule.scene !== undefined && rule.scene !== scene.def.name) continue;
    for (const subjectId of rule.event.subjects) {
      const instance = program.instances[subjectId];
      if (!instance || instance.scene !== scene.def.name) continue;
      if (cached.has(subjectId) || !tileCellsCacheable(ctx, scene, subjectId)) continue;
      cached.add(subjectId);
      emitFillCells(ctx, subjectId, level);
    }
  }
  const walk = (subjectId: number, base: number, body: () => void): void => {
    if (cached.has(subjectId)) emitOverCells(ctx, subjectId, body);
    else emitTilesUnder(ctx, base, level, body);
  };

  for (const rule of program.rules) {
    if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;
    if (rule.scene !== undefined && rule.scene !== scene.def.name) continue;
    const event = rule.event;
    for (const subjectId of event.subjects) {
      const instance = program.instances[subjectId];
      if (!instance || instance.scene !== scene.def.name) continue;
      const named = blockers.get(subjectId) ?? new Set<string>();
      for (const name of event.tiles) named.add(name);
      blockers.set(subjectId, named);

      const skip = ctx.unique("tileSubjSkip");
      if (isMutable(ctx.analysis, subjectId, "visible")) {
        branchZero32(ctx, (layout.entities[subjectId] as number) + propOffset("visible"), skip);
      } else if ((instance.numbers["visible"] ?? 0) === 0) {
        asm.label(skip);
        continue;
      }

      const base = layout.entities[subjectId] as number;
      const listBase = tileSlot(ctx, rule.id, subjectId);
      emitBeginContacts(ctx, listBase);

      walk(subjectId, base, () => {
        const next = ctx.unique("tileNext");
        asm.cmpi("w", GRID_EMPTY, eaD(0));
        ctx.far("eq", next);
        // Is this legend entry one the rule names?
        asm.lea(eaAbs(label(ruleTileTableLabel(rule, level))), 0);
        asm.tst("b", eaIdx(0, 0, 0));
        ctx.far("eq", next);

        // A side the rule did not name is a contact that never happened: it
        // does not fire and it is not recorded either, so next tick's "was this
        // seen before" answers as the interpreter's does (`sim.ts`
        // §resolveTiles). Separation is unaffected — what can hold an object up
        // is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.andi("b", mask, eaD(0));
          ctx.far("eq", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.lea(at(listBase + 1), 1);
          asm.move("b", at(listBase), eaD(1));
          asm.jsr("TileContactSeen");
          ctx.far("ne", next);
        }
        const bind: Binding = {
          subject: { kind: "const", id: subjectId, base },
          other: { kind: "none" },
        };
        emitFireTileRule(ctx, rule, bind);
        asm.label(next);
      });

      emitCommitContacts(ctx, listBase);
      asm.label(skip);
    }
  }

  for (const [subjectId, named] of blockers) {
    const instance = program.instances[subjectId] as InstanceDef;
    const skip = ctx.unique("tileSepSkip");
    if (isMutable(ctx.analysis, subjectId, "visible")) {
      branchZero32(ctx, (layout.entities[subjectId] as number) + propOffset("visible"), skip);
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[subjectId] as number;
    const namedTable = `BlockNames_${scene.index}_${subjectId}`;
    walk(subjectId, base, () => {
      const next = ctx.unique("sepNext");
      asm.cmpi("w", GRID_EMPTY, eaD(0));
      ctx.far("eq", next);
      asm.lea(eaAbs(label(level.solidLabel)), 0);
      asm.tst("b", eaIdx(0, 0, 0));
      ctx.far("eq", next);
      asm.lea(eaAbs(label(namedTable)), 0);
      asm.tst("b", eaIdx(0, 0, 0));
      ctx.far("eq", next);
      emitTileSeparate(ctx, base);
      asm.label(next);
    });
    asm.label(skip);
    // The table of tiles that can stop this subject, by legend index.
    ctx.need(namedTable, () => {
      for (const tile of level.file.tiles) ctx.asm.db(named.has(tile.name) ? 1 : 0);
      ctx.asm.align();
    });
  }
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: M68kCtx, rule: RuleDef, bind: Binding): void {
  const { asm } = ctx;
  const elseLabel = ctx.unique("tileElse");
  const done = ctx.unique("tileFired");
  let branched = false;
  if (rule.guard) {
    const verdict = emitTest(ctx, rule.guard, bind, elseLabel);
    if (verdict === "never") {
      if (rule.otherwise) emitAssignments(ctx, rule.otherwise, bind);
      return;
    }
    if (verdict === "runtime") branched = true;
  }
  emitSound(ctx, rule);
  emitAssignments(ctx, rule.assignments, bind);
  if (!branched) return;
  if (rule.otherwise && rule.otherwise.length > 0) {
    asm.bra(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  asm.move("b", at(layout.words + W.tileCol * 2 + 1), at(layout.words + W.cell * 2));
  asm.move("b", at(layout.words + W.tileRow * 2 + 1), at(layout.words + W.cell * 2 + 1));
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: M68kCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.clr("b", at(layout.tileScratch));
  asm.move("b", at(listBase), at(layout.words + W.target * 2));
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.moveq(0, 1);
  asm.move("b", at(layout.tileScratch), eaD(1));
  asm.cmpi("w", TILE_CONTACT_MAX, eaD(1));
  ctx.far("cc", full);
  asm.add("l", eaD(1), 1); // an entry is two bytes
  asm.lea(at(layout.tileScratch + 1), 0);
  asm.adda("l", eaD(1), 0);
  // Two byte stores rather than one word store: the entries sit after a count
  // byte, so half of them are at odd addresses.
  asm.move("b", at(layout.words + W.cell * 2), eaInd(0));
  asm.move("b", at(layout.words + W.cell * 2 + 1), eaDisp(0, 1));
  asm.addq("b", 1, at(layout.tileScratch));
  asm.label(full);
}

/** Replace the pair's stored list with the one just built. */
function emitCommitContacts(ctx: M68kCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("commitLoop");
  const done = ctx.unique("commitDone");
  asm.moveq(0, 0);
  asm.move("b", at(layout.tileScratch), eaD(0));
  asm.move("b", eaD(0), at(listBase));
  asm.tst("w", eaD(0));
  ctx.far("eq", done);
  asm.add("w", eaD(0), 0); // two bytes an entry
  asm.subq("w", 1, eaD(0));
  asm.lea(at(layout.tileScratch + 1), 0);
  asm.lea(at(listBase + 1), 1);
  asm.label(loop);
  asm.move("b", eaPost(0), eaPost(1));
  asm.dbra(0, loop);
  asm.label(done);
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles. The list to
 * search arrives in `a1` and its length in `d1`, and the answer is the zero flag
 * — set when the cell was not there.
 */
export function emitTileContactHelper(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  const step = ctx.unique("seenStep");
  asm.andi("l", 0xff, eaD(1));
  ctx.far("eq", missing);
  asm.subq("w", 1, eaD(1));
  asm.move("b", at(layout.words + W.cell * 2), eaD(2));
  asm.move("b", at(layout.words + W.cell * 2 + 1), eaD(3));
  asm.moveq(0, 4);
  asm.label(loop);
  // Indexed rather than walked with a post-increment, and compared a byte at a
  // time: the entries follow a count byte, so half of them are odd-addressed.
  asm.move("b", eaIdx(1, 0, 4), eaD(5));
  asm.cmp("b", eaD(5), 2);
  ctx.far("ne", step);
  asm.move("b", eaIdx(1, 1, 4), eaD(5));
  asm.cmp("b", eaD(5), 3);
  ctx.far("eq", found);
  asm.label(step);
  asm.addq("l", 2, eaD(4));
  asm.dbra(1, loop);
  asm.label(missing);
  asm.moveq(0, 0);
  asm.rts();
  asm.label(found);
  asm.moveq(1, 0);
  asm.rts();
}
