/**
 * The whole-program emitter for the Mega Drive: boot, the frame, the renderer.
 *
 * Everything here is per *scene*, for the reason the other three backends give:
 * a scene is what the machine is doing at any moment and the compiler knows
 * which one. What differs is all hardware, and five differences are load-bearing:
 *
 *   - **The plane is bigger than the screen, so there is no seam.** Sixty-four
 *     cells by thirty-two against a forty-by-twenty-eight window, so a scrolling
 *     scene paints its leading edge into a column nobody is looking at. The
 *     Master System's name table is exactly as wide as its screen and has to
 *     mask a column to hide the write; here that whole mechanism is absent.
 *   - **A cell is a word, and everything is in it.** Priority, a two-bit palette
 *     select, both flip bits and an eleven-bit tile index. So the shared level
 *     tables' "tile" byte is the *low* byte of that word and its "attribute"
 *     byte is the high one — which is exactly eight bits of priority, palette,
 *     flips and the tile's top three bits, with nothing left over.
 *   - **Colour zero is transparent on the background too.** A background pixel
 *     of index 0 shows register 7's backdrop, not the palette's own entry. That
 *     is why a caption's paper is the backdrop and why the system palette's ink
 *     is chosen against it, the same reasoning the NES backend uses for its
 *     universal backdrop.
 *   - **The VDP is memory-mapped, not a port.** Two longwords at `$C00000` and
 *     `$C00004`, and a control write is *two* words — so a handler that lands
 *     between them and reads the status port leaves the second being read as a
 *     first. The full redraw runs with interrupts masked for exactly that
 *     reason; everything else runs immediately after the interrupt it waited for.
 *   - **A sprite is eight bytes and the list is linked.** Each entry names the
 *     next and a link of zero ends it, so parking a sprite means fixing the
 *     link rather than moving it off screen.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 */

import { AUDIO_STOP, type MdGameAudio } from "@demake/audio";
import {
  eaAbs,
  eaD,
  eaDisp,
  eaIdx,
  eaImm,
  eaInd,
  eaPost,
  eaPre,
  label,
  type Ref,
} from "@demake/core";

import type { InstanceDef } from "../../program.js";
import { glyphTile, OBJECT_TILE, patternTile } from "../../rom/graphics.js";
import { isMutable } from "../analyze.js";
import { emitTickSteps, type TickSteps } from "../backend.js";
import { PROPS, W } from "../layout.js";
import {
  artKey,
  emitInstanceDefaults,
  fixedCells,
  hudIsStatic,
  instanceCells,
  sceneContexts,
  sceneIndexOf,
  scrolls,
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { M68kCtx } from "../m68k/ctx.js";
import { emitTileContactHelper, emitTileRules } from "../m68k/tilerules.js";
import { propOffset } from "../m68k/expr.js";
import {
  CELL_OFFSET,
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
} from "../m68k/rules.js";
import {
  collectLevels,
  copy16,
  dec16,
  emitLevelData,
  emitRuleTileTable,
  emitTileAt,
  GRID_EMPTY,
  inc16,
  tileAtLabel,
  type LevelData,
} from "../m68k/tiles.js";
import { at, branchZero32, copy32, sub32 } from "../m68k/val.js";

/** Where a cartridge's code starts, past the vectors and the header. */
export const CODE_ORIGIN = 0x0200;

/** The VDP's two longword ports, and the controller's. */
const VDP = {
  DATA: 0xc00000,
  CONTROL: 0xc00004,
} as const;

/** Player one's data and control registers on the I/O chip. */
const PAD = {
  DATA: 0xa10003,
  CONTROL: 0xa10009,
} as const;

/** The TMSS security register, and the word that satisfies it. */
const TMSS = { VERSION: 0xa10001, REGISTER: 0xa14000, KEY: 0x53454741 } as const;

/** Where the VDP's tables live, which the register writes at boot decide. */
const VRAM = {
  /** The shared tile bank: 1408 tiles of 32 bytes, `$0000`–`$AFFF`. */
  TILES: 0x0000,
  /** The horizontal scroll table; only its first word is used. */
  HSCROLL: 0xb000,
  /** Plane A's name table: 64×32 entries of two bytes. */
  NAME: 0xc000,
  /** Plane B's, which stays blank so the backdrop shows through. */
  NAME_B: 0xe000,
  /** The sprite attribute table: eighty entries of eight bytes. */
  SAT: 0xf000,
} as const;

/** Cells the plane holds. Both are powers of two, so the wrap is a mask. */
const MAP_W = 64;
const MAP_H = 32;

/** Tiles the bank holds, which is the console spec's own budget. */
export const BANK_TILES = 1408;

/** Bytes one 4bpp tile occupies. */
export const TILE_BYTES = 32;

/** Sub-palettes the background art may use: CRAM entries 0–31. */
export const ART_PALETTES = 2;

/** The sub-palette object art is fitted into. */
export const SPRITE_PALETTE = 2;

/**
 * The sub-palette the font, the level patterns and the placeholder block draw
 * with, on both layers.
 *
 * One of four, reserved, for the reason the Game Boy Color build keeps one of
 * eight and the NES one of four: a caption drawn in a title screen's own palette
 * is a caption nobody can read. Sprites and the background share colour RAM on
 * this console — unlike the Sega 8-bits, where they have a bank each — so one
 * reservation covers the HUD on both layers.
 */
export const SYSTEM_PALETTE = 3;

/** The cell-word bits that select the system palette. */
const SYSTEM_CELL = SYSTEM_PALETTE << 13;

/** The sprite-attribute bits that select the object palette. */
const SPRITE_ATTR = SPRITE_PALETTE << 13;

/** Colour index the built-in tiles' ink lands on, within their palette. */
export const SYSTEM_INK = 3;

/** The control longword that points the data port at a VRAM address, for writing. */
function vramCtrl(address: number): number {
  return (0x40000000 | ((address & 0x3fff) << 16) | ((address >> 14) & 3)) >>> 0;
}

/** The same, for colour RAM. */
function cramCtrl(address: number): number {
  return (0xc0000000 | ((address & 0x3fff) << 16)) >>> 0;
}

/** The same, for the vertical scroll RAM. */
function vsramCtrl(address: number): number {
  return (0x40000010 | ((address & 0x3fff) << 16)) >>> 0;
}

/** The byte the frame interrupt raises and the main loop waits on. */
function frameFlag(ctx: M68kCtx): number {
  return ctx.layout.interrupt as number;
}

/** Everything the emitter needs beyond the program itself. */
export interface MdEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number }>;
  /** Demade backdrops by scene name: the name table the picture fills. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The 4bpp tile bank, uploaded to video RAM at boot. */
  bank?: Uint8Array;
  /** Colour RAM as the art chose it: sixty-four big-endian BGR333 words. */
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
  audio?: MdGameAudio;
  /** Driver index of each of the program's sounds, or `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Which track each scene plays, as an index into the driver's table. */
  sceneTracks?: readonly number[];
}

