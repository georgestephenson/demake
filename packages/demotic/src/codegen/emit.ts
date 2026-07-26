/**
 * The whole-program emitter: boot, the tick, the renderer, and the data.
 *
 * Everything here is per *scene*, because a scene is what the machine is doing
 * at any moment and the compiler knows which one. A rule that cannot fire in a
 * scene contributes nothing to it; a scene with no level has no tilemap code;
 * a scene with no camera has no scroll.
 *
 * The tick order is `sim.ts`'s, exactly, and the comments say where each step
 * comes from — that order is the specification, and a conformance
 * implementation that reorders it diverges within seconds.
 */

import { label } from "@demake/core";

import { fromInt } from "../fixed.js";
import type { InstanceDef, Program, RuleDef, SceneDef } from "../program.js";
import { boundsOf } from "../level/scene.js";

import type { Ctx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { isMutable } from "./analyze.js";
import {
  ENTITY_SIZE,
  OAM_SHADOW,
  PLOT_MAX,
  PROPS,
  QUEUE_MAX,
  TILE_CONTACT_MAX,
  VIEW_H,
  VIEW_W,
  W,
} from "./layout.js";
import {
  emitAssignments,
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
  type SceneCtx,
} from "./rules.js";
import {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  emitTileAt,
  emitTileSeparate,
  emitTilesUnder,
  GRID_EMPTY,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "./tiles.js";
import { copy32, isZero32, set32, sub32 } from "./val.js";
import {
  BUILTIN_TILES,
  builtinTiles,
  glyphTile,
  OBJECT_TILE,
  patternTile,
  TILE_BYTES,
} from "../rom/graphics.js";

/** Hardware registers this backend touches. */
const R = {
  P1: 0xff00,
  IF: 0xff0f,
  LCDC: 0xff40,
  STAT: 0xff41,
  SCY: 0xff42,
  SCX: 0xff43,
  LY: 0xff44,
  DMA: 0xff46,
  BGP: 0xff47,
  OBP0: 0xff48,
  OBP1: 0xff49,
  IE: 0xffff,
} as const;

const VRAM_TILES = 0x8000;
const VRAM_MAP = 0x9800;
/** Where the OAM DMA kernel is copied to; it must run outside the main bus. */
const HRAM_DMA = 0xff80;

/** Art for one asset, already converted by the image pipeline. */
export interface SpriteArt {
  /** First tile index in the bank. */
  tile: number;
  /** Size in cells, which is the collision box's size (doc 15 §art). */
  width: number;
  height: number;
}

/** Everything the emitter needs beyond the program itself. */
export interface EmitOptions {
  /** Converted sprite art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, number>;
  /** Extra tiles appended to the built-in bank. */
  extraTiles?: Uint8Array;
  /**
   * The object palette register, when converted art chose one.
   *
   * The image pipeline picks which hardware shades an object's three colour
   * indices map to, over every asset in the build at once (doc 15 §The
   * conversion path). That choice only exists as a register value, so it
   * arrives here rather than in the tile bytes.
   */
  objectPalette?: number;
}

/** Scene index by name. */
function sceneIndex(program: Program, name: string): number {
  const index = program.scenes.findIndex((scene) => scene.name === name);
  return index < 0 ? 0 : index;
}

/** Build the per-scene view the rule emitters work against. */
function sceneContexts(ctx: Ctx): SceneCtx[] {
  return ctx.program.scenes.map((def: SceneDef, index: number) => {
    const bounds = boundsOf(def.level, ctx.profile);
    return {
      index,
      def,
      boundsW: fromInt(bounds.width),
      boundsH: fromInt(bounds.height),
      level: def.level,
    };
  });
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: Ctx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.jp(labels[0] as string);
    return;
  }
  asm.lda(layout.scene);
  for (const [index, target] of labels.entries()) {
    if (index === labels.length - 1) {
      asm.jp(target);
      break;
    }
    asm.aluN("cp", index);
    asm.jp(target, "z");
  }
}

/** Emit the whole program. */
export function emitProgram(ctx: Ctx, options: EmitOptions = {}): void {
  const { asm, program, layout } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  // --- cartridge header ------------------------------------------------------
  // The VBlank vector: the main loop uses `halt` to wait for it, so the handler
  // only has to exist and return.
  asm.padTo(0x0040);
  asm.reti();
  asm.padTo(0x0100);
  asm.nop();
  asm.jp("Entry");
  asm.padTo(0x0150);

  emitEntry(ctx, scenes, levelFor, options);
  emitMainLoop(ctx);
  emitInput(ctx);
  emitTickDispatch(ctx, scenes);
  emitSceneChange(ctx, scenes);

  for (const scene of scenes) {
    emitSceneTick(ctx, scene, levelFor.get(scene.index));
    emitSceneReset(ctx, scene);
    emitSceneCamera(ctx, scene);
    emitSceneRender(ctx, scene, levelFor.get(scene.index), options);
  }

  emitRenderHelpers(ctx);
  emitTileContactHelper(ctx);
  ctx.finish();

  // --- data ------------------------------------------------------------------
  for (const level of levels) {
    emitLevelData(ctx, level, (index) => {
      const art = level.file.tiles[index]?.art;
      const bound = art ? options.tiles?.get(art) : undefined;
      return bound ?? patternTile(index, level.file.tiles[index]?.solid ?? false);
    });
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(ctx, rule, level);
      }
    }
  }
  emitInstanceDefaults(ctx);

  asm.label("TileBank");
  asm.bytes(builtinTiles());
  if (options.extraTiles) asm.bytes(options.extraTiles);
  void layout;
}

