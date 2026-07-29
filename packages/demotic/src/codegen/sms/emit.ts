/**
 * The whole-program emitter for the Sega 8-bits: boot, the frame, the renderer.
 *
 * Everything here is per *scene*, for the reason the other two backends give: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and five differences are load-bearing:
 *
 *   - **The tile bank is RAM, and has to be uploaded.** The NES addresses
 *     characters straight out of the cartridge; here they live in the VDP's own
 *     16 KiB and boot copies them in. That is the Game Boy's arrangement, at four
 *     times the size — and it is why the bank is capped at 256 tiles rather than
 *     the 448 that would fit: a sprite's tile number is one byte, so anything a
 *     *sprite* can draw has to be below 256, and a second bank for the
 *     background would be two budgets to explain and one more thing to get wrong.
 *   - **Scrolling is two registers, not a nametable bit.** `R8` shifts the
 *     picture horizontally and `R9` vertically, and the name table wraps at 32
 *     columns and 28 rows on its own. So the runtime never chooses which of two
 *     tables a cell belongs to; it paints the leading edge and writes a byte.
 *   - **The name table is exactly as wide as a Master System's screen, and wider
 *     than a Game Gear's.** Thirty-two columns against thirty-two leaves a
 *     scrolling Master System *no* spare column: the cell a new column is written
 *     into is the one straddling the screen's left edge, and masking that column
 *     (`R0` bit 5) is what makes the seam invisible. A Game Gear's window is
 *     twenty of the same thirty-two, so it has twelve spare columns and no seam
 *     at all — which is why the horizontal edge painter asks
 *     {@link spareColumn} rather than assuming the wrap.
 *   - **There are two palettes and the background chooses per cell.** Bit 3 of a
 *     name-table entry selects colour bank 0 or 1. Art draws in bank 0; the
 *     font, the level patterns and the placeholder block draw in bank 1, which is
 *     also the sprites' — so one reservation covers the HUD on both layers.
 *   - **A Game Gear is the same VDP behind a smaller window.** The chip renders
 *     the whole 256×192 frame and the LCD shows the middle 160×144, so the
 *     scroll registers carry a fixed bias that puts name-table cell (0,0) at the
 *     window's top left. Nothing else in this file asks which console it is.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 */

import { AUDIO_STOP, type SmsGameAudio } from "@demake/audio";
import { label, type Ref } from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import {
  BUILTIN_TILES as BUILTIN_TILE_COUNT,
  glyphTile,
  OBJECT_TILE,
  patternTile,
} from "../../rom/graphics.js";
import { isMutable } from "../analyze.js";
import { emitTickSteps, type TickSteps } from "../backend.js";
import { ENTITY_SIZE, PROPS, TILE_CONTACT_MAX, W } from "../layout.js";
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
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { SmsCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
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
  emitTileAt,
  emitTileSeparate,
  emitTilesUnder,
  GRID_EMPTY,
  inc16,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "./tiles.js";
import { branchZero32, copy32, mem, sub32 } from "./val.js";

/** The two VDP ports, and the controller's. */
const PORT = {
  /** Read or write VRAM and colour RAM through the address the control port set. */
  DATA: 0xbe,
  /** Two-byte address and command writes; reading it is the status byte. */
  CONTROL: 0xbf,
  /** Player one's six inputs, active low. */
  JOY1: 0xdc,
  /** The Game Gear's Start button and region bit. */
  GG_START: 0x00,
  /** The sound chip, which answers on either half of `$40`–`$7F`. */
  PSG: 0x7f,
} as const;

/** Where the VDP's tables live, which the register writes at boot decide. */
const VRAM = {
  /** The shared tile bank: 256 tiles of 32 bytes. */
  TILES: 0x0000,
  /** The name table: 32×28 entries of two bytes. */
  NAME: 0x3800,
  /** The sprite attribute table: 64 Y bytes, then 64 (X, tile) pairs. */
  SAT: 0x3f00,
} as const;

/** Cells the name table holds. Wider than the Game Gear's window, taller than both screens. */
const MAP_W = 32;
const MAP_H = 28;

/** Tiles the bank holds — a sprite's tile number is a single byte. */
export const BANK_TILES = 256;

/**
 * Colour-RAM entries reserved for the font, the level patterns and the block an
 * object draws as before its art is bound.
 *
 * The Game Boy Color build keeps a whole sub-palette back for this and the NES
 * keeps one of four; here there are two palettes and no third, so the
 * reservation is three *entries* at the top of the sprite bank instead. The
 * built-in tiles are re-indexed onto them when the bank is packed, and the
 * sprite fit is told it has that many fewer colours — which is what keeps a
 * score legible over art whose own palette was chosen for the art.
 */
export const SYSTEM_COLORS = 3;

/** Colour index the built-in tiles' ink lands on. */
export const SYSTEM_INK = 15;

/** Colours a sprite fit may use, transparency included. */
export const SPRITE_COLORS = 16 - SYSTEM_COLORS;

/**
 * Where the visible window sits inside the frame the VDP renders.
 *
 * Zero on a Master System, whose screen *is* the frame. A Game Gear shows the
 * middle 160×144 of the same 256×192 picture, so the window's top left is 48
 * pixels in and 24 down — and everything the runtime draws in *screen* pixels has
 * to be put there, or the game plays in a rectangle the LCD does not show.
 *
 * Two layers reach it by different roads, which is the whole reason this is one
 * number in one place. The background is moved by the scroll registers
 * ({@link scrollBias}); an object's position is a **frame** coordinate the VDP
 * reads straight out of the sprite table, so it carries the origin itself
 * ({@link needPushSprite}). Bias one and not the other and the two layers
 * disagree about where the top of the world is: a paddle at `y 0` lands 24 lines
 * above the window and is simply not there.
 */
function windowOrigin(ctx: SmsCtx): { x: number; y: number } {
  return ctx.gameGear ? { x: 48, y: 24 } : { x: 0, y: 0 };
}

/**
 * Whether the name table has a column the window does not show.
 *
 * The whole of horizontal scrolling turns on this. A Master System's screen is
 * all thirty-two columns, so the cell a new column goes into is the one already
 * straddling the left edge — hence the mask, and hence a leftward step painting
 * offset one rather than offset zero. A Game Gear shows twenty of the same
 * thirty-two, so the incoming column has a cell of its own on either side and
 * both of those workarounds become the bug: the mask blanks nothing the LCD
 * shows, and offset one skips the column that has just come into view.
 *
 * Vertically the answer is always yes — twenty-eight rows against twenty-four or
 * eighteen — which is why the rows have never needed to ask.
 */
function spareColumn(ctx: SmsCtx): boolean {
  return ctx.layout.memory.viewW < MAP_W;
}

/**
 * The byte the frame interrupt raises and the main loop waits on.
 *
 * Its own byte, not a scratch word. An interrupt lands in the middle of whatever
 * the game was doing, and everything in `layout.scratch` is documented as valid
 * for the length of one routine — so a flag parked there is a flag written over
 * somebody's working value. It was `S.w3`, which `Mod16` uses for its divisor,
 * and a frame boundary inside the sixteen-iteration loop of `random()` therefore
 * produced a draw outside its own bounds. Nothing named the tick, because the
 * tick that broke was whichever one the raster happened to cross.
 */
function frameFlag(ctx: SmsCtx): number {
  return ctx.layout.interrupt as number;
}

/** The Pause key's latch, which the input read turns into an edge. */
function pauseFlag(ctx: SmsCtx): number {
  return (ctx.layout.interrupt as number) + 1;
}

/** The same origin, as the two scroll registers want it. */
function scrollBias(ctx: SmsCtx): { x: number; y: number } {
  const origin = windowOrigin(ctx);
  // The horizontal register shifts the picture right and the vertical one shifts
  // it up, which is why one bias is added and the other subtracted from the wrap.
  return { x: origin.x, y: (MAP_H * 8 - origin.y) % (MAP_H * 8) };
}

/** Everything the emitter needs beyond the program itself. */
export interface SmsEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number }>;
  /** Demade backdrops by scene name: the name table the picture fills. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The 4bpp tile bank, uploaded to video RAM at boot. */
  bank?: Uint8Array;
  /** Colour RAM as the art chose it: sixteen background entries, then sixteen sprite. */
  palette?: Uint8Array;
  /** Per-scene colour RAM, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
  /**
   * The game's audio driver, already built from its demade tracks and effects.
   *
   * Absent for a game with no audio, and then the ROM is exactly what it was
   * before sound existed — no counter in the interrupt, no service call in the
   * main loop, no driver. Pulled in by a game that asks for it, like everything
   * else.
   */
  audio?: SmsGameAudio;
  /** Driver index of each of the program's sounds, or `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Which track each scene plays, as an index into the driver's table. */
  sceneTracks?: readonly number[];
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: SmsCtx, labels: readonly string[]): void {
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
    ctx.far("z", target);
  }
}

