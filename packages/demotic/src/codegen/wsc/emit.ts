/**
 * The whole-program emitter for the WonderSwan Color: boot, the frame, the
 * renderer.
 *
 * Everything here is per *scene*, for the reason every other backend gives: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and five differences are load-bearing —
 * four of which are things the other consoles need and this one does not.
 *
 *   - **There is no video memory.** The screen maps, the tile bank, the object
 *     table and palette RAM are addresses in the same 64 KiB the game's
 *     variables are in, so writing a cell is one store and the boot "upload" is
 *     a block copy out of the cartridge. No port is involved anywhere in the
 *     renderer, which is why this file has no counterpart to the Sega's
 *     two-write control port and none of its interrupt hazard.
 *   - **The HUD gets a plane of its own.** `SCR2` scrolls independently of
 *     `SCR1` and draws in front of it, so a caption's cell is `floor(pos) −
 *     floor(camera)` whether the scene scrolls or not. The sprite HUD every
 *     8-bit console needs for a scrolling scene, the second decimal renderer
 *     that drives it and the whole pixel-pinning argument are absent rather than
 *     reimplemented — the Game Boy Advance's arrangement, on a tenth of the
 *     hardware.
 *   - **A cell carries its own palette**, four bits of the map word, so there is
 *     no attribute table and no 16×16 block. The two bytes of a map entry are
 *     exactly the low and high halves of that word, which is why the level's
 *     tile and attribute tables are those two bytes and nothing has to be
 *     assembled at run time.
 *   - **The map is 32×32 against a 28×18 window**, so a scrolling scene paints
 *     its leading edge where nobody is looking and *both* wraps are powers of
 *     two. Neither the NES's row pinning nor the Master System's seam mask
 *     exists here, and the vertical scroll register is a byte like the
 *     horizontal one because the map is 256 pixels on both axes.
 *   - **The loop watches the beam.** This console's interrupt controller vectors
 *     through the processor's own table in the first kilobyte of RAM, and a main
 *     loop that waits either way gains nothing from it — the Nintendo DS's
 *     reasoning. So there is no handler, no frame flag, and the wait is two
 *     phases of reading the line counter.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 */

import { AUDIO_STOP, type WscGameAudio } from "@demake/audio";
import { AsmError, label, type Ref } from "@demake/core";

import type { InstanceDef, Program, RuleDef } from "../../program.js";
import { glyphTile, OBJECT_TILE, patternTile } from "../../rom/graphics.js";
import { isMutable } from "../analyze.js";
import { emitTickSteps, type TickSteps } from "../backend.js";
import { PROPS, TILE_CONTACT_MAX, W } from "../layout.js";
import {
  artKey,
  emitInstanceDefaults,
  fixedCells,
  hudIsStatic,
  instanceCells,
  sceneContexts,
  sceneIndexOf,
  sideMask,
  tileCellsCacheable,
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { WscCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { abs, at, romAbs, romAt } from "./ops.js";
import {
  emitAssignments,
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
  emitSound,
} from "./rules.js";
import { S } from "./scratch.js";
import {
  collectLevels,
  copy16,
  dec16,
  emitLevelData,
  emitRuleTileTable,
  levelCopy,
  emitTileAt,
  emitTileSeparate,
  emitTileSide,
  emitTilesUnder,
  GRID_EMPTY,
  inc16,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "./tiles.js";
import { branchZero32, copy32, mem, sub32 } from "./val.js";

/** The display controller's ports, by number. */
const PORT = {
  /** Which layers are drawn. */
  DISP_CTRL: 0x00,
  /** The colour behind everything, as `palette << 4 | index`. */
  BACK_COLOR: 0x01,
  /** The line being drawn — how a cartridge with no interrupt waits. */
  LINE_CUR: 0x02,
  /** The object table's address, in units of 512 bytes. */
  SPR_BASE: 0x04,
  SPR_FIRST: 0x05,
  SPR_COUNT: 0x06,
  /** Both screen maps' addresses, a nibble each, in units of 2 KiB. */
  MAP_BASE: 0x07,
  SCR1_X: 0x10,
  SCR1_Y: 0x11,
  SCR2_X: 0x12,
  SCR2_Y: 0x13,
  LCD_CTRL: 0x14,
  /** Colour mode, tile depth and tile layout. */
  DISP_MODE: 0x60,
  /** The keypad: write a group select, read the four keys it multiplexes. */
  KEYPAD: 0xb5,
} as const;

/** Cells each screen map holds, on both axes. */
export const MAP_W = 32;
export const MAP_H = 32;

/** Tiles the bank holds. A map entry has nine bits of tile; an object has nine too. */
export const BANK_TILES = 512;

/** Sub-palettes background art may use — the sixteenth of the low half is the font's. */
export const ART_PALETTES = 7;

/**
 * The palettes the font, the level patterns and the placeholder block draw in.
 *
 * The split is the Game Boy Color's and it is forced by the hardware rather than
 * chosen: an object's palette field is three bits and selects among palettes
 * 8–15, so the background half and the object half cannot share one. Background
 * art gets 0–6 with 7 for the font; objects get 8–14 with 15 for theirs.
 */
export const SYSTEM_PALETTE = 7;
export const SYSTEM_OBJECT_PALETTE = 15;

/** Sub-palettes an object fit may use. */
export const OBJECT_PALETTES = 7;

/** One map entry, as the two bytes the hardware reads. */
export function mapWord(tile: number, palette: number): number {
  return (tile & 0x1ff) | ((palette & 0x0f) << 9);
}

/** Everything the emitter needs beyond the program itself. */
export interface WscEmitOptions {
  /**
   * Measure a segmented build without placing it.
   *
   * The measuring pass: the same instructions a segmented one emits, laid end to
   * end, so `wsc.ts` can read each scene's length off and plan the segments from
   * numbers rather than an estimate.
   */
  split?: boolean;
  /**
   * Where each scene goes, for a game that outgrew one segment.
   *
   * Absent for a game that fits, and then this emitter does exactly what it
   * always did — one segment, near calls, and a cartridge byte-identical to the
   * one it built before this existed.
   */
  segments?: WsSegmentPlan;
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette: number }>;
  /** Demade backdrops by scene name: the map the picture fills, packed. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The 4bpp tile bank, copied into RAM at boot. */
  bank?: Uint8Array;
  /** Palette RAM as the art chose it: sixteen palettes of sixteen RGB444 words. */
  palette?: Uint8Array;
  /** Per-scene palette RAM, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
  /** Which sub-palette a level's tile art was fitted into. */
  levelPalette?: number;
  /**
   * The game's audio driver, already built from its demade tracks and effects.
   *
   * Absent for a game with no audio, and then the cartridge is exactly what it
   * was before sound existed — no tally read in the loop, no service call, no
   * driver. Pulled in by a game that asks for it, like everything else.
   */
  audio?: WscGameAudio;
  /** Driver index of each of the program's sounds, or `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Which track each scene plays, as an index into the driver's table. */
  sceneTracks?: readonly number[];
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: WscCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    ctx.jump(labels[0] as string);
    return;
  }
  asm.movm8("al", abs(layout.scene));
  for (const [index, target] of labels.entries()) {
    if (index === labels.length - 1) {
      ctx.jump(target);
      break;
    }
    asm.aluI8("cmp", "al", index);
    if (!ctx.banked) {
      ctx.far("z", target);
      continue;
    }
    // Spread across segments the transfer is five bytes rather than three, so
    // the condition is inverted over it and the comparison's own result is
    // reloaded — `jump` leaves nothing, but the next test needs `al` again.
    const over = ctx.unique("dispatch");
    asm.jcc("nz", over);
    ctx.jump(target);
    asm.label(over);
    asm.movm8("al", abs(layout.scene));
  }
}

/**
 * Every routine a segmented build places, in the order it emits them.
 *
 * A whole *scene* here, not a step of one: a segment is sixty-four kilobytes and
 * the library's largest scene is twenty-two, so this console takes the Super
 * Nintendo's unit rather than the Sega's. What a scene is, is its tick, its
 * reset, its camera and its render — the four routines the dispatches reach.
 */
export function sceneUnits(scenes: readonly SceneCtx[]): string[][] {
  return scenes.map((scene) => [
    `SceneTick_${scene.index}`,
    `SceneReset_${scene.index}`,
    `SceneCamera_${scene.index}`,
    `SceneRender_${scene.index}`,
  ]);
}

/** What a pass over the program measured. */
export interface EmittedWsProgram {
  /** How long each scene's four routines came out, by scene index. */
  scenes: readonly number[];
  /** How long one segment's copy of the shared tables came out. */
  data: number;
  /** Bytes the fixed half took: everything that is not a scene. */
  fixed: number;
}

/** Which segment each scene's routines go in. */
export interface WsSegmentPlan {
  /** The scene indices in each paged segment, in the order they are emitted. */
  segments: readonly (readonly number[])[];
  /** Which segment each scene landed in, by scene index. */
  segmentOf: ReadonlyMap<number, number>;
}

/**
 * Emit the whole program, and report what a segment plan would need to know.
 *
 * With no plan and no split this is exactly the emitter it always was: one
 * segment, near calls, and the same bytes.
 */
export function emitProgram(ctx: WscCtx, options: WscEmitOptions = {}): EmittedWsProgram {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  /**
   * One scene's four routines, wherever they are being put.
   *
   * The level they are handed is the copy in *their* segment: this code reads a
   * grid and a legend with a `cs:` override, so a scene in segment `$E` given the
   * shared tables would read whatever is at those offsets in `$E`
   * (§emitSegmentData). It reads them rather than crashing, which is a tile walk
   * that never terminates.
   */
  const emitScene = (scene: SceneCtx): void => {
    const shared = levelFor.get(scene.index);
    const level = shared ? levelCopy(shared, ctx.dataSuffix) : undefined;
    emitSceneTick(ctx, scene, level);
    emitSceneReset(ctx, scene);
    emitSceneCamera(ctx, scene);
    emitSceneRender(ctx, scene, level, options);
  };

  const plan = options.segments;
  const split = options.split === true || plan !== undefined;
  const sceneBytes: number[] = scenes.map(() => 0);
  let dataBytes = 0;
  if (split) {
    // The paged segments first, and the fixed half last — helpers are *pulled*
    // by whatever calls them, so `ctx.finish()` has to be the last thing that
    // runs and everything it emits belongs in the segment that never moves.
    const groups = plan
      ? plan.segments.map((indices) => [...indices])
      : [scenes.map((scene) => scene.index)];
    for (const [at, indices] of groups.entries()) {
      // A segment register counts sixteen-byte paragraphs, so the segment below
      // `$E000` is `$D000` rather than `$DFFF`: one 64 KiB bank is `$1000` of
      // them. Off by that and a dispatch jumps sixteen bytes into the right bank.
      const segment = PAGED_SEGMENT - at * SEGMENT_STEP;
      const suffix = segmentSuffix(segment);
      asm.section(segment);
      ctx.dataSuffix = suffix;
      const start = asm.length;
      for (const index of indices) {
        const before = asm.length;
        emitScene(scenes[index] as SceneCtx);
        sceneBytes[index] = asm.length - before;
      }
      const beforeData = asm.length;
      emitSegmentData(ctx, options, scenes, levels, suffix);
      dataBytes = asm.length - beforeData;
      // Only a *planned* pass is placing anything: the measuring one lays every
      // scene end to end on purpose, so its length is a measurement rather than
      // an overflow.
      if (plan) {
        const used = asm.length - start;
        if (used > WS_SEGMENT_SIZE) {
          throw new AsmError(`a segment holds ${used} bytes of a possible ${WS_SEGMENT_SIZE}`);
        }
        asm.ds(WS_SEGMENT_SIZE - used, 0xff);
      }
    }
    ctx.dataSuffix = "";
    asm.section(ctx.homeSegment);
  }

  emitReset(ctx, options);
  emitMainLoop(ctx, options.audio !== undefined);
  emitInput(ctx);
  emitTickDispatch(ctx, scenes);
  emitSceneChange(ctx, scenes, program);

  if (!split) for (const scene of scenes) emitScene(scene);

  emitRenderHelpers(ctx);
  emitTileContactHelper(ctx);
  if (options.audio) options.audio.emitCode(asm);
  ctx.finish();

  // The data a *paged* segment's own code reads, once per segment (§emitSegmentData).
  emitSegmentData(ctx, options, scenes, levels, "");

  // And the data only the fixed half reads: the boot uploads the tile bank, the
  // scene change reads the track table, and the driver walks the schedules.
  if (options.audio) {
    if (program.tracks.length > 0) {
      asm.label("SceneTracks");
      // One byte per scene: the request value that starts its track, or the one
      // that stops the music. A table rather than a dispatch because a scene
      // change already costs a redraw, and this is the cheapest thing in it.
      for (const scene of scenes) {
        const track = options.sceneTracks?.[scene.index] ?? -1;
        asm.db(track < 0 ? AUDIO_STOP : track + 1);
      }
    }
    options.audio.emitData(asm);
  }

  asm.label("TileBank");
  asm.bytes(options.bank ?? new Uint8Array(0));
  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette());

  // What the fixed half took is everything the paged segments did not, and a
  // planned pass pads each of those out to a whole segment.
  const paged = plan
    ? plan.segments.length * WS_SEGMENT_SIZE
    : split
      ? sceneBytes.reduce((sum, bytes) => sum + bytes, 0) + dataBytes
      : 0;
  return { scenes: sceneBytes, data: dataBytes, fixed: asm.length - paged };
}