// --- boot --------------------------------------------------------------------

function emitEntry(
  ctx: Ctx,
  scenes: readonly SceneCtx[],
  levelFor: ReadonlyMap<number, LevelData>,
  options: EmitOptions,
): void {
  const { asm, layout, program } = ctx;
  const tileCount =
    BUILTIN_TILES + (options.extraTiles ? options.extraTiles.length / TILE_BYTES : 0);

  asm.label("Entry");
  asm.di();
  asm.ld16("sp", 0xdff0);
  asm.call("LcdOff");

  // Tiles into VRAM.
  asm.ld16("hl", label("TileBank"));
  asm.ld16("de", VRAM_TILES);
  asm.ld16("bc", tileCount * TILE_BYTES);
  asm.call("CopyBytes");

  // A blank tilemap, so nothing stale shows through before the first draw.
  asm.ld16("hl", VRAM_MAP);
  asm.ld16("bc", 32 * 32);
  asm.call("ClearBytes");

  asm.ldn("a", 0b11100100);
  asm.stha(R.BGP & 0xff);
  // Objects get whatever palette the art conversion chose; with no bound art
  // the built-in block is drawn in the same shades as the background.
  asm.ldn("a", options.objectPalette ?? 0b11100100);
  asm.stha(R.OBP0 & 0xff);
  asm.stha(R.OBP1 & 0xff);
  asm.alu("xor", "a");
  asm.stha(R.SCX & 0xff);
  asm.stha(R.SCY & 0xff);

  // The OAM DMA kernel has to run from HRAM: the transfer holds the main bus.
  asm.ld16("hl", label("DmaKernel"));
  asm.ld16("de", HRAM_DMA);
  asm.ld16("bc", 10);
  asm.call("CopyBytes");

  // Every entity starts from its declared values, not just the entry scene's:
  // a rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    asm.ld16("hl", label(`Defaults_${instance.id}`));
    asm.ld16("de", layout.entities[instance.id] as number);
    asm.ld16("bc", ENTITY_SIZE);
    asm.call("CopyBytes");
  }

  asm.alu("xor", "a");
  asm.sta(layout.tick);
  asm.sta(layout.tick + 1);
  asm.sta(layout.ready);
  asm.sta(layout.booted);
  asm.sta(layout.held);
  asm.sta(layout.pressed);
  asm.sta(layout.released);
  asm.sta(layout.plotCount);
  asm.sta(layout.plotPrevCount);
  asm.sta(layout.queueCount);
  asm.ldn("a", 40);
  asm.sta(layout.oamPrev);
  asm.alu("xor", "a");
  asm.ldn("a", 0xff);
  asm.sta(layout.pending);
  asm.ldn("a", sceneIndex(program, program.entryScene));
  asm.sta(layout.scene);
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  emitClearState(ctx);
  if (layout.rng !== null) set32(ctx, layout.rng, program.seed | 0);

  asm.call("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end*
  // of a tick, so a rule reading it on tick one sees zero. Following the target
  // here instead would put the HUD one tick ahead of the specification.
  if (layout.camera !== null) {
    set32(ctx, layout.camera, 0);
    set32(ctx, layout.camera + 4, 0);
  }
  asm.call("BuildFrame");
  asm.call("UploadFrame");

  // LCD on, BG on, OBJ on, tiles at $8000, map at $9800.
  asm.ldn("a", 0b10010011);
  asm.stha(R.LCDC & 0xff);
  asm.ldn("a", 1);
  asm.stha(R.IE & 0xff);
  asm.alu("xor", "a");
  asm.stha(R.IF & 0xff);
  asm.ei();
  asm.ldn("a", 1);
  asm.sta(layout.booted);
  asm.jp("Main");
  void scenes;
  void levelFor;
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: Ctx): void {
  const { asm, layout } = ctx;
  asm.alu("xor", "a");
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.sta(layout.contacts + index);
    asm.sta(layout.contactsPrev + index);
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) asm.sta(layout.holdFlags + index);
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) asm.sta(layout.reachFlags + index);
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.sta(layout.tileContacts + index * layout.tileContactStride);
    }
  }
}

function emitMainLoop(ctx: Ctx): void {
  const { asm } = ctx;
  asm.label("Main");
  asm.halt();
  asm.nop();
  asm.call("UploadFrame");
  asm.call("ReadInput");
  asm.call("Tick");
  asm.call("BuildFrame");
  asm.jp("Main");

  asm.label("LcdOff");
  const wait = ctx.unique("lcdWait");
  asm.ldha(R.LCDC & 0xff);
  asm.bit(7, "a");
  asm.ret("z");
  asm.label(wait);
  asm.ldha(R.LY & 0xff);
  asm.aluN("cp", 144);
  asm.jp(wait, "c");
  asm.alu("xor", "a");
  asm.stha(R.LCDC & 0xff);
  asm.ret();

  asm.label("CopyBytes");
  const copyLoop = ctx.unique("copyLoop");
  asm.label(copyLoop);
  asm.ldaHLI();
  asm.staDE();
  asm.inc16("de");
  asm.dec16("bc");
  asm.ld("a", "b");
  asm.alu("or", "c");
  asm.jp(copyLoop, "nz");
  asm.ret();

  asm.label("ClearBytes");
  const clearLoop = ctx.unique("clearLoop");
  asm.label(clearLoop);
  asm.alu("xor", "a");
  asm.staHLI();
  asm.dec16("bc");
  asm.ld("a", "b");
  asm.alu("or", "c");
  asm.jp(clearLoop, "nz");
  asm.ret();

  asm.label("DmaKernel");
  asm.ldn("a", OAM_SHADOW >> 8);
  asm.stha(R.DMA & 0xff);
  asm.ldn("a", 40);
  const spin = ctx.unique("dmaSpin");
  asm.label(spin);
  asm.dec("a");
  asm.jr(spin, "nz");
  asm.ret();
}