/**
 * Dispatch on the running scene, through a table.
 *
 * A chain of comparisons is what the other three backends emit, because on those
 * machines a jump table costs an indirect load this one gets for nothing — and
 * because a conditional branch there reaches the whole program. Here it does not:
 * `Bcc` is sixteen signed bits and a scene's tick routine can be further away
 * than that, so a table is the form that is *correct* rather than the form that
 * is fast.
 */
function emitSceneDispatch(ctx: M68kCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.jmp(labels[0] as string);
    return;
  }
  const table = ctx.unique("sceneTable");
  asm.moveq(0, 0);
  asm.move("b", at(layout.scene), eaD(0));
  asm.lsl("l", 2, 0);
  asm.lea(eaAbs(label(table)), 0);
  asm.adda("l", eaD(0), 0);
  asm.movea("l", eaInd(0), 0);
  asm.jmp(eaInd(0));
  ctx.data((data) => {
    data.label(table);
    for (const target of labels) data.dl(label(target));
  });
}

/** Emit the whole program. */
export function emitProgram(ctx: M68kCtx, options: MdEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx, options);
  emitVint(ctx, options);
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
  asm.align();
  for (const level of levels) {
    const boundTile = (index: number): number => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern, in the system palette.
      if (bound) return bound.tile;
      return patternTile(index, level.file.tiles[index]?.solid ?? false) | (SYSTEM_CELL << 0);
    };
    // The two bytes of a cell word: the tile's low byte, and the high byte that
    // carries its palette, its flips and the tile's top three bits.
    emitLevelData(
      asm,
      level,
      (index) => boundTile(index) & 0xff,
      (index) => (boundTile(index) >> 8) & 0xff,
    );
    asm.align();
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
        asm.align();
      }
    }
  }
  asm.align();
  emitInstanceDefaults(asm, program, PROPS, ctx.layout.entitySizes);

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (art) {
      asm.align();
      asm.label(backdropLabel(scene));
      asm.bytes(packCells(art.map));
      asm.align();
    }
    const palette = options.scenePalettes?.get(scene.def.name);
    if (palette) {
      asm.align();
      asm.label(scenePaletteLabel(scene));
      asm.bytes(palette);
    }
  }

  if (options.audio) {
    if (program.tracks.length > 0) {
      asm.align();
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

  asm.align();
  asm.label("TileBank");
  asm.bytes(options.bank ?? new Uint8Array(0));
  asm.align();
  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette());
}

/**
 * The colour RAM a build with no demade art uses.
 *
 * Sixty-four big-endian `0000 BBB0 GGG0 RRR0` words, of which only the system
 * palette's four entries are anything but black: a rising grey ramp, so a
 * caption and a placeholder block are legible with nothing else uploaded.
 */
function defaultPalette(): Uint8Array {
  const bytes = new Uint8Array(64 * 2);
  const ramp = [
    [0, 0, 0],
    [2, 2, 2],
    [4, 4, 4],
    [7, 7, 7],
  ];
  for (const [index, codes] of ramp.entries()) {
    const word = encodeColour(codes as number[]);
    const at = (SYSTEM_PALETTE * 16 + index) * 2;
    bytes[at] = (word >> 8) & 0xff;
    bytes[at + 1] = word & 0xff;
  }
  return bytes;
}

/** One CRAM word from three three-bit codes. */
export function encodeColour(codes: readonly number[]): number {
  const r = (codes[0] ?? 0) & 7;
  const g = (codes[1] ?? 0) & 7;
  const b = (codes[2] ?? 0) & 7;
  return (b << 9) | (g << 5) | (r << 1);
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: M68kCtx, options: MdEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.moveToSr(eaImm(0x2700));

  // TMSS: a model-1+ console holds the VDP off its bus until the security
  // register has been written, and an accurate core does the same. The version
  // register's low nibble says whether this machine has one.
  const noTmss = ctx.unique("noTmss");
  asm.move("b", eaAbs(TMSS.VERSION), eaD(0));
  asm.andi("b", 0x0f, eaD(0));
  ctx.far("eq", noTmss);
  asm.move("l", eaImm(TMSS.KEY), eaAbs(TMSS.REGISTER));
  asm.label(noTmss);

  // Clear the console's whole 64 KiB, so a game's state starts from zero rather
  // than from whatever powered up — including the object shadow, whose sprites
  // would otherwise appear before the first frame is built.
  const clearLoop = ctx.unique("clearRam");
  asm.movea("l", eaImm(0xff0000), 0);
  asm.move("w", eaImm(0x3fff), eaD(0));
  asm.label(clearLoop);
  asm.clr("l", eaPost(0));
  asm.dbra(0, clearLoop);
  // The stack was in the range just cleared; put it back where reset left it.
  asm.movea("l", eaImm(STACK_TOP), 7);

  emitVdpInit(ctx);
  emitTileUpload(ctx, options.bank?.length ?? 0);
  emitPaletteUpload(ctx, "Palette");
  emitBlankPlanes(ctx);

  // The pad's TH line is an output, which is how the second half of a
  // three-button controller is read at all.
  asm.move("b", eaImm(0x40), eaAbs(PAD.CONTROL));

  // Every entity starts from its declared values, not just the entry scene's: a
  // rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    emitCopyBlock(
      ctx,
      label(`Defaults_${instance.id}`),
      layout.entities[instance.id] as number,
      layout.entitySizes[instance.id] as number,
    );
  }

  asm.clr("w", at(layout.tick));
  for (const address of [
    layout.ready,
    layout.booted,
    layout.held,
    layout.pressed,
    layout.released,
    layout.plotCount,
    layout.plotPrevCount,
    layout.queueCount,
  ]) {
    asm.clr("b", at(address));
  }
  asm.move("b", eaImm(layout.memory.oamEntries), at(layout.oamPrev));
  asm.move("b", eaImm(0xff), at(layout.pending));
  asm.move("b", eaImm(sceneIndexOf(program, program.entryScene)), at(layout.scene));
  asm.move("b", eaImm(1), at(layout.redraw));
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.jsr("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.clr("l", at(layout.camera));
    asm.clr("l", at(layout.camera + 4));
  }
  asm.jsr("BuildFrame");
  asm.jsr("UploadFrame");

  if (options.audio) {
    asm.jsr("AudioInit");
    if (program.tracks.length > 0) asm.jsr("SceneMusic");
  }

  // Display on, frame interrupt on. Everything above ran with both off, which is
  // what makes a screenful of name table safe to write without tearing.
  emitVdpRegister(ctx, 1, 0x64);
  asm.move("b", eaImm(1), at(layout.booted));
  asm.moveToSr(eaImm(0x2000));
  asm.jmp("Main");
}