/** The segment a paged build's first extra segment is, counting down from home. */
export const PAGED_SEGMENT = 0xe000;

/** What one 64 KiB bank is worth in a segment register: paragraphs, not bytes. */
export const SEGMENT_STEP = 0x1000;

/** Bytes a segment addresses, which is what one holds. */
export const WS_SEGMENT_SIZE = 0x10000;

/** What one segment's copy of the shared tables is called. */
export function segmentSuffix(segment: number): string {
  return `_s${(segment >> 12).toString(16)}`;
}

/**
 * The tables a segment's own code reads, under names of that segment's own.
 *
 * Emitted once in the fixed half and once more in every paged segment, because
 * on this machine a cartridge table is read with a `cs:` override and a block
 * copy takes `DS` from `CS` — so a routine in segment `$E` reads the copy in
 * segment `$E` or nothing. That is the NES's duplication reached by completely
 * different hardware (doc 13 §Banked cartridges), and it is why `suffix` runs
 * through `levelCopy`, `emitInstanceDefaults` and `ctx.dataSuffix` alike.
 *
 * What is *not* here is the tile bank, the game's fallback palette, the scene
 * track table and the packed audio schedules: every one of those is read by code
 * in the fixed half — the boot, the scene change, the audio driver — so a second
 * copy would be bytes nothing can reach.
 */
function emitSegmentData(
  ctx: WscCtx,
  options: WscEmitOptions,
  scenes: readonly SceneCtx[],
  levels: readonly LevelData[],
  suffix: string,
): void {
  const { asm, program } = ctx;
  // First, because that is where `CtxBase.finish` used to put them and the order
  // of this section is output bytes.
  ctx.emitConstants(suffix);
  for (const shared of levels) {
    const level = levelCopy(shared, suffix);
    const boundTile = (index: number): { tile: number; palette: number } => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern, in the font's
      // palette — which is where every built-in tile's colours are.
      if (bound) return bound;
      return {
        tile: patternTile(index, level.file.tiles[index]?.solid ?? false),
        palette: SYSTEM_PALETTE,
      };
    };
    // The two tables the shared emitter writes are exactly the low and high
    // bytes of a map word, which is what makes a cell one store rather than an
    // assembly of fields.
    emitLevelData(
      asm,
      level,
      (index) => mapWord(boundTile(index).tile, boundTile(index).palette) & 0xff,
      (index) => (mapWord(boundTile(index).tile, boundTile(index).palette) >> 8) & 0xff,
    );
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
      }
    }
  }
  emitInstanceDefaults(asm, program, PROPS, ctx.layout.entitySizes, {
    ids: program.instances.map((instance) => instance.id),
    label: (id) => `Defaults_${id}${suffix}`,
  });

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    // A backdrop is the one table on this console that a *paged* segment does
    // not carry, and the reason is who reads it: `BlitBackdrop` is a pulled
    // helper and helpers live in the fixed half, so its `cs:` means the fixed
    // segment however the scene that called it got there. A copy in the scene's
    // own segment is one the helper cannot reach — it read the fixed segment at
    // the paged copy's offset, which is padding on a cartridge, and unpacked
    // `$FF` runs over the stack until the return address was gone.
    //
    // So the rule this file already runs under is unchanged and only its
    // application moves: a table goes in the segment of the code that reads it,
    // and this one's reader is not the scene (§emitSegmentData).
    if (art && suffix === "") {
      // Already packed: `wsc-art.ts` encodes the map as it interns the tiles,
      // exactly as the PC Engine's does, because the pool is what decides a
      // cell's number. Packing it a second time here encodes the *stream* as a
      // run of literal cells, which is a title screen that boots as its own
      // compression format.
      asm.label(backdropLabel(scene));
      asm.bytes(art.map);
    }
    const palette = options.scenePalettes?.get(scene.def.name);
    if (palette) {
      asm.label(scenePaletteLabel(scene, suffix));
      asm.bytes(palette);
    }
  }
  // The fallback palette is read by a scene with no picture, which is a *paged*
  // renderer — so a paged segment needs its own. The fixed half's stays at the
  // end of the program, where it has always been.
  if (suffix !== "") {
    asm.label(`Palette${suffix}`);
    asm.bytes(options.palette ?? defaultPalette());
  }
}

