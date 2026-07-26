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

import type { InstanceDef, RuleDef } from "../program.js";

import type { Ctx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { isMutable } from "./analyze.js";
import { emitTickSteps, type TickSteps } from "./backend.js";
import {
  artKey,
  emitInstanceDefaults,
  fixedCells,
  hudIsStatic,
  instanceCells,
  sceneContexts,
  sceneIndexOf,
  scrolls,
  tileCellsCacheable,
  type SpriteArt,
} from "./shape.js";
import { ENTITY_SIZE, PROPS, TILE_CONTACT_MAX, W } from "./layout.js";
import {
  emitAssignments,
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
  emitSound,
  type SceneCtx,
} from "./rules.js";
import {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  emitMulConst16,
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
import { AUDIO_STOP, type GameAudio } from "@demake/audio";

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
  /** CGB: which VRAM bank `$8000`–`$9FFF` reaches. */
  VBK: 0xff4f,
  /** CGB: background palette index, then its data port. */
  BCPS: 0xff68,
  BCPD: 0xff69,
  /** CGB: object palette index, then its data port. */
  OCPS: 0xff6a,
  OCPD: 0xff6b,
  IE: 0xffff,
} as const;

const VRAM_TILES = 0x8000;
const VRAM_MAP = 0x9800;

/** Tiles one VRAM bank holds; a Game Boy Color has two of them. */
const BANK_TILES = 256;

/** Bytes one four-colour CGB palette occupies in palette RAM. */
export const PALETTE_BYTES = 8;

/**
 * The palette reserved for the font, the level patterns and the placeholder
 * block — background and objects alike.
 *
 * Everything else on a colour build is demade art whose palette was chosen
 * *for that art*: a title screen's fit is free to spend all four colours of a
 * palette on sky. A caption drawn in one of those would be sky on sky, so one
 * palette of each kind is kept back and the fitters are given the rest.
 */
export const SYSTEM_PALETTE = 7;

/** Sub-palettes a colour build's art may use — every one but the system's. */
export const ART_PALETTES = SYSTEM_PALETTE;
/** Where the OAM DMA kernel is copied to; it must run outside the main bus. */
const HRAM_DMA = 0xff80;

/**
 * The flag the main loop waits on, the first high-RAM byte after the DMA kernel.
 *
 * A flag rather than a bare `halt`, because with the audio driver running most
 * wake-ups are the timer's. `ldh` is what makes setting it fit in the eight
 * bytes the VBlank vector has before the LCD-STAT one.
 */
const HRAM_VBLANK = 0xff8a;

/** Everything the emitter needs beyond the program itself. */
export interface EmitOptions {
  /** Converted sprite art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette: number }>;
  /** Extra tiles appended to the built-in bank. */
  extraTiles?: Uint8Array;
  /**
   * Demade backdrops by scene name: the map that places the picture's tiles,
   * and the background palette its fit chose. The map holds bank indices, which
   * may point anywhere — a picture's cells are pooled against the whole bank.
   *
   * A colour build carries two more things, because on that hardware a cell is
   * a tile *and* an attribute: `attr` is one byte per cell (its sub-palette,
   * its flips and its VRAM bank) and `palettes` is the block of colours the
   * scene uploads before it paints.
   */
  backdrops?: ReadonlyMap<
    string,
    { map: Uint8Array; bgp: number; attr?: Uint8Array; palettes?: Uint8Array }
  >;
  /**
   * The object palette register, when converted art chose one.
   *
   * The image pipeline picks which hardware shades an object's three colour
   * indices map to, over every asset in the build at once (doc 15 §The
   * conversion path). That choice only exists as a register value, so it
   * arrives here rather than in the tile bytes. Monochrome builds only: colour
   * hardware has palette RAM instead, and {@link objectPalettes} carries it.
   */
  objectPalette?: number;
  /** CGB object palette RAM, all eight palettes, ready to upload verbatim. */
  objectPalettes?: Uint8Array;
  /** CGB background palettes for level tile art — the scenes with a level. */
  tilePalettes?: Uint8Array;
  /** CGB background palette {@link SYSTEM_PALETTE}: the font's own ramp. */
  systemPalette?: Uint8Array;
  /**
   * The game's audio driver, already built from its demade tracks and effects.
   *
   * Absent for a game with no `music` and no `sound`, and everything about the
   * ROM is then exactly what it was before audio existed — no timer, no vectors,
   * no per-frame test. Audio is pulled in by a game that asks for it.
   */
  audio?: GameAudio;
  /** The driver index of each of the program's sounds; `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Track index each scene asks for, or `-1`; indexed by scene. */
  sceneTracks?: readonly number[];
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
  // only has to exist and return. With audio there is a second interrupt, and
  // `halt` cannot tell them apart — so VBlank raises a flag the loop waits on,
  // and a timer tick in between no longer looks like the start of a frame.
  asm.padTo(0x0040);
  if (options.audio) {
    asm.push("af");
    asm.ldn("a", 1);
    asm.stha(HRAM_VBLANK & 0xff);
    asm.pop("af");
  }
  asm.reti();
  if (options.audio) {
    // The timer vector, where the driver's tick is driven from. Every pair is
    // saved because the game's own code is what was interrupted.
    asm.padTo(0x0050);
    asm.push("af").push("bc").push("de").push("hl");
    asm.call("AudioTick");
    asm.pop("hl").pop("de").pop("bc").pop("af");
    asm.reti();
  }
  asm.padTo(0x0100);
  asm.nop();
  asm.jp("Entry");
  asm.padTo(0x0150);

  emitEntry(ctx, scenes, levelFor, options);
  emitMainLoop(ctx, options.audio !== undefined);
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
  if (options.audio) options.audio.emitCode(asm);
  ctx.finish();

  // --- data ------------------------------------------------------------------
  for (const level of levels) {
    const boundTile = (index: number): { tile: number; palette: number } => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      return (
        bound ?? {
          // A legend entry with no art draws a built-in pattern, which lives in
          // the first bank and is drawn with the font's own palette.
          tile: patternTile(index, level.file.tiles[index]?.solid ?? false),
          palette: SYSTEM_PALETTE,
        }
      );
    };
    emitLevelData(
      asm,
      level,
      (index) => boundTile(index).tile & 0xff,
      ctx.color
        ? (index) => {
            const bound = boundTile(index);
            return (bound.palette & 0x07) | (bound.tile > 0xff ? 0x08 : 0);
          }
        : undefined,
    );
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
      }
    }
  }
  emitInstanceDefaults(asm, program, PROPS);

  // One demade tilemap per scene that has a backdrop: a screenful of bytes,
  // each naming a tile in the bank the conversion filled — followed, on a
  // colour build, by the same screenful of attributes.
  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (!art) continue;
    asm.label(backdropLabel(scene));
    asm.bytes(art.map);
    if (ctx.color && art.attr) asm.bytes(art.attr);
  }

  if (ctx.color) {
    // Palette blocks. The object palettes and the font's are the game's, so
    // they are emitted once; a picture's are the picture's, and only a scene
    // whose redraw uploads them is emitted at all.
    if (options.objectPalettes) {
      asm.label("ObjectPalettes");
      asm.bytes(options.objectPalettes);
    }
    if (options.systemPalette) {
      asm.label("SystemPalette");
      asm.bytes(options.systemPalette);
    }
    const emitted = new Set<string>();
    for (const scene of scenes) {
      const block = scenePalettes(scene, levelFor.get(scene.index), options);
      if (!block || emitted.has(block.name)) continue;
      emitted.add(block.name);
      asm.label(block.name);
      asm.bytes(block.bytes);
    }
  }

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

  // Tiles into VRAM. Past the first bank's 256 they continue in the second, and
  // only a colour build has one — which is most of why it can afford a demade
  // backdrop and the game's own art at the same time.
  const inBank0 = Math.min(tileCount, BANK_TILES);
  asm.ld16("hl", label("TileBank"));
  asm.ld16("de", VRAM_TILES);
  asm.ld16("bc", inBank0 * TILE_BYTES);
  asm.call("CopyBytes");
  if (tileCount > inBank0) {
    emitVramBank(ctx, 1);
    asm.ld16("hl", label("TileBank", inBank0 * TILE_BYTES));
    asm.ld16("de", VRAM_TILES);
    asm.ld16("bc", (tileCount - inBank0) * TILE_BYTES);
    asm.call("CopyBytes");
    emitVramBank(ctx, 0);
  }

  // A blank tilemap, so nothing stale shows through before the first draw.
  asm.ld16("hl", VRAM_MAP);
  asm.ld16("bc", 32 * 32);
  asm.call("ClearBytes");

  if (ctx.color) {
    // Every cell carries a palette whether the game has painted it or not, so
    // the blank map is attributed to the font's ramp rather than to whatever
    // palette RAM powered up holding.
    emitVramBank(ctx, 1);
    asm.ld16("hl", VRAM_MAP);
    asm.ld16("bc", 32 * 32);
    asm.ldn("d", SYSTEM_PALETTE);
    asm.call(needFillBytes(ctx));
    emitVramBank(ctx, 0);
    // The object palettes and the font's background palette are the build's,
    // once, at boot. A scene's own background palettes go up with its redraw,
    // because they are the scene's rather than the game's.
    if (options.objectPalettes) {
      emitUploadPalette(ctx, label("ObjectPalettes"), options.objectPalettes.length, 0, R.OCPS);
    }
    if (options.systemPalette) {
      emitUploadPalette(
        ctx,
        label("SystemPalette"),
        options.systemPalette.length,
        SYSTEM_PALETTE,
        R.BCPS,
      );
    }
  } else {
    asm.ldn("a", 0b11100100);
    asm.stha(R.BGP & 0xff);
    // Objects get whatever palette the art conversion chose; with no bound art
    // the built-in block is drawn in the same shades as the background.
    asm.ldn("a", options.objectPalette ?? 0b11100100);
    asm.stha(R.OBP0 & 0xff);
    // OBP1 stays the plain ramp, and that is what a HUD drawn with sprites
    // uses. The art's palette is chosen for the art: it may well map the font's
    // ink index onto the lightest shade, which is a score nobody can read.
    asm.ldn("a", 0b11100100);
    asm.stha(R.OBP1 & 0xff);
  }
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
  asm.ldn("a", layout.memory.oamEntries);
  asm.sta(layout.oamPrev);
  asm.alu("xor", "a");
  asm.ldn("a", 0xff);
  asm.sta(layout.pending);
  asm.ldn("a", sceneIndexOf(program, program.entryScene));
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

  if (options.audio) {
    asm.alu("xor", "a");
    asm.stha(HRAM_VBLANK & 0xff);
    asm.call("AudioInit");
    if (program.tracks.length > 0) asm.call("SceneMusic");
  }

  // LCD on, BG on, OBJ on, tiles at $8000, map at $9800.
  asm.ldn("a", 0b10010011);
  asm.stha(R.LCDC & 0xff);
  asm.ldn("a", options.audio ? 1 | options.audio.clock.interrupt : 1);
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