/** Where the stack starts: the top of work RAM, kept even. */
export const STACK_TOP = 0xfffffe;

/**
 * The vertical interrupt, and the whole of what it does: say that the frame
 * happened.
 *
 * The upload is the main loop's, exactly as on the other three consoles, so the
 * loop owns the scratch the renderer uses and no interrupt can arrive in the
 * middle of a tick's use of it. Reading the control port is what tells the VDP
 * the interrupt has been seen; it is also what would corrupt a half-written
 * address, which is why the one routine long enough to be interrupted runs
 * masked.
 */
function emitVint(ctx: M68kCtx, options: MdEmitOptions): void {
  const { asm } = ctx;
  asm.label("Vint");
  asm.move("l", eaD(0), eaPre(7));
  asm.move("w", eaAbs(VDP.CONTROL), eaD(0));
  asm.move("b", eaImm(1), at(frameFlag(ctx)));
  // The driver's tick is *counted* here and performed in the main loop, exactly
  // as on the NES and the Sega 8-bits and for the same reason: the blanking
  // interval is the picture's, and a driver tick taken here is a tick the sprite
  // upload waits behind. A frame the game overran is then owed rather than lost,
  // which is what keeps the tempo the frame's rather than the loop's.
  // `AudioFrame` touches `d0` and the flags and nothing else, which is why one
  // register is saved.
  //
  // `jsr` rather than `bsr`, here and at every other call the game makes into
  // the driver: a `bsr` reaches sixteen signed bits and the driver is emitted
  // after every rule body in the program, which on this console is tens of
  // kilobytes away. Inside the driver the same call is a `bsr`, because there
  // the distance is a few hundred bytes and visible in one file.
  if (options.audio) asm.jsr(options.audio.routines.frame);
  asm.move("l", eaPost(7), eaD(0));
  asm.rte();
}

/** Write one VDP register with a compile-time value. */
function emitVdpRegister(ctx: M68kCtx, register: number, value: number): void {
  ctx.asm.move("w", eaImm(0x8000 | (register << 8) | (value & 0xff)), eaAbs(VDP.CONTROL));
}

/**
 * The register file, as the boot leaves it.
 *
 * `R2`, `R4`, `R5` and `R13` are where the four tables live and are the reason
 * {@link VRAM}'s addresses are what they are. `R16` is the plane size, and 64×32
 * is what gives a scrolling scene somewhere off screen to paint into.
 */
function emitVdpInit(ctx: M68kCtx): void {
  const registers: readonly [number, number][] = [
    [0, 0x04], // mode 1: no horizontal interrupt
    [1, 0x04], // mode 2: display off, no frame interrupt, Mega Drive mode
    [2, VRAM.NAME >> 10], // plane A
    [3, 0x00], // the window, which nothing uses
    [4, VRAM.NAME_B >> 13], // plane B
    [5, VRAM.SAT >> 9], // the sprite attribute table
    [6, 0x00],
    [7, 0x00], // the backdrop is palette 0, colour 0
    [8, 0x00],
    [9, 0x00],
    [10, 0xff], // the line counter, parked
    [11, 0x00], // mode 3: full-screen scroll on both axes
    [12, 0x81], // mode 4: H40, 320 pixels
    [13, VRAM.HSCROLL >> 10],
    [14, 0x00],
    [15, 0x02], // the data port's auto-increment
    [16, 0x01], // plane size 64×32
    [17, 0x00],
    [18, 0x00],
    [19, 0x00],
    [20, 0x00],
    [21, 0x00],
    [22, 0x00],
    [23, 0x00],
  ];
  for (const [register, value] of registers) emitVdpRegister(ctx, register, value);
}

/** Point the data port at a compile-time video-RAM address, for writing. */
function emitVramAddress(ctx: M68kCtx, address: number): void {
  ctx.asm.move("l", eaImm(vramCtrl(address)), eaAbs(VDP.CONTROL));
}

/** Copy the tile bank from the cartridge into video RAM. */
function emitTileUpload(ctx: M68kCtx, bytes: number): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  const loop = ctx.unique("bankLoop");
  emitVramAddress(ctx, VRAM.TILES);
  asm.lea(eaAbs(label("TileBank")), 0);
  asm.lea(eaAbs(VDP.DATA), 1);
  asm.move("w", eaImm((bytes >> 1) - 1), eaD(0));
  asm.label(loop);
  asm.move("w", eaPost(0), eaInd(1));
  asm.dbra(0, loop);
}

/** Upload all four sub-palettes: sixty-four colours, one word each. */
function emitPaletteUpload(ctx: M68kCtx, source: string): void {
  const { asm } = ctx;
  const loop = ctx.unique("cramLoop");
  asm.move("l", eaImm(cramCtrl(0)), eaAbs(VDP.CONTROL));
  asm.lea(eaAbs(label(source)), 0);
  asm.lea(eaAbs(VDP.DATA), 1);
  asm.move("w", eaImm(63), eaD(0));
  asm.label(loop);
  asm.move("w", eaPost(0), eaInd(1));
  asm.dbra(0, loop);
}

/**
 * Blank both planes and end the sprite list.
 *
 * Plane B is cleared and never written again: every cell of it is tile zero,
 * whose pixels are all index 0 and therefore transparent, so the backdrop shows
 * through it. That is the Mega Drive convention `codegen/md.ts` already relies
 * on for the image path.
 */
function emitBlankPlanes(ctx: M68kCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("blankLoop");
  const words = (VRAM.SAT - VRAM.NAME) >> 1;
  emitVramAddress(ctx, VRAM.NAME);
  asm.lea(eaAbs(VDP.DATA), 1);
  asm.move("w", eaImm(words - 1), eaD(0));
  asm.moveq(0, 1);
  asm.label(loop);
  asm.move("w", eaD(1), eaInd(1));
  asm.dbra(0, loop);

  // One parked sprite whose link ends the list, so nothing is drawn until the
  // first frame builds it.
  emitVramAddress(ctx, VRAM.SAT);
  for (let index = 0; index < 4; index += 1) asm.move("w", eaD(1), eaInd(1));
}