/**
 * Read the joypad into the abstract button set, and derive this tick's edges.
 *
 * Bits are `ACTIONS` order — left right up down a b start — which is the
 * portable floor doc 14 §Buttons chose, and it maps one for one onto this
 * machine's pad.
 */
function emitInput(ctx: Ctx): void {
  const { asm, layout } = ctx;
  asm.label("ReadInput");
  asm.ldn("a", 0x20); // select the direction pad
  asm.stha(R.P1 & 0xff);
  asm.ldha(R.P1 & 0xff);
  asm.ldha(R.P1 & 0xff);
  asm.cpl();
  asm.aluN("and", 0x0f);
  asm.ld("b", "a");
  asm.ldn("c", 0);
  // Hardware order is right left up down; ours is left right up down.
  const map = (from: number, to: number): void => {
    const skip = ctx.unique("padSkip");
    asm.ld("a", "b");
    asm.bit(from, "a");
    asm.jr(skip, "z");
    asm.ld("a", "c");
    asm.aluN("or", 1 << to);
    asm.ld("c", "a");
    asm.label(skip);
  };
  map(1, 0); // left
  map(0, 1); // right
  map(2, 2); // up
  map(3, 3); // down

  asm.ldn("a", 0x10); // select the face buttons
  asm.stha(R.P1 & 0xff);
  for (let index = 0; index < 4; index += 1) asm.ldha(R.P1 & 0xff);
  asm.cpl();
  asm.aluN("and", 0x0f);
  asm.ld("b", "a");
  map(0, 4); // a
  map(1, 5); // b
  map(3, 6); // start
  asm.ldn("a", 0x30);
  asm.stha(R.P1 & 0xff);

  asm.lda(layout.held);
  asm.ld("b", "a"); // what was held last tick
  asm.ld("a", "c");
  asm.sta(layout.held);
  asm.ld("a", "b");
  asm.cpl();
  asm.alu("and", "c");
  asm.sta(layout.pressed);
  asm.ld("a", "c");
  asm.cpl();
  asm.alu("and", "b");
  asm.sta(layout.released);
  asm.ret();
}