/** Emit the whole program. */
export function emitProgram(ctx: SmsCtx, options: SmsEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitVectors(ctx, options);
  emitReset(ctx, options);
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
    const boundTile = (index: number): number => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern.
      return bound?.tile ?? patternTile(index, level.file.tiles[index]?.solid ?? false);
    };
    emitLevelData(asm, level, (index) => boundTile(index) & 0xff);
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
      }
    }
  }
  emitInstanceDefaults(asm, program, PROPS);

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (art) {
      asm.label(backdropLabel(scene));
      asm.bytes(packCells(art.map));
    }
    const palette = options.scenePalettes?.get(scene.def.name);
    if (palette) {
      asm.label(scenePaletteLabel(scene));
      asm.bytes(palette);
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
  asm.bytes(options.bank ?? new Uint8Array(0));
  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette(ctx.gameGear));
}

/**
 * The colour RAM a build with no demade art uses.
 *
 * Both banks are the font's ramp, so a caption and a placeholder block are
 * legible with nothing else uploaded: black behind, then three rising greys in
 * the reserved entries. A Master System colour is one byte of `--BBGGRR` and a
 * Game Gear's is two of `----BBBBGGGGRRRR`, so this table is as long as the
 * upload that reads it — thirty-two colours, in this console's bytes.
 */
function defaultPalette(gameGear: boolean): Uint8Array {
  const greys = gameGear
    ? [0x55, 0x05, 0xaa, 0x0a, 0xff, 0x0f]
    : [0x15, 0x00, 0x2a, 0x00, 0x3f, 0x00];
  const width = gameGear ? 2 : 1;
  const bank = (): number[] => {
    const entries = new Array<number>(16 * width).fill(0x00);
    for (let shade = 0; shade < 3; shade += 1) {
      for (let byte = 0; byte < width; byte += 1) {
        entries[(SYSTEM_INK - 2 + shade) * width + byte] = greys[shade * 2 + byte] as number;
      }
    }
    return entries;
  };
  return Uint8Array.from([...bank(), ...bank()]);
}

// --- boot --------------------------------------------------------------------

/**
 * The two entry points the hardware defines, and nothing else at a fixed address.
 *
 * The Z80 resets to `$0000`, takes a maskable interrupt to `$0038` in mode 1, and
 * a non-maskable one to `$0066`. So the first bytes of the cartridge are a jump
 * over the vectors rather than a header the console reads — unlike both other
 * machines, where the entry point is data.
 */
function emitVectors(ctx: SmsCtx, options: SmsEmitOptions): void {
  const { asm } = ctx;
  asm.label("Boot");
  asm.di();
  asm.jp("Reset");

  asm.padTo(0x0038);
  asm.label("Irq");
  // The frame interrupt, and the whole of what it does: say that the frame
  // happened. The upload is the main loop's, exactly as on the other two
  // consoles, so the loop owns the scratch the renderer uses and no interrupt
  // can arrive in the middle of a tick's use of it.
  asm.push("af");
  asm.inN(PORT.CONTROL); // reading the status byte is how the VDP is acknowledged
  asm.ldn("a", 1);
  asm.sta(frameFlag(ctx));
  // The driver's tick is *counted* here and performed in the main loop, exactly
  // as on the NES and for the same reason: the blanking interval is the
  // picture's, and a driver tick taken here is a tick the tilemap upload waits
  // behind. A frame the game overran is then owed rather than lost, which is what
  // keeps the tempo the frame's rather than the loop's. `AudioFrame` touches `a`
  // and the flags and nothing else, which is why `af` alone is saved.
  if (options.audio) asm.call(options.audio.routines.frame);
  asm.pop("af");
  asm.ei();
  asm.reti();

  asm.padTo(0x0066);
  asm.label("Nmi");
  // Pause. The language's `start` is this button on a Master System (doc 14
  // §Buttons), so the handler records the press and the input read turns it into
  // an edge like any other.
  asm.push("af");
  asm.ldn("a", 1);
  asm.sta(pauseFlag(ctx));
  asm.pop("af");
  asm.retn();
}

function emitReset(ctx: SmsCtx, options: SmsEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.ld16("sp", 0xdff0);
  asm.im(1);

  // Clear the console's whole 8 KiB, so a game's state starts from zero rather
  // than from whatever powered up — including the object shadow, whose sprites
  // would otherwise appear before the first frame is built.
  asm.ld16("hl", 0xc000);
  asm.ld16("de", 0xc001);
  asm.ld16("bc", 0x1ffe);
  asm.ldn("hlp", 0);
  asm.ldir();

  emitVdpInit(ctx);
  emitTileUpload(ctx, options.bank?.length ?? 0);
  emitPaletteUpload(ctx, "Palette");
  emitBlankNameTable(ctx);

  // Every entity starts from its declared values, not just the entry scene's: a
  // rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    emitCopyBlock(
      ctx,
      label(`Defaults_${instance.id}`),
      layout.entities[instance.id] as number,
      ENTITY_SIZE,
    );
  }

  asm.alu("xor", "a");
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
  ]) {
    asm.sta(address);
  }
  asm.ldn("a", layout.memory.oamEntries);
  asm.sta(layout.oamPrev);
  asm.ldn("a", 0xff);
  asm.sta(layout.pending);
  asm.ldn("a", sceneIndexOf(program, program.entryScene));
  asm.sta(layout.scene);
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.call("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.ld16("hl", 0);
    for (let index = 0; index < 8; index += 2) asm.st16To(layout.camera + index, "hl");
  }
  asm.call("BuildFrame");
  asm.call("UploadFrame");

  if (options.audio) {
    asm.call("AudioInit");
    if (program.tracks.length > 0) asm.call("SceneMusic");
  }

  // Display on, frame interrupt on. Everything above ran with it off, which is
  // what makes a screenful of name table safe to write without tearing.
  emitVdpRegister(ctx, 1, 0x60);
  asm.ldn("a", 1);
  asm.sta(layout.booted);
  asm.ei();
  asm.jp("Main");
}

/** Write one VDP register with a compile-time value. */
function emitVdpRegister(ctx: SmsCtx, register: number, value: number): void {
  const { asm } = ctx;
  asm.ldn("a", value);
  asm.outN(PORT.CONTROL);
  asm.ldn("a", 0x80 | register);
  asm.outN(PORT.CONTROL);
}

/** Write one VDP register with the value in `a`. */
function emitVdpRegisterA(ctx: SmsCtx, register: number): void {
  const { asm } = ctx;
  asm.outN(PORT.CONTROL);
  asm.ldn("a", 0x80 | register);
  asm.outN(PORT.CONTROL);
}

/**
 * The register file, as the boot leaves it.
 *
 * `R2`, `R5` and `R6` are where the three tables live and are the reason
 * {@link VRAM}'s addresses are what they are. `R6` is `$FB` rather than `$FF`
 * because bit 2 is the sprite pattern base and clearing it puts sprites in the
 * same bank as the background — one bank, one budget, and a glyph a HUD draws
 * with a sprite is the same tile the background would have used.
 */
function emitVdpInit(ctx: SmsCtx): void {
  emitVdpRegister(ctx, 0, 0x04); // mode 4, no line interrupt, nothing masked yet
  emitVdpRegister(ctx, 1, 0x20); // display off, frame interrupt armed
  emitVdpRegister(ctx, 2, 0xff); // name table at $3800
  emitVdpRegister(ctx, 3, 0xff);
  emitVdpRegister(ctx, 4, 0xff);
  emitVdpRegister(ctx, 5, 0xff); // sprite attributes at $3F00
  emitVdpRegister(ctx, 6, 0xfb); // sprite characters at $0000
  emitVdpRegister(ctx, 7, 0x00); // the border takes the sprite bank's colour zero
  emitVdpRegister(ctx, 8, 0x00);
  emitVdpRegister(ctx, 9, 0x00);
  emitVdpRegister(ctx, 10, 0xff); // the line counter, parked
  // The sound chip powers up making noise on all four channels, so it is silenced
  // here whether or not this game has a driver.
  const { asm } = ctx;
  for (const channel of [0x9f, 0xbf, 0xdf, 0xff]) {
    asm.ldn("a", channel);
    asm.outN(PORT.PSG);
  }
}