/** Copy an entity's defaults from the cartridge into work RAM. */
function emitCopyBlock(ctx: M68kCtx, source: Ref, dest: number, bytes: number): void {
  const { asm } = ctx;
  asm.lea(eaAbs(source), 0);
  asm.lea(at(dest), 1);
  for (let index = 0; index < bytes / 4; index += 1) {
    asm.move("l", eaPost(0), eaPost(1));
  }
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: M68kCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  asm.move("l", eaImm(program.seed >>> 0), at(layout.rng));
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.clr("b", at(layout.contacts + index));
    asm.clr("b", at(layout.contactsPrev + index));
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) asm.clr("b", at(layout.holdFlags + index));
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) asm.clr("b", at(layout.reachFlags + index));
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.clr("b", at(layout.tileContacts + index * layout.tileContactStride));
    }
  }
}

function emitMainLoop(ctx: M68kCtx, audio: boolean): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  asm.label("Main");
  asm.label(wait);
  asm.tst("b", at(frameFlag(ctx)));
  ctx.far("eq", wait);
  asm.clr("b", at(frameFlag(ctx)));
  asm.jsr("UploadFrame");
  asm.jsr("ReadInput");
  asm.jsr("Tick");
  // After the tick, so an effect a rule asked for is heard this frame rather than
  // next; after the upload, so the frame it delays is nobody's.
  if (audio) asm.jsr("AudioService");
  asm.jsr("BuildFrame");
  asm.jmp("Main");
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * A three-button controller reports half its buttons at a time, selected by the
 * TH line: high gives `1CBRLDU` and low gives `0SA00DU`, both active low. So the
 * read is two byte reads with a line toggle between them, and `c` — which the
 * language has no word for — is simply not looked at.
 */
function emitInput(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  asm.label("ReadInput");
  asm.move("b", eaImm(0x40), eaAbs(PAD.DATA));
  asm.nop();
  asm.nop();
  asm.move("b", eaAbs(PAD.DATA), eaD(0));
  asm.not("b", eaD(0));
  asm.move("b", eaImm(0x00), eaAbs(PAD.DATA));
  asm.nop();
  asm.nop();
  asm.move("b", eaAbs(PAD.DATA), eaD(1));
  asm.not("b", eaD(1));
  asm.move("b", eaImm(0x40), eaAbs(PAD.DATA));

  // The abstract set is `ACTIONS` order — left right up down a b start — which
  // doc 14 §Buttons chose as the portable floor.
  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  /** Which register and which bit each abstract button comes from. */
  const SOURCE: Readonly<Record<string, [number, number]>> = {
    up: [0, 0],
    down: [0, 1],
    left: [0, 2],
    right: [0, 3],
    b: [0, 4],
    a: [1, 4],
    start: [1, 5],
  };
  asm.moveq(0, 2);
  for (const [to, action] of ABSTRACT.entries()) {
    const source = SOURCE[action];
    if (!source) continue;
    const skip = ctx.unique("padSkip");
    asm.btst(source[1], eaD(source[0]));
    ctx.far("eq", skip);
    asm.bset(to, eaD(2));
    asm.label(skip);
  }

  // held → pressed and released, against last tick's set.
  asm.move("b", at(layout.held), eaD(3));
  asm.move("b", eaD(2), at(layout.held));
  asm.move("b", eaD(3), eaD(4));
  asm.not("b", eaD(4));
  asm.and("b", eaD(2), 4);
  asm.move("b", eaD(4), at(layout.pressed));
  asm.move("b", eaD(2), eaD(4));
  asm.not("b", eaD(4));
  asm.and("b", eaD(3), 4);
  asm.move("b", eaD(4), at(layout.released));
  asm.rts();
}

function emitTickDispatch(ctx: M68kCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) asm.move("b", eaImm(0xff), at(layout.sound));
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.jsr("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  asm.addq("w", 1, at(layout.tick));
  asm.addq("b", 1, at(layout.ready));
  asm.rts();
}