/**
 * The palette RAM a build with no demade art uses.
 *
 * Every palette is the font's ramp, so a caption and a placeholder block are
 * legible with nothing else copied in: transparent, then three rising greys in
 * the entries the built-in tiles were re-indexed onto.
 */
function defaultPalette(): Uint8Array {
  const bytes = new Uint8Array(16 * 16 * 2);
  const greys = [0x5, 0xa, 0xf];
  for (let palette = 0; palette < 16; palette += 1) {
    for (const [shade, level] of greys.entries()) {
      const at2 = (palette * 16 + (13 + shade)) * 2;
      bytes[at2] = (level << 4) | level;
      bytes[at2 + 1] = level;
    }
  }
  return bytes;
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: WscCtx, options: WscEmitOptions): void {
  const { asm, layout, program, machine } = ctx;
  const RAM = machine.ram;

  asm.label("Boot");
  asm.cli();
  asm.cld();
  // The processor arrives here through the far jump at the top of the bank with
  // nothing set up at all: the segments and the stack are the program's own
  // first job.
  //
  // `DS` and `ES` are **the heap**, which on almost every build is segment zero
  // along with everything else — so all three registers point there and no
  // instruction in the runtime carries a prefix except the ones that read the
  // cartridge's own tables. On a game the console's own memory cannot hold they
  // are the cartridge's save RAM instead, and `SS` is what still means the
  // console: the stack, and the six operands the display decodes (§emitReset's
  // `ctx.vram`).
  if (ctx.saved) {
    asm.movi("ax", ctx.heapSegment);
    asm.movsr("ds", "ax");
    asm.movsr("es", "ax");
    asm.movi("ax", 0);
    asm.movsr("ss", "ax");
  } else {
    asm.movi("ax", 0);
    asm.movsr("ds", "ax");
    asm.movsr("es", "ax");
    asm.movsr("ss", "ax");
  }
  asm.movi("sp", machine.stackTop);

  // Clear everything from the heap to the top of the object table, so a game's
  // state starts from zero rather than from whatever powered up — the screen
  // maps and the object shadow included, since both are read by the display and
  // neither is behind a port.
  //
  // Two runs where the heap is elsewhere, because they are then two memories:
  // the display's structures in the console's, and the bytes the allocator
  // handed out in the cartridge's. Only those bytes — a save RAM is up to
  // sixty-four kilobytes and clearing all of it would be most of a second on
  // hardware, for a region nothing has ever read.
  if (ctx.saved) {
    ctx.toInternal(() => {
      asm.movi("di", RAM.SHADOW);
      asm.movi("cx", (RAM.TILES - RAM.SHADOW) / 2);
      asm.movi("ax", 0);
      asm.rep().stosw();
    });
    asm.movi("di", layout.memory.heapStart);
    asm.movi("cx", (layout.used + 1) >> 1);
    asm.movi("ax", 0);
    asm.rep().stosw();
  } else {
    asm.movi("di", layout.memory.heapStart);
    asm.movi("cx", (RAM.TILES - layout.memory.heapStart) / 2);
    asm.movi("ax", 0);
    asm.rep().stosw();
  }

  // Colour mode, sixteen colours a tile, packed 4bpp: chosen first, so that the
  // tiles copied in below are decoded in the layout they were emitted in. The
  // mono machine has one arrangement and no register to say so.
  if (machine.dispMode !== undefined) emitPort(ctx, PORT.DISP_MODE, machine.dispMode);
  emitPort(ctx, PORT.MAP_BASE, (RAM.SCR1 >> 11) | ((RAM.SCR2 >> 11) << 4));
  emitPort(ctx, PORT.SPR_BASE, RAM.OAM >> 9);
  emitPort(ctx, PORT.SPR_FIRST, 0);
  emitPort(ctx, PORT.SPR_COUNT, 0);
  emitPort(ctx, PORT.BACK_COLOR, 0);
  emitPort(ctx, PORT.SCR1_X, 0);
  emitPort(ctx, PORT.SCR1_Y, 0);
  // The HUD plane never moves again. That one fact is what makes a caption's
  // cell exact on a scrolling scene, where every 8-bit console in the set has to
  // draw the same caption with hardware sprites.
  emitPort(ctx, PORT.SCR2_X, 0);
  emitPort(ctx, PORT.SCR2_Y, 0);

  emitRomCopy(ctx, label("TileBank"), RAM.TILES, options.bank?.length ?? 0, "console");
  emitPaletteBlock(ctx, label("Palette"));

  // Every entity starts from its declared values, not just the entry scene's: a
  // rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    emitRomCopy(
      ctx,
      label(`Defaults_${instance.id}`),
      layout.entities[instance.id] as number,
      layout.entitySizes[instance.id] as number,
      "heap",
    );
  }

  for (const address of [
    layout.tick,
    layout.tick + 1,
    layout.ready,
    layout.booted,
    layout.held,
    layout.pressed,
    layout.released,
    layout.plotCount,
    layout.plotPrevCount,
    layout.queueCount,
    layout.oamCount,
  ]) {
    asm.movmi8(abs(address), 0);
  }
  asm.movmi8(abs(layout.oamPrev), 0);
  asm.movmi8(abs(layout.pending), 0xff);
  asm.movmi8(abs(layout.scene), sceneIndexOf(program, program.entryScene));
  asm.movmi8(abs(layout.redraw), 1);
  emitClearState(ctx);
  emitSeedRng(ctx);

  ctx.call("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    for (let index = 0; index < 8; index += 2) asm.movmi(abs(layout.camera + index), 0);
  }
  ctx.call("BuildFrame");
  ctx.call("UploadFrame");

  if (options.audio) {
    ctx.callNear("AudioInit");
    if (program.tracks.length > 0) ctx.call("SceneMusic");
  }

  // The screen comes on last, so nothing above it was ever visible.
  emitPort(ctx, PORT.LCD_CTRL, 0x01);
  emitPort(ctx, PORT.DISP_CTRL, 0x07);
  asm.movmi8(abs(layout.booted), 1);
  asm.jmp("Main");
}

/** Write a compile-time byte to a port. */
function emitPort(ctx: WscCtx, port: number, value: number): void {
  ctx.asm.movi8("al", value);
  ctx.asm.out8(port);
}

/**
 * Copy a run of cartridge bytes into RAM.
 *
 * `movs` reads `DS:SI` and writes `ES:DI`, and everything a game addresses is in
 * segment zero — so the data segment is pointed at the cartridge for the length
 * of the copy and put back. Doing it with a `cs:` prefix on the string operation
 * instead would work on this processor and not on an 8086, whose interrupt
 * handling loses one of two prefixes; this way the question does not arise.
 */
function emitRomCopy(
  ctx: WscCtx,
  source: Ref,
  dest: number,
  count: number,
  into: "console" | "heap",
): void {
  const { asm } = ctx;
  if (count === 0) return;
  const copy = (): void => {
    asm.movrs("ax", "cs");
    asm.movsr("ds", "ax");
    asm.movi("si", source);
    asm.movi("di", dest);
    asm.movi("cx", (count + 1) >> 1);
    asm.rep().movsw();
    asm.movi("ax", ctx.heapSegment);
    asm.movsr("ds", "ax");
  };
  // `movs` writes `ES:DI`, so the caller has to say which memory it means — and
  // this routine has both kinds of caller. The tile bank and palette RAM are
  // addresses the display decodes and are always the console's own; an entity's
  // declared values go into the *heap*, which on a game too big for that memory
  // is the cartridge's save RAM. Bracketing both put every object in the game at
  // the right offset of the wrong segment, which boots, runs, and plays a game
  // whose every entity is zero.
  if (into === "heap") copy();
  else ctx.toInternal(copy);
}