/** Point the data port at a compile-time video-RAM address, for writing. */
function emitVramAddress(ctx: SmsCtx, address: number): void {
  const { asm } = ctx;
  asm.ldn("a", address & 0xff);
  asm.outN(PORT.CONTROL);
  asm.ldn("a", 0x40 | ((address >> 8) & 0x3f));
  asm.outN(PORT.CONTROL);
}

/**
 * Copy the tile bank from the cartridge into video RAM.
 *
 * Counted rather than terminated, because the length is known when the code is
 * emitted — a program that had to compare two label addresses at run time would
 * need the assembler to do arithmetic on them, which this one deliberately does
 * not.
 */
function emitTileUpload(ctx: SmsCtx, bytes: number): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  const loop = ctx.unique("bankLoop");
  emitVramAddress(ctx, VRAM.TILES);
  asm.ld16("hl", label("TileBank"));
  asm.ld16("bc", bytes);
  asm.label(loop);
  asm.ld("a", "hlp");
  asm.outN(PORT.DATA);
  asm.inc16("hl");
  asm.dec16("bc");
  asm.ld("a", "b");
  asm.alu("or", "c");
  ctx.far("nz", loop);
}

/**
 * Upload both colour banks: thirty-two colours, in the bytes this console
 * spends on them.
 *
 * The one place in the emitter that asks which console this is, and the only
 * place it can: a Master System colour is a byte of `--BBGGRR` and a Game Gear
 * colour is two of `----BBBBGGGGRRRR`, so the *number of bytes* differs even
 * though the number of colours does not. Everything else — every rule, every
 * collision, every cell of the renderer — is the same code on both.
 *
 * There is exactly one of these because there was briefly two, and the second
 * counted colours rather than bytes: boot uploaded thirty-two of each, which on
 * a Game Gear is sixteen colours and leaves the whole sprite bank unwritten.
 */
function emitPaletteUpload(ctx: SmsCtx, source: string): void {
  const { asm } = ctx;
  const loop = ctx.unique("cramLoop");
  asm.alu("xor", "a");
  asm.outN(PORT.CONTROL);
  asm.ldn("a", 0xc0);
  asm.outN(PORT.CONTROL);
  asm.ld16("hl", label(source));
  asm.ldn("b", ctx.gameGear ? 64 : 32);
  asm.label(loop);
  asm.ld("a", "hlp");
  asm.outN(PORT.DATA);
  asm.inc16("hl");
  asm.djnz(loop);
}

/** Fill the name table with tile zero, so nothing stale shows through. */
function emitBlankNameTable(ctx: SmsCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("blankLoop");
  emitVramAddress(ctx, VRAM.NAME);
  asm.ld16("bc", MAP_W * MAP_H);
  asm.label(loop);
  asm.alu("xor", "a");
  asm.outN(PORT.DATA);
  // The palette bit, so a blank cell is the font bank's colour zero rather than
  // whatever the art's happens to be.
  asm.ldn("a", 0x08);
  asm.outN(PORT.DATA);
  asm.dec16("bc");
  asm.ld("a", "b");
  asm.alu("or", "c");
  ctx.far("nz", loop);

  // And the sprite table, whose first Y byte ends the list: nothing is drawn
  // until the first frame builds it.
  emitVramAddress(ctx, VRAM.SAT);
  asm.ldn("a", 0xd0);
  asm.outN(PORT.DATA);
}