function emitSceneChange(ctx: M68kCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("SceneChange");
  const go = ctx.unique("changeGo");
  asm.cmpi("b", 0xff, at(layout.pending));
  ctx.far("ne", go);
  asm.rts();
  asm.label(go);
  asm.move("b", at(layout.pending), at(layout.scene));
  asm.move("b", eaImm(0xff), at(layout.pending));
  if (ctx.audio?.driver === true && ctx.program.tracks.length > 0) asm.jsr("SceneMusic");
  asm.jsr("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.jsr("UpdateCamera");
  asm.move("b", eaImm(1), at(layout.redraw));
  asm.rts();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request one byte: the driver
  // is serviced from the loop, and a scene change is not where it happens.
  if (ctx.audio?.driver === true && ctx.program.tracks.length > 0) {
    asm.label("SceneMusic");
    asm.moveq(0, 0);
    asm.move("b", at(layout.scene), eaD(0));
    asm.lea(eaAbs(label("SceneTracks")), 0);
    asm.move("b", eaIdx(0, 0, 0), eaD(1));
    asm.move("b", eaD(1), at(ctx.audio.music));
    asm.rts();
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

/** This console's instructions for each of doc 14's tick steps. */
function tickSteps(ctx: M68kCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.clr("b", at(layout.contacts + index));
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.move("b", at(layout.contacts + index), at(layout.contactsPrev + index));
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: M68kCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jmp("TickDone");
}

function emitSceneReset(ctx: M68kCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    emitCopyBlock(
      ctx,
      label(`Defaults_${id}`),
      layout.entities[id] as number,
      layout.entitySizes[id] as number,
    );
  }
  asm.rts();
}

function emitSceneCamera(ctx: M68kCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.rts();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: M68kCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: MdEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.clr("w", at(layout.words + W.camX * 2));
    asm.clr("w", at(layout.words + W.camY * 2));
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.tst("b", at(layout.redraw));
  ctx.far("eq", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  asm.clr("b", at(layout.redraw));
  asm.clr("b", at(layout.plotPrevCount));
  asm.bra(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with sprites; one that does not gets it
  // as background cells, which costs no objects at all.
  if (!scrolls(ctx, scene)) {
    emitHudErase(ctx, scene, level);
    asm.clr("b", at(layout.plotCount));
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options);
  asm.rts();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: M68kCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.move("l", at(src), eaD(0));
  asm.asr("l", 8, 0);
  asm.asr("l", 5, 0);
  asm.move("w", eaD(0), at(dst));
}

/** Draw the whole visible window, with the display off. */
function emitFullRedraw(
  ctx: M68kCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: MdEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Interrupts off for the whole of it, and this is not about tearing.
  //
  // Every address this routine gives the VDP is a *longword* to the control
  // port, which the processor performs as two word writes — and acknowledging
  // the frame interrupt means reading that port, which resets the half-written
  // state. A handler landing between the two words therefore leaves one cell of
  // the screen written somewhere else entirely, on a redraw that is otherwise
  // perfect. The rest of the runtime is safe by construction, because
  // `UploadFrame` runs a few instructions after the interrupt it waited for.
  asm.moveToSr(eaImm(0x2700));
  // Display off: a screenful of name table does not fit in one blanking interval.
  emitVdpRegister(ctx, 1, 0x24);

  // Every scene uploads a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours; one without brings the
  // build's — the level tiles' and the objects' fit. Leaving colour RAM alone
  // would mean a level scene wore whichever title screen the player came from.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteUpload(ctx, palette ? scenePaletteLabel(scene) : "Palette");

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a run of whole rows padded to the plane's width, so painting
    // it is one stream into the data port.
    emitVramAddress(ctx, VRAM.NAME);
    asm.lea(eaAbs(label(backdropLabel(scene))), 0);
    asm.jsr(needBlitBackdrop(ctx));
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    //
    // The window *plus one cell on each axis*, which is the same invariant the
    // Sega emitter states and holds for the same reason: a scroll of part of a
    // cell shows a sliver of the next one, and the walk only paints a strip once
    // the origin has actually moved. Painting the window alone leaves that sliver
    // holding whatever the last scene left in the plane — which on this console
    // is a bug the wide plane hides everywhere except the first sub-cell step of
    // a scene. The rows had it and the columns did not, which is the asymmetry
    // that gave it away.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    copy16(ctx, layout.words + W.firstCol * 2, layout.words + W.mapCol * 2);
    copy16(ctx, layout.words + W.tileRow * 2, layout.words + W.mapRow * 2);

    const rowLoop = ctx.unique("fullRow");
    const colLoop = ctx.unique("fullCol");
    const rows = layout.words + W.firstRow * 2;
    const columns = layout.words + W.lastCol * 2;
    const spare = level !== undefined ? 1 : 0;
    const height = layout.memory.viewH + spare;
    const width = layout.memory.viewW + spare;
    asm.move("w", eaImm(height), at(rows));
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.move("w", eaImm(width), at(columns));
    asm.label(colLoop);
    // The address is set per cell rather than per row, because the plane wraps
    // at sixty-four columns and a row's cells are not contiguous once the origin
    // is not zero.
    asm.jsr("VramFor");
    emitBackgroundTile(ctx, level);
    asm.move("w", eaD(0), eaAbs(VDP.DATA));
    inc16(ctx, layout.words + W.tileCol * 2);
    asm.subq("w", 1, at(columns));
    ctx.far("ne", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    asm.subq("w", 1, at(rows));
    ctx.far("ne", rowLoop);
  }

  // Captions go on now, with the background they sit on. A scrolling scene draws
  // its whole HUD with sprites, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  emitVdpRegister(ctx, 1, 0x64);
  asm.moveToSr(eaImm(0x2000));
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
 * the tile's low byte and the byte carrying its palette, flips and high bits —
 * so a run of identical cells has no byte runs in it at all. The Sega 8-bits'
 * name table packs the same way for the same reason; the NES's does not, because
 * an entry there is a single byte.
 *
 * A screenful is 1792 cells once padded to the plane's width, 3584 bytes, and a
 * demade screen is mostly runs — sky, a floor, a wall, and the twenty-four
 * columns of plane the window does not show.
 *
 * The format is the encoder's and the decoder's business and nothing else's:
 * what is guaranteed is the bytes that reach the VDP.
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

/** `a0` = a packed name table; write it to the data port at the current address. */
function needBlitBackdrop(ctx: M68kCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");
    const out = inner.unique("blitOut");

    asm.lea(eaAbs(VDP.DATA), 1);
    asm.label(next);
    asm.moveq(0, 0);
    asm.move("b", eaPost(0), eaD(0));
    inner.far("eq", out);
    asm.btst(7, eaD(0));
    inner.far("ne", run);

    asm.subq("w", 1, eaD(0));
    asm.label(literal);
    emitPackedCell(inner);
    asm.move("w", eaD(2), eaInd(1));
    asm.dbra(0, literal);
    asm.bra(next);

    asm.label(run);
    asm.andi("w", 0x7f, eaD(0));
    asm.subq("w", 1, eaD(0));
    emitPackedCell(inner);
    asm.label(runLoop);
    asm.move("w", eaD(2), eaInd(1));
    asm.dbra(0, runLoop);
    asm.bra(next);

    asm.label(out);
    asm.rts();
  });
}

/**
 * Read the next cell of a packed stream into `d2`, a byte at a time.
 *
 * Not `move.w (a0)+`: a cell in this stream follows a control *byte*, so half of
 * them are at odd addresses — and a word read from an odd address is an address
 * error on this CPU. It cost the first cell of every picture, which is exactly
 * the kind of thing a cell-for-cell oracle finds and a screenshot does not.
 */
function emitPackedCell(ctx: M68kCtx): void {
  const { asm } = ctx;
  asm.moveq(0, 2);
  asm.move("b", eaPost(0), eaD(2));
  asm.lsl("w", 8, 2);
  asm.move("b", eaPost(0), eaD(2));
}

/** The labels holding one scene's name table and colour RAM. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}

/**
 * `d0` = the cell word that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: M68kCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.move("w", eaImm(SYSTEM_CELL), eaD(0));
    return;
  }
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/** `d0 = the cell word for the legend index in d0`. */
function emitLegendToTile(ctx: M68kCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.cmpi("w", GRID_EMPTY, eaD(0));
  ctx.far("eq", empty);
  asm.lea(eaAbs(label(level.tileLabel)), 0);
  asm.moveq(0, 1);
  asm.move("b", eaIdx(0, 0, 0), eaD(1));
  asm.lea(eaAbs(label(level.attrLabel)), 0);
  asm.moveq(0, 2);
  asm.move("b", eaIdx(0, 0, 0), eaD(2));
  asm.lsl("w", 8, 2);
  asm.or("w", eaD(2), 1);
  asm.move("w", eaD(1), eaD(0));
  asm.bra(done);
  asm.label(empty);
  asm.move("w", eaImm(SYSTEM_CELL), eaD(0));
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: M68kCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.move("w", at(src), eaD(0));
    asm.ext("l", 0);
    asm.asr("l", 3, 0);
    asm.move("w", eaD(0), at(dst));
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the plane up to date after the camera moved.
 *
 * The scroll registers do the moving, so crossing a cell boundary costs one
 * column or one row of writes and nothing else. A jump too large to walk sets
 * the full-redraw flag instead of silently dropping cells off the end of the
 * queue.
 */
function emitScrollUpdate(ctx: M68kCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  asm.bra(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.move("b", eaImm(1), at(layout.redraw));
  asm.label(done);
}

/**
 * Step one axis of the plane origin toward the camera, painting the leading edge
 * as it goes. More than four cells in a tick is a teleport, not a scroll.
 *
 * The forward offset is the window's own size on both axes, because the plane is
 * bigger than the window on both: a new column goes twenty-four columns off the
 * right-hand edge and a new row four rows below the bottom, and neither is seen
 * until the scroll brings it round. The Master System has to write its new
 * column into the cell straddling the screen's left edge and mask it; here there
 * is nothing to hide.
 */
function emitWalkAxis(
  ctx: M68kCtx,
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

  asm.move("w", eaImm(5), at(guard));
  asm.label(loop);
  asm.subq("w", 1, at(guard));
  ctx.far("eq", bail);
  asm.move("w", at(want), eaD(0));
  asm.cmp("w", at(origin), 0);
  ctx.far("eq", done);
  ctx.far("lt", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  asm.bra(loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, 0);
  asm.bra(loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: M68kCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = (isColumn ? layout.memory.viewH : layout.memory.viewW) + 1;
  // Not `temp`: the grid lookup uses that word, and a counter clobbered mid-loop
  // paints a strip of whatever tile the count happened to land on.
  const remaining = layout.words + W.lastRow * 2;

  copy16(ctx, across, originAcross);
  if (offset !== 0) asm.addi("w", offset, at(across));
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.move("w", eaImm(count), at(remaining));
  asm.label(loop);
  asm.jsr("VramForQueue");
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  asm.jsr("QueueEntry");
  inc16(ctx, along);
  asm.subq("w", 1, at(remaining));
  ctx.far("ne", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(ctx: M68kCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  void scene;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.tst("b", at(layout.plotPrevCount));
  ctx.far("eq", done);
  asm.clr("w", at(cursor));
  asm.label(loop);
  asm.lea(at(layout.plotPrev), 0);
  asm.moveq(0, 1);
  asm.move("w", at(cursor), eaD(1));
  asm.adda("l", eaD(1), 0);
  asm.move("w", eaInd(0), at(layout.words + W.tileCol * 2));
  asm.move("w", eaDisp(0, 2), at(layout.words + W.tileRow * 2));
  asm.jsr("VramForQueue");
  emitBackgroundTile(ctx, level);
  asm.jsr("QueueEntry");
  asm.addi("w", 4, at(cursor));
  asm.moveq(0, 1);
  asm.move("b", at(layout.plotPrevCount), eaD(1));
  asm.lsl("w", 2, 1);
  asm.cmp("w", at(cursor), 1);
  ctx.far("ne", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  const loop = ctx.unique("swapLoop");
  asm.move("b", at(layout.plotCount), at(layout.plotPrevCount));
  asm.moveq(0, 2);
  asm.move("b", at(layout.plotCount), eaD(2));
  ctx.far("eq", done);
  asm.subq("w", 1, eaD(2));
  asm.lea(at(layout.plot), 0);
  asm.lea(at(layout.plotPrev), 1);
  asm.label(loop);
  // Four bytes an entry: a column and a row, both words.
  asm.move("l", eaPost(0), eaPost(1));
  asm.dbra(2, loop);
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(ctx: M68kCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    // wrapped plane puts it in the right place with no extra work.
    asm.move("w", at(base + propOffset("x") + CELL_OFFSET), at(layout.words + W.tileCol * 2));
    asm.move("w", at(base + propOffset("y") + CELL_OFFSET), at(layout.words + W.tileRow * 2));

    // A static object is painted straight into video RAM with the display
    // already off, so it needs neither the write queue nor a place in the erase
    // list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.move("w", eaImm(glyphTile(character)), eaD(0));
        asm.jsr(plot);
      }
    } else {
      asm.lea(at(base + propOffset("value") + CELL_OFFSET), 1);
      asm.jsr(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `d0 = tile`: write it at the current cell and advance the column. */
function needPokeCell(ctx: M68kCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    // Neither `VramFor` nor the routines under it touch `d0`, so the cell word
    // stays where the caller left it.
    asm.ori("w", SYSTEM_CELL, eaD(0));
    asm.jsr("VramFor");
    asm.move("w", eaD(0), eaAbs(VDP.DATA));
    inc16(inner, layout.words + W.tileCol * 2);
    asm.rts();
  });
}

/** The decimal renderer again, writing straight to video RAM. */
function needPokeNumber(ctx: M68kCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeCell(inner));
  });
}

/**
 * `a1` = entity base, `d4`/`d5` = the size in cells → `d0` zero when the object
 * is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * word of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled.
 */
function needOnscreen(ctx: M68kCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");

    const axis = (offset: number, margin: number, span: number): void => {
      asm.move("w", eaDisp(1, offset + CELL_OFFSET), eaD(0));
      asm.sub("w", at(camera + offset + CELL_OFFSET), 0);
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.move("w", eaD(0), eaD(1));
      asm.add("w", eaD(margin), 1);
      inner.far("mi", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.move("w", eaD(0), eaD(1));
      asm.subi("w", span + 1, eaD(1));
      inner.far("pl", apart);
    };
    axis(propOffset("x"), 4, layout.memory.viewW);
    axis(propOffset("y"), 5, layout.memory.viewH);

    asm.moveq(1, 0);
    asm.rts();
    asm.label(apart);
    asm.moveq(0, 0);
    asm.rts();
  });
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: M68kCtx, scene: SceneCtx, options: MdEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.clr("b", at(layout.oamCount));

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;

    // The collision box is the sprite's footprint, in whole cells — *this*
    // object's box, not its class's and not the largest one the file was
    // converted at.
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
      asm.lea(at(base), 1);
      asm.move("w", eaImm(width), eaD(4));
      asm.move("w", eaImm(height), eaD(5));
      asm.jsr(needOnscreen(ctx));
      ctx.far("eq", skip);
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
        const attribute = (art ? SPRITE_ATTR : SYSTEM_CELL) | (tile & 0x7ff);
        asm.move("w", at(layout.words + W.count * 2), eaD(0));
        if (row !== 0) asm.addi("w", row * 8, eaD(0));
        asm.move("w", at(layout.words + W.cell * 2), eaD(1));
        if (column !== 0) asm.addi("w", column * 8, eaD(1));
        asm.move("w", eaImm(attribute), eaD(2));
        asm.jsr(needPushSprite(ctx));
      }
    }
    asm.label(skip);
  }
  if (scrolls(ctx, scene)) emitHudSprites(ctx, scene);
  asm.jsr(needClearRestOfOam(ctx));
}

/**
 * Draw a scrolling scene's `number` and `text` objects as hardware sprites.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already
 * wrote — only the layer differs. Twenty objects to a scanline is the hardware's
 * limit here, which is twice what the Sega 8-bits and the NES allow, so a
 * caption in a scrolling scene is far less constrained than it is there.
 */
function emitHudSprites(ctx: M68kCtx, scene: SceneCtx): void {
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
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.move("w", eaImm(glyphTile(character)), eaD(0));
        asm.jsr(needHudGlyph(ctx));
      }
    } else {
      asm.lea(at(base + propOffset("value") + CELL_OFFSET), 1);
      asm.jsr(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `d0 = tile`: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: M68kCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const { asm, layout } = inner;
    asm.ori("w", SYSTEM_CELL, eaD(0));
    asm.move("w", eaD(0), eaD(2)); // the attribute word `PushSprite` takes
    asm.move("w", at(layout.words + W.count * 2), eaD(0));
    asm.move("w", at(layout.words + W.cell * 2), eaD(1));
    asm.jsr(needPushSprite(inner));
    asm.addi("w", 8, at(layout.words + W.cell * 2));
    asm.rts();
  });
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: M68kCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    emitDecimal(inner, needHudGlyph(inner));
  });
}