// --- colour ------------------------------------------------------------------

/**
 * Point VRAM at one of the Game Boy Color's two banks.
 *
 * Bank 0 holds tiles and the tile map; bank 1 holds the second half of the tile
 * bank and, at the map's own addresses, one attribute byte per cell. Every
 * write in this backend leaves the bank at 0, so a routine can assume it.
 */
function emitVramBank(ctx: Ctx, bank: number): void {
  const { asm } = ctx;
  if (bank === 0) asm.alu("xor", "a");
  else asm.ldn("a", bank);
  asm.stha(R.VBK & 0xff);
}

/** `HL` = destination, `BC` = count, `D` = the byte to write. */
function needFillBytes(ctx: Ctx): string {
  const name = "FillBytes";
  ctx.need(name, (inner) => {
    const { asm } = inner;
    const loop = inner.unique("fillLoop");
    asm.label(loop);
    asm.ld("a", "d");
    asm.staHLI();
    asm.dec16("bc");
    asm.ld("a", "b");
    asm.alu("or", "c");
    asm.jp(loop, "nz");
    asm.ret();
  });
  return name;
}

/**
 * Copy `B` bytes from `HL` into palette RAM, starting at the index in `A`.
 *
 * `C` is the *index* register's low address and the data port is the byte after
 * it, which is what lets one routine serve both the background and the object
 * palettes. The index auto-increments — bit 7 of the value written to it — so
 * sixty-four bytes cost sixty-four writes rather than a hundred and twenty-eight.
 */