/**
 * Put a scene's palette block where this machine keeps its palettes.
 *
 * The one place the two WonderSwans' renderers genuinely part company, and they
 * part company about the *destination* rather than about the bytes: on the
 * colour machine palettes are five hundred and twelve bytes of RAM at `$FE00`,
 * so the block is a copy; on the mono machine they are thirty-six consecutive
 * ports — four for the shade pool and thirty-two for the palettes — so the block
 * is a run of `out`s. Nothing on that bus a `movs` could reach, which is why the
 * mono path is a loop rather than a shorter copy.
 */
function emitPaletteBlock(ctx: WscCtx, source: Ref): void {
  const { asm, machine } = ctx;
  if ("ram" in machine.palette) {
    emitRomCopy(ctx, source, machine.palette.ram, machine.palette.bytes, "console");
    return;
  }
  // `outsb` would be one instruction, but it reads `DS:SI` — so the data segment
  // would have to point at the cartridge anyway, and a byte at a time through
  // `al` costs two instructions and leaves the segment alone.
  const loop = ctx.unique("palette");
  asm.movi("si", source);
  asm.movi("dx", machine.palette.port);
  asm.movi("cx", machine.palette.bytes);
  asm.label(loop);
  asm.movm8("al", romAt("si"));
  asm.inc("si");
  asm.outDx8();
  asm.inc("dx");
  asm.loop(loop);
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: WscCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  const seed = program.seed | 0;
  asm.movmi(abs(layout.rng), seed & 0xffff);
  asm.movmi(abs(layout.rng + 2), (seed >>> 16) & 0xffff);
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.movmi8(abs(layout.contacts + index), 0);
    asm.movmi8(abs(layout.contactsPrev + index), 0);
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) asm.movmi8(abs(layout.holdFlags + index), 0);
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) asm.movmi8(abs(layout.reachFlags + index), 0);
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.movmi8(abs(layout.tileContacts + index * layout.tileContactStride), 0);
    }
  }
}

/**
 * The frame, waited for in two phases.
 *
 * There is no interrupt in this cartridge and no flag: the loop reads the line
 * counter until the picture is being drawn and then until it is not, which is
 * one frame however long the tick before it took. Two phases rather than one
 * because a tick that finished *inside* the blanking interval would otherwise
 * see it still set and run twice on one frame.
 */
function emitMainLoop(ctx: WscCtx, audio: boolean): void {
  const { asm } = ctx;
  const active = ctx.unique("waitActive");
  const blank = ctx.unique("waitBlank");
  asm.label("Main");
  asm.label(active);
  asm.in8(PORT.LINE_CUR);
  asm.aluI8("cmp", "al", ctx.layout.memory.viewH * 8);
  ctx.far("nb", active);
  asm.label(blank);
  asm.in8(PORT.LINE_CUR);
  asm.aluI8("cmp", "al", ctx.layout.memory.viewH * 8);
  ctx.far("b", blank);
  ctx.call("UploadFrame");
  if (audio) {
    // The frame the loop just waited for, counted before anything else spends
    // it. `AudioFrame` reads the vertical-blank timer's counter rather than
    // being told, so a frame the game overran is owed rather than lost — and
    // `AudioService` performs what is owed *outside* the blanking interval,
    // which belongs to the picture.
    ctx.callNear("AudioFrame");
    ctx.callNear("AudioService");
  }
  ctx.call("ReadInput");
  ctx.call("Tick");
  ctx.call("BuildFrame");
  asm.jmp("Main");
}

/**
 * Read the keypad into the abstract button set, and derive this tick's edges.
 *
 * The port is a multiplexer: writing a group select and reading it back gives
 * that group's four keys in the low nibble. In landscape the X cluster is the
 * direction pad — X1 up, X2 right, X3 down, X4 left — and the buttons are their
 * own group.
 *
 * **A pressed key reads as a one here**, which no other console in this set
 * does. A runtime that complemented the byte out of habit would have every
 * direction held from power-on.
 */
function emitInput(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const out = layout.scratch + S.w0;
  asm.label("ReadInput");
  asm.movmi8(abs(out), 0);

  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  /** Which group answers a key, and which of its four bits it is. */
  const KEYS: Record<string, { group: number; bit: number }> = {
    up: { group: 0x20, bit: 0 },
    right: { group: 0x20, bit: 1 },
    down: { group: 0x20, bit: 2 },
    left: { group: 0x20, bit: 3 },
    start: { group: 0x40, bit: 0 },
    a: { group: 0x40, bit: 1 },
    b: { group: 0x40, bit: 2 },
  };

  for (const group of [0x20, 0x40]) {
    asm.movi8("al", group);
    asm.out8(PORT.KEYPAD);
    asm.in8(PORT.KEYPAD);
    asm.movmr8(abs(layout.scratch + S.w1), "al");
    for (const [to, action] of ABSTRACT.entries()) {
      const key = KEYS[action];
      if (!key || key.group !== group) continue;
      const skip = ctx.unique("padSkip");
      asm.testMI8(abs(layout.scratch + S.w1), 1 << key.bit);
      ctx.far("z", skip);
      asm.aluMI8("or", abs(out), 1 << to);
      asm.label(skip);
    }
  }

  // held → pressed and released, against last tick's set.
  asm.movm8("bl", abs(layout.held)); // last tick's
  asm.movm8("cl", abs(out)); // this tick's
  asm.movmr8(abs(layout.held), "cl");
  asm.mov8("al", "bl");
  asm.unary8("not", "al");
  asm.alu8("and", "al", "cl");
  asm.movmr8(abs(layout.pressed), "al");
  asm.mov8("al", "cl");
  asm.unary8("not", "al");
  asm.alu8("and", "al", "bl");
  asm.movmr8(abs(layout.released), "al");
  ctx.ret();
}

function emitTickDispatch(ctx: WscCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) asm.movmi8(abs(layout.sound), 0xff);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  ctx.call("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  inc16(ctx, layout.tick);
  asm.incM8(abs(layout.ready));
  ctx.ret();
}