/**
 * `d0` = y, `d1` = x, `d2` = the attribute word; append an object entry.
 *
 * The sprite table takes positions biased by 128 on both axes, which is how the
 * hardware lets an object hang off the top or left of the screen. The bias goes
 * on here, in the one door every object cell and every HUD glyph goes through;
 * adding it at each call site is how one of them comes to be missed.
 *
 * The shadow is the sprite attribute table's own layout — eight bytes an entry,
 * with the *link* to the next — so the upload is one run. Each entry links to
 * the one after it and {@link needClearRestOfOam} cuts the list at the end.
 */
function needPushSprite(ctx: M68kCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    asm.moveq(0, 3);
    asm.move("b", at(layout.oamCount), eaD(3));
    asm.cmpi("w", layout.memory.oamEntries, eaD(3));
    inner.far("cs", room);
    asm.rts();
    asm.label(room);
    asm.lea(at(layout.memory.oamShadow), 1);
    asm.move("l", eaD(3), eaD(6));
    asm.lsl("l", 3, 6);
    asm.adda("l", eaD(6), 1);
    asm.addi("w", 128, eaD(0));
    asm.move("w", eaD(0), eaInd(1));
    asm.clr("b", eaDisp(1, 2)); // one cell wide and one tall
    asm.addq("w", 1, eaD(3));
    asm.move("b", eaD(3), eaDisp(1, 3)); // the link to the next entry
    asm.move("w", eaD(2), eaDisp(1, 4));
    asm.addi("w", 128, eaD(1));
    asm.move("w", eaD(1), eaDisp(1, 6));
    asm.move("b", eaD(3), at(layout.oamCount));
    asm.rts();
  });
}