function needCopyPalette(ctx: Ctx): string {
  const name = "CopyPalette";
  ctx.need(name, (inner) => {
    const { asm } = inner;
    asm.staC();
    asm.inc("c");
    const loop = inner.unique("palLoop");
    asm.label(loop);
    asm.ldaHLI();
    asm.staC();
    asm.dec("b");
    asm.jr(loop, "nz");
    asm.ret();
  });
  return name;
}

/** Upload one palette block, `first` palettes into the given index register. */
function emitUploadPalette(
  ctx: Ctx,
  source: ReturnType<typeof label>,
  bytes: number,
  first: number,
  spec: number,
): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  asm.ld16("hl", source);
  asm.ldn("b", bytes);
  asm.ldn("c", spec & 0xff);
  asm.ldn("a", 0x80 | (first * PALETTE_BYTES));
  asm.call(needCopyPalette(ctx));
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

function emitMainLoop(ctx: Ctx, audio: boolean): void {
  const { asm, layout } = ctx;
  asm.label("Main");
  asm.halt();
  asm.nop();
  if (audio) {
    // `halt` wakes on any enabled interrupt, and with the driver running most
    // of them are the timer's. Uploading a frame then would mean writing OAM
    // and the scroll registers in the middle of a scanline.
    asm.ldha(HRAM_VBLANK & 0xff);
    asm.alu("or", "a");
    asm.jr("Main", "z");
    asm.alu("xor", "a");
    asm.stha(HRAM_VBLANK & 0xff);
  }
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
  asm.ldn("a", layout.memory.oamShadow >> 8);
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
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) {
    asm.ldn("a", 0xff);
    asm.sta(layout.sound);
  }
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
  if (ctx.audio?.driver === true && program.tracks.length > 0) asm.call("SceneMusic");
  asm.call("ResetScene");
  if (layout.rng !== null) set32(ctx, layout.rng, program.seed | 0);
  emitClearState(ctx);
  asm.call("UpdateCamera");
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  asm.ret();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request atomic: the driver
  // runs on an interrupt and could arrive between any two instructions.
  if (ctx.audio?.driver === true && program.tracks.length > 0) {
    asm.label("SceneMusic");
    asm.lda(layout.scene);
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.ld16("de", label("SceneTracks"));
    asm.addHL("de");
    asm.ld("a", "hlp");
    asm.stha(ctx.audio.music & 0xff);
    asm.ret();
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
 * The Game Boy's instructions for each of doc 14's tick steps.
 *
 * The *order* is not here: `emitTickSteps` runs them, so this backend supplies
 * the code for a step and has no say in the sequence (`backend.ts` §The tick's).
 */
function tickSteps(ctx: Ctx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      asm.alu("xor", "a");
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.sta(layout.contacts + index);
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.lda(layout.contacts + index);
        asm.sta(layout.contactsPrev + index);
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: Ctx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
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

/** Where one subject's cell list lives. */
function cellSlot(ctx: Ctx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: Ctx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.alu("xor", "a");
  asm.sta(list);
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.aluN("cp", GRID_EMPTY);
    asm.jp(next, "z");
    asm.ld("c", "a");
    asm.lda(list);
    asm.aluN("cp", TILE_CONTACT_MAX);
    asm.jp(next, "nc");
    // hl = list + 1 + count * 5
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.addHL("hl");
    asm.addHL("hl");
    asm.ld("d", "h");
    asm.ld("e", "l");
    asm.lda(list);
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.addHL("de");
    asm.ld16("de", list + 1);
    asm.addHL("de");
    for (const address of [col, col + 1, row, row + 1]) {
      asm.lda(address);
      asm.staHLI();
    }
    asm.ld("a", "c");
    asm.staHLI();
    asm.lda(list);
    asm.inc("a");
    asm.sta(list);
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `A`. */
function emitOverCells(ctx: Ctx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.lda(list);
  asm.alu("or", "a");
  asm.jp(done, "z");
  asm.ld("b", "a");
  asm.ld16("hl", list + 1);
  asm.label(loop);
  for (const address of [col, col + 1, row, row + 1]) {
    asm.ldaHLI();
    asm.sta(address);
  }
  asm.ldaHLI();
  asm.push("hl");
  asm.push("bc");
  body();
  asm.pop("bc");
  asm.pop("hl");
  asm.dec("b");
  asm.jp(loop, "nz");
  asm.label(done);
}

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

      walk(subjectId, base, () => {
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
    walk(subjectId, base, () => {
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
  emitSound(ctx, rule);
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
  emitFullRedraw(ctx, scene, level, options);
  asm.alu("xor", "a");
  asm.sta(layout.redraw);
  asm.sta(layout.plotPrevCount);
  const afterScroll = ctx.unique("afterScroll");
  asm.jp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with sprites instead (see
  // {@link emitHudSprites}); one that does not gets it as background cells,
  // which costs no OAM at all.
  if (!scrolls(ctx, scene)) {
    // Restore the level tiles the HUD covered last frame, then draw it again.
    // Only the objects that can change: the captions were painted with the
    // background and are still there.
    emitHudErase(ctx, scene, level, options);
    asm.alu("xor", "a");
    asm.sta(layout.plotCount);
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
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
function emitFullRedraw(
  ctx: Ctx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: EmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.call("LcdOff");
  const backdrop = options.backdrops?.get(scene.def.name);
  if (ctx.color) {
    // A scene's background palettes are the scene's: a picture's own where it
    // is a title screen, the level art's where there is a level. They go up
    // here rather than at boot because a scene change is exactly when they
    // change, and it is already the one moment the LCD is off.
    const block = scenePalettes(scene, level, options);
    if (block) emitUploadPalette(ctx, label(block.name), block.bytes.length, 0, R.BCPS);
  } else {
    // A picture brings its own palette; everything else uses the plain ramp the
    // font and the level patterns were drawn for.
    asm.ldn("a", backdrop?.bgp ?? 0b11100100);
    asm.stha(R.BGP & 0xff);
  }

  // A backdrop is a whole screen of map bytes in order, so painting it is a
  // block copy: one row of twenty, then twelve bytes of stride to the next.
  // The general path below asks a routine for every one of the 360 cells to
  // reach the same answer, and costs about as much ROM as the picture does.
  if (backdrop && !level) {
    asm.ld16("hl", label(backdropLabel(scene)));
    asm.ld16("de", VRAM_MAP);
    asm.call(needCopyScreen(ctx));
    if (ctx.color && backdrop.attr) {
      // The attributes are the same screenful again, in the other bank, and
      // they follow the map under the same label.
      emitVramBank(ctx, 1);
      asm.ld16("hl", label(backdropLabel(scene), backdrop.map.length));
      asm.ld16("de", VRAM_MAP);
      asm.call(needCopyScreen(ctx));
      emitVramBank(ctx, 0);
    }
    if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
    asm.ldn("a", 0b10010011);
    asm.stha(R.LCDC & 0xff);
    return;
  }
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

  // A backdrop is exactly the window, so the extra row and column a scrolling
  // level needs would read past the end of its map.
  const painted = options.backdrops?.has(scene.def.name) && !level ? 0 : 1;
  const rowLoop = ctx.unique("fullRow");
  const colLoop = ctx.unique("fullCol");
  asm.ldn("b", layout.memory.viewH + painted);
  asm.label(rowLoop);
  asm.push("bc");
  asm.lda(layout.words + W.firstCol * 2);
  asm.sta(layout.words + W.tileCol * 2);
  asm.lda(layout.words + W.firstCol * 2 + 1);
  asm.sta(layout.words + W.tileCol * 2 + 1);
  asm.ldn("b", layout.memory.viewW + painted);
  asm.label(colLoop);
  asm.push("bc");
  emitBackgroundTile(ctx, scene, level, options);
  asm.ld("c", "a");
  asm.call("VramFor");
  asm.ld("a", "c");
  asm.ld("hlp", "a");
  if (ctx.color) {
    // The attribute lives at the same address in the other bank, and `HL` is
    // still pointing at it.
    emitVramBank(ctx, 1);
    asm.lda(layout.attr);
    asm.ld("hlp", "a");
    emitVramBank(ctx, 0);
  }
  emitIncWord(ctx, layout.words + W.tileCol * 2);
  asm.pop("bc");
  asm.dec("b");
  asm.jp(colLoop, "nz");
  emitIncWord(ctx, layout.words + W.tileRow * 2);
  asm.pop("bc");
  asm.dec("b");
  asm.jp(rowLoop, "nz");
  // Captions go on now, with the background they sit on. A scrolling scene
  // draws its whole HUD with sprites instead, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  // The LCD comes back on with the picture already correct.
  asm.ldn("a", 0b10010011);
  asm.stha(R.LCDC & 0xff);
}

/** The label holding one scene's backdrop map, then its attributes. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}

/** The label holding one backdrop scene's own background palettes. */
function backdropPaletteLabel(scene: SceneCtx): string {
  return `BackdropPal_${scene.index}`;
}

/**
 * The background palette block a scene paints under, on a colour build.
 *
 * A level's art is fitted once for the whole game, so every level scene shares
 * one block; a backdrop is fitted per picture, so a title screen brings its
 * own. A scene with neither has nothing but system-palette cells on its
 * background and needs no upload at all.
 */
function scenePalettes(
  scene: SceneCtx,
  level: LevelData | undefined,
  options: EmitOptions,
): { name: string; bytes: Uint8Array } | undefined {
  if (!level) {
    const backdrop = options.backdrops?.get(scene.def.name);
    if (backdrop?.palettes && backdrop.palettes.length > 0) {
      return { name: backdropPaletteLabel(scene), bytes: backdrop.palettes };
    }
  }
  if (options.tilePalettes && options.tilePalettes.length > 0) {
    return { name: "TilePalettes", bytes: options.tilePalettes };
  }
  return undefined;
}

/** Copy one screenful of cells into the tile map, twelve bytes of stride a row. */
function needCopyScreen(ctx: Ctx): string {
  const name = "CopyScreen";
  ctx.need(name, (inner) => {
    const { asm } = inner;
    const rowLoop = inner.unique("scrRow");
    const colLoop = inner.unique("scrCol");
    const { viewW, viewH } = inner.layout.memory;
    asm.ldn("b", viewH);
    asm.label(rowLoop);
    asm.ldn("c", viewW);
    asm.label(colLoop);
    asm.ldaHLI();
    asm.staDE();
    asm.inc16("de");
    asm.dec("c");
    asm.jr(colLoop, "nz");
    asm.ld("a", "e");
    asm.aluN("add", 32 - viewW);
    asm.ld("e", "a");
    asm.ld("a", "d");
    asm.aluN("adc", 0);
    asm.ld("d", "a");
    asm.dec("b");
    asm.jr(rowLoop, "nz");
    asm.ret();
  });
  return name;
}

/** Record the system palette as the attribute of the cell about to be written. */
function emitSystemAttr(ctx: Ctx): void {
  if (!ctx.color) return;
  ctx.asm.ldn("a", SYSTEM_PALETTE);
  ctx.asm.sta(ctx.layout.attr);
}

/**
 * `A` = the background tile that belongs at `words[tileCol], words[tileRow]`.
 *
 * Three kinds of scene answer it three ways — a level looks the cell up in its
 * grid and through its legend, a backdrop reads the demade tilemap, and a scene
 * with neither is blank — and both the full redraw and the HUD's erase pass need
 * the same answer, so they ask here.
 */
function emitBackgroundTile(
  ctx: Ctx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: EmitOptions,
): void {
  const { asm, layout } = ctx;
  if (level) {
    asm.call(tileAtLabel(level));
    emitLegendToTile(ctx, level);
    return;
  }
  // A backdrop nobody supplied bytes for leaves the background blank, exactly
  // as an object with no art draws the built-in block: absent, never half-drawn.
  if (!options.backdrops?.has(scene.def.name)) {
    emitSystemAttr(ctx);
    asm.alu("xor", "a");
    return;
  }
  const outside = ctx.unique("bdOutside");
  const done = ctx.unique("bdDone");
  // A cell off the picture is blank rather than a byte from whatever follows
  // the map: the HUD is free to sit anywhere, including past the last column.
  emitAtLeastConst(ctx, layout.words + W.tileCol * 2, layout.memory.viewW, outside);
  emitAtLeastConst(ctx, layout.words + W.tileRow * 2, layout.memory.viewH, outside);
  asm.lda(layout.words + W.tileRow * 2);
  asm.ld("l", "a");
  asm.lda(layout.words + W.tileRow * 2 + 1);
  asm.ld("h", "a");
  emitMulConst16(ctx, layout.memory.viewW);
  asm.lda(layout.words + W.tileCol * 2);
  asm.ld("e", "a");
  asm.lda(layout.words + W.tileCol * 2 + 1);
  asm.ld("d", "a");
  asm.addHL("de");
  asm.ld16("de", label(backdropLabel(scene)));
  asm.addHL("de");
  asm.ld("a", "hlp");
  if (ctx.color) {
    // The picture's attributes are the same screenful again, right behind its
    // map, so the cell's attribute is one fixed offset from its tile.
    asm.ld("c", "a");
    asm.ld16("de", layout.memory.viewW * layout.memory.viewH);
    asm.addHL("de");
    asm.ld("a", "hlp");
    asm.sta(layout.attr);
    asm.ld("a", "c");
  }
  asm.jp(done);
  asm.label(outside);
  emitSystemAttr(ctx);
  asm.alu("xor", "a");
  asm.label(done);
}

/** Jump to `target` when the unsigned word at `addr` is at least `value`. */
function emitAtLeastConst(ctx: Ctx, addr: number, value: number, target: string): void {
  const { asm } = ctx;
  const below = ctx.unique("bdBelow");
  asm.lda(addr + 1);
  asm.alu("or", "a");
  asm.jp(target, "nz");
  asm.lda(addr);
  asm.aluN("cp", value);
  asm.jp(target, "nc");
  asm.label(below);
}

/** `A = the background tile for the legend index in A`. */
function emitLegendToTile(ctx: Ctx, level: LevelData): void {
  const { asm, layout } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.aluN("cp", GRID_EMPTY);
  asm.jp(empty, "z");
  asm.ld("e", "a");
  asm.ldn("d", 0);
  asm.ld16("hl", label(level.tileLabel));
  asm.addHL("de");
  asm.ld("a", "hlp");
  if (ctx.color) {
    // The legend's attributes are a parallel table, so the same index reaches
    // both — and `DE` still holds it.
    asm.ld("c", "a");
    asm.ld16("hl", label(level.attrLabel));
    asm.addHL("de");
    asm.ld("a", "hlp");
    asm.sta(layout.attr);
    asm.ld("a", "c");
  }
  asm.jp(done);
  asm.label(empty);
  emitSystemAttr(ctx);
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
  emitPaintEdge(ctx, level, isColumn, isColumn ? ctx.layout.memory.viewW : ctx.layout.memory.viewH);
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
  const count = isColumn ? layout.memory.viewH + 1 : layout.memory.viewW + 1;

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
function emitHudErase(
  ctx: Ctx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: EmitOptions,
): void {
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
  emitBackgroundTile(ctx, scene, level, options);
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
function emitHud(ctx: Ctx, scene: SceneCtx, want: "static" | "dynamic"): void {
  const { asm, layout, program } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;
    if ((hudIsStatic(ctx, id) ? "static" : "dynamic") !== want) continue;

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

    // A static object is painted straight into VRAM with the LCD already off,
    // so it needs neither the write queue nor a place in the erase list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, 20)) {
        asm.ldn("a", glyphTile(character));
        asm.call(plot);
      }
    } else {
      asm.ld16("hl", base + propOffset("value") + 2);
      asm.call(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `A = tile`: write it at the current cell and advance the column. */
function needPokeCell(ctx: Ctx): string {
  const name = "PokeCell";
  ctx.need(name, (inner) => {
    const { asm, layout } = inner;
    asm.ld("c", "a");
    asm.call("VramFor");
    asm.ld("a", "c");
    asm.ld("hlp", "a");
    if (inner.color) {
      // Painted with the LCD already off, so this writes both banks directly
      // rather than going through the queue.
      emitVramBank(inner, 1);
      asm.ldn("a", SYSTEM_PALETTE);
      asm.ld("hlp", "a");
      emitVramBank(inner, 0);
    }
    emitIncWord(inner, layout.words + W.tileCol * 2);
    asm.ret();
  });
  return name;
}

/** The decimal renderer again, writing straight to VRAM. */
function needPokeNumber(ctx: Ctx): string {
  const name = "DrawNumberPoke";
  ctx.need(name, (inner) => {
    emitDecimal(inner, needPokeCell(inner), inner.layout.words + W.target * 2);
  });
  return name;
}

/**
 * `HL` = entity base, `B` = cells wide, `C` = cells high → `A` is zero when the
 * object is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the
 * high half of a 16.16 coordinate *is* the cell it sits in, so this is a
 * sixteen-bit subtract and two sign tests per axis and touches no fixed-point
 * arithmetic at all. The margins are rounded outward by a cell, so an object
 * straddling the edge is never culled — the test may say "maybe" when the answer
 * is no, and never the other way round.
 */
function needOnscreen(ctx: Ctx): string {
  const name = "Onscreen";
  ctx.need(name, (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");

    asm.ld("a", "l");
    asm.sta(layout.cull);
    asm.ld("a", "h");
    asm.sta(layout.cull + 1);

    /** `HL = entity.<prop> cell − camera.<axis> cell`, then range-test it. */
    const axis = (offset: number, margin: "b" | "c", span: number): void => {
      asm.lda(layout.cull);
      asm.ld("l", "a");
      asm.lda(layout.cull + 1);
      asm.ld("h", "a");
      asm.ld16("de", offset + 2);
      asm.addHL("de");
      asm.ldaHLI();
      asm.ld("e", "a");
      asm.ld("a", "hlp");
      asm.ld("d", "a");
      asm.ld16("hl", camera + offset + 2);
      asm.ld("a", "e");
      asm.alu("sub", "hlp");
      asm.ld("e", "a");
      asm.inc16("hl");
      asm.ld("a", "d");
      asm.alu("sbc", "hlp");
      asm.ld("d", "a");
      asm.ld("h", "d");
      asm.ld("l", "e");
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.ldn("d", 0);
      asm.ld("e", margin);
      asm.push("hl");
      asm.addHL("de");
      asm.ld("a", "h");
      asm.pop("hl");
      asm.bit(7, "a");
      asm.jp(apart, "nz");
      // Off the far side: the object's near edge is past the last visible cell.
      asm.ld16("de", (0x10000 - (span + 1)) & 0xffff);
      asm.addHL("de");
      asm.bit(7, "h");
      asm.jp(apart, "z");
    };
    axis(propOffset("x"), "b", layout.memory.viewW);
    axis(propOffset("y"), "c", layout.memory.viewH);

    asm.ldn("a", 1);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
  return name;
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

    // The collision box is the sprite's footprint, in whole cells — *this*
    // object's box, not its class's and not the largest one the file was
    // converted at. Anything else draws ledge where nothing can be stood on.
    const width = instanceCells(instance, "width");
    const height = instanceCells(instance, "height");
    // A caller that supplied its own bank keyed by plain name still works.
    const art = options.sprites?.get(artKey(asset, width, height)) ?? options.sprites?.get(asset);

    const skip = ctx.unique("oamSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      isZero32(ctx, (layout.entities[id] as number) + propOffset("visible"));
      asm.jp(skip, "z");
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }
    const base = layout.entities[id] as number;
    // An object the view does not cover needs none of the work below: not the
    // subtraction, not the shifts, not an OAM entry. In a level bigger than the
    // screen that is most of them most of the time — a cavern's worth of coins
    // is eleven objects off screen and one on it.
    if (layout.camera !== null && fixedCells(ctx, id)) {
      asm.ld16("hl", base);
      asm.ldn("b", width);
      asm.ldn("c", height);
      asm.call(needOnscreen(ctx));
      asm.alu("or", "a");
      asm.jp(skip, "z");
    }
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

    // On colour hardware an object names its own palette, and its tiles may sit
    // in the second VRAM bank; both live in the attribute byte, and both are
    // compile-time constants because the art was bound at build time.
    const attribute = art ? (art.palette ?? 0) | (art.tile > 0xff ? 0x08 : 0) : SYSTEM_PALETTE;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE;
        asm.lda(layout.words + W.count * 2);
        asm.aluN("add", row * 8 + 16);
        asm.ld("b", "a");
        asm.lda(layout.words + W.temp * 2);
        asm.aluN("add", column * 8 + 8);
        asm.ld("c", "a");
        asm.ldn("d", tile & 0xff);
        if (ctx.color) {
          asm.ldn("e", attribute);
          asm.call("PushSpriteAttr");
        } else {
          asm.call("PushSprite");
        }
      }
    }
    asm.label(skip);
  }
  if (scrolls(ctx, scene)) emitHudSprites(ctx, scene);
  asm.call("ClearRestOfOam");
}

/**
 * Draw a scrolling scene's `number` and `text` objects as hardware sprites.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already
 * wrote — only the layer differs. The pen lives in the two scratch words the
 * OAM builder already uses for a sprite's screen position, so the glyph routine
 * is four instructions and a call.
 */
function emitHudSprites(ctx: Ctx, scene: SceneCtx): void {
  const { asm, layout, program } = ctx;
  const penX = layout.words + W.temp * 2;
  const penY = layout.words + W.count * 2;

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;

    const skip = ctx.unique("hudOamSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      isZero32(ctx, (layout.entities[id] as number) + propOffset("visible"));
      asm.jp(skip, "z");
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      asm.label(skip);
      continue;
    }

    const base = layout.entities[id] as number;
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, base + propOffset("x"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera);
      emitPixelsFromFixed(ctx, temp, penX);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera + 4);
      emitPixelsFromFixed(ctx, temp, penY);
    });
    // OAM counts from eight pixels left of the screen and sixteen above it.
    asm.lda(penX);
    asm.aluN("add", 8);
    asm.sta(penX);
    asm.lda(penY);
    asm.aluN("add", 16);
    asm.sta(penY);

    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, 20)) {
        asm.ldn("a", glyphTile(character));
        asm.call(needHudGlyph(ctx));
      }
    } else {
      asm.ld16("hl", base + propOffset("value") + 2);
      asm.call(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `A = tile`: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: Ctx): string {
  const name = "HudGlyph";
  ctx.need(name, (inner) => {
    const { asm, layout } = inner;
    asm.ld("d", "a");
    asm.lda(layout.words + W.count * 2);
    asm.ld("b", "a");
    asm.lda(layout.words + W.temp * 2);
    asm.ld("c", "a");
    // The font's own palette — OBP1 on a monochrome build, the reserved object
    // palette on a colour one. Either way it is the plain ramp the glyphs were
    // drawn for, and never the palette the art around them chose.
    asm.ldn("e", inner.color ? SYSTEM_PALETTE : 0x10);
    asm.call("PushSpriteAttr");
    asm.lda(layout.words + W.temp * 2);
    asm.aluN("add", 8);
    asm.sta(layout.words + W.temp * 2);
    asm.ret();
  });
  return name;
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: Ctx): string {
  const name = "DrawNumberOam";
  ctx.need(name, (inner) => {
    // The pen occupies `temp`, so the leading-zero flag needs a word of its
    // own; `target` is only live during tile-contact bookkeeping, which is a
    // different phase of the tick entirely.
    emitDecimal(inner, needHudGlyph(inner), inner.layout.words + W.target * 2);
  });
  return name;
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

  // A = tile; queue it at the current cell, with the attribute the cell routine
  // left behind on a colour build.
  asm.label("QueueCell");
  asm.ld("c", "a");
  asm.lda(layout.queueCount);
  asm.aluN("cp", layout.memory.queueMax);
  asm.ret("nc");
  asm.push("bc");
  asm.call("VramFor");
  asm.pop("bc");
  asm.ld("d", "h");
  asm.ld("e", "l");
  asm.lda(layout.queueCount);
  asm.ld("l", "a");
  asm.ldn("h", 0);
  if (layout.queueStride === 4) {
    asm.addHL("hl");
    asm.addHL("hl");
  } else {
    asm.push("de");
    asm.ld("d", "h");
    asm.ld("e", "l");
    asm.addHL("hl");
    asm.addHL("de");
    asm.pop("de");
  }
  asm.push("de");
  asm.ld16("de", layout.queue);
  asm.addHL("de");
  asm.pop("de");
  asm.ld("a", "e");
  asm.staHLI();
  asm.ld("a", "d");
  asm.staHLI();
  asm.ld("a", "c");
  asm.staHLI();
  if (layout.queueStride === 4) {
    asm.lda(layout.attr);
    asm.staHLI();
  }
  asm.lda(layout.queueCount);
  asm.inc("a");
  asm.sta(layout.queueCount);
  asm.ret();

  // A = tile; queue it, record the cell for erasing, and advance the column.
  asm.label("PlotCell");
  if (ctx.color) {
    // A HUD cell is the font's, whatever the art it is drawn over chose. `B` is
    // free here: every caller pushes it around the call.
    asm.ld("b", "a");
    emitSystemAttr(ctx);
    asm.ld("a", "b");
  }
  asm.push("af");
  asm.call("QueueCell");
  asm.pop("af");
  asm.lda(layout.plotCount);
  asm.aluN("cp", layout.memory.plotMax);
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
  // built from the shadow's page rather than with a 16-bit load — that
  // form overwrites the tile number with the address's high byte, and the cost
  // is forty objects all drawing whatever tile happens to live at $C0.
  // `PushSpriteAttr` takes the attribute byte in E as well, which is how a HUD
  // glyph asks for OBP1; the plain entry point falls through with zero.
  asm.label("PushSprite");
  asm.ldn("e", 0);
  asm.label("PushSpriteAttr");
  asm.lda(layout.oamCount);
  asm.aluN("cp", layout.memory.oamEntries);
  asm.ret("nc");
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld("l", "a");
  asm.ldn("h", layout.memory.oamShadow >> 8);
  asm.ld("a", "b");
  asm.staHLI();
  asm.ld("a", "c");
  asm.staHLI();
  asm.ld("a", "d");
  asm.staHLI();
  asm.ld("a", "e");
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
  asm.ldn("h", layout.memory.oamShadow >> 8);
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
  if (layout.queueStride === 4) asm.inc16("hl");
  asm.dec("b");
  asm.jp(flush, "nz");
  if (layout.queueStride === 4) {
    // The attributes are a second pass rather than a bank switch per cell:
    // switching costs two register writes each way, and the list is short.
    emitVramBank(ctx, 1);
    asm.lda(layout.queueCount);
    asm.ld("b", "a");
    asm.ld16("hl", layout.queue);
    const attrFlush = ctx.unique("flushAttr");
    asm.label(attrFlush);
    asm.ldaHLI();
    asm.ld("e", "a");
    asm.ldaHLI();
    asm.ld("d", "a");
    asm.inc16("hl");
    asm.ldaHLI();
    asm.staDE();
    asm.dec("b");
    asm.jp(attrFlush, "nz");
    emitVramBank(ctx, 0);
  }
  asm.alu("xor", "a");
  asm.sta(layout.queueCount);
  asm.label(noQueue);
  // The transfer holds the main bus, so the CPU can only reach high RAM while
  // it runs — and an interrupt vector is not in high RAM. The driver's tick is
  // delayed by the transfer's 160 cycles, which is a fortieth of its period.
  if (ctx.audio?.driver === true) asm.di();
  asm.call(HRAM_DMA);
  if (ctx.audio?.driver === true) asm.ei();
  asm.ret();

  // HL points at the low byte of a value's whole part; draw it in decimal.
  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell", layout.words + W.temp * 2);

  asm.label("DecimalPowers");
  asm.dw(10000);
  asm.dw(1000);
  asm.dw(100);
  asm.dw(10);
  asm.dw(1);
}

/**
 * Draw the signed 16-bit value at HL in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the sprite one — which
 * is why it is a parameter rather than a second copy of the digit loop.
 * `flag` is a byte remembering whether a significant digit has been seen, so
 * leading zeroes are suppressed and a lone zero still prints.
 */
function emitDecimal(ctx: Ctx, plot: string, flag: number): void {
  const { asm } = ctx;
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
  asm.call(plot);
  asm.pop("de");
  asm.label(positive);
  asm.ld16("hl", label("DecimalPowers"));
  asm.ldn("c", 5);
  asm.alu("xor", "a");
  asm.sta(flag);
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
  asm.lda(flag);
  asm.alu("or", "a");
  asm.jp(emitDigit, "nz");
  asm.ld("a", "c");
  asm.dec("a");
  asm.jp(skipDigit, "nz");
  asm.label(emitDigit);
  asm.ldn("a", 1);
  asm.sta(flag);
  asm.ld("a", "b");
  asm.aluN("add", glyphTile("0"));
  asm.push("bc");
  asm.push("de");
  asm.call(plot);
  asm.pop("de");
  asm.pop("bc");
  asm.label(skipDigit);
  asm.pop("hl");
  asm.dec("c");
  asm.jp(powerLoop, "nz");
  asm.ret();
}

// --- data --------------------------------------------------------------------

export { artKey };
export type { SpriteArt };