/** Copy a compile-time run of bytes from the cartridge into work RAM. */
function emitCopyBlock(ctx: SmsCtx, source: Ref, dest: number, count: number): void {
  const { asm } = ctx;
  asm.ld16("hl", source);
  asm.ld16("de", dest);
  asm.ld16("bc", count);
  asm.ldir();
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: SmsCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  const seed = program.seed | 0;
  asm.ld16("hl", seed & 0xffff);
  asm.st16To(layout.rng, "hl");
  asm.ld16("hl", (seed >>> 16) & 0xffff);
  asm.st16To(layout.rng + 2, "hl");
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: SmsCtx): void {
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

function emitMainLoop(ctx: SmsCtx, audio: boolean): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  asm.label("Main");
  asm.label(wait);
  asm.lda(frameFlag(ctx));
  asm.aluN("or", 0);
  ctx.far("z", wait);
  asm.alu("xor", "a");
  asm.sta(frameFlag(ctx));
  asm.call("UploadFrame");
  asm.call("ReadInput");
  asm.call("Tick");
  // After the tick, so an effect a rule asked for is heard this frame rather than
  // next; after the upload, so the frame it delays is nobody's.
  if (audio) asm.call("AudioService");
  asm.call("BuildFrame");
  asm.jp("Main");
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * Port `$DC` reports Up, Down, Left, Right, button 1, button 2 in bits 0 to 5,
 * *active low* — so the byte is complemented before anything is read out of it.
 * The abstract set is `ACTIONS` order — left right up down a b start — which doc
 * 14 §Buttons chose as the portable floor, so the read is a permutation of six
 * bits and then whatever this machine calls Start.
 */
function emitInput(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const raw = layout.scratch + S.w0;
  const out = layout.scratch + S.w0 + 1;
  asm.label("ReadInput");
  asm.inN(PORT.JOY1);
  asm.cpl(); // active low: a pressed button reads as a zero bit
  asm.sta(raw);

  const HARDWARE = ["up", "down", "left", "right", "a", "b"] as const;
  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  asm.alu("xor", "a");
  asm.sta(out);
  for (const [to, action] of ABSTRACT.entries()) {
    const from = HARDWARE.indexOf(action as (typeof HARDWARE)[number]);
    if (from < 0) continue;
    const skip = ctx.unique("padSkip");
    asm.lda(raw);
    asm.aluN("and", 1 << from);
    ctx.far("z", skip);
    asm.lda(out);
    asm.aluN("or", 1 << to);
    asm.sta(out);
    asm.label(skip);
  }

  // Start. On a Game Gear it is a real button on its own port, active low; on a
  // Master System there is no such button and the Pause key raises a
  // non-maskable interrupt instead, which the handler has already latched.
  const startBit = 1 << ABSTRACT.indexOf("start");
  const noStart = ctx.unique("noStart");
  if (ctx.gameGear) {
    asm.inN(PORT.GG_START);
    asm.aluN("and", 0x80);
    ctx.far("nz", noStart);
  } else {
    asm.lda(pauseFlag(ctx));
    asm.aluN("or", 0);
    ctx.far("z", noStart);
    // A latch, not a level: the interrupt fires once per press and the edge
    // machinery below turns it into `pressed` for exactly one tick.
    asm.alu("xor", "a");
    asm.sta(pauseFlag(ctx));
  }
  asm.lda(out);
  asm.aluN("or", startBit);
  asm.sta(out);
  asm.label(noStart);

  // held → pressed and released, against last tick's set.
  asm.lda(layout.held);
  asm.ld("b", "a"); // last tick's
  asm.lda(out);
  asm.sta(layout.held);
  asm.ld("c", "a"); // this tick's
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

function emitTickDispatch(ctx: SmsCtx, scenes: readonly SceneCtx[]): void {
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
  inc16(ctx, layout.tick);
  asm.lda(layout.ready);
  asm.inc("a");
  asm.sta(layout.ready);
  asm.ret();
}

function emitSceneChange(ctx: SmsCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout, program } = ctx;
  asm.label("SceneChange");
  asm.lda(layout.pending);
  asm.aluN("cp", 0xff);
  const go = ctx.unique("changeGo");
  ctx.far("nz", go);
  asm.ret();
  asm.label(go);
  asm.sta(layout.scene);
  asm.ldn("a", 0xff);
  asm.sta(layout.pending);
  if (ctx.audio?.driver === true && program.tracks.length > 0) asm.call("SceneMusic");
  asm.call("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.call("UpdateCamera");
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  asm.ret();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request one byte: the driver
  // is serviced from the loop, and a scene change is not where it happens.
  if (ctx.audio?.driver === true && program.tracks.length > 0) {
    asm.label("SceneMusic");
    asm.lda(layout.scene);
    asm.ld("l", "a");
    asm.ldn("h", 0);
    asm.ld16("de", label("SceneTracks"));
    asm.addHL("de");
    asm.ld("a", "hlp");
    asm.sta(ctx.audio.music);
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
 * This console's instructions for each of doc 14's tick steps.
 *
 * The *order* is not here: `emitTickSteps` runs them, so this backend supplies
 * the code for a step and has no say in the sequence (`backend.ts` §The tick's).
 */
function tickSteps(ctx: SmsCtx): TickSteps {
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

function emitSceneTick(ctx: SmsCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jp("TickDone");
}

function emitSceneReset(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    emitCopyBlock(ctx, label(`Defaults_${id}`), layout.entities[id] as number, ENTITY_SIZE);
  }
  asm.ret();
}

function emitSceneCamera(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.ret();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: SmsCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: SmsCtx, subjectId: number, level: LevelData): void {
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
    ctx.far("z", next);
    asm.ld("c", "a"); // the legend index, held across the arithmetic
    asm.lda(list);
    asm.aluN("cp", TILE_CONTACT_MAX);
    ctx.far("nc", next);
    // The entry is five bytes: the column, the row, and the legend index.
    asm.ld("e", "a");
    asm.ldn("d", 0);
    asm.ld("l", "e");
    asm.ld("h", "d");
    asm.addHL("hl");
    asm.addHL("hl");
    asm.addHL("de"); // count * 5
    asm.ld16("de", list + 1);
    asm.addHL("de");
    // Column, row, then the legend index, in that order.
    for (const address of [col, row]) {
      asm.push("hl");
      asm.ld16From("de", address);
      asm.ld("hlp", "e");
      asm.inc16("hl");
      asm.ld("hlp", "d");
      asm.pop("hl");
      asm.inc16("hl");
      asm.inc16("hl");
    }
    asm.ld("hlp", "c");
    asm.lda(list);
    asm.inc("a");
    asm.sta(list);
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `a`. */
function emitOverCells(ctx: SmsCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.lda(list);
  asm.aluN("or", 0);
  ctx.far("z", done);
  asm.ld16("hl", 0);
  asm.st16To(cursor, "hl");
  asm.label(loop);
  asm.ld16From("hl", cursor);
  asm.ld16("de", list + 1);
  asm.addHL("de");
  // Column, row, legend index — the layout `emitFillCells` wrote.
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.inc16("hl");
  asm.st16To(col, "de");
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.inc16("hl");
  asm.st16To(row, "de");
  asm.ld("a", "hlp");
  body();
  // Five bytes on, and stop when the count is reached. The cursor is in RAM
  // because a rule body uses every register there is.
  asm.ld16From("hl", cursor);
  asm.ld16("de", 5);
  asm.addHL("de");
  asm.st16To(cursor, "hl");
  asm.lda(list);
  asm.ld("e", "a");
  asm.ldn("d", 0);
  asm.ld("l", "e");
  asm.ld("h", "d");
  asm.addHL("hl");
  asm.addHL("hl");
  asm.addHL("de"); // count * 5
  asm.ld16From("de", cursor);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("nz", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: SmsCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.aluN("cp", GRID_EMPTY);
        ctx.far("z", next);
        // Is this legend entry one the rule names?
        asm.ld16("hl", label(ruleTileTableLabel(rule, level)));
        emitAddA(ctx);
        asm.ld("a", "hlp");
        asm.aluN("or", 0);
        ctx.far("z", next);

        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.ld16("de", listBase + 1);
          asm.call("TileContactSeen");
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
      asm.aluN("cp", GRID_EMPTY);
      ctx.far("z", next);
      asm.ld("c", "a");
      asm.ld16("hl", label(level.solidLabel));
      emitAddA(ctx);
      asm.ld("a", "hlp");
      asm.aluN("or", 0);
      ctx.far("z", next);
      asm.ld("a", "c");
      asm.ld16("hl", label(namedTable));
      emitAddA(ctx);
      asm.ld("a", "hlp");
      asm.aluN("or", 0);
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

/** `hl += a`, unsigned — the index step every table lookup here makes. */
function emitAddA(ctx: SmsCtx): void {
  const { asm } = ctx;
  asm.alu("add", "l");
  asm.ld("l", "a");
  asm.ldn("a", 0);
  asm.alu("adc", "h");
  asm.ld("h", "a");
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: SmsCtx, rule: RuleDef, bind: Binding): void {
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
function emitCellId(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  asm.lda(layout.words + W.tileCol * 2);
  asm.sta(layout.words + W.cell * 2);
  asm.lda(layout.words + W.tileRow * 2);
  asm.sta(layout.words + W.cell * 2 + 1);
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: SmsCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.alu("xor", "a");
  asm.sta(layout.tileScratch);
  asm.lda(listBase);
  asm.sta(layout.words + W.target * 2);
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.lda(layout.tileScratch);
  asm.aluN("cp", TILE_CONTACT_MAX);
  ctx.far("nc", full);
  asm.alu("add", "a");
  asm.ld16("hl", layout.tileScratch + 1);
  emitAddA(ctx);
  asm.lda(layout.words + W.cell * 2);
  asm.ld("hlp", "a");
  asm.inc16("hl");
  asm.lda(layout.words + W.cell * 2 + 1);
  asm.ld("hlp", "a");
  asm.lda(layout.tileScratch);
  asm.inc("a");
  asm.sta(layout.tileScratch);
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries that
 * exist, not the whole slot. An object usually touches two or three cells, and
 * copying sixteen of them every tick was costing more than the walk.
 */
function emitCommitContacts(ctx: SmsCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.lda(layout.tileScratch);
  asm.alu("add", "a");
  asm.inc("a"); // the count byte itself travels with the entries
  asm.ld("c", "a");
  asm.ldn("b", 0);
  asm.ld16("hl", layout.tileScratch);
  asm.ld16("de", listBase);
  asm.ldir();
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry
 * event fires only when the answer is no, a level one fires regardless. The list
 * to search arrives in `de`, and the answer is the zero flag — set when the cell
 * was not there.
 */
function emitTileContactHelper(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const step = ctx.unique("seenStep");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.lda(layout.words + W.target * 2);
  asm.aluN("or", 0);
  ctx.far("z", missing);
  asm.ld("b", "a");
  asm.exDEHL();
  asm.label(loop);
  asm.lda(layout.words + W.cell * 2);
  asm.alu("cp", "hlp");
  ctx.far("nz", step);
  asm.inc16("hl");
  asm.lda(layout.words + W.cell * 2 + 1);
  asm.alu("cp", "hlp");
  asm.dec16("hl");
  ctx.far("z", found);
  asm.label(step);
  asm.inc16("hl");
  asm.inc16("hl");
  asm.djnz(loop);
  asm.label(missing);
  asm.alu("xor", "a");
  asm.ret();
  asm.label(found);
  asm.ldn("a", 1);
  asm.aluN("or", 0);
  asm.ret();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: SmsCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: SmsEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.ld16("hl", 0);
    asm.st16To(layout.words + W.camX * 2, "hl");
    asm.st16To(layout.words + W.camY * 2, "hl");
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.lda(layout.redraw);
  asm.aluN("or", 0);
  ctx.far("z", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  asm.alu("xor", "a");
  asm.sta(layout.redraw);
  asm.sta(layout.plotPrevCount);
  asm.jp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with sprites; one that does not gets it
  // as background cells, which costs no objects at all.
  if (!scrolls(ctx, scene)) {
    emitHudErase(ctx, scene, level);
    asm.alu("xor", "a");
    asm.sta(layout.plotCount);
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options);
  asm.ret();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: SmsCtx, src: number, dst: number): void {
  const { asm } = ctx;
  // Five places right of the middle two bytes, sign-extended through the top.
  const high = ctx.layout.words + W.temp * 2;
  asm.ld16From("hl", mem(src, 1));
  asm.st16To(dst, "hl");
  asm.lda(mem(src, 3));
  asm.sta(high);
  for (let shift = 0; shift < 5; shift += 1) {
    // The sign has to come back in at the top of a 24-bit value, so it goes out
    // through the carry first and the rotates bring it back down.
    asm.ld16("hl", high);
    asm.shift("sra", "hlp");
    asm.ld16("hl", dst + 1);
    asm.shift("rr", "hlp");
    asm.dec16("hl");
    asm.shift("rr", "hlp");
  }
}

/** Draw the whole visible window, with the display off. */
function emitFullRedraw(
  ctx: SmsCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: SmsEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Interrupts off for the whole of it, and this is not about tearing.
  //
  // Every address this routine gives the VDP is *two* writes to the control
  // port, and acknowledging the frame interrupt means reading that port — which
  // resets the half-written state. A handler that lands between the two bytes
  // therefore leaves the second one being read as a first, and one cell of the
  // screen is written somewhere else entirely: a single wrong tile, at no cell
  // anyone can predict, on a redraw that is otherwise perfect. The rest of the
  // runtime is safe by construction, because `UploadFrame` runs a few
  // instructions after the interrupt it waited for; a redraw is the one thing
  // long enough to be interrupted, and it happens once a scene.
  //
  // The frame the game spends here is owed rather than lost: the interrupt is
  // pending when `ei` runs, so the flag is raised once and the audio driver's
  // counter takes one tick, which is exactly what it does for any frame the game
  // overruns.
  asm.di();
  // Display off: a screenful of name table does not fit in one blanking interval,
  // and writing it with the display on would tear.
  emitVdpRegister(ctx, 1, 0x20);

  // Column zero is masked only where a scrolling level has nowhere else to put
  // its incoming column — a Master System, whose screen is the whole name table.
  // A Game Gear has twelve columns outside its window, so the seam does not
  // exist there and blanking eight pixels of a smaller screen would be a defect,
  // exactly as it would be for a still picture.
  const wide = level !== undefined && level.file.width > layout.memory.viewW && !spareColumn(ctx);
  emitVdpRegister(ctx, 0, wide ? 0x24 : 0x04);

  // Every scene uploads a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours; one without brings the build's
  // — the level tiles' and the objects' fit. Leaving colour RAM alone would mean
  // a level scene wore whichever title screen the player came from, and a level
  // has no picture to make that look deliberate.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteUpload(ctx, palette ? scenePaletteLabel(scene) : "Palette");

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a run of whole rows, so painting it is one stream into the
    // data port — but it is only as tall as the *screen*, and the name table is
    // four rows taller, so the address is set once and the picture stops short.
    emitVramAddress(ctx, VRAM.NAME);
    asm.ld16("hl", label(backdropLabel(scene)));
    asm.call(needBlitBackdrop(ctx));
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    // The window, and the one column and row the first scroll step will need
    // before it has had a chance to paint them — and nothing else. Painting a
    // whole level here instead would draw cells nobody has looked at yet and hold
    // the screen off while it did; the rule on every console is that a cell is
    // drawn when it is about to be seen.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    copy16(ctx, layout.words + W.firstCol * 2, layout.words + W.mapCol * 2);
    copy16(ctx, layout.words + W.tileRow * 2, layout.words + W.mapRow * 2);

    const rowLoop = ctx.unique("fullRow");
    const colLoop = ctx.unique("fullCol");
    const rows = layout.words + W.firstRow * 2;
    const columns = layout.words + W.lastCol * 2;
    // One past the window on each axis: a scroll that is not a whole number of
    // cells shows a sliver of the next column and the next row, and a cell
    // nothing painted shows whatever the scene before it left there. A Game Gear
    // has a spare column to put it in; a Master System's thirty-third column
    // wraps onto the cell straddling the masked left edge, which is where the
    // scroll expects to find the far sliver anyway — so the count is the same on
    // both and only the *step back* has to know the difference.
    const height = layout.memory.viewH + (level !== undefined ? 1 : 0);
    const width = layout.memory.viewW + (level !== undefined ? 1 : 0);
    asm.ldn("a", height);
    asm.sta(rows);
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.ldn("a", width);
    asm.sta(columns);
    asm.label(colLoop);
    // The address is set per cell rather than per row, because the name table
    // wraps at thirty-two columns and a row's cells are not contiguous once the
    // origin is not zero.
    asm.call("VramFor");
    emitBackgroundTile(ctx, scene, level);
    asm.call("PokeEntry");
    inc16(ctx, layout.words + W.tileCol * 2);
    asm.lda(columns);
    asm.dec("a");
    asm.sta(columns);
    ctx.far("nz", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    asm.lda(rows);
    asm.dec("a");
    asm.sta(rows);
    ctx.far("nz", rowLoop);
  }

  // Captions go on now, with the background they sit on. A scrolling scene draws
  // its whole HUD with sprites, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  emitVdpRegister(ctx, 1, 0x60);
  asm.ei();
}

/**
 * A packed name table: literals and runs of whole *cells*, and the walk that
 * unpacks it.
 *
 * ```text
 *   $00        the end
 *   $01..$7F   n cells follow, two bytes each
 *   $81..$FF   the next two bytes, (n & $7F) times
 * ```
 *
 * The unit is a cell rather than a byte because an entry here is two of them —
 * the tile and its attribute — so a run of identical cells is `T A T A T A` and
 * has no byte runs in it at all. That is the one thing this does not share with
 * the NES's `packCells`, whose entries are single bytes.
 *
 * A screenful is 768 cells on a Master System, 1536 bytes against a cartridge of
 * 32 KiB with no mapper, and two pictures stored raw were a tenth of the whole
 * program. A demade screen is mostly runs — sky, a floor, a wall, and on a Game
 * Gear the twelve columns of name table its window does not show — so it packs
 * to a fraction of that.
 *
 * The format is the encoder's and the decoder's business and nothing else's:
 * what is guaranteed is the bytes that reach the VDP, and `sms-rom.test.ts`
 * checks those against the level and the picture rather than checking this
 * encoding. Same rule the NES's nametables and the audio driver's packing run
 * under (doc 16 §The driver format is not part of the contract).
 */
export function packCells(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  const same = (a: number, b: number): boolean =>
    cells[a * 2] === cells[b * 2] && cells[a * 2 + 1] === cells[b * 2 + 1];
  const total = cells.length >> 1;
  let at = 0;
  while (at < total) {
    let run = 1;
    while (run < 127 && at + run < total && same(at + run, at)) run += 1;
    // Two of a kind is a wash — three bytes either way — so a run has to be worth
    // the control byte before it is taken, and pairs go through as literals.
    if (run >= 3) {
      out.push(0x80 | run, cells[at * 2] as number, cells[at * 2 + 1] as number);
      at += run;
      continue;
    }
    const start = at;
    while (at < total && at - start < 127) {
      let ahead = 1;
      while (ahead < 3 && at + ahead < total && same(at + ahead, at)) ahead += 1;
      if (ahead >= 3) break;
      at += 1;
    }
    out.push(at - start, ...cells.subarray(start * 2, at * 2));
  }
  out.push(0x00);
  return Uint8Array.from(out);
}

/** `hl` = a packed name table; write it to the data port at the current address. */
function needBlitBackdrop(ctx: SmsCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");

    asm.label(next);
    asm.ld("a", "hlp");
    asm.inc16("hl");
    asm.alu("or", "a");
    asm.ret("z");
    inner.far("m", run);

    asm.ld("b", "a");
    asm.label(literal);
    asm.ld("a", "hlp");
    asm.outN(PORT.DATA);
    asm.inc16("hl");
    asm.ld("a", "hlp");
    asm.outN(PORT.DATA);
    asm.inc16("hl");
    asm.djnz(literal);
    asm.jp(next);

    asm.label(run);
    asm.aluN("and", 0x7f);
    asm.ld("b", "a");
    asm.ld("c", "hlp");
    asm.inc16("hl");
    asm.ld("e", "hlp");
    asm.inc16("hl");
    asm.label(runLoop);
    asm.ld("a", "c");
    asm.outN(PORT.DATA);
    asm.ld("a", "e");
    asm.outN(PORT.DATA);
    asm.djnz(runLoop);
    asm.jp(next);
  });
}

/** The labels holding one scene's name table and colour RAM. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}

/**
 * `a` = the tile that belongs at `words[tileCol], words[tileRow]`, and the
 * attribute byte for it in `layout.attr`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: SmsCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  void scene;
  if (!level) {
    asm.alu("xor", "a");
    emitTileAttr(ctx);
    return;
  }
  asm.call(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/**
 * The attribute byte a tile draws with, from the tile number in `a`.
 *
 * Bit 3 selects the colour bank, and the rule is the tile's own index: anything
 * below the built-in bank is the font, the level patterns or the placeholder
 * block, which draw in bank 1 alongside the sprites. Art draws in bank 0. That
 * is the whole of the reservation on this console — there is no third palette to
 * keep back, so the *tiles* are what decides.
 */
function emitTileAttr(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const system = ctx.unique("attrSystem");
  const done = ctx.unique("attrDone");
  asm.aluN("cp", BUILTIN_TILE_COUNT);
  ctx.far("c", system);
  asm.push("af");
  asm.alu("xor", "a");
  asm.sta(layout.attr);
  asm.pop("af");
  asm.jp(done);
  asm.label(system);
  asm.push("af");
  asm.ldn("a", 0x08);
  asm.sta(layout.attr);
  asm.pop("af");
  asm.label(done);
}

/** `a = the background tile for the legend index in a`, with its attribute. */
function emitLegendToTile(ctx: SmsCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.aluN("cp", GRID_EMPTY);
  ctx.far("z", empty);
  asm.ld16("hl", label(level.tileLabel));
  emitAddA(ctx);
  asm.ld("a", "hlp");
  asm.jp(done);
  asm.label(empty);
  asm.alu("xor", "a");
  asm.label(done);
  emitTileAttr(ctx);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: SmsCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    copy16(ctx, dst, src);
    for (let index = 0; index < 3; index += 1) {
      asm.ld16("hl", dst + 1);
      asm.shift("sra", "hlp");
      asm.dec16("hl");
      asm.shift("rr", "hlp");
    }
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the name table up to date after the camera moved.
 *
 * The scroll registers do the moving, so crossing a cell boundary costs one
 * column or one row of writes and nothing else — no nametable to choose, no
 * address arithmetic beyond the wrap. A jump too large to walk sets the
 * full-redraw flag instead of silently dropping cells off the end of the queue.
 */
function emitScrollUpdate(ctx: SmsCtx, level: LevelData): void {
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
 *
 * The invariant is that the name table holds the window plus one cell past it on
 * each axis, because a scroll of part of a cell shows a sliver of the next one.
 * So moving on paints one past the far edge — `viewW` or `viewH` from the new
 * origin — and moving back paints the new origin itself.
 *
 * A Master System's columns are the exception, and the exception is the wrap: its
 * screen is the whole thirty-two-column name table, so "one past the window" and
 * "the origin" are the *same cell*, and it has to hold the far sliver rather than
 * the near one. The mask over column zero is what makes the near half of it
 * invisible, and it is why moving back paints offset one there — offset zero is
 * that shared cell, and painting it would put the left-hand column's tiles into
 * the sliver at the right-hand edge.
 */
function emitWalkAxis(
  ctx: SmsCtx,
  level: LevelData,
  origin: number,
  want: number,
  bail: string,
  isColumn: boolean,
): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("walkLoop");
  const done = ctx.unique("walkDone");
  const back = ctx.unique("walkBack");
  const guard = layout.words + W.count * 2;

  asm.ldn("a", 5);
  asm.sta(guard);
  asm.label(loop);
  asm.lda(guard);
  asm.dec("a");
  asm.sta(guard);
  ctx.far("z", bail);
  asm.ld16From("hl", want);
  asm.ld16From("de", origin);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("z", done);
  ctx.far("m", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  asm.jp(loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn && !spareColumn(ctx) ? 1 : 0);
  asm.jp(loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: SmsCtx, level: LevelData, isColumn: boolean, offset: number): void {
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
  if (offset !== 0) {
    asm.ld16From("hl", across);
    asm.ld16("de", offset);
    asm.addHL("de");
    asm.st16To(across, "hl");
  }
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.ldn("a", count);
  asm.sta(remaining);
  asm.label(loop);
  asm.call("VramForQueue");
  asm.call(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  asm.call("QueueEntry");
  inc16(ctx, along);
  asm.lda(remaining);
  asm.dec("a");
  asm.sta(remaining);
  ctx.far("nz", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(ctx: SmsCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.lda(layout.plotPrevCount);
  asm.aluN("or", 0);
  ctx.far("z", done);
  asm.ld16("hl", 0);
  asm.st16To(cursor, "hl");
  asm.label(loop);
  asm.ld16From("hl", cursor);
  asm.ld16("de", layout.plotPrev);
  asm.addHL("de");
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.inc16("hl");
  asm.st16To(layout.words + W.tileCol * 2, "de");
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.st16To(layout.words + W.tileRow * 2, "de");
  asm.call("VramForQueue");
  emitBackgroundTile(ctx, scene, level);
  asm.call("QueueEntry");
  asm.ld16From("hl", cursor);
  asm.ld16("de", 4);
  asm.addHL("de");
  asm.st16To(cursor, "hl");
  asm.lda(layout.plotPrevCount);
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld("e", "a");
  asm.ldn("d", 0);
  asm.ld16From("hl", cursor);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("nz", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  asm.lda(layout.plotCount);
  asm.sta(layout.plotPrevCount);
  asm.aluN("or", 0);
  ctx.far("z", done);
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld("c", "a");
  asm.ldn("b", 0);
  asm.ld16("hl", layout.plot);
  asm.ld16("de", layout.plotPrev);
  asm.ldir();
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(ctx: SmsCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    // The cell the object sits in; positions are level coordinates, so the
    // wrapped name table puts it in the right place with no extra work.
    asm.ld16From("hl", base + propOffset("x") + 2);
    asm.st16To(layout.words + W.tileCol * 2, "hl");
    asm.ld16From("hl", base + propOffset("y") + 2);
    asm.st16To(layout.words + W.tileRow * 2, "hl");

    // A static object is painted straight into video RAM with the display
    // already off, so it needs neither the write queue nor a place in the erase
    // list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, MAP_W)) {
        asm.ldn("a", glyphTile(character));
        asm.call(plot);
      }
    } else {
      asm.ld16("de", base + propOffset("value") + 2);
      asm.call(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `a = tile`: write it at the current cell and advance the column. */
function needPokeCell(ctx: SmsCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    emitTileAttr(inner);
    asm.push("af");
    asm.call("VramFor");
    asm.pop("af");
    asm.call("PokeEntry");
    inc16(inner, layout.words + W.tileCol * 2);
    asm.ret();
  });
}

/** The decimal renderer again, writing straight to video RAM. */
function needPokeNumber(ctx: SmsCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeCell(inner));
  });
}

/**
 * `ix` = entity base, `c`/`b` = the size in cells → Z set when the object is
 * certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * half of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled — the test
 * may say "maybe" when the answer is no, and never the other way round.
 */
function needOnscreen(ctx: SmsCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");
    const delta = layout.scratch + S.w1;

    const axis = (offset: number, margin: "b" | "c", span: number): void => {
      asm.ldIdx("l", "ix", offset + 2);
      asm.ldIdx("h", "ix", offset + 3);
      asm.ld16From("de", camera + offset + 2);
      asm.aluN("or", 0);
      asm.sbcHL("de");
      asm.st16To(delta, "hl");
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.ld("e", margin);
      asm.ldn("d", 0);
      asm.aluN("or", 0);
      asm.adcHL("de");
      inner.far("m", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.ld16From("hl", delta);
      asm.ld16("de", span + 1);
      asm.aluN("or", 0);
      asm.sbcHL("de");
      inner.far("p", apart);
    };
    axis(propOffset("x"), "c", layout.memory.viewW);
    axis(propOffset("y"), "b", layout.memory.viewH);

    asm.ldn("a", 1);
    asm.aluN("or", 0);
    asm.ret();
    asm.label(apart);
    asm.alu("xor", "a");
    asm.ret();
  });
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: SmsCtx, scene: SceneCtx, options: SmsEmitOptions): void {
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
      asm.ld16Idx("ix", base);
      asm.ld16("bc", (height << 8) | width);
      asm.call(needOnscreen(ctx));
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

    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE;
        // The VDP draws an object one line below its Y, so the shadow carries the
        // position minus one — which also parks a sprite at Y=$D0 off screen.
        asm.lda(layout.words + W.count * 2);
        asm.aluN("add", (row * 8 - 1) & 0xff);
        asm.ld("b", "a");
        asm.lda(layout.words + W.cell * 2);
        asm.aluN("add", column * 8);
        asm.ld("c", "a");
        asm.ldn("e", tile & 0xff);
        asm.call(needPushSprite(ctx));
      }
    }
    asm.label(skip);
  }
  if (scrolls(ctx, scene)) emitHudSprites(ctx, scene);
  asm.call(needClearRestOfOam(ctx));
}

/**
 * Draw a scrolling scene's `number` and `text` objects as hardware sprites.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already
 * wrote — only the layer differs. Eight objects to a scanline is the hardware's
 * limit (doc 14 §Budgets), which is why a *long* caption in a scrolling scene is
 * the one HUD this cannot draw; a counter is one to five glyphs and fits.
 */
function emitHudSprites(ctx: SmsCtx, scene: SceneCtx): void {
  const { asm, layout, program } = ctx;
  const penX = layout.words + W.cell * 2;
  const penY = layout.words + W.count * 2;

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;

    const skip = ctx.unique("hudOamSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      branchZero32(ctx, (layout.entities[id] as number) + propOffset("visible"), skip);
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

    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, MAP_W)) {
        asm.ldn("a", glyphTile(character));
        asm.call(needHudGlyph(ctx));
      }
    } else {
      asm.ld16("de", base + propOffset("value") + 2);
      asm.call(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `a = tile`: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: SmsCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const { asm, layout } = inner;
    asm.ld("e", "a");
    asm.lda(layout.words + W.count * 2);
    asm.aluN("sub", 1);
    asm.ld("b", "a");
    asm.lda(layout.words + W.cell * 2);
    asm.ld("c", "a");
    asm.call(needPushSprite(inner));
    asm.lda(layout.words + W.cell * 2);
    asm.aluN("add", 8);
    asm.sta(layout.words + W.cell * 2);
    asm.ret();
  });
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: SmsCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    emitDecimal(inner, needHudGlyph(inner));
  });
}

/**
 * `b` = y, `c` = x, `e` = tile; append an object entry to the shadow.
 *
 * The position arriving here is a *screen* position, and the sprite table takes
 * a **frame** one — the same coordinate on a Master System and 48 pixels in and
 * 24 down on a Game Gear, whose LCD shows the middle of the frame. The window
 * origin is added once, here, because this is the one door every object cell and
 * every HUD glyph goes through; adding it at each call site is how one of them
 * comes to be missed.
 *
 * The shadow is the sprite attribute table's own layout — sixty-four Y bytes,
 * then sixty-four (X, tile) pairs — so the upload is two block copies rather
 * than a scatter. That is the whole reason the two halves are 128 bytes apart in
 * work RAM as well as in video RAM.
 */
function needPushSprite(ctx: SmsCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    const shadow = layout.memory.oamShadow;
    const origin = windowOrigin(inner);
    // The window origin goes on before the count is loaded, because the count
    // stays in `a` from the check below all the way into `emitAddA` — the entry's
    // address is built from it. Biasing after the load costs every object its
    // slot and draws nothing at all.
    if (origin.y !== 0) {
      asm.ld("a", "b");
      asm.aluN("add", origin.y);
      asm.ld("b", "a");
    }
    if (origin.x !== 0) {
      asm.ld("a", "c");
      asm.aluN("add", origin.x);
      asm.ld("c", "a");
    }
    asm.lda(layout.oamCount);
    asm.aluN("cp", layout.memory.oamEntries);
    asm.jr(room, "c");
    asm.ret();
    asm.label(room);
    // Y first: the shadow's low half is the Y table.
    asm.ld16("hl", shadow);
    emitAddA(inner);
    asm.ld("hlp", "b");
    // Then the (X, tile) pair, at twice the index in the upper half.
    asm.lda(layout.oamCount);
    asm.alu("add", "a");
    asm.ld16("hl", shadow + 0x80);
    emitAddA(inner);
    asm.ld("hlp", "c");
    asm.inc16("hl");
    asm.ld("hlp", "e");
    asm.lda(layout.oamCount);
    asm.inc("a");
    asm.sta(layout.oamCount);
    asm.ret();
  });
}

/**
 * Park the entries that are no longer in use.
 *
 * Only the ones *this* frame vacated need clearing: everything above last
 * frame's high-water mark is already parked. Parking means Y = `$D0`, which is
 * the value that ends the sprite list — so the hardware stops there rather than
 * drawing whatever the rest of the table holds.
 */
function needClearRestOfOam(ctx: SmsCtx): Ref {
  return ctx.need("ClearRestOfOam", (inner) => {
    const { asm, layout } = inner;
    const shadow = layout.memory.oamShadow;
    // One byte is enough: the list terminator stops the hardware at the first
    // unused entry, so nothing above it has to be touched at all.
    asm.lda(layout.oamCount);
    asm.ld16("hl", shadow);
    emitAddA(inner);
    asm.ldn("hlp", 0xd0);
    asm.ret();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const QUEUE_BYTES = layout.memory.queueMax * layout.queueStride;

  // Point the data port at the cell in words[tileCol]/words[tileRow], for
  // writing. The name table wraps every thirty-two columns and every
  // twenty-eight rows, and there is no second table to choose between.
  asm.label("VramFor");
  emitCellAddress(ctx);
  asm.ld("a", "l");
  asm.outN(PORT.CONTROL);
  asm.ld("a", "h");
  asm.aluN("or", 0x40);
  asm.outN(PORT.CONTROL);
  asm.ret();

  // The same address, left in `words[target]` for the queue to carry.
  asm.label("VramForQueue");
  emitCellAddress(ctx);
  asm.st16To(layout.words + W.target * 2, "hl");
  asm.ret();

  // `a` = a tile, `layout.attr` = its attribute: write the pair to the data port.
  asm.label("PokeEntry");
  asm.outN(PORT.DATA);
  asm.lda(layout.attr);
  asm.outN(PORT.DATA);
  asm.ret();

  // `a` = a tile, `layout.attr` = its attribute, `words[target]` = the address:
  // append a three-byte entry to the queue. A cell here is an address *and* two
  // bytes of data, so the queue is a flat list rather than the run stream the
  // NES uses — the VDP's auto-increment makes a run cheap to write but the
  // address is only two bytes, so the saving is not worth a second format.
  asm.label("QueueEntry");
  const room = ctx.unique("queueRoom");
  asm.ld("c", "a");
  asm.lda(layout.queueCount);
  asm.aluN("cp", QUEUE_BYTES - layout.queueStride + 1);
  asm.jr(room, "c");
  // No room: repaint the whole background next frame rather than leave a strip
  // of it stale for ever.
  asm.ldn("a", 1);
  asm.sta(layout.redraw);
  asm.ret();
  asm.label(room);
  asm.ld16("hl", layout.queue);
  emitAddA(ctx);
  asm.ld16From("de", layout.words + W.target * 2);
  asm.ld("hlp", "e");
  asm.inc16("hl");
  asm.ld("hlp", "d");
  asm.inc16("hl");
  asm.ld("hlp", "c");
  asm.inc16("hl");
  asm.lda(layout.attr);
  asm.ld("hlp", "a");
  asm.lda(layout.queueCount);
  asm.aluN("add", layout.queueStride);
  asm.sta(layout.queueCount);
  asm.ret();

  // `a` = tile: queue it as one cell, record the cell for erasing, and advance
  // the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  emitTileAttr(ctx);
  asm.push("af");
  asm.call("VramForQueue");
  asm.pop("af");
  asm.call("QueueEntry");
  asm.lda(layout.plotCount);
  asm.aluN("cp", layout.memory.plotMax);
  asm.jr(plotFull, "nc");
  asm.alu("add", "a");
  asm.alu("add", "a");
  asm.ld16("hl", layout.plot);
  emitAddA(ctx);
  asm.ld16From("de", layout.words + W.tileCol * 2);
  asm.ld("hlp", "e");
  asm.inc16("hl");
  asm.ld("hlp", "d");
  asm.inc16("hl");
  asm.ld16From("de", layout.words + W.tileRow * 2);
  asm.ld("hlp", "e");
  asm.inc16("hl");
  asm.ld("hlp", "d");
  asm.lda(layout.plotCount);
  asm.inc("a");
  asm.sta(layout.plotCount);
  asm.label(plotFull);
  inc16(ctx, layout.words + W.tileCol * 2);
  asm.ret();

  // Flush the queue, upload the objects, and set the scroll. All three fit
  // inside the blanking interval by construction: the queue is capped at what
  // one will hold and anything over sets the redraw flag instead of being
  // dropped.
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.lda(layout.queueCount);
  asm.aluN("or", 0);
  ctx.far("z", noQueue);
  asm.ld("b", "a");
  asm.ld16("hl", layout.queue);
  asm.label(flush);
  asm.push("bc");
  asm.ld("a", "hlp");
  asm.outN(PORT.CONTROL);
  asm.inc16("hl");
  asm.ld("a", "hlp");
  asm.aluN("or", 0x40);
  asm.outN(PORT.CONTROL);
  asm.inc16("hl");
  asm.ld("a", "hlp");
  asm.outN(PORT.DATA);
  asm.inc16("hl");
  asm.ld("a", "hlp");
  asm.outN(PORT.DATA);
  asm.inc16("hl");
  asm.pop("bc");
  asm.ldn("a", layout.queueStride);
  asm.ld("c", "a");
  asm.ld("a", "b");
  asm.alu("sub", "c");
  asm.ld("b", "a");
  ctx.far("nz", flush);
  asm.alu("xor", "a");
  asm.sta(layout.queueCount);
  asm.label(noQueue);

  // Objects: the Y table, then the (X, tile) pairs, as two runs through the data
  // port — which auto-increments, so each is one address write and a block.
  //
  // Only the entries in use, and `otir` rather than a loop. Both are the same
  // observation twice: this runs inside the blanking interval, and a table that
  // is 192 bytes whatever the scene holds is the largest thing in it. The list
  // *terminates* — the first parked entry is `$D0` and the hardware stops there
  // — so the Y run is one byte past the last object and the pair run stops with
  // it; a game showing eleven sprites uploads thirty-five bytes instead of a
  // hundred and ninety-two. It was thirteen per cent of pong's tick.
  const noObjects = ctx.unique("noObjects");
  asm.lda(layout.oamCount);
  // One past the last, for the terminator — unless every entry is in use, in
  // which case there is no terminator to send and `b` would wrap to zero.
  const full = ctx.unique("oamFull");
  asm.aluN("cp", layout.memory.oamEntries);
  asm.jr(full, "nc");
  asm.inc("a");
  asm.label(full);
  asm.ld("b", "a");
  emitVramAddress(ctx, VRAM.SAT);
  asm.ld16("hl", layout.memory.oamShadow);
  asm.ldn("c", PORT.DATA);
  asm.otir();
  // The pairs are two bytes an entry and there is nothing to park, so a frame
  // with no objects at all skips the run — `otir` with `b` at zero writes 256.
  asm.lda(layout.oamCount);
  asm.alu("or", "a");
  ctx.far("z", noObjects);
  asm.alu("add", "a");
  asm.ld("b", "a");
  emitVramAddress(ctx, VRAM.SAT + 0x80);
  asm.ld16("hl", layout.memory.oamShadow + 0x80);
  asm.ldn("c", PORT.DATA);
  asm.otir();
  asm.label(noObjects);

  emitScrollWrite(ctx);
  asm.ret();

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell");

  emitDecimalPowers(ctx);
}

/**
 * Write the two scroll registers.
 *
 * The horizontal register shifts the picture *right*, so it carries the negated
 * camera; the vertical one shifts it up and carries the camera directly. Both
 * take the Game Gear's bias, which is what puts name-table cell (0,0) at the
 * small window's top left.
 *
 * **The two axes wrap differently, and only one of them is a byte.** The name
 * table is thirty-two columns, so a horizontal scroll wraps at 256 — which is
 * exactly what an eight-bit accumulator does for free, and why a level wider than
 * a byte needs nothing special. It is twenty-eight *rows*: a vertical scroll
 * wraps at 224, which a byte does not do. Reducing in `a` therefore throws away
 * thirty-two pixels every time the sum passes 255 — four rows, and the four rows
 * a picture slides by are the four nothing has painted, so the top of a scrolling
 * level wears whatever the last scene left there. It is done in `hl` for the
 * second reason as well: a level taller than 255 pixels has a camera that does
 * not fit in one either.
 */
function emitScrollWrite(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const bias = scrollBias(ctx);

  asm.lda(layout.words + W.scrollX * 2);
  asm.neg();
  if (bias.x !== 0) asm.aluN("add", bias.x);
  emitVdpRegisterA(ctx, 8);

  const wrap = ctx.unique("vscrollWrap");
  asm.ld16From("hl", layout.words + W.scrollY * 2);
  if (bias.y !== 0) {
    asm.ld16("de", bias.y);
    asm.addHL("de");
  }
  asm.ld16("de", MAP_H * 8);
  // Subtract until it goes negative, then put the last one back: the borrow is
  // the only sixteen-bit comparison this CPU has, and it is the subtraction.
  asm.label(wrap);
  asm.alu("or", "a");
  asm.sbcHL("de");
  asm.jr(wrap, "nc");
  asm.addHL("de");
  asm.ld("a", "l");
  emitVdpRegisterA(ctx, 9);
}

/**
 * `hl` = the video-RAM address of the cell in words[tileCol]/words[tileRow].
 *
 * The wrap is the whole of scrolling on this console: the name table is 32×28
 * and the scroll registers do the moving, so a level column lands at
 * `column mod 32` and a row at `row mod 28`. Thirty-two divides 256 so the column
 * is a mask; twenty-eight does not, so the row is a subtraction loop — and a
 * level is never more than a few multiples of twenty-eight tall.
 */
function emitCellAddress(ctx: SmsCtx): void {
  const { asm, layout } = ctx;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  // A subtraction loop rather than a mask: twenty-eight does not divide 256, so
  // there is no bit to test. A level is never more than a few multiples of it
  // tall, and the loop terminates for any input because the subtraction is
  // unsigned.
  const rowLoop = ctx.unique("rowMod");
  asm.ld16From("hl", row);
  asm.label(rowLoop);
  asm.ld16("de", MAP_H);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("nc", rowLoop);
  asm.addHL("de"); // one subtraction too many, put back

  // address = NAME + row * 64 + (column & 31) * 2
  asm.addHL("hl");
  asm.addHL("hl");
  asm.addHL("hl");
  asm.addHL("hl");
  asm.addHL("hl");
  asm.addHL("hl");
  asm.lda(col);
  asm.aluN("and", MAP_W - 1);
  asm.alu("add", "a");
  emitAddA(ctx);
  asm.ld16("de", VRAM.NAME);
  asm.addHL("de");
}

/**
 * Draw the signed 16-bit value `de` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the sprite one — which is
 * why it is a parameter rather than a second copy of the digit loop. Leading
 * zeroes are suppressed and a lone zero still prints.
 */
function emitDecimal(ctx: SmsCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine, the write queue and the object builder — which between them
  // use every byte of the helper scratch. So the digit loop keeps its state in
  // the render words instead, in slots nothing on that path touches.
  //
  // Which slots those are is not a matter of taste. Not the pen (`cell`,
  // `count`); not the cell being written (`tileCol`, `tileRow`); not the queued
  // address (`target`); and — the one that actually bit — **not the map origin**.
  // `mapCol`/`mapRow` are where the renderer remembers which cell the name table
  // starts at, and they have to survive from one frame to the next; a HUD counter
  // that scribbled on them made the scroll walk read a nonsense origin, decide
  // the camera had teleported, and ask for a full redraw. The game looked right
  // and repainted the whole screen seventy-eight frames in ninety.
  //
  // What is safe is the redraw's and the walk's own loop counters, because both
  // have finished by the time a HUD is drawn.
  const value = layout.words + W.firstCol * 2;
  const flag = layout.words + W.firstRow * 2;
  const digit = layout.words + W.firstRow * 2 + 1;
  const power = layout.words + W.lastCol * 2;

  asm.exDEHL();
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.st16To(value, "de");

  const positive = ctx.unique("numPos");
  asm.ld("a", "d");
  asm.aluN("or", 0);
  ctx.far("p", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.ld16("hl", 0);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  asm.st16To(value, "hl");
  asm.ldn("a", glyphTile("-"));
  asm.call(plot);
  asm.label(positive);

  asm.alu("xor", "a");
  asm.sta(flag);
  asm.sta(power);
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const digitDone = ctx.unique("numDigit");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");

  asm.label(powerLoop);
  asm.alu("xor", "a");
  asm.sta(digit);
  asm.label(subLoop);
  // value -= power, keeping it only while it does not go negative.
  asm.lda(power);
  asm.ld16("hl", label("DecimalPowers"));
  emitAddA(ctx);
  asm.ld("e", "hlp");
  asm.inc16("hl");
  asm.ld("d", "hlp");
  asm.ld16From("hl", value);
  asm.aluN("or", 0);
  asm.sbcHL("de");
  ctx.far("c", digitDone);
  asm.st16To(value, "hl");
  asm.lda(digit);
  asm.inc("a");
  asm.sta(digit);
  asm.jp(subLoop);
  asm.label(digitDone);
  asm.lda(digit);
  asm.aluN("or", 0);
  ctx.far("nz", emitDigit);
  asm.lda(flag);
  asm.aluN("or", 0);
  ctx.far("nz", emitDigit);
  asm.lda(power);
  asm.aluN("cp", 8);
  ctx.far("nz", skipDigit);
  asm.label(emitDigit);
  asm.ldn("a", 1);
  asm.sta(flag);
  asm.lda(digit);
  asm.aluN("add", glyphTile("0"));
  asm.call(plot);
  asm.label(skipDigit);
  asm.lda(power);
  asm.aluN("add", 2);
  asm.sta(power);
  asm.aluN("cp", 10);
  ctx.far("nz", powerLoop);
  asm.ret();
}

/** The powers of ten a decimal render walks, as little-endian words. */
function emitDecimalPowers(ctx: SmsCtx): void {
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}