/**
 * End the sprite list.
 *
 * A link of zero is what stops the hardware, so a frame with objects cuts the
 * chain after the last one and a frame with none parks a single entry off the
 * top of the screen. Nothing above the list has to be touched at all, which is
 * why the upload is as long as the list rather than as long as the table.
 */
function needClearRestOfOam(ctx: M68kCtx): Ref {
  return ctx.need("ClearRestOfOam", (inner) => {
    const { asm, layout } = inner;
    const some = inner.unique("oamSome");
    asm.moveq(0, 0);
    asm.move("b", at(layout.oamCount), eaD(0));
    inner.far("ne", some);
    // Nothing drawn: one entry at y = 0, which the 128 bias puts off the screen.
    asm.lea(at(layout.memory.oamShadow), 1);
    asm.clr("w", eaInd(1));
    asm.clr("w", eaDisp(1, 2));
    asm.clr("w", eaDisp(1, 4));
    asm.clr("w", eaDisp(1, 6));
    asm.move("b", eaImm(1), at(layout.oamCount));
    asm.rts();
    asm.label(some);
    asm.lea(at(layout.memory.oamShadow), 1);
    asm.subq("w", 1, eaD(0));
    asm.lsl("l", 3, 0);
    asm.adda("l", eaD(0), 1);
    asm.clr("b", eaDisp(1, 3));
    asm.rts();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: M68kCtx): void {
  const { asm, layout } = ctx;

  // `d1.w` = a plane address → point the data port at it, for writing. Every
  // address the queue and the redraw produce is inside the name table, so the
  // two high bits of the VRAM address are always the same and go in as a
  // constant rather than being computed.
  asm.label("WriteCtrl");
  asm.andi("l", 0x3fff, eaD(1));
  asm.swap(1);
  asm.ori("l", vramCtrl(VRAM.NAME), eaD(1));
  asm.move("l", eaD(1), eaAbs(VDP.CONTROL));
  asm.rts();

  // `d1.w` = the address of the cell in words[tileCol]/words[tileRow]. The plane
  // wraps every sixty-four columns and every thirty-two rows, and both are powers
  // of two — so the wrap is two masks rather than the Master System's
  // subtraction loop.
  asm.label("CellAddr");
  asm.move("w", at(layout.words + W.tileRow * 2), eaD(1));
  asm.andi("w", MAP_H - 1, eaD(1));
  asm.lsl("w", 6, 1);
  asm.move("w", at(layout.words + W.tileCol * 2), eaD(2));
  asm.andi("w", MAP_W - 1, eaD(2));
  asm.add("w", eaD(2), 1);
  asm.add("w", eaD(1), 1);
  asm.addi("w", VRAM.NAME, eaD(1));
  asm.rts();

  asm.label("VramFor");
  asm.jsr("CellAddr");
  asm.jmp("WriteCtrl");

  asm.label("VramForQueue");
  asm.jsr("CellAddr");
  asm.move("w", eaD(1), at(layout.words + W.target * 2));
  asm.rts();

  // `d0.w` = a cell word, `words[target]` = the address: append a four-byte entry
  // to the queue.
  asm.label("QueueEntry");
  const room = ctx.unique("queueRoom");
  asm.moveq(0, 1);
  asm.move("b", at(layout.queueCount), eaD(1));
  asm.cmpi("w", layout.memory.queueMax, eaD(1));
  ctx.far("cs", room);
  // No room: repaint the whole background next frame rather than leave a strip
  // of it stale for ever.
  asm.move("b", eaImm(1), at(layout.redraw));
  asm.rts();
  asm.label(room);
  asm.lsl("l", 2, 1); // four bytes an entry
  asm.lea(at(layout.queue), 1);
  asm.adda("l", eaD(1), 1);
  asm.move("w", at(layout.words + W.target * 2), eaInd(1));
  asm.move("w", eaD(0), eaDisp(1, 2));
  asm.addq("b", 1, at(layout.queueCount));
  asm.rts();

  // `d0` = tile: queue it as one cell, record the cell for erasing, and advance
  // the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  asm.ori("w", SYSTEM_CELL, eaD(0));
  asm.jsr("VramForQueue");
  asm.jsr("QueueEntry");
  asm.moveq(0, 1);
  asm.move("b", at(layout.plotCount), eaD(1));
  asm.cmpi("w", layout.memory.plotMax, eaD(1));
  ctx.far("cc", plotFull);
  asm.lsl("l", 2, 1);
  asm.lea(at(layout.plot), 0);
  asm.adda("l", eaD(1), 0);
  asm.move("w", at(layout.words + W.tileCol * 2), eaInd(0));
  asm.move("w", at(layout.words + W.tileRow * 2), eaDisp(0, 2));
  asm.addq("b", 1, at(layout.plotCount));
  asm.label(plotFull);
  inc16(ctx, layout.words + W.tileCol * 2);
  asm.rts();

  emitUploadFrame(ctx);

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell");

  emitDecimalPowers(ctx);
}

/**
 * Flush the queue, upload the objects, and set the scroll.
 *
 * All three fit inside the blanking interval by construction: the queue is
 * capped at what one will hold and anything over sets the redraw flag instead of
 * being dropped.
 */
function emitUploadFrame(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.moveq(0, 0);
  asm.move("b", at(layout.queueCount), eaD(0));
  ctx.far("eq", noQueue);
  asm.subq("w", 1, eaD(0));
  asm.lea(at(layout.queue), 0);
  asm.lea(eaAbs(VDP.DATA), 1);
  asm.label(flush);
  // `WriteCtrl` touches `d1` and the control port and nothing else, which is why
  // the cursor can stay in `a0` across it.
  asm.moveq(0, 1);
  asm.move("w", eaPost(0), eaD(1));
  asm.jsr("WriteCtrl");
  asm.move("w", eaPost(0), eaInd(1));
  asm.dbra(0, flush);
  asm.clr("b", at(layout.queueCount));
  asm.label(noQueue);

  // Objects: eighty entries of eight bytes, uploaded only as far as the list
  // goes. The link of the last entry is zero, so the hardware stops there.
  const noObjects = ctx.unique("noObjects");
  const oamLoop = ctx.unique("oamLoop");
  asm.moveq(0, 0);
  asm.move("b", at(layout.oamCount), eaD(0));
  ctx.far("eq", noObjects);
  asm.lsl("l", 2, 0); // four words an entry
  asm.subq("w", 1, eaD(0));
  emitVramAddress(ctx, VRAM.SAT);
  asm.lea(at(layout.memory.oamShadow), 0);
  asm.lea(eaAbs(VDP.DATA), 1);
  asm.label(oamLoop);
  asm.move("w", eaPost(0), eaInd(1));
  asm.dbra(0, oamLoop);
  asm.label(noObjects);

  emitScrollWrite(ctx);
  asm.rts();
}

/**
 * Write the two scroll registers.
 *
 * The horizontal one shifts the picture *right*, so it carries the negated
 * camera; the vertical one carries the camera directly. Both wrap at the plane's
 * size in pixels — 512 across and 256 down — and both are powers of two, so the
 * wrap is a mask rather than the subtraction loop the Master System's
 * twenty-eight rows force.
 */
function emitScrollWrite(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  asm.move("l", eaImm(vramCtrl(VRAM.HSCROLL)), eaAbs(VDP.CONTROL));
  asm.move("w", at(layout.words + W.scrollX * 2), eaD(0));
  asm.neg("w", eaD(0));
  asm.andi("w", (MAP_W * 8 - 1) & 0x3ff, eaD(0));
  asm.move("w", eaD(0), eaAbs(VDP.DATA));

  asm.move("l", eaImm(vsramCtrl(0)), eaAbs(VDP.CONTROL));
  asm.move("w", at(layout.words + W.scrollY * 2), eaD(0));
  asm.andi("w", MAP_H * 8 - 1, eaD(0));
  asm.move("w", eaD(0), eaAbs(VDP.DATA));
}

/**
 * Draw the signed 16-bit value `a1` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the sprite one — which is
 * why it is a parameter rather than a second copy of the digit loop. Leading
 * zeroes are suppressed and a lone zero still prints.
 */
function emitDecimal(ctx: M68kCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine, the write queue and the object builder — which between them
  // use every register there is. So the digit loop keeps its state in the render
  // words instead, in slots nothing on that path touches: not the pen, not the
  // cell being written, not the queued address, and above all not the map origin,
  // which has to survive from one frame to the next.
  const value = layout.words + W.firstCol * 2;
  const flag = layout.words + W.firstRow * 2;
  const digit = layout.words + W.firstRow * 2 + 1;
  const power = layout.words + W.lastCol * 2;

  asm.move("w", eaInd(1), at(value));

  const positive = ctx.unique("numPos");
  asm.tst("w", at(value));
  ctx.far("pl", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.neg("w", at(value));
  asm.move("w", eaImm(glyphTile("-")), eaD(0));
  asm.jsr(plot);
  asm.label(positive);

  asm.clr("b", at(flag));
  asm.clr("b", at(power));
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const digitDone = ctx.unique("numDigit");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");

  asm.label(powerLoop);
  asm.clr("b", at(digit));
  asm.label(subLoop);
  // value -= power, keeping it only while it does not go negative.
  asm.moveq(0, 1);
  asm.move("b", at(power), eaD(1));
  asm.lea(eaAbs(label("DecimalPowers")), 0);
  asm.adda("l", eaD(1), 0);
  asm.move("w", eaInd(0), eaD(2));
  asm.move("w", at(value), eaD(3));
  asm.sub("w", eaD(2), 3);
  ctx.far("cs", digitDone);
  asm.move("w", eaD(3), at(value));
  asm.addq("b", 1, at(digit));
  asm.bra(subLoop);
  asm.label(digitDone);
  asm.tst("b", at(digit));
  ctx.far("ne", emitDigit);
  asm.tst("b", at(flag));
  ctx.far("ne", emitDigit);
  asm.cmpi("b", 8, at(power));
  ctx.far("ne", skipDigit);
  asm.label(emitDigit);
  asm.move("b", eaImm(1), at(flag));
  asm.moveq(0, 0);
  asm.move("b", at(digit), eaD(0));
  asm.addi("w", glyphTile("0"), eaD(0));
  asm.jsr(plot);
  asm.label(skipDigit);
  asm.addq("b", 2, at(power));
  asm.cmpi("b", 10, at(power));
  ctx.far("ne", powerLoop);
  asm.rts();
}

/** The powers of ten a decimal render walks, as big-endian words. */
function emitDecimalPowers(ctx: M68kCtx): void {
  ctx.asm.align();
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}