function emitTickDispatch(ctx: Ctx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.call("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  asm.ld16("hl", layout.tick);
  asm.inc("hlp");
  const noCarry = ctx.unique("tickCarry");
  asm.jr(noCarry, "nz");
  asm.inc16("hl");
  asm.inc("hlp");
  asm.label(noCarry);
  asm.ld16("hl", layout.ready);
  asm.inc("hlp");
  asm.ret();
}

function emitSceneChange(ctx: Ctx, scenes: readonly SceneCtx[]): void {
  const { asm, layout, program } = ctx;
  asm.label("SceneChange");
  asm.lda(layout.pending);
  asm.aluN("cp", 0xff);
  asm.ret("z");
  asm.sta(layout.scene);
  asm.ldn("a", 0xff);
  asm.sta(layout.pending);
  asm.call("ResetScene");
  if (layout.rng !== null) set32(ctx, layout.rng, program.seed | 0);
  emitClearState(ctx);
  asm.call("UpdateCamera");
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  asm.ret();

  asm.label("ResetScene");
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneReset_${scene.index}`),
  );

  asm.label("UpdateCamera");
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneCamera_${scene.index}`),
  );

  asm.label("BuildFrame");
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneRender_${scene.index}`),
  );
}

// --- per-scene ---------------------------------------------------------------

function emitSceneTick(ctx: Ctx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitControls(ctx, scene);
  emitLevelRules(ctx, scene);
  emitIntegrate(ctx, scene);

  // A fresh set of contacts each tick; last tick's is what `hits` tests.
  asm.alu("xor", "a");
  for (let index = 0; index < layout.contactBytes; index += 1) asm.sta(layout.contacts + index);
  emitCollisions(ctx, scene);
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.lda(layout.contacts + index);
    asm.sta(layout.contactsPrev + index);
  }

  if (level) emitTileRules(ctx, scene, level);
  emitEdgeRules(ctx, scene);
  emitCamera(ctx, scene);
  asm.jp("TickDone");
}

function emitSceneReset(ctx: Ctx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    asm.ld16("hl", label(`Defaults_${id}`));
    asm.ld16("de", layout.entities[id] as number);
    asm.ld16("bc", ENTITY_SIZE);
    asm.call("CopyBytes");
  }
  asm.ret();
}

function emitSceneCamera(ctx: Ctx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.ret();
}

// --- 6. tiles ----------------------------------------------------------------

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 *
 * The two are separate because they answer different questions — "did anything
 * happen here" and "can I stand here" — and a tile can be either, both, or
 * neither.
 */
function emitTileRules(ctx: Ctx, scene: SceneCtx, level: LevelData): void {
  const { asm, layout, program } = ctx;
  // Which tiles can stop which subject: the union over every rule, in first
  // appearance order, exactly as the interpreter builds it.
  const blockers = new Map<number, Set<string>>();

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
        isZero32(ctx, (layout.entities[subjectId] as number) + propOffset("visible"));
        asm.jp(skip, "z");
      } else if ((instance.numbers["visible"] ?? 0) === 0) {
        asm.label(skip);
        continue;
      }

      const base = layout.entities[subjectId] as number;
      const listBase = tileSlot(ctx, rule.id, subjectId);
      // This tick's list is built in scratch and compared against the stored
      // one, so the comparison is never against a half-overwritten list.
      emitBeginContacts(ctx, listBase);

      emitTilesUnder(ctx, base, level, () => {
        const next = ctx.unique("tileNext");
        asm.aluN("cp", GRID_EMPTY);
        asm.jp(next, "z");
        // Is this legend entry one the rule names?
        asm.ld("e", "a");
        asm.ldn("d", 0);
        asm.ld16("hl", label(ruleTileTableLabel(rule, level)));
        asm.addHL("de");
        asm.ld("a", "hlp");
        asm.alu("or", "a");
        asm.jp(next, "z");

        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.ld16("hl", listBase + 1);
          asm.call("TileContactSeen");
          asm.alu("or", "a");
          asm.jp(next, "nz");
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
      isZero32(ctx, (layout.entities[subjectId] as number) + propOffset("visible"));
      asm.jp(skip, "z");
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[subjectId] as number;
    const solidTable = `${level.solidLabel}`;
    const namedTable = `BlockNames_${scene.index}_${subjectId}`;
    emitTilesUnder(ctx, base, level, () => {
      const next = ctx.unique("sepNext");
      asm.aluN("cp", GRID_EMPTY);
      asm.jp(next, "z");
      asm.ld("e", "a");
      asm.ldn("d", 0);
      asm.push("de");
      asm.ld16("hl", label(solidTable));
      asm.addHL("de");
      asm.ld("a", "hlp");
      asm.alu("or", "a");
      asm.pop("de");
      asm.jp(next, "z");
      asm.ld16("hl", label(namedTable));
      asm.addHL("de");
      asm.ld("a", "hlp");
      asm.alu("or", "a");
      asm.jp(next, "z");
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
function emitFireTileRule(ctx: Ctx, rule: RuleDef, bind: Binding): void {
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
  emitAssignments(ctx, rule.assignments, bind);
  if (!branched) return;
  if (rule.otherwise && rule.otherwise.length > 0) {
    asm.jp(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: Ctx): void {
  const { asm, layout } = ctx;
  asm.lda(layout.words + W.tileCol * 2);
  asm.sta(layout.words + W.cell * 2);
  asm.lda(layout.words + W.tileRow * 2);
  asm.sta(layout.words + W.cell * 2 + 1);
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: Ctx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.alu("xor", "a");
  asm.sta(layout.tileScratch);
  asm.lda(listBase);
  asm.sta(layout.words + W.target * 2);
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: Ctx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.lda(layout.tileScratch);
  asm.aluN("cp", TILE_CONTACT_MAX);
  asm.jp(full, "nc");
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.addHL("hl");
  asm.ld16("de", layout.tileScratch + 1);
  asm.addHL("de");
  asm.lda(layout.words + W.cell * 2);
  asm.staHLI();
  asm.lda(layout.words + W.cell * 2 + 1);
  asm.staHLI();
  asm.lda(layout.tileScratch);
  asm.inc("a");
  asm.sta(layout.tileScratch);
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries
 * that exist, not the whole slot. An object usually touches two or three cells,
 * and copying sixteen of them every tick was costing more than the walk.
 */
function emitCommitContacts(ctx: Ctx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.lda(layout.tileScratch);
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.addHL("hl");
  asm.inc16("hl");
  asm.ld("b", "h");
  asm.ld("c", "l");
  asm.ld16("hl", layout.tileScratch);
  asm.ld16("de", listBase);
  asm.call("CopyBytes");
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry
 * event fires only when the answer is no, a level one fires regardless.
 */
function emitTileContactHelper(ctx: Ctx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const step = ctx.unique("seenStep");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.lda(layout.words + W.target * 2);
  asm.alu("or", "a");
  asm.jp(missing, "z");
  asm.ld("b", "a");
  asm.label(loop);
  asm.ldaHLI();
  asm.ld("c", "a");
  asm.ldaHLI();
  asm.ld("d", "a");
  asm.lda(layout.words + W.cell * 2);
  asm.alu("cp", "c");
  asm.jp(step, "nz");
  asm.lda(layout.words + W.cell * 2 + 1);
  asm.alu("cp", "d");
  asm.jp(found, "z");
  asm.label(step);
  asm.dec("b");
  asm.jp(loop, "nz");
  asm.label(missing);
  asm.alu("xor", "a");
  asm.ret();
  asm.label(found);
  asm.ldn("a", 1);
  asm.ret();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: Ctx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: EmitOptions,
): void {
  const { asm, layout, program, profile } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.alu("xor", "a");
    asm.sta(layout.words + W.camX * 2);
    asm.sta(layout.words + W.camX * 2 + 1);
    asm.sta(layout.words + W.camY * 2);
    asm.sta(layout.words + W.camY * 2 + 1);
  }
  asm.lda(layout.words + W.camX * 2);
  asm.sta(layout.words + W.scrollX * 2);
  asm.lda(layout.words + W.camY * 2);
  asm.sta(layout.words + W.scrollY * 2);

  const noRedraw = ctx.unique("noRedraw");
  asm.lda(layout.redraw);
  asm.alu("or", "a");
  asm.jp(noRedraw, "z");
  emitFullRedraw(ctx, scene, level);
  asm.alu("xor", "a");
  asm.sta(layout.redraw);
  asm.sta(layout.plotPrevCount);
  const afterScroll = ctx.unique("afterScroll");
  asm.jp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // Restore the level tiles the HUD covered last frame, then draw it again.
  emitHudErase(ctx, level);
  asm.alu("xor", "a");
  asm.sta(layout.plotCount);
  emitHud(ctx, scene);
  emitSwapPlots(ctx);
  emitOam(ctx, scene, options);
  asm.ret();
  void program;
  void profile;
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: Ctx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(src + 1);
  asm.ld("l", "a");
  asm.lda(src + 2);
  asm.ld("h", "a");
  asm.lda(src + 3);
  asm.ld("b", "a");
  for (let index = 0; index < 5; index += 1) {
    asm.shift("sra", "b");
    asm.shift("rr", "h");
    asm.shift("rr", "l");
  }
  asm.ld("a", "l");
  asm.sta(dst);
  asm.ld("a", "h");
  asm.sta(dst + 1);
}

/** Draw the whole visible window, with the LCD off. */
function emitFullRedraw(ctx: Ctx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  asm.call("LcdOff");
  // The map's origin is the camera's cell.
  emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
  asm.lda(layout.words + W.mapCol * 2);
  asm.sta(layout.words + W.firstCol * 2);
  asm.lda(layout.words + W.mapCol * 2 + 1);
  asm.sta(layout.words + W.firstCol * 2 + 1);
  asm.lda(layout.words + W.mapRow * 2);
  asm.sta(layout.words + W.tileRow * 2);
  asm.lda(layout.words + W.mapRow * 2 + 1);
  asm.sta(layout.words + W.tileRow * 2 + 1);

  const rowLoop = ctx.unique("fullRow");
  const colLoop = ctx.unique("fullCol");
  asm.ldn("b", VIEW_H + 1);
  asm.label(rowLoop);
  asm.push("bc");
  asm.lda(layout.words + W.firstCol * 2);
  asm.sta(layout.words + W.tileCol * 2);
  asm.lda(layout.words + W.firstCol * 2 + 1);
  asm.sta(layout.words + W.tileCol * 2 + 1);
  asm.ldn("b", VIEW_W + 1);
  asm.label(colLoop);
  asm.push("bc");
  if (level) {
    asm.call(tileAtLabel(level));
    emitLegendToTile(ctx, level);
  } else {
    asm.alu("xor", "a");
  }
  asm.ld("c", "a");
  asm.call("VramFor");
  asm.ld("a", "c");
  asm.ld("hlp", "a");
  emitIncWord(ctx, layout.words + W.tileCol * 2);
  asm.pop("bc");
  asm.dec("b");
  asm.jp(colLoop, "nz");
  emitIncWord(ctx, layout.words + W.tileRow * 2);
  asm.pop("bc");
  asm.dec("b");
  asm.jp(rowLoop, "nz");
  // The LCD comes back on with the picture already correct.
  asm.ldn("a", 0b10010011);
  asm.stha(R.LCDC & 0xff);
  void scene;
}

/** `A = the background tile for the legend index in A`. */
function emitLegendToTile(ctx: Ctx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.aluN("cp", GRID_EMPTY);
  asm.jp(empty, "z");
  asm.ld("e", "a");
  asm.ldn("d", 0);
  asm.ld16("hl", label(level.tileLabel));
  asm.addHL("de");
  asm.ld("a", "hlp");
  asm.jp(done);
  asm.label(empty);
  asm.alu("xor", "a");
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: Ctx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.lda(src);
    asm.ld("l", "a");
    asm.lda(src + 1);
    asm.ld("h", "a");
    for (let index = 0; index < 3; index += 1) {
      asm.shift("sra", "h");
      asm.shift("rr", "l");
    }
    asm.ld("a", "l");
    asm.sta(dst);
    asm.ld("a", "h");
    asm.sta(dst + 1);
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

function emitIncWord(ctx: Ctx, addr: number): void {
  const { asm } = ctx;
  asm.lda(addr);
  asm.ld("l", "a");
  asm.lda(addr + 1);
  asm.ld("h", "a");
  asm.inc16("hl");
  asm.ld("a", "l");
  asm.sta(addr);
  asm.ld("a", "h");
  asm.sta(addr + 1);
}

/**
 * Bring the tilemap up to date after the camera moved.
 *
 * The map wraps every 32 cells, so level column `c` always lives at map column
 * `c mod 32` and the hardware scroll registers do the rest. Crossing a cell
 * boundary therefore costs one column or one row of writes, not a screen — and
 * a jump too large to walk sets the full-redraw flag instead of silently
 * dropping cells off the end of the queue.
 */
function emitScrollUpdate(ctx: Ctx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  asm.jp(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge
 * as it goes. More than four cells in a tick is a teleport, not a scroll.
 */
function emitWalkAxis(
  ctx: Ctx,
  level: LevelData,
  origin: number,
  want: number,
  bail: string,
  isColumn: boolean,
): void {
  const { asm } = ctx;
  const loop = ctx.unique("walkLoop");
  const done = ctx.unique("walkDone");
  const forward = ctx.unique("walkFwd");
  const back = ctx.unique("walkBack");
  const guard = ctx.unique("walkGuard");

  asm.ldn("b", 5);
  asm.label(loop);
  asm.dec("b");
  asm.jp(bail, "z");
  // signed compare: want - origin
  asm.lda(want);
  asm.ld("e", "a");
  asm.lda(want + 1);
  asm.ld("d", "a");
  asm.lda(origin);
  asm.ld("l", "a");
  asm.lda(origin + 1);
  asm.ld("h", "a");
  asm.ld("a", "e");
  asm.alu("sub", "l");
  asm.ld("c", "a");
  asm.ld("a", "d");
  asm.alu("sbc", "h");
  asm.ld("d", "a");
  asm.alu("or", "c");
  asm.jp(done, "z");
  asm.ld("a", "d");
  asm.bit(7, "a");
  asm.jp(back, "nz");
  asm.label(forward);
  // Moving on: the origin advances and the far edge becomes visible.
  asm.inc16("hl");
  asm.ld("a", "l");
  asm.sta(origin);
  asm.ld("a", "h");
  asm.sta(origin + 1);
  asm.push("bc");
  emitPaintEdge(ctx, level, isColumn, isColumn ? VIEW_W : VIEW_H);
  asm.pop("bc");
  asm.jp(loop);
  asm.label(back);
  asm.dec16("hl");
  asm.ld("a", "l");
  asm.sta(origin);
  asm.ld("a", "h");
  asm.sta(origin + 1);
  asm.push("bc");
  emitPaintEdge(ctx, level, isColumn, 0);
  asm.pop("bc");
  asm.jp(loop);
  asm.label(guard);
  void guard;
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: Ctx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = isColumn ? VIEW_H + 1 : VIEW_W + 1;

  asm.lda(originAcross);
  asm.ld("l", "a");
  asm.lda(originAcross + 1);
  asm.ld("h", "a");
  if (offset !== 0) {
    asm.ld16("de", offset);
    asm.addHL("de");
  }
  asm.ld("a", "l");
  asm.sta(across);
  asm.ld("a", "h");
  asm.sta(across + 1);
  asm.lda(originAlong);
  asm.sta(along);
  asm.lda(originAlong + 1);
  asm.sta(along + 1);

  const loop = ctx.unique("paintLoop");
  asm.ldn("b", count);
  asm.label(loop);
  asm.push("bc");
  asm.call(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  asm.call("QueueCell");
  emitIncWord(ctx, along);
  asm.pop("bc");
  asm.dec("b");
  asm.jp(loop, "nz");
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(ctx: Ctx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  asm.lda(layout.plotPrevCount);
  asm.alu("or", "a");
  asm.jp(done, "z");
  asm.ld("b", "a");
  asm.ld16("hl", layout.plotPrev);
  asm.label(loop);
  asm.push("bc");
  asm.ldaHLI();
  asm.sta(layout.words + W.tileCol * 2);
  asm.ldaHLI();
  asm.sta(layout.words + W.tileCol * 2 + 1);
  asm.ldaHLI();
  asm.sta(layout.words + W.tileRow * 2);
  asm.ldaHLI();
  asm.sta(layout.words + W.tileRow * 2 + 1);
  asm.push("hl");
  if (level) {
    asm.call(tileAtLabel(level));
    emitLegendToTile(ctx, level);
  } else {
    asm.alu("xor", "a");
  }
  asm.call("QueueCell");
  asm.pop("hl");
  asm.pop("bc");
  asm.dec("b");
  asm.jp(loop, "nz");
  asm.label(done);
}

function emitSwapPlots(ctx: Ctx): void {
  const { asm, layout } = ctx;
  asm.lda(layout.plotCount);
  asm.sta(layout.plotPrevCount);
  asm.alu("or", "a");
  const done = ctx.unique("swapDone");
  asm.jp(done, "z");
  asm.ld("b", "a");
  asm.ld16("hl", layout.plot);
  asm.ld16("de", layout.plotPrev);
  const loop = ctx.unique("swapLoop");
  asm.label(loop);
  for (let index = 0; index < 4; index += 1) {
    asm.ldaHLI();
    asm.staDE();
    asm.inc16("de");
  }
  asm.dec("b");
  asm.jp(loop, "nz");
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(ctx: Ctx, scene: SceneCtx): void {
  const { asm, layout, program } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;

    const skip = ctx.unique("hudSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      isZero32(ctx, (layout.entities[id] as number) + propOffset("visible"));
      asm.jp(skip, "z");
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[id] as number;
    // The cell the object sits in; positions are level coordinates, so the
    // wrapped tilemap puts it in the right place with no extra work.
    asm.lda(base + propOffset("x") + 2);
    asm.sta(layout.words + W.tileCol * 2);
    asm.lda(base + propOffset("x") + 3);
    asm.sta(layout.words + W.tileCol * 2 + 1);
    asm.lda(base + propOffset("y") + 2);
    asm.sta(layout.words + W.tileRow * 2);
    asm.lda(base + propOffset("y") + 3);
    asm.sta(layout.words + W.tileRow * 2 + 1);

    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, 20)) {
        asm.ldn("a", glyphTile(character));
        asm.call("PlotCell");
      }
    } else {
      asm.ld16("hl", base + propOffset("value") + 2);
      asm.call("DrawNumber");
    }
    asm.label(skip);
  }
}

/** Build the OAM shadow from the scene's sprite objects. */
function emitOam(ctx: Ctx, scene: SceneCtx, options: EmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.alu("xor", "a");
  asm.sta(layout.oamCount);

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;
    const art = options.sprites?.get(asset);

    const skip = ctx.unique("oamSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      isZero32(ctx, (layout.entities[id] as number) + propOffset("visible"));
      asm.jp(skip, "z");
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[id] as number;
    // Screen pixels are level pixels minus the camera's.
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, base + propOffset("x"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera);
      emitPixelsFromFixed(ctx, temp, layout.words + W.temp * 2);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera + 4);
      emitPixelsFromFixed(ctx, temp, layout.words + W.count * 2);
    });

    // The collision box is the sprite's footprint, in whole cells.
    const cells = (prop: string): number =>
      Math.max(1, Math.round((instance.numbers[prop] ?? 0) / 65536));
    const width = art?.width ?? cells("width");
    const height = art?.height ?? cells("height");
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * width + column : OBJECT_TILE;
        asm.lda(layout.words + W.count * 2);
        asm.aluN("add", row * 8 + 16);
        asm.ld("b", "a");
        asm.lda(layout.words + W.temp * 2);
        asm.aluN("add", column * 8 + 8);
        asm.ld("c", "a");
        asm.ldn("d", tile);
        asm.call("PushSprite");
      }
    }
    asm.label(skip);
  }
  asm.call("ClearRestOfOam");
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: Ctx): void {
  const { asm, layout } = ctx;

  // HL = the VRAM address for the cell in words[tileCol]/words[tileRow].
  asm.label("VramFor");
  asm.lda(layout.words + W.tileRow * 2);
  asm.aluN("and", 31);
  asm.ld("l", "a");
  asm.ldn("h", 0);
  for (let index = 0; index < 5; index += 1) asm.addHL("hl");
  asm.lda(layout.words + W.tileCol * 2);
  asm.aluN("and", 31);
  asm.ld("e", "a");
  asm.ldn("d", 0);
  asm.addHL("de");
  asm.ld16("de", VRAM_MAP);
  asm.addHL("de");
  asm.ret();

  // A = tile; queue it at the current cell.
  asm.label("QueueCell");
  asm.ld("c", "a");
  asm.lda(layout.queueCount);
  asm.aluN("cp", QUEUE_MAX);
  asm.ret("nc");
  asm.push("bc");
  asm.call("VramFor");
  asm.pop("bc");
  asm.ld("d", "h");
  asm.ld("e", "l");
  asm.lda(layout.queueCount);
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.push("de");
  asm.ld("d", "h");
  asm.ld("e", "l");
  asm.addHL("hl");
  asm.addHL("de");
  asm.ld16("de", layout.queue);
  asm.addHL("de");
  asm.pop("de");
  asm.ld("a", "e");
  asm.staHLI();
  asm.ld("a", "d");
  asm.staHLI();
  asm.ld("a", "c");
  asm.staHLI();
  asm.lda(layout.queueCount);
  asm.inc("a");
  asm.sta(layout.queueCount);
  asm.ret();

  // A = tile; queue it, record the cell for erasing, and advance the column.
  asm.label("PlotCell");
  asm.push("af");
  asm.call("QueueCell");
  asm.pop("af");
  asm.lda(layout.plotCount);
  asm.aluN("cp", PLOT_MAX);
  const noRoom = ctx.unique("plotFull");
  asm.jp(noRoom, "nc");
  asm.ld("l", "a");
  asm.ldn("h", 0);
  asm.addHL("hl");
  asm.addHL("hl");
  asm.ld16("de", layout.plot);
  asm.addHL("de");
  asm.lda(layout.words + W.tileCol * 2);
  asm.staHLI();
  asm.lda(layout.words + W.tileCol * 2 + 1);
  asm.staHLI();
  asm.lda(layout.words + W.tileRow * 2);
  asm.staHLI();
  asm.lda(layout.words + W.tileRow * 2 + 1);
  asm.staHLI();
  asm.lda(layout.plotCount);
  asm.inc("a");
  asm.sta(layout.plotCount);
  asm.label(noRoom);
  emitIncWord(ctx, layout.words + W.tileCol * 2);
  asm.ret();

  // B = y, C = x, D = tile; append an OAM entry.
  // B = y, C = x, D = tile. **D has to survive**, which is why the address is
  // built from the shadow's page rather than with `ld de, OAM_SHADOW` — that
  // form overwrites the tile number with the address's high byte, and the cost
  // is forty objects all drawing whatever tile happens to live at $C0.
  asm.label("PushSprite");
  asm.lda(layout.oamCount);
  asm.aluN("cp", 40);
  asm.ret("nc");
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld("l", "a");
  asm.ldn("h", OAM_SHADOW >> 8);
  asm.ld("a", "b");
  asm.staHLI();
  asm.ld("a", "c");
  asm.staHLI();
  asm.ld("a", "d");
  asm.staHLI();
  asm.alu("xor", "a");
  asm.staHLI();
  asm.lda(layout.oamCount);
  asm.inc("a");
  asm.sta(layout.oamCount);
  asm.ret();

  // Park the entries that are no longer in use. Only the ones *this* frame
  // vacated need clearing: everything above last frame's high-water mark is
  // already parked, and sweeping all forty of them every frame was costing more
  // than the sprites themselves.
  asm.label("ClearRestOfOam");
  asm.lda(layout.oamPrev);
  asm.ld("b", "a");
  asm.lda(layout.oamCount);
  asm.sta(layout.oamPrev);
  asm.alu("cp", "b");
  asm.ret("nc");
  asm.ld("c", "a");
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld("l", "a");
  asm.ldn("h", OAM_SHADOW >> 8);
  asm.ld("a", "b");
  asm.alu("sub", "c");
  asm.ld("b", "a");
  const clear = ctx.unique("oamClear");
  asm.label(clear);
  asm.alu("xor", "a");
  asm.staHLI();
  asm.staHLI();
  asm.staHLI();
  asm.staHLI();
  asm.dec("b");
  asm.jp(clear, "nz");
  asm.ret();

  // Flush the queue and hand OAM to the DMA. Both fit inside VBlank by
  // construction: the queue is capped and anything over spills to next frame.
  asm.label("UploadFrame");
  asm.lda(layout.words + W.scrollX * 2);
  asm.stha(R.SCX & 0xff);
  asm.lda(layout.words + W.scrollY * 2);
  asm.stha(R.SCY & 0xff);
  asm.lda(layout.queueCount);
  asm.alu("or", "a");
  const noQueue = ctx.unique("noQueue");
  asm.jp(noQueue, "z");
  asm.ld("b", "a");
  asm.ld16("hl", layout.queue);
  const flush = ctx.unique("flushLoop");
  asm.label(flush);
  asm.ldaHLI();
  asm.ld("e", "a");
  asm.ldaHLI();
  asm.ld("d", "a");
  asm.ldaHLI();
  asm.staDE();
  asm.dec("b");
  asm.jp(flush, "nz");
  asm.alu("xor", "a");
  asm.sta(layout.queueCount);
  asm.label(noQueue);
  asm.call(HRAM_DMA);
  asm.ret();

  // HL points at the low byte of a value's whole part; draw it in decimal.
  asm.label("DrawNumber");
  asm.ldaHLI();
  asm.ld("e", "a");
  asm.ld("a", "hlp");
  asm.ld("d", "a");
  const negative = ctx.unique("numNeg");
  const positive = ctx.unique("numPos");
  asm.bit(7, "d");
  asm.jp(positive, "z");
  asm.label(negative);
  asm.ld("a", "d");
  asm.cpl();
  asm.ld("d", "a");
  asm.ld("a", "e");
  asm.cpl();
  asm.ld("e", "a");
  asm.inc16("de");
  asm.push("de");
  asm.ldn("a", glyphTile("-"));
  asm.call("PlotCell");
  asm.pop("de");
  asm.label(positive);
  asm.ld16("hl", label("DecimalPowers"));
  asm.ldn("c", 5);
  asm.alu("xor", "a");
  asm.sta(layout.words + W.temp * 2);
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const digitDone = ctx.unique("numDigit");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");
  asm.label(powerLoop);
  asm.ldaHLI();
  asm.ld("b", "a");
  asm.ld("a", "hlp");
  asm.inc16("hl");
  asm.push("hl");
  asm.ld("h", "a");
  asm.ld("l", "b");
  asm.ldn("b", 0);
  asm.label(subLoop);
  asm.ld("a", "e");
  asm.alu("sub", "l");
  asm.ld("a", "d");
  asm.alu("sbc", "h");
  asm.jp(digitDone, "c");
  asm.ld("a", "e");
  asm.alu("sub", "l");
  asm.ld("e", "a");
  asm.ld("a", "d");
  asm.alu("sbc", "h");
  asm.ld("d", "a");
  asm.inc("b");
  asm.jp(subLoop);
  asm.label(digitDone);
  asm.ld("a", "b");
  asm.alu("or", "a");
  asm.jp(emitDigit, "nz");
  asm.lda(layout.words + W.temp * 2);
  asm.alu("or", "a");
  asm.jp(emitDigit, "nz");
  asm.ld("a", "c");
  asm.dec("a");
  asm.jp(skipDigit, "nz");
  asm.label(emitDigit);
  asm.ldn("a", 1);
  asm.sta(layout.words + W.temp * 2);
  asm.ld("a", "b");
  asm.aluN("add", glyphTile("0"));
  asm.push("bc");
  asm.push("de");
  asm.call("PlotCell");
  asm.pop("de");
  asm.pop("bc");
  asm.label(skipDigit);
  asm.pop("hl");
  asm.dec("c");
  asm.jp(powerLoop, "nz");
  asm.ret();

  asm.label("DecimalPowers");
  asm.dw(10000);
  asm.dw(1000);
  asm.dw(100);
  asm.dw(10);
  asm.dw(1);
}

// --- data --------------------------------------------------------------------

function emitInstanceDefaults(ctx: Ctx): void {
  const { asm, program } = ctx;
  for (const instance of program.instances) {
    asm.label(`Defaults_${instance.id}`);
    for (const prop of PROPS) asm.dd(instance.numbers[prop] ?? 0);
  }
}