function emitSceneChange(ctx: WscCtx, scenes: readonly SceneCtx[], program: Program): void {
  const { asm, layout } = ctx;
  const audio = ctx.audio?.driver === true && program.tracks.length > 0;
  asm.label("SceneChange");
  asm.movm8("al", abs(layout.pending));
  asm.aluI8("cmp", "al", 0xff);
  const go = ctx.unique("changeGo");
  ctx.far("nz", go);
  ctx.ret();
  asm.label(go);
  asm.movmr8(abs(layout.scene), "al");
  asm.movmi8(abs(layout.pending), 0xff);
  if (audio) ctx.call("SceneMusic");
  ctx.call("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  ctx.call("UpdateCamera");
  asm.movmi8(abs(layout.redraw), 1);
  ctx.ret();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request one byte: the driver
  // is serviced from the loop, and a scene change is not where it happens.
  if (audio) {
    asm.label("SceneMusic");
    asm.movm8("al", abs(layout.scene));
    asm.movi8("ah", 0);
    asm.mov("bx", "ax");
    asm.movm8("al", romAt("bx", label("SceneTracks")));
    asm.movmr8(abs(ctx.audio?.music as number), "al");
    ctx.ret();
  }

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

/**
 * This console's instructions for each of doc 14's tick steps.
 *
 * The *order* is not here: `emitTickSteps` runs them, so this backend supplies
 * the code for a step and has no say in the sequence (`backend.ts` §The tick's).
 */
function tickSteps(ctx: WscCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.movmi8(abs(layout.contacts + index), 0);
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.movm8("al", abs(layout.contacts + index));
        asm.movmr8(abs(layout.contactsPrev + index), "al");
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: WscCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  // The shared tail of the tick is in the fixed half and this routine may not
  // be, so it is the one *jump* in a scene that has to be able to leave.
  ctx.jump("TickDone");
}

function emitSceneReset(ctx: WscCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    // This segment's copy: the block copy takes `DS` from `CS` (§emitRomCopy),
    // so a reset running in another segment reads that segment's defaults.
    emitRomCopy(
      ctx,
      label(`Defaults_${id}${ctx.dataSuffix}`),
      layout.entities[id] as number,
      layout.entitySizes[id] as number,
      "heap",
    );
  }
  ctx.ret();
}

function emitSceneCamera(ctx: WscCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  ctx.ret();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: WscCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: WscCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.movmi8(abs(list), 0);
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.aluI8("cmp", "al", GRID_EMPTY);
    ctx.far("z", next);
    asm.mov8("dl", "al"); // the legend index, held across the arithmetic
    asm.movm8("al", abs(list));
    asm.aluI8("cmp", "al", TILE_CONTACT_MAX);
    ctx.far("nb", next);
    // The entry is five bytes: the column, the row, and the legend index. The
    // stride is a shift and an add rather than a `mul`, because `mul` writes the
    // product's high half into `dx` — and `dl` is carrying the legend index this
    // whole entry is about. It recorded a cell of tile zero for every cell of
    // every level, which is a game whose hero stands on thin air.
    asm.movi8("ah", 0);
    asm.mov("bx", "ax");
    asm.shift("shl", "bx", 2);
    asm.alu("add", "bx", "ax");
    asm.movm("ax", abs(col));
    asm.movmr(at("bx", list + 1), "ax");
    asm.movm("ax", abs(row));
    asm.movmr(at("bx", list + 3), "ax");
    asm.movmr8(at("bx", list + 5), "dl");
    asm.incM8(abs(list));
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `al`. */
function emitOverCells(ctx: WscCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  // Where the walk stops, in bytes. Computed once: the list cannot grow while it
  // is being read, and a `mul` in the loop's tail is twenty-four cycles a cell on
  // a machine whose whole frame is forty thousand. `W.temp` is free here — only
  // the *grid* walk uses it, and this is the walk that reads the list instead.
  const limit = layout.words + W.temp * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.aluMI8("cmp", abs(list), 0);
  ctx.far("z", done);
  asm.movm8("al", abs(list));
  asm.movi8("ah", 0);
  asm.movi("cx", 5);
  asm.unary("mul", "cx");
  asm.movmr(abs(limit), "ax");
  asm.movmi(abs(cursor), 0);
  asm.label(loop);
  asm.movm("bx", abs(cursor));
  asm.movm("ax", at("bx", list + 1));
  asm.movmr(abs(col), "ax");
  asm.movm("ax", at("bx", list + 3));
  asm.movmr(abs(row), "ax");
  asm.movm8("al", at("bx", list + 5));
  body();
  // Five bytes on, and stop when the end is reached. The cursor is in RAM
  // because a rule body uses every register there is.
  asm.aluMI("add", abs(cursor), 5);
  asm.movm("ax", abs(limit));
  asm.aluM("cmp", "ax", abs(cursor));
  ctx.far("nz", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: WscCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.aluI8("cmp", "al", GRID_EMPTY);
        ctx.far("z", next);
        // Is this legend entry one the rule names?
        emitTableByte(ctx, label(ruleTileTableLabel(rule, level)));
        asm.alu8("or", "al", "al");
        ctx.far("z", next);

        // A side the rule did not name is a contact that never happened: it
        // does not fire and it is not recorded either, so next tick's "was this
        // seen before" answers as the interpreter's does (`sim.ts`
        // §resolveTiles). Separation is unaffected — what can hold an object up
        // is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.aluI8("and", "al", mask);
          ctx.far("z", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.movi("si", listBase + 1);
          ctx.call("TileContactSeen");
          ctx.far("nz", next);
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
      asm.aluI8("cmp", "al", GRID_EMPTY);
      ctx.far("z", next);
      asm.mov8("dl", "al");
      emitTableByte(ctx, label(level.solidLabel));
      asm.alu8("or", "al", "al");
      ctx.far("z", next);
      asm.mov8("al", "dl");
      emitTableByte(ctx, label(namedTable));
      asm.alu8("or", "al", "al");
      ctx.far("z", next);
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

/** `al = cs:[table + al]` — the byte-table lookup every legend test makes. */
function emitTableByte(ctx: WscCtx, table: Ref): void {
  const { asm } = ctx;
  asm.mov8("bl", "al");
  asm.movi8("bh", 0);
  asm.movm8("al", romAt("bx", table));
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: WscCtx, rule: RuleDef, bind: Binding): void {
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
function emitCellId(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  asm.movm8("al", abs(layout.words + W.tileCol * 2));
  asm.movmr8(abs(layout.words + W.cell * 2), "al");
  asm.movm8("al", abs(layout.words + W.tileRow * 2));
  asm.movmr8(abs(layout.words + W.cell * 2 + 1), "al");
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: WscCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.movmi8(abs(layout.tileScratch), 0);
  asm.movm8("al", abs(listBase));
  asm.movmr8(abs(layout.words + W.target * 2), "al");
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.movm8("al", abs(layout.tileScratch));
  asm.aluI8("cmp", "al", TILE_CONTACT_MAX);
  ctx.far("nb", full);
  asm.movi8("ah", 0);
  asm.shift("shl", "ax");
  asm.mov("bx", "ax");
  asm.movm("ax", abs(layout.words + W.cell * 2));
  asm.movmr(at("bx", layout.tileScratch + 1), "ax");
  asm.incM8(abs(layout.tileScratch));
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries that
 * exist, not the whole slot. An object usually touches two or three cells, and
 * copying sixteen of them every tick was costing more than the walk.
 */
function emitCommitContacts(ctx: WscCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.movm8("al", abs(layout.tileScratch));
  asm.movi8("ah", 0);
  asm.shift("shl", "ax");
  asm.inc("ax"); // the count byte itself travels with the entries
  asm.mov("cx", "ax");
  asm.movi("si", layout.tileScratch);
  asm.movi("di", listBase);
  asm.rep().movsb();
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry
 * event fires only when the answer is no, a level one fires regardless. The list
 * to search arrives in `si`, and the answer is the zero flag — set when the cell
 * was not there.
 */
function emitTileContactHelper(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const step = ctx.unique("seenStep");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.movm8("cl", abs(layout.words + W.target * 2));
  asm.movi8("ch", 0);
  asm.alu("or", "cx", "cx");
  ctx.far("z", missing);
  asm.movm("dx", abs(layout.words + W.cell * 2));
  asm.label(loop);
  asm.movm("ax", at("si"));
  asm.alu("cmp", "ax", "dx");
  ctx.far("z", found);
  asm.label(step);
  asm.aluI("add", "si", 2);
  asm.loop(loop);
  asm.label(missing);
  asm.alu8("xor", "al", "al");
  ctx.ret();
  asm.label(found);
  asm.movi8("al", 1);
  asm.alu8("or", "al", "al");
  ctx.ret();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: WscCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: WscEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.movmi(abs(layout.words + W.camX * 2), 0);
    asm.movmi(abs(layout.words + W.camY * 2), 0);
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.aluMI8("cmp", abs(layout.redraw), 0);
  ctx.far("z", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  asm.movmi8(abs(layout.redraw), 0);
  asm.movmi8(abs(layout.plotPrevCount), 0);
  asm.jmp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // One HUD, whether the scene scrolls or not: the second plane holds still
  // under a moving camera, so there is nothing to pin and no sprite version of
  // any of this.
  emitHudErase(ctx);
  asm.movmi8(abs(layout.plotCount), 0);
  emitHud(ctx, scene, "dynamic");
  emitSwapPlots(ctx);
  emitOam(ctx, scene, options);
  ctx.ret();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: WscCtx, src: number, dst: number): void {
  const { asm } = ctx;
  // The whole-cell half times eight, plus the fraction's top three bits. Both
  // halves are read as they lie, so a negative coordinate needs no special case:
  // the low bits of `cells × 8` are what an arithmetic shift of the whole
  // thirty-two would have left.
  asm.movm("ax", abs(mem(src, 2)));
  asm.shift("shl", "ax", 3);
  asm.movm("cx", abs(mem(src, 0)));
  asm.shift("shr", "cx", 13);
  asm.alu("or", "ax", "cx");
  asm.movmr(abs(dst), "ax");
}

/** Draw the whole visible window, with the layers off. */
function emitFullRedraw(
  ctx: WscCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: WscEmitOptions,
): void {
  const { asm, layout } = ctx;
  const RAM = ctx.machine.ram;
  // A screenful of map does not fit in one blanking interval, and the display
  // reads the map where the runtime writes it — there is no port and no shadow
  // between them — so the layers go off for the length of the redraw. It happens
  // once a scene.
  emitPort(ctx, PORT.DISP_CTRL, 0x00);

  // Every scene brings a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours; one without brings the
  // build's — the level tiles' and the objects' fit. Leaving palette RAM alone
  // would mean a level scene wore whichever title screen the player came from.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteBlock(
    ctx,
    label(palette ? scenePaletteLabel(scene, ctx.dataSuffix) : `Palette${ctx.dataSuffix}`),
  );

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is packed as whole map rows, so painting it is one walk with a
    // destination that only ever moves forward.
    asm.movi("di", RAM.SCR1);
    // The fixed half's copy, whatever segment this scene is in: the helper about
    // to read it is in the fixed half and reads through its own `CS`
    // (§emitSegmentData).
    asm.movi("si", label(backdropLabel(scene)));
    ctx.call(needBlitBackdrop(ctx));
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    // The window, and the one column and row the first scroll step will need
    // before it has had a chance to paint them — and nothing else.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    copy16(ctx, layout.words + W.firstCol * 2, layout.words + W.mapCol * 2);
    copy16(ctx, layout.words + W.tileRow * 2, layout.words + W.mapRow * 2);

    const rowLoop = ctx.unique("fullRow");
    const colLoop = ctx.unique("fullCol");
    const rows = layout.words + W.firstRow * 2;
    const columns = layout.words + W.lastCol * 2;
    // One past the window on each axis: a scroll that is not a whole number of
    // cells shows a sliver of the next column and the next row, and the map has
    // four columns and fourteen rows the window never shows, so there is always
    // somewhere to put it.
    const height = layout.memory.viewH + (level !== undefined ? 1 : 0);
    const width = layout.memory.viewW + (level !== undefined ? 1 : 0);
    asm.movmi8(abs(rows), height);
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.movmi8(abs(columns), width);
    asm.label(colLoop);
    emitBackgroundTile(ctx, level);
    ctx.call("PokeCellAt");
    inc16(ctx, layout.words + W.tileCol * 2);
    asm.decM8(abs(columns));
    ctx.far("nz", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    asm.decM8(abs(rows));
    ctx.far("nz", rowLoop);
  }

  // Captions go on now, with the plane they sit on: a static one is painted
  // once and never touches the per-frame queue again.
  emitBlankPlane(ctx, RAM.SCR2);
  emitHud(ctx, scene, "static");
  emitPort(ctx, PORT.DISP_CTRL, 0x07);
}

/** Fill a whole screen map with the blank tile, so nothing stale shows through. */
function emitBlankPlane(ctx: WscCtx, base: number): void {
  const { asm } = ctx;
  ctx.toInternal(() => {
    asm.movi("di", base);
    asm.movi("cx", MAP_W * MAP_H);
    asm.movi("ax", 0);
    asm.rep().stosw();
  });
}

/** `si` = a packed map, `di` = where it goes; unpack it into RAM. */
function needBlitBackdrop(ctx: WscCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");
    const out = inner.unique("blitDone");

    asm.label(next);
    // The control byte is in the cartridge and everything it describes goes to
    // RAM, so the source carries a segment override and the destination does not.
    asm.movm8("al", romAt("si"));
    asm.inc("si");
    asm.alu8("or", "al", "al");
    inner.far("z", out);
    inner.far("s", run);

    asm.movi8("ah", 0);
    asm.mov("cx", "ax");
    asm.label(literal);
    asm.movm("ax", romAt("si"));
    asm.aluI("add", "si", 2);
    asm.movmr(inner.vram("di"), "ax");
    asm.aluI("add", "di", 2);
    asm.loop(literal);
    asm.jmp(next);

    asm.label(run);
    asm.aluI8("and", "al", 0x7f);
    asm.movi8("ah", 0);
    asm.mov("cx", "ax");
    asm.movm("ax", romAt("si"));
    asm.aluI("add", "si", 2);
    asm.label(runLoop);
    asm.movmr(inner.vram("di"), "ax");
    asm.aluI("add", "di", 2);
    asm.loop(runLoop);
    asm.jmp(next);

    asm.label(out);
    ctx.ret();
  });
}

/** The labels holding one scene's map and palette RAM. */
function backdropLabel(scene: SceneCtx, suffix = ""): string {
  return `Backdrop_${scene.index}${suffix}`;
}
function scenePaletteLabel(scene: SceneCtx, suffix = ""): string {
  return `ScenePal_${scene.index}${suffix}`;
}

/**
 * `ax` = the map word that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: WscCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.movi("ax", 0);
    return;
  }
  ctx.call(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/** `ax` = the map word for the legend index in `al`. */
function emitLegendToTile(ctx: WscCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.aluI8("cmp", "al", GRID_EMPTY);
  ctx.far("z", empty);
  // The two tables are the low and high bytes of the word, so this is two
  // indexed loads and nothing to assemble.
  asm.mov8("bl", "al");
  asm.movi8("bh", 0);
  asm.movm8("al", romAt("bx", label(level.tileLabel)));
  asm.movm8("ah", romAt("bx", label(level.attrLabel)));
  asm.jmp(done);
  asm.label(empty);
  asm.movi("ax", 0);
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: WscCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.movm("ax", abs(src));
    asm.shift("sar", "ax", 3);
    asm.movmr(abs(dst), "ax");
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the map up to date after the camera moved.
 *
 * The scroll registers do the moving, so crossing a cell boundary costs one
 * column or one row of writes and nothing else. A jump too large to walk sets
 * the full-redraw flag instead of silently dropping cells off the end of the
 * queue.
 */
function emitScrollUpdate(ctx: WscCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  asm.jmp(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.movmi8(abs(layout.redraw), 1);
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge
 * as it goes. More than four cells in a tick is a teleport, not a scroll.
 *
 * The invariant is that the map holds the window plus one cell past it on each
 * axis, because a scroll of part of a cell shows a sliver of the next one. So
 * moving on paints one past the far edge and moving back paints the new origin
 * itself — and unlike the Master System there is no exception, because the map
 * is four columns wider and fourteen rows taller than the window on this
 * console and "one past the window" is never the same cell as "the origin".
 */
function emitWalkAxis(
  ctx: WscCtx,
  level: LevelData,
  origin: number,
  want: number,
  bail: string,
  isColumn: boolean,
): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("scrollWalk");
  const done = ctx.unique("walkDone");
  const back = ctx.unique("walkBack");
  const guard = layout.words + W.count * 2;

  asm.movmi8(abs(guard), 5);
  asm.label(loop);
  asm.decM8(abs(guard));
  ctx.far("z", bail);
  asm.movm("ax", abs(want));
  asm.aluM("sub", "ax", abs(origin));
  ctx.far("z", done);
  ctx.far("s", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  asm.jmp(loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, 0);
  asm.jmp(loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: WscCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = (isColumn ? layout.memory.viewH : layout.memory.viewW) + 1;
  // Not `temp`: the grid lookup uses that word for its row-times-width multiply,
  // and a counter clobbered mid-loop paints a strip of whatever tile the count
  // happened to land on.
  const remaining = layout.words + W.lastRow * 2;

  copy16(ctx, across, originAcross);
  if (offset !== 0) asm.aluMI("add", abs(across), offset);
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.movmi8(abs(remaining), count);
  asm.label(loop);
  ctx.call(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  ctx.call("QueueCellAt");
  inc16(ctx, along);
  asm.decM8(abs(remaining));
  ctx.far("nz", loop);
}

/** Blank the cells the HUD covered last frame. */
function emitHudErase(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.aluMI8("cmp", abs(layout.plotPrevCount), 0);
  ctx.far("z", done);
  asm.movmi(abs(cursor), 0);
  asm.label(loop);
  asm.movm("bx", abs(cursor));
  asm.movm("ax", at("bx", layout.plotPrev));
  asm.movmr(abs(layout.words + W.tileCol * 2), "ax");
  asm.movm("ax", at("bx", layout.plotPrev + 2));
  asm.movmr(abs(layout.words + W.tileRow * 2), "ax");
  // The HUD's plane is transparent where nothing is drawn, so erasing is one
  // blank cell rather than a lookup into whatever the world put there — which
  // is the whole saving of giving the HUD a plane of its own.
  asm.movi("ax", 0);
  ctx.call("QueueHudAt");
  asm.aluMI("add", abs(cursor), 4);
  asm.movm8("al", abs(layout.plotPrevCount));
  asm.movi8("ah", 0);
  asm.shift("shl", "ax", 2);
  asm.aluM("cmp", "ax", abs(cursor));
  ctx.far("nz", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  asm.movm8("al", abs(layout.plotCount));
  asm.movmr8(abs(layout.plotPrevCount), "al");
  asm.alu8("or", "al", "al");
  ctx.far("z", done);
  asm.movi8("ah", 0);
  asm.shift("shl", "ax", 1);
  asm.mov("cx", "ax");
  asm.movi("si", layout.plot);
  asm.movi("di", layout.plotPrev);
  asm.rep().movsw();
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the HUD plane. */
function emitHud(ctx: WscCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
  const { asm, layout, program } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;
    if ((hudIsStatic(ctx, id) ? "static" : "dynamic") !== want) continue;

    const skip = ctx.unique("hudSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      branchZero32(ctx, (layout.entities[id] as number) + propOffset("visible"), skip);
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[id] as number;
    // The screen cell the object sits in. The plane never scrolls, so this is
    // the object's own cell minus the camera's — exact on both axes, with no
    // pixel to round and nothing to pin.
    asm.movm("ax", abs(base + propOffset("x") + 2));
    if (layout.camera !== null) asm.aluM("sub", "ax", abs(layout.camera + 2));
    asm.movmr(abs(layout.words + W.tileCol * 2), "ax");
    asm.movm("ax", abs(base + propOffset("y") + 2));
    if (layout.camera !== null) asm.aluM("sub", "ax", abs(layout.camera + 6));
    asm.movmr(abs(layout.words + W.tileRow * 2), "ax");

    // A static caption is painted straight into the plane with the display
    // already off, so it needs neither the write queue nor a place in the erase
    // list.
    const plot = want === "static" ? needPokeGlyph(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, MAP_W)) {
        asm.movi("ax", mapWord(glyphTile(character), SYSTEM_PALETTE));
        ctx.call(plot);
      }
    } else {
      asm.movi("si", base + propOffset("value") + 2);
      ctx.call(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `ax` = a map word: write it into the HUD plane and advance the column. */
function needPokeGlyph(ctx: WscCtx): Ref {
  return ctx.need("PokeGlyph", (inner) => {
    const { layout } = inner;
    ctx.call("PokeHudAt");
    inc16(inner, layout.words + W.tileCol * 2);
    ctx.ret();
  });
}

/** The decimal renderer again, writing straight into the plane. */
function needPokeNumber(ctx: WscCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeGlyph(inner));
  });
}

/**
 * `bx` = entity base, `cl`/`ch` = the size in cells → Z set when the object is
 * certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * half of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled — the test
 * may say "maybe" when the answer is no, and never the other way round.
 */
function needOnscreen(ctx: WscCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");
    const delta = layout.scratch + S.w1;

    const axis = (offset: number, margin: "cl" | "ch", span: number): void => {
      asm.movm("ax", at("bx", offset + 2));
      asm.aluM("sub", "ax", abs(camera + offset + 2));
      asm.movmr(abs(delta), "ax");
      asm.mov8("dl", margin);
      asm.movi8("dh", 0);
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.alu("add", "ax", "dx");
      inner.far("s", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.movm("ax", abs(delta));
      asm.aluI("sub", "ax", span + 1);
      inner.far("ns", apart);
    };
    axis(propOffset("x"), "cl", layout.memory.viewW);
    axis(propOffset("y"), "ch", layout.memory.viewH);

    asm.movi8("al", 1);
    asm.alu8("or", "al", "al");
    ctx.ret();
    asm.label(apart);
    asm.alu8("xor", "al", "al");
    ctx.ret();
  });
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: WscCtx, scene: SceneCtx, options: WscEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.movmi8(abs(layout.oamCount), 0);

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;

    // The collision box is the sprite's footprint, in whole cells — *this*
    // object's box, not its class's and not the largest one the file was
    // converted at. Anything else draws ledge where nothing can be stood on.
    const width = instanceCells(instance, "width");
    const height = instanceCells(instance, "height");
    const art = options.sprites?.get(artKey(asset, width, height)) ?? options.sprites?.get(asset);

    const skip = ctx.unique("oamSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      branchZero32(ctx, (layout.entities[id] as number) + propOffset("visible"), skip);
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[id] as number;
    // An object the view does not cover needs none of the work below. In a level
    // bigger than the screen that is most of them most of the time.
    if (layout.camera !== null && fixedCells(ctx, id)) {
      asm.movi("bx", base);
      asm.movi("cx", (height << 8) | width);
      ctx.call(needOnscreen(ctx));
      ctx.far("z", skip);
    }
    // Screen pixels are level pixels minus the camera's.
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, base + propOffset("x"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera);
      emitPixelsFromFixed(ctx, temp, layout.words + W.cell * 2);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera + 4);
      emitPixelsFromFixed(ctx, temp, layout.words + W.count * 2);
    });

    const palette = art ? 8 + (art.palette ?? 0) : SYSTEM_OBJECT_PALETTE;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE;
        // Y in `cl` and X in `ch`, which is the order the two bytes of an entry
        // lie in — so the pair is one store.
        asm.movm8("cl", abs(layout.words + W.count * 2));
        asm.aluI8("add", "cl", (row * 8) & 0xff);
        asm.movm8("ch", abs(layout.words + W.cell * 2));
        asm.aluI8("add", "ch", (column * 8) & 0xff);
        asm.movi("ax", mapWord(tile, palette));
        ctx.call(needPushSprite(ctx));
      }
    }
    asm.label(skip);
  }
}

/**
 * `ax` = the attribute word, `cl` = y, `ch` = x; append an entry to the shadow.
 *
 * **An entry off the screen is dropped rather than clipped**, and that is the
 * hardware rather than a shortcut: an object's position here is eight unsigned
 * bits with no wrap, so a sprite at −4 cannot be drawn as four columns at the
 * left edge — there is no coordinate that means that. What the runtime can do is
 * not draw it, which is what the unsigned comparisons below are.
 */
function needPushSprite(ctx: WscCtx): Ref {
  const RAM = ctx.machine.ram;
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const skip = inner.unique("oamOff");
    asm.aluI8("cmp", "cl", layout.memory.viewH * 8);
    inner.far("nb", skip);
    asm.aluI8("cmp", "ch", layout.memory.viewW * 8);
    inner.far("nb", skip);
    asm.aluMI8("cmp", abs(layout.oamCount), layout.memory.oamEntries);
    inner.far("nb", skip);
    asm.movm8("bl", abs(layout.oamCount));
    asm.movi8("bh", 0);
    asm.shift("shl", "bx", 2);
    asm.movmr(inner.vram("bx", RAM.SHADOW), "ax");
    asm.movmr(inner.vram("bx", RAM.SHADOW + 2), "cx");
    asm.incM8(abs(layout.oamCount));
    asm.label(skip);
    ctx.ret();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: WscCtx): void {
  const RAM = ctx.machine.ram;
  const { asm, layout } = ctx;
  const QUEUE_BYTES = layout.memory.queueMax * layout.queueStride;

  // `bx` = the offset of the cell in words[tileCol]/words[tileRow] within a
  // screen map. Both wraps are powers of two, so this is two masks and a shift
  // — the whole of scrolling on this console.
  asm.label("CellOffset");
  asm.movm("ax", abs(layout.words + W.tileRow * 2));
  asm.aluI("and", "ax", MAP_H - 1);
  asm.shift("shl", "ax", 5);
  asm.movm("bx", abs(layout.words + W.tileCol * 2));
  asm.aluI("and", "bx", MAP_W - 1);
  asm.alu("add", "ax", "bx");
  asm.shift("shl", "ax", 1);
  asm.mov("bx", "ax");
  ctx.ret();

  // `ax` = a map word: write it into the world plane, or the HUD's.
  const poke = (name: string, base: number): void => {
    asm.label(name);
    asm.mov("dx", "ax");
    ctx.call("CellOffset");
    asm.movmr(ctx.vram("bx", base), "dx");
    ctx.ret();
  };
  poke("PokeCellAt", RAM.SCR1);
  poke("PokeHudAt", RAM.SCR2);

  // The same two, queued rather than written: the display reads the map where
  // the runtime writes it, so anything built outside the blanking interval waits
  // in a list until there is one.
  const queue = (name: string, base: number): void => {
    asm.label(name);
    asm.mov("dx", "ax");
    ctx.call("CellOffset");
    asm.aluI("add", "bx", base);
    asm.mov("ax", "dx");
    asm.jmp("QueueEntry");
  };
  queue("QueueCellAt", RAM.SCR1);
  queue("QueueHudAt", RAM.SCR2);

  // `ax` = a map word, `bx` = where it goes: append a four-byte entry.
  asm.label("QueueEntry");
  const room = ctx.unique("queueRoom");
  asm.aluMI8("cmp", abs(layout.queueCount), QUEUE_BYTES - layout.queueStride + 1);
  ctx.far("b", room);
  // No room: repaint the whole background next frame rather than leave a strip
  // of it stale for ever.
  asm.movmi8(abs(layout.redraw), 1);
  ctx.ret();
  asm.label(room);
  asm.mov("dx", "ax");
  asm.movm8("al", abs(layout.queueCount));
  asm.movi8("ah", 0);
  asm.mov("si", "ax");
  asm.movmr(at("si", layout.queue), "bx");
  asm.movmr(at("si", layout.queue + 2), "dx");
  asm.aluMI8("add", abs(layout.queueCount), layout.queueStride);
  ctx.ret();

  // `ax` = a map word: queue it as one HUD cell, record the cell for erasing,
  // and advance the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  ctx.call("QueueHudAt");
  asm.aluMI8("cmp", abs(layout.plotCount), layout.memory.plotMax);
  ctx.far("nb", plotFull);
  asm.movm8("al", abs(layout.plotCount));
  asm.movi8("ah", 0);
  asm.shift("shl", "ax", 2);
  asm.mov("bx", "ax");
  asm.movm("ax", abs(layout.words + W.tileCol * 2));
  asm.movmr(at("bx", layout.plot), "ax");
  asm.movm("ax", abs(layout.words + W.tileRow * 2));
  asm.movmr(at("bx", layout.plot + 2), "ax");
  asm.incM8(abs(layout.plotCount));
  asm.label(plotFull);
  inc16(ctx, layout.words + W.tileCol * 2);
  ctx.ret();

  // Flush the queue, copy the objects across, and set the scroll. All three fit
  // inside the blanking interval by construction: the queue is capped at what
  // one will hold and anything over sets the redraw flag instead of being
  // dropped.
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.movm8("cl", abs(layout.queueCount));
  asm.movi8("ch", 0);
  asm.alu("or", "cx", "cx");
  ctx.far("z", noQueue);
  asm.shift("shr", "cx", 2);
  asm.movi("si", layout.queue);
  asm.label(flush);
  asm.movm("bx", at("si"));
  asm.movm("ax", at("si", 2));
  asm.movmr(ctx.vram("bx"), "ax");
  asm.aluI("add", "si", layout.queueStride);
  asm.loop(flush);
  asm.movmi8(abs(layout.queueCount), 0);
  asm.label(noQueue);

  // The objects. The display reads the table where it lies, so what the frame
  // built goes across here — and only the entries in use, because port `$06`
  // says how many the chip should look at.
  const noObjects = ctx.unique("noObjects");
  asm.movm8("al", abs(layout.oamCount));
  asm.out8(PORT.SPR_COUNT);
  asm.movm8("cl", abs(layout.oamCount));
  asm.movi8("ch", 0);
  asm.alu("or", "cx", "cx");
  ctx.far("z", noObjects);
  asm.shift("shl", "cx", 1); // two words an entry
  // Both ends are the console's own memory — the shadow the frame built and the
  // table the chip reads — so this is the one copy that moves `DS` as well as
  // `ES` on a build whose heap is in the cartridge.
  ctx.toInternal(() => {
    asm.movi("si", RAM.SHADOW);
    asm.movi("di", RAM.OAM);
    asm.rep().movsw();
  }, true);
  asm.label(noObjects);

  emitScrollWrite(ctx);
  ctx.ret();

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell");

  emitDecimalPowers(ctx);
}

/**
 * Write the two scroll registers of the world plane.
 *
 * The register names the map pixel that appears at the screen's left edge, so it
 * carries the camera directly rather than its negation — and *both* axes wrap at
 * 256, because the map is thirty-two cells on both. That is the whole of it:
 * this console has neither the Master System's 224-row wrap nor its bias.
 */
function emitScrollWrite(ctx: WscCtx): void {
  const { asm, layout } = ctx;
  asm.movm8("al", abs(layout.words + W.scrollX * 2));
  asm.out8(PORT.SCR1_X);
  asm.movm8("al", abs(layout.words + W.scrollY * 2));
  asm.out8(PORT.SCR1_Y);
}

/**
 * Draw the signed 16-bit value `si` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the static HUD and the queued one — which is why
 * it is a parameter rather than a second copy of the digit loop.
 *
 * **A digit is a division here, not a subtraction loop.** Every 8-bit backend in
 * this project walks the powers of ten subtracting one at a time, because none of
 * their processors can divide; this one can, so a digit is `div` against the
 * power and the remainder is what is left to print. The leading zeroes are then
 * not suppressed but never produced: four unsigned comparisons pick the power to
 * start at, and a lone zero starts at the units. That is five divisions and four
 * comparisons against what was a hundred and thirty memory accesses, and on a
 * console whose whole frame is forty thousand cycles it was an eighth of a tick
 * spent printing a two-digit coin counter.
 */
function emitDecimal(ctx: WscCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine and the write queue — which between them use every byte of
  // the helper scratch. So the digit loop keeps its state in the render words
  // instead, in slots nothing on that path touches: not the pen, not the cell
  // being written, and — the one that actually bites — **not the map origin**,
  // which has to survive from one frame to the next.
  const value = layout.words + W.firstCol * 2;
  const power = layout.words + W.lastCol * 2;

  asm.movm("ax", at("si"));
  asm.movmr(abs(value), "ax");

  const positive = ctx.unique("numPos");
  const chosen = ctx.unique("numChosen");
  asm.alu("or", "ax", "ax");
  ctx.far("ns", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.unary("neg", "ax");
  asm.movmr(abs(value), "ax");
  asm.movi("ax", mapWord(glyphTile("-"), SYSTEM_PALETTE));
  ctx.call(plot);
  asm.movm("ax", abs(value));
  asm.label(positive);

  // The power to start at, as a byte offset into `DecimalPowers`. Unsigned, and
  // the value is known non-negative by here. Short branches: every target is a
  // few instructions along and there is no call between them.
  asm.movi8("bl", 8);
  asm.aluI("cmp", "ax", 10);
  asm.jcc("b", chosen);
  asm.movi8("bl", 6);
  asm.aluI("cmp", "ax", 100);
  asm.jcc("b", chosen);
  asm.movi8("bl", 4);
  asm.aluI("cmp", "ax", 1000);
  asm.jcc("b", chosen);
  asm.movi8("bl", 2);
  asm.aluI("cmp", "ax", 10000);
  asm.jcc("b", chosen);
  asm.movi8("bl", 0);
  asm.label(chosen);
  asm.movmr8(abs(power), "bl");

  const digitLoop = ctx.unique("numDigit");
  asm.label(digitLoop);
  asm.movm8("bl", abs(power));
  asm.movi8("bh", 0);
  asm.movm("cx", romAt("bx", label("DecimalPowers")));
  asm.movm("ax", abs(value));
  asm.movi("dx", 0);
  asm.unary("div", "cx");
  // The quotient is the digit and the remainder is the rest of the number, so
  // what is left has to be stored before `ax` is turned into a map word.
  asm.movmr(abs(value), "dx");
  asm.movi8("ah", 0);
  asm.aluI("add", "ax", mapWord(glyphTile("0"), SYSTEM_PALETTE));
  ctx.call(plot);
  asm.aluMI8("add", abs(power), 2);
  asm.aluMI8("cmp", abs(power), 10);
  ctx.far("nz", digitLoop);
  ctx.ret();
}

/** The powers of ten a decimal render walks, as little-endian words. */
function emitDecimalPowers(ctx: WscCtx): void {
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}

/** What the emitter re-exports for the backend and its tests. */
export { MAP_W as WSC_MAP_W, MAP_H as WSC_MAP_H, romAbs };
