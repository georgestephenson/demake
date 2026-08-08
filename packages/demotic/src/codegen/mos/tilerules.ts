/**
 * Step 6 of a tick — tile collision — for both 6502-family consoles.
 *
 * The `mos/` files beside this one are the *value* layer: arithmetic,
 * expressions, rule bodies, the grid walk. This one is a step of the tick, and it
 * is here for the same reason they are — every instruction in it is a 6502
 * instruction, and the two consoles that run them differ only in what a
 * *picture* is. It was the NES backend's until the PC Engine arrived and the
 * choice was to move it or to have two copies of a two-pass contact algorithm
 * whose passes have to agree with the interpreter's (AGENTS.md §Working on the
 * console backend: move it, do not duplicate it).
 *
 * The two passes are the interpreter's own: fire every rule that names a tile,
 * then push objects out of the solid ones. What makes them subtle is the
 * *contact list* — `hits` fires on entry and `touches` fires every tick, so this
 * tick's list is built in scratch and compared against the stored one before it
 * replaces it. Comparing against a half-overwritten list is the bug that shape
 * exists to make impossible.
 */

import { absX, imm, immHigh, immLow, indY, label } from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import { isMutable } from "../analyze.js";
import { TILE_CONTACT_MAX, W } from "../layout.js";
import { sideMask, tileCellsCacheable, type SceneCtx } from "../shape.js";

import type { MosCtx } from "./ctx.js";
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
import { branchZero32 } from "./val.js";
import { mem, ZP } from "./zp.js";

/** Where one subject's cell list lives. */
function cellSlot(ctx: MosCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: MosCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.lda(imm(0));
  asm.sta(mem(list));
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.cmp(imm(GRID_EMPTY));
    ctx.far("eq", next);
    asm.sta(mem(ZP.t2));
    asm.lda(mem(list));
    asm.cmp(imm(TILE_CONTACT_MAX));
    ctx.far("cs", next);
    // The entry is five bytes: the column, the row, and the legend index.
    asm.sta(mem(ZP.t3));
    asm.asl();
    asm.asl();
    asm.clc();
    asm.adc(mem(ZP.t3));
    asm.tax();
    for (const [offset, address] of [col, col + 1, row, row + 1].entries()) {
      asm.lda(mem(address));
      asm.sta(absX(list + 1 + offset));
    }
    asm.lda(mem(ZP.t2));
    asm.sta(absX(list + 5));
    asm.inc(mem(list));
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `A`. */
function emitOverCells(ctx: MosCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.lda(mem(list));
  ctx.far("eq", done);
  asm.lda(imm(0));
  asm.sta(mem(cursor));
  asm.label(loop);
  asm.ldx(mem(cursor));
  for (const [offset, address] of [col, col + 1, row, row + 1].entries()) {
    asm.lda(absX(list + 1 + offset));
    asm.sta(mem(address));
  }
  asm.lda(absX(list + 5));
  body();
  // Five bytes on, and stop when the count is reached. The cursor is in RAM
  // because a rule body uses every register there is.
  asm.clc();
  asm.lda(mem(cursor));
  asm.adc(imm(5));
  asm.sta(mem(cursor));
  asm.lda(mem(list));
  asm.sta(mem(ZP.t3));
  asm.asl(mem(ZP.t3));
  asm.asl(mem(ZP.t3));
  asm.clc();
  asm.lda(mem(ZP.t3));
  asm.adc(mem(list));
  asm.cmp(mem(cursor));
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
export function emitTileRules(ctx: MosCtx, scene: SceneCtx, level: LevelData): void {
  const { asm, layout, program } = ctx;
  // Which tiles can stop which subject: the union over every rule, in first
  // appearance order, exactly as the interpreter builds it.
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
      // This tick's list is built in scratch and compared against the stored one,
      // so the comparison is never against a half-overwritten list.
      emitBeginContacts(ctx, listBase);

      walk(subjectId, base, () => {
        const next = ctx.unique("tileNext");
        asm.cmp(imm(GRID_EMPTY));
        ctx.far("eq", next);
        // Is this legend entry one the rule names?
        asm.tax();
        asm.lda(absX(label(ruleTileTableLabel(rule, level))));
        ctx.far("eq", next);

        // A side the rule did not name is a contact that never happened: it
        // does not fire and it is not recorded either, so next tick's "was this
        // seen before" answers as the interpreter's does (`sim.ts`
        // §resolveTiles). Separation is unaffected — what can hold an object up
        // is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.and(imm(mask));
          ctx.far("eq", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.lda(immLow(listBase + 1));
          asm.sta(mem(ZP.p1));
          asm.lda(immHigh(listBase + 1));
          asm.sta(mem(ZP.p1, 1));
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
      asm.cmp(imm(GRID_EMPTY));
      ctx.far("eq", next);
      asm.tax();
      asm.lda(absX(label(level.solidLabel)));
      ctx.far("eq", next);
      asm.lda(absX(label(namedTable)));
      ctx.far("eq", next);
      emitTileSeparate(ctx, base);
      asm.label(next);
    });
    asm.label(skip);
    // The table of tiles that can stop this subject, by legend index.
    ctx.need(namedTable, () => {
      for (const tile of level.file.tiles) ctx.asm.db(named.has(tile.name) ? 1 : 0);
    });
  }
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: MosCtx, rule: RuleDef, bind: Binding): void {
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
    asm.jmp(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: MosCtx): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.sta(mem(layout.words + W.cell * 2));
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.sta(mem(layout.words + W.cell * 2 + 1));
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: MosCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.lda(imm(0));
  asm.sta(mem(layout.tileScratch));
  asm.lda(mem(listBase));
  asm.sta(mem(layout.words + W.target * 2));
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: MosCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.lda(mem(layout.tileScratch));
  asm.cmp(imm(TILE_CONTACT_MAX));
  ctx.far("cs", full);
  asm.asl();
  asm.tax();
  asm.lda(mem(layout.words + W.cell * 2));
  asm.sta(absX(layout.tileScratch + 1));
  asm.lda(mem(layout.words + W.cell * 2 + 1));
  asm.sta(absX(layout.tileScratch + 2));
  asm.inc(mem(layout.tileScratch));
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries that
 * exist, not the whole slot. An object usually touches two or three cells, and
 * copying sixteen of them every tick was costing more than the walk.
 */
function emitCommitContacts(ctx: MosCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("commitContacts");
  asm.lda(mem(layout.tileScratch));
  asm.asl();
  asm.tax();
  asm.label(loop);
  asm.lda(absX(layout.tileScratch));
  asm.sta(absX(listBase));
  asm.dex();
  asm.bpl(loop);
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry event
 * fires only when the answer is no, a level one fires regardless. The list to
 * search is in `p1`, and the answer is the Z flag.
 */
export function emitTileContactHelper(ctx: MosCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const step = ctx.unique("seenStep");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.lda(mem(layout.words + W.target * 2));
  asm.beq(missing);
  asm.sta(mem(ZP.t0));
  asm.ldy(imm(0));
  asm.label(loop);
  asm.lda(indY(ZP.p1));
  asm.cmp(mem(layout.words + W.cell * 2));
  asm.bne(step);
  asm.iny();
  asm.lda(indY(ZP.p1));
  asm.dey();
  asm.cmp(mem(layout.words + W.cell * 2 + 1));
  asm.beq(found);
  asm.label(step);
  asm.iny();
  asm.iny();
  asm.dec(mem(ZP.t0));
  asm.bne(loop);
  asm.label(missing);
  asm.lda(imm(0));
  asm.rts();
  asm.label(found);
  asm.lda(imm(1));
  asm.rts();
}
