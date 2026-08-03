/**
 * The whole-program emitter for the PC Engine: boot, the frame, the renderer.
 *
 * Everything here is per *scene*, for the reason every backend gives: a scene is
 * what the machine is doing at any moment and the compiler knows which one. The
 * tick order, the rule bodies and every compile-time decision are shared
 * (`backend.ts`, `shape.ts`), and the 16.16 arithmetic is shared one level lower
 * (`codegen/mos/`) because this console's processor *is* a 6502 with a memory
 * mapper on it. What is left — this file — is the picture hardware, and five of
 * its differences are load-bearing:
 *
 *   - **The program lives in a window, not in a cartridge.** Eight `MPR`
 *     registers map 8 KiB pages, and the four things a game needs — the hardware
 *     page, work RAM, its code and its data — leave exactly 48 KiB contiguous at
 *     `$4000`–`$FFFF`. The boot stub is the one part that has to be *somewhere*
 *     rather than anywhere: reset maps cartridge bank 0 at `$E000`, so the top
 *     8 KiB of the image is bank 0 and everything below it is banks 1 upward,
 *     which is why {@link emitProgram} pads to `$E000` and emits the reset code
 *     last.
 *   - **Video RAM is words behind a port, and one instruction fills it.** `tia
 *     source, $0002, n` streams a run into the data port with the destination
 *     alternating between its two bytes, which is exactly a word write — so the
 *     tile bank, the sprite patterns and the palettes each upload in a single
 *     instruction rather than in a loop.
 *   - **The map is bigger than the screen on both axes, and both wraps are
 *     powers of two.** Sixty-four cells by thirty-two against a window of
 *     thirty-two by twenty-eight, so a scrolling scene paints its leading edge
 *     where nobody is looking and the Master System's whole seam-masking
 *     mechanism is absent — the Mega Drive's arrangement, on an 8-bit CPU. It
 *     also makes the cell address two masks and a shift instead of a modulo.
 *   - **A cell carries its own palette.** A BAT entry is a word: twelve bits of
 *     character and four of palette. So there is no attribute table and no
 *     16×16 block to reason about — a caption's cell simply names the font's
 *     palette, and the NES's whole compile-time attribute machinery is absent.
 *   - **The sprite table is copied out of video RAM, once a frame.** The chip
 *     fetches 256 words from `DVSSR` at the top of every vertical blank, so the
 *     runtime writes its shadow into video RAM during *active display* — after
 *     the tick, before the blank the fetch happens in — and the objects then
 *     land on the same frame as the background the blank uploads. Doing it in
 *     the blanking interval instead would put the sprites one frame behind the
 *     scenery, which reads as a game with lag rather than as a bug.
 *
 * And one thing this console has that costs rather than saves: **there is no
 * 8×8 sprite**. Objects are 16×16 at their smallest, so a one-cell object is a
 * sprite with three quarters of it transparent and a HUD glyph is a whole
 * 128-byte pattern. The upside is the same fact: an object `w` cells wide costs
 * `ceil(w/2)` entries against every other console's `ceil(w)`, into a per-line
 * budget of sixteen rather than eight.
 */

import { Asm6280, abs, absX, imm, indY, label, type Ref } from "@demake/core";

import type { InstanceDef } from "../../program.js";
import { isMutable } from "../analyze.js";
import { emitTickSteps, type TickSteps } from "../backend.js";
import { PROPS, W } from "../layout.js";
import { propOffset } from "../mos/expr.js";
import {
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
} from "../mos/rules.js";
import { emitTileContactHelper, emitTileRules } from "../mos/tilerules.js";
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
} from "../mos/tiles.js";
import { branchZero32, copy32, sub32 } from "../mos/val.js";
import { mem, ZP } from "../mos/zp.js";
import { packCellPairs } from "../pack.js";
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
} from "../shape.js";

import type { PceCtx } from "./ctx.js";

/**
 * Hardware addresses, as a program sees them once its `tam`s have run.
 *
 * The whole `$FF` bank at `$0000`, which is the one page a game gives up to have
 * the video chip, the pad and the interrupt controller reachable. `st0`–`st2`
 * bypass the map entirely (`asm/huc6280.ts`), so the three VDC addresses appear
 * here only for the paths that write a *computed* value.
 */
const R = {
  /** Write: which VDC register the data port addresses. Read: the status. */
  VDC_ADDR: 0x0000,
  VDC_LO: 0x0002,
  VDC_HI: 0x0003,
  VCE_CTRL: 0x0400,
  VCE_CTA_LO: 0x0402,
  VCE_CTA_HI: 0x0403,
  VCE_DATA: 0x0404,
  JOY: 0x1000,
  IRQ_MASK: 0x1402,
  IRQ_STATUS: 0x1403,
} as const;

/** VDC registers this backend programs, by the number `st0` selects. */
const VDC = {
  MAWR: 0x00,
  VWR: 0x02,
  CR: 0x05,
  BXR: 0x07,
  BYR: 0x08,
  MWR: 0x09,
  HSR: 0x0a,
  HDR: 0x0b,
  VPR: 0x0c,
  VDW: 0x0d,
  VCR: 0x0e,
  DCR: 0x0f,
  DVSSR: 0x13,
} as const;

/** The background map, in cells. Bigger than the window on both axes. */
export const MAP_W = 64;
export const MAP_H = 32;

/**
 * The video RAM map, in words.
 *
 * Everything below is a word address, because that is the only kind this chip
 * has: `MAWR` counts words and one write through the data port is one word.
 */
/** The BAT is fixed at word zero and `MWR` chooses its size. */
const BAT_WORD = 0x0000;
/** Words a character takes: eight of planes 0/1, eight of planes 2/3. */
const CHAR_WORDS = 16;
/** The first character number art may use — the BAT occupies the ones below. */
export const CHAR_BASE = (MAP_W * MAP_H) / CHAR_WORDS;
/** Words a 16×16 sprite pattern takes: sixteen rows of four planes. */
const PATTERN_WORDS = 64;
/** Bytes one of them is in ROM. */
export const PATTERN_BYTES = PATTERN_WORDS * 2;
/** The first sprite pattern number, chosen to clear the character budget. */
export const SPRITE_BASE = 0x3800 / PATTERN_WORDS;
/** Where the chip fetches its sprite table from, at the top of video RAM. */
const SATB_WORD = 0x7f00;

/**
 * Characters a build may put in video RAM, built-in bank included.
 *
 * Ten kilobytes of the program's forty-eight at thirty-two bytes each, which is
 * the trade this console makes and the NES does not: characters there are a
 * separate ROM on the cartridge and cost the program nothing, and here they are
 * program bytes that also have to be uploaded. Three hundred and twenty is more
 * than the NES's own budget for a picture even so.
 */
export const BANK_TILES = 320;

/** Sprite patterns a build may put in video RAM: object art and HUD glyphs. */
export const SPRITE_PATTERNS = 64;

/**
 * The sub-palette reserved for the font, on both layers.
 *
 * The last of sixteen, for the reason every colour backend keeps one back:
 * everything else is demade art whose palette was chosen *for that art*, and a
 * caption drawn in a title screen's palette is sky on sky. Fifteen are left,
 * which is more than any fit here has ever asked for.
 */
export const SYSTEM_PALETTE = 15;

/** Sub-palettes a build's art may use — every one but the font's. */
export const ART_PALETTES = SYSTEM_PALETTE;

/** Colours in one sub-palette, and sub-palettes on each layer. */
export const PALETTE_SIZE = 16;

/** Where the object layer's palettes start in the colour table. */
const SPRITE_PALETTE_BASE = 256;

/** Bytes one scene's palette blob takes per sub-palette. */
export const PALETTE_BYTES = PALETTE_SIZE * 2;

/**
 * `CR`'s low byte with the display on: background, objects, and the blank's
 * interrupt.
 *
 * Bit 7 enables the background plane, bit 6 the objects, bit 3 the vertical
 * blanking interrupt — which is the only one this runtime has a handler for.
 */
const CR_ON = 0xc8;

/**
 * `CR`'s high byte, which is where the data port's auto-increment lives.
 *
 * Bits 12 and 11 of the register, so a step of sixty-four words — one whole map
 * row, which is what makes a scrolled column a single run — is `$10` up here and
 * not `$08`. Off by one bit it steps thirty-two, which paints every other row of
 * a column into the row above the one it belonged to.
 */
const CR_STEP_ONE = 0x00;
const CR_STEP_ROW = 0x10;

/**
 * Whether this level's vertical axis has to be scrolled by repainting.
 *
 * Only where the level is taller than the map. Thirty-two rows of map against a
 * twenty-eight-row window leave four to spare, so a level the map holds whole is
 * painted once and scrolled by the register alone — which is the NES's `pinsRows`
 * problem simply not arising, because there the map and the raster were both
 * thirty rows.
 */
function scrollsRows(level: LevelData): boolean {
  return level.file.height > MAP_H;
}

/** Everything the emitter needs beyond the program itself. */
export interface PceEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, { pattern: number; wide: number; tall: number; palette: number }>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette: number }>;
  /** Demade backdrops by scene name: the packed BAT and how many palettes it used. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array; palettes: number }>;
  /** One scene's colour table, by scene name: its art palettes then the font's. */
  scenePalettes?: ReadonlyMap<string, { art: Uint8Array; font: Uint8Array }>;
  /** The character bank: the built-in patterns, then the art's. */
  bank?: Uint8Array;
  /** The object patterns art contributed, already 16×16. */
  patterns?: Uint8Array;
  /** The object layer's colour table, and the palette a level's tiles use. */
  spritePalette?: Uint8Array;
  levelPalette?: Uint8Array;
  /** The font's ramp, for a scene with no picture of its own. */
  fontPalette?: Uint8Array;
  /** Which sub-palette a level's tile art was fitted into. */
  levelSubPalette?: number;
}

/** A BAT word: a character number and the sub-palette that colours it. */
function batWord(tile: number, palette: number): number {
  return ((CHAR_BASE + tile) & 0x0fff) | ((palette & 0x0f) << 12);
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: PceCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.jmp(labels[0] as string);
    return;
  }
  asm.lda(mem(layout.scene));
  for (const [index, target] of labels.entries()) {
    if (index === labels.length - 1) {
      asm.jmp(target);
      break;
    }
    asm.cmp(imm(index));
    ctx.far("eq", target);
  }
}

/** Emit the whole program. */
export function emitProgram(ctx: PceCtx, options: PceEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitInterrupts(ctx);
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
    const boundTile = (index: number): number => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern.
      return bound?.tile ?? ctx.bank.pattern(index, level.file.tiles[index]?.solid ?? false);
    };
    emitLevelData(asm, level, (index) => boundTile(index) & 0xff);
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
      }
    }
  }
  emitInstanceDefaults(asm, program, PROPS, ctx.layout.entitySizes);

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (art) {
      asm.label(backdropLabel(scene));
      asm.bytes(art.map);
    }
    const palettes = options.scenePalettes?.get(scene.def.name);
    asm.label(scenePaletteLabel(scene));
    asm.bytes(palettes?.art ?? options.levelPalette ?? defaultPalette(1));
    asm.label(fontPaletteLabel(scene));
    asm.bytes(palettes?.font ?? options.fontPalette ?? defaultFont());
  }

  asm.label("Chars");
  asm.bytes(options.bank ?? new Uint8Array(0));
  // The object patterns and the HUD's glyph patterns, adjacent — one upload
  // covers both, and the glyphs are only here at all if a scrolling scene drew
  // one (`needGlyphPattern`).
  asm.label("Patterns");
  asm.bytes(options.patterns ?? new Uint8Array(0));
  emitGlyphPatterns(ctx);
  asm.label("SpritePalette");
  asm.bytes(options.spritePalette ?? defaultPalette(1));

  // The boot stub, in the one bank reset maps: the top 8 KiB of the image, which
  // packs into cartridge bank 0 (`asm/pce-cart.ts`). Everything above is the
  // program, so this is where the one overflow this backend finds itself is.
  ctx.dataEnd = asm.pc;
  if (asm.pc > BOOT_ORIGIN) throw new WindowOverflow(asm.pc - CODE_ORIGIN);
  asm.padTo(BOOT_ORIGIN, 0xff);
  emitReset(ctx, options);
}

/**
 * The program ran past the address the boot stub has to start at.
 *
 * Its own error rather than an assembler one, because "this game is too big" is a
 * different thing to be told from "the code generator emitted something invalid",
 * and `pce.ts` turns it into `E_GAME_TOO_LARGE` — which is what makes the
 * cut-the-music path (`backend.ts` §Cutting the music) reach this console too, for
 * the day it has music to cut.
 */
export class WindowOverflow extends Error {
  constructor(readonly bytes: number) {
    super(
      `the program is ${bytes} bytes and the window below the boot bank holds ${BOOT_ORIGIN - CODE_ORIGIN}`,
    );
    this.name = "WindowOverflow";
  }
}

/** Where the boot stub sits: the last 8 KiB of the visible window. */
export const BOOT_ORIGIN = 0xe000;

/** Where the program is assembled: the first byte a `tam` can reach. */
export const CODE_ORIGIN = 0x4000;

/** A colour table of `count` sub-palettes, all black — a build with no art. */
function defaultPalette(count: number): Uint8Array {
  return new Uint8Array(count * PALETTE_BYTES);
}

/**
 * The font's own ramp: three rising greys at the top of its sub-palette.
 *
 * Colour zero of every background palette is the *shared* backdrop on this chip,
 * so a glyph's unlit pixels are whatever the picture chose and only the ink is
 * decided here. A scene with a demade backdrop gets a ramp chosen against it
 * (`pce-art.ts`); this is the one a scene with no picture uses, over the black
 * that an unwritten colour table holds.
 */
function defaultFont(): Uint8Array {
  const bytes = new Uint8Array(PALETTE_BYTES);
  const write = (index: number, code: number): void => {
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = (code >> 8) & 0xff;
  };
  // `GGGRRRBBB`: a dim, a mid and a full grey.
  write(13, (2 << 6) | (2 << 3) | 2);
  write(14, (5 << 6) | (5 << 3) | 5);
  write(15, (7 << 6) | (7 << 3) | 7);
  return bytes;
}

// --- boot --------------------------------------------------------------------

/** Select a VDC register and write a compile-time word into it. */
function vdcWord(ctx: PceCtx, register: number, value: number): void {
  ctx.asm.st0(register);
  ctx.asm.st1(value & 0xff);
  ctx.asm.st2((value >> 8) & 0xff);
}

/** Point the data port at a compile-time video RAM address, ready to write. */
function vdcAddress(ctx: PceCtx, word: number): void {
  vdcWord(ctx, VDC.MAWR, word);
  ctx.asm.st0(VDC.VWR);
}

/** Set the display's state and the data port's step in one register write. */
function vdcControl(ctx: PceCtx, low: number, step: number): void {
  ctx.asm.st0(VDC.CR);
  ctx.asm.st1(low);
  ctx.asm.st2(step);
}

/** Point the colour table at an entry, ready for a run of words. */
function vceAddress(ctx: PceCtx, entry: number): void {
  const { asm } = ctx;
  asm.lda(imm(entry & 0xff));
  asm.sta(abs(R.VCE_CTA_LO));
  asm.lda(imm((entry >> 8) & 1));
  asm.sta(abs(R.VCE_CTA_HI));
}

function emitReset(ctx: PceCtx, options: PceEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.sei();
  asm.csh(); // 7.16 MHz, and never undone
  asm.cld();
  // The map, before anything else: reset defines only `MPR7`, so until these run
  // there is no work RAM, no stack, no hardware page and no data.
  asm.lda(imm(0xff));
  asm.tam(Asm6280.mprBit(0));
  asm.lda(imm(0xf8));
  asm.tam(Asm6280.mprBit(1));
  asm.ldx(imm(0xff));
  asm.txs();
  for (let page = 2; page <= 6; page += 1) {
    asm.lda(imm(page - 1));
    asm.tam(Asm6280.mprBit(page));
  }
  // Every interrupt masked but the video chip's.
  asm.lda(imm(0x05));
  asm.sta(abs(R.IRQ_MASK));
  asm.sta(abs(R.IRQ_STATUS));

  // Clear the console's whole 8 KiB, so a game's state starts from zero rather
  // than from whatever powered up.
  const clear = ctx.unique("clearRam");
  asm.lda(imm(0));
  asm.ldx(imm(0));
  asm.label(clear);
  for (let page = 0x2000; page < 0x4000; page += 0x100) asm.sta(absX(page));
  asm.inx();
  asm.bne(clear);

  // The display off while video RAM is filled, and the data port stepping by one.
  vdcControl(ctx, 0x00, CR_STEP_ONE);
  // A 64×32 background map, which is what makes both wraps powers of two.
  vdcWord(ctx, VDC.MWR, 0x0010);
  // Display timing for a 256×224 frame in 262 lines. The numbers are the ones
  // `rom-harness/pce/main.asm` writes, because they are the console's rather
  // than any one program's.
  vdcWord(ctx, VDC.HSR, 0x0202);
  vdcWord(ctx, VDC.HDR, 0x031f);
  vdcWord(ctx, VDC.VPR, 0x0c02);
  vdcWord(ctx, VDC.VDW, 0x00df);
  vdcWord(ctx, VDC.VCR, 0x0016);
  vdcWord(ctx, VDC.BXR, 0x0000);
  vdcWord(ctx, VDC.BYR, 0x0000);
  // Where the chip fetches its sprite table, and the bit that makes it do so
  // every frame rather than once.
  vdcWord(ctx, VDC.DVSSR, SATB_WORD);
  vdcWord(ctx, VDC.DCR, 0x0010);

  // The character bank and the sprite patterns, one instruction each. The
  // destination is the data port's two bytes and the source walks, which is what
  // `tia` is for — and it is why nothing here is a loop.
  const bankBytes = options.bank?.length ?? 0;
  if (bankBytes > 0) {
    vdcAddress(ctx, CHAR_BASE * CHAR_WORDS);
    asm.tia(label("Chars"), R.VDC_LO, bankBytes);
  }
  const patternBytes = (options.patterns?.length ?? 0) + ctx.glyphPatterns.size * PATTERN_BYTES;
  if (patternBytes > 0) {
    vdcAddress(ctx, SPRITE_BASE * PATTERN_WORDS);
    asm.tia(label("Patterns"), R.VDC_LO, patternBytes);
  }

  // The colour encoder: normal dot clock, colour, a 262-line frame.
  asm.stz(abs(R.VCE_CTRL));
  vceAddress(ctx, SPRITE_PALETTE_BASE);
  asm.tia(label("SpritePalette"), R.VCE_DATA, options.spritePalette?.length ?? PALETTE_BYTES);
  // The object layer's font palette is fixed, because a glyph sprite is drawn
  // over whatever is behind it rather than over a picture's own backdrop.
  vceAddress(ctx, SPRITE_PALETTE_BASE + SYSTEM_PALETTE * PALETTE_SIZE);
  asm.tia(label(fontPaletteLabel(sceneContexts(ctx)[0] as SceneCtx)), R.VCE_DATA, PALETTE_BYTES);

  // A blank map, so nothing stale shows through before the first redraw.
  emitBlankMap(ctx);

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

  asm.lda(imm(0));
  asm.sta(mem(layout.tick));
  asm.sta(mem(layout.tick + 1));
  asm.sta(mem(layout.ready));
  asm.sta(mem(layout.booted));
  asm.sta(mem(layout.held));
  asm.sta(mem(layout.pressed));
  asm.sta(mem(layout.released));
  asm.sta(mem(layout.plotCount));
  asm.sta(mem(layout.plotPrevCount));
  asm.sta(mem(layout.queueCount));
  asm.lda(imm(layout.memory.oamEntries));
  asm.sta(mem(layout.oamPrev));
  asm.lda(imm(0xff));
  asm.sta(mem(layout.pending));
  asm.lda(imm(sceneIndexOf(program, program.entryScene)));
  asm.sta(mem(layout.scene));
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.jsr("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.lda(imm(0));
    for (let index = 0; index < 8; index += 1) asm.sta(mem(layout.camera + index));
  }
  asm.jsr("BuildFrame");
  asm.jsr("UploadFrame");

  vdcControl(ctx, CR_ON, CR_STEP_ONE);
  asm.lda(imm(1));
  asm.sta(mem(layout.booted));
  asm.cli();
  asm.jmp("Main");
}

/** Fill the whole background map with the blank character. */
function emitBlankMap(ctx: PceCtx): void {
  const { asm } = ctx;
  const outer = ctx.unique("blankOuter");
  const inner = ctx.unique("blankInner");
  vdcAddress(ctx, BAT_WORD);
  const word = batWord(0, 0);
  asm.ldy(imm((MAP_W * MAP_H) / 256));
  asm.label(outer);
  asm.ldx(imm(0));
  asm.label(inner);
  asm.lda(imm(word & 0xff));
  asm.sta(abs(R.VDC_LO));
  asm.lda(imm((word >> 8) & 0xff));
  asm.sta(abs(R.VDC_HI));
  asm.inx();
  asm.bne(inner);
  asm.dey();
  asm.bne(outer);
}

/** Copy a compile-time run of bytes from ROM into RAM. */
function emitCopyBlock(ctx: PceCtx, source: Ref, dest: number, count: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("copyLoop");
  asm.ldx(imm(count - 1));
  asm.label(loop);
  asm.lda(absX(source));
  asm.sta(absX(dest));
  asm.dex();
  asm.bpl(loop);
}

/** Put the program's seed back, which is what makes a scene change repeatable. */
function emitSeedRng(ctx: PceCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  const seed = program.seed | 0;
  for (let index = 0; index < 4; index += 1) {
    asm.lda(imm((seed >> (index * 8)) & 0xff));
    asm.sta(mem(layout.rng + index));
  }
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  asm.lda(imm(0));
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.sta(mem(layout.contacts + index));
    asm.sta(mem(layout.contactsPrev + index));
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) asm.sta(mem(layout.holdFlags + index));
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) asm.sta(mem(layout.reachFlags + index));
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.sta(mem(layout.tileContacts + index * layout.tileContactStride));
    }
  }
}

/**
 * The two flags the frame loop runs on, in the zero page beside the render
 * scratch.
 *
 * `VBLANKED` is the clock: the handler raises it and the main loop consumes it.
 * `FRAME_READY` is the hand-off: the main loop raises it when a frame's worth of
 * queue is *complete*, and the handler lowers it once that frame has been
 * uploaded. A half-built queue is never uploaded, because the flag that offers it
 * is set only after `BuildFrame` returns.
 */
const VBLANKED = 7;
const FRAME_READY = 6;

/**
 * The interrupt vectors, and the one of them that does anything.
 *
 * This console has five and a demade game answers one: `IRQ1`, which the video
 * chip raises at the top of the blanking interval. The upload happens *here*
 * rather than in the main loop for the reason the NES backend gives — the loop's
 * flag says "a blank happened", not "we are in one", so a tick that overran its
 * frame would upload in the middle of active display and tear.
 */
function emitInterrupts(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const idle = ctx.unique("irqNoFrame");
  // The scratch the upload borrows, saved because the tick may be mid-expression.
  const borrowed = [ZP.p0, ZP.p0 + 1, ZP.t0, ZP.t1, ZP.t2, ZP.t3, ZP.spare, ZP.spare + 1];

  asm.label("Irq1");
  asm.pha();
  asm.phx();
  asm.phy();
  // Reading the status acknowledges every bit it reports, which is what drops the
  // chip's interrupt line — the whole of this console's acknowledgement.
  asm.lda(abs(R.VDC_ADDR));

  asm.lda(mem(layout.scratch + FRAME_READY));
  asm.beq(idle);
  for (const byte of borrowed) {
    asm.lda(mem(byte));
    asm.pha();
  }
  asm.jsr("UploadFrame");
  for (const byte of [...borrowed].reverse()) {
    asm.pla();
    asm.sta(mem(byte));
  }
  asm.lda(imm(0));
  asm.sta(mem(layout.scratch + FRAME_READY));

  asm.label(idle);
  asm.lda(imm(1));
  asm.sta(mem(layout.scratch + VBLANKED));
  asm.ply();
  asm.plx();
  asm.pla();
  asm.rti();

  // Nothing else can raise one: the timer is stopped, IRQ2 is masked, and this
  // cartridge has no hardware of its own.
  asm.label("Irq2");
  asm.label("TimerIrq");
  asm.label("Nmi");
  asm.rti();
}

function emitMainLoop(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const wait = ctx.unique("waitVblank");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  asm.label("Main");
  asm.label(wait);
  asm.lda(mem(layout.scratch + VBLANKED));
  asm.beq(wait);
  asm.lda(imm(0));
  asm.sta(mem(layout.scratch + VBLANKED));
  asm.jsr("ReadInput");
  asm.jsr("Tick");
  asm.jsr("BuildFrame");
  // The objects go to video RAM here, in active display, because the chip fetches
  // them at the *top* of the next blank — so this is what lands them on the same
  // frame as the background the handler is about to upload.
  asm.jsr("UploadObjects");
  // The frame is whole: the next blank may show it.
  asm.lda(imm(1));
  asm.sta(mem(layout.scratch + FRAME_READY));
  asm.jmp("Main");
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * A multiplexer rather than a shift register: one address reports the directions
 * or the four buttons depending on the select line, both active low. The abstract
 * set is `ACTIONS` order — left right up down a b start — which doc 14 §Buttons
 * chose as the portable floor, and `start` is this pad's Run key.
 */
function emitInput(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const raw = ZP.t0;
  asm.label("ReadInput");
  // Directions first, with select low, then the buttons with it high. The pad
  // needs a moment to settle after the line moves, which is what the pair of
  // reads before each real one is for.
  asm.stz(abs(R.JOY));
  asm.lda(abs(R.JOY));
  asm.lda(abs(R.JOY));
  asm.and(imm(0x0f));
  asm.eor(imm(0x0f));
  asm.sta(mem(raw));
  asm.lda(imm(1));
  asm.sta(abs(R.JOY));
  asm.lda(abs(R.JOY));
  asm.lda(abs(R.JOY));
  asm.and(imm(0x0f));
  asm.eor(imm(0x0f));
  asm.asl();
  asm.asl();
  asm.asl();
  asm.asl();
  asm.ora(mem(raw));
  asm.sta(mem(raw));

  // Hardware order → abstract order. `raw` holds up right down left in bits 0–3
  // and I, II, Select, Run in bits 4–7.
  const HARDWARE = ["up", "right", "down", "left", "a", "b", "select", "start"] as const;
  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  asm.lda(imm(0));
  asm.sta(mem(ZP.t1));
  for (const [to, action] of ABSTRACT.entries()) {
    const from = HARDWARE.indexOf(action as (typeof HARDWARE)[number]);
    if (from < 0) continue;
    const skip = ctx.unique("padSkip");
    asm.lda(mem(raw));
    asm.and(imm(1 << from));
    asm.beq(skip);
    asm.lda(mem(ZP.t1));
    asm.ora(imm(1 << to));
    asm.sta(mem(ZP.t1));
    asm.label(skip);
  }

  // held → pressed and released, against last tick's set.
  asm.lda(mem(layout.held));
  asm.sta(mem(ZP.t2));
  asm.lda(mem(ZP.t1));
  asm.sta(mem(layout.held));
  asm.lda(mem(ZP.t2));
  asm.eor(imm(0xff));
  asm.and(mem(ZP.t1));
  asm.sta(mem(layout.pressed));
  asm.lda(mem(ZP.t1));
  asm.eor(imm(0xff));
  asm.and(mem(ZP.t2));
  asm.sta(mem(layout.released));
  asm.rts();
}

function emitTickDispatch(ctx: PceCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick —
  // and it is written even though this console has no driver to hear it, so that
  // its trace is the trace every other machine produces (doc 14 §Conformance).
  if (layout.sound !== null) {
    asm.lda(imm(0xff));
    asm.sta(mem(layout.sound));
  }
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.jsr("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  inc16(ctx, layout.tick);
  asm.inc(mem(layout.ready));
  asm.rts();
}

function emitSceneChange(ctx: PceCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("SceneChange");
  asm.lda(mem(layout.pending));
  asm.cmp(imm(0xff));
  const go = ctx.unique("changeGo");
  asm.bne(go);
  asm.rts();
  asm.label(go);
  asm.sta(mem(layout.scene));
  asm.lda(imm(0xff));
  asm.sta(mem(layout.pending));
  asm.jsr("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.jsr("UpdateCamera");
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.rts();

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
function tickSteps(ctx: PceCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      asm.lda(imm(0));
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.sta(mem(layout.contacts + index));
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.lda(mem(layout.contacts + index));
        asm.sta(mem(layout.contactsPrev + index));
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: PceCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jmp("TickDone");
}

function emitSceneReset(ctx: PceCtx, scene: SceneCtx): void {
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

function emitSceneCamera(ctx: PceCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.rts();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: PceCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: PceEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.lda(imm(0));
    asm.sta(mem(layout.words + W.camX * 2));
    asm.sta(mem(layout.words + W.camX * 2 + 1));
    asm.sta(mem(layout.words + W.camY * 2));
    asm.sta(mem(layout.words + W.camY * 2 + 1));
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.lda(mem(layout.redraw));
  ctx.far("eq", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  asm.lda(imm(0));
  asm.sta(mem(layout.redraw));
  asm.sta(mem(layout.plotPrevCount));
  asm.jmp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with sprites; one that does not gets it as
  // background cells, which costs no objects at all.
  if (!scrolls(ctx, scene)) {
    emitHudErase(ctx, scene, level, options);
    asm.lda(imm(0));
    asm.sta(mem(layout.plotCount));
    emitHud(ctx, scene, "dynamic", options);
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options);
  asm.rts();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: PceCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(mem(src, 1));
  asm.sta(mem(dst));
  asm.lda(mem(src, 2));
  asm.sta(mem(dst, 1));
  asm.lda(mem(src, 3));
  asm.sta(mem(ZP.t0));
  for (let shift = 0; shift < 5; shift += 1) {
    // The sign has to come back in at the top of a 24-bit value, so it goes out
    // through the carry first and the rotate brings it back.
    asm.lda(mem(ZP.t0));
    asm.asl();
    asm.ror(mem(ZP.t0));
    asm.ror(mem(dst, 1));
    asm.ror(mem(dst));
  }
}

/** Draw the whole visible window, with the display off. */
function emitFullRedraw(
  ctx: PceCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: PceEmitOptions,
): void {
  const { asm, layout } = ctx;
  // The display off: a screenful of writes with it on would tear, and this is the
  // one path long enough to be worth the frame it costs.
  vdcControl(ctx, 0x00, CR_STEP_ONE);
  emitScenePalette(ctx, scene, options);

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A picture is a whole map in order, so painting it is one walk from the
    // first cell — but it is *packed*, because a screenful is 1792 words here and
    // two of them stored raw would be a seventh of the whole program.
    vdcAddress(ctx, BAT_WORD);
    ctx.pointer(ZP.p0, label(backdropLabel(scene)));
    asm.jsr(needBlitCells(ctx));
  } else {
    // The window, and the one column the first scroll step will need before it
    // has had a chance to paint one. A level the map holds whole is painted to
    // the map's full height instead, because then the scroll register alone can
    // move it and no row ever has to be repainted.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    if (level !== undefined && !scrollsRows(level)) {
      asm.lda(imm(0));
      asm.sta(mem(layout.words + W.mapRow * 2));
      asm.sta(mem(layout.words + W.mapRow * 2 + 1));
    }
    copy16(ctx, layout.words + W.firstCol * 2, layout.words + W.mapCol * 2);
    copy16(ctx, layout.words + W.tileRow * 2, layout.words + W.mapRow * 2);

    const rowLoop = ctx.unique("fullRow");
    const colLoop = ctx.unique("fullCol");
    const rows = layout.words + W.firstRow * 2;
    const columns = layout.words + W.lastCol * 2;
    const height =
      level === undefined
        ? layout.memory.viewH
        : scrollsRows(level)
          ? layout.memory.viewH + 1
          : MAP_H;
    const width = layout.memory.viewW + (level === undefined ? 0 : 1);
    asm.lda(imm(height));
    asm.sta(mem(rows));
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.lda(imm(width));
    asm.sta(mem(columns));
    // The address is set once per row and the chip steps it — the whole point of
    // an auto-incrementing port. It has to be reset where the column wraps past
    // the map's width, because the next cell is then a whole row back.
    asm.jsr("VramFor");
    asm.label(colLoop);
    emitBackgroundTile(ctx, scene, level, options);
    asm.jsr("PokeEntry");
    inc16(ctx, layout.words + W.tileCol * 2);
    const noWrap = ctx.unique("fullNoWrap");
    asm.lda(mem(layout.words + W.tileCol * 2));
    asm.and(imm(MAP_W - 1));
    asm.bne(noWrap);
    asm.jsr("VramFor");
    asm.label(noWrap);
    asm.dec(mem(columns));
    ctx.far("ne", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    asm.dec(mem(rows));
    ctx.far("ne", rowLoop);
  }

  // Captions go on now, with the background they sit on. A scrolling scene draws
  // its whole HUD with sprites instead, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static", options);
  vdcControl(ctx, CR_ON, CR_STEP_ONE);
}

/** Upload one scene's colour table: its art palettes, then the font's. */
function emitScenePalette(ctx: PceCtx, scene: SceneCtx, options: PceEmitOptions): void {
  const { asm } = ctx;
  const entry = options.scenePalettes?.get(scene.def.name);
  const artBytes = entry?.art.length ?? options.levelPalette?.length ?? PALETTE_BYTES;
  const run = (target: number, source: string, entries: number): void => {
    vceAddress(ctx, target);
    ctx.pointer(ZP.p1, label(source));
    asm.lda(imm(entries));
    asm.sta(mem(ZP.t0));
    asm.jsr(needBlitPalette(ctx));
  };
  // The art's own sub-palettes at the bottom of the table, and the font's in the
  // slot every backend here keeps back — chosen against *this* picture's backdrop,
  // because colour zero of every background palette is the one the picture chose
  // and a fixed white ink is invisible over a pale sky.
  run(0, scenePaletteLabel(scene), artBytes / 2);
  run(SYSTEM_PALETTE * PALETTE_SIZE, fontPaletteLabel(scene), PALETTE_SIZE);
}

/**
 * `p1` = a colour blob, `t0` = how many entries: write it to the colour table.
 *
 * A loop rather than a block transfer, because the length is a *scene's* rather
 * than a build's — how many sub-palettes a fit used differs per picture, and one
 * routine that takes a count is smaller than a `tia` emitted per scene.
 */
function needBlitPalette(ctx: PceCtx): Ref {
  return ctx.need("BlitPalette", (inner) => {
    const self = inner as PceCtx;
    const asm = self.asm;
    const loop = self.unique("palLoop");
    // Fifteen sub-palettes is 480 bytes, so the cursor really does wrap and the
    // pointer's high byte has to follow it.
    const step = (): void => {
      const wrap = self.unique("palWrap");
      asm.iny();
      asm.bne(wrap);
      asm.inc(mem(ZP.p1, 1));
      asm.label(wrap);
    };
    asm.ldy(imm(0));
    asm.label(loop);
    asm.lda(indY(ZP.p1));
    asm.sta(abs(R.VCE_DATA));
    step();
    asm.lda(indY(ZP.p1));
    // The high half steps the colour-table address, which is what makes an upload
    // a plain run of byte pairs.
    asm.sta(abs(R.VCE_DATA + 1));
    step();
    asm.dec(mem(ZP.t0));
    self.far("ne", loop);
    asm.rts();
  });
}

/** `p0` = a packed map; write it to the video RAM data port. */
function needBlitCells(ctx: PceCtx): Ref {
  return ctx.need("BlitCells", (inner) => {
    const asm = (inner as PceCtx).asm;
    const next = inner.unique("blitNext");
    const literal = inner.unique("blitLiteral");
    const run = inner.unique("blitRun");
    const runLoop = inner.unique("blitRunLoop");
    const done = inner.unique("blitDone");

    // The cursor is `y` with the pointer's high byte bumped as it wraps, rather
    // than a 16-bit add per byte: a packed screen is a few hundred bytes and the
    // inner loops are what this routine is.
    const step = (): void => {
      const wrap = inner.unique("blitWrap");
      asm.iny();
      asm.bne(wrap);
      asm.inc(mem(ZP.p0, 1));
      asm.label(wrap);
    };

    asm.ldy(imm(0));
    asm.label(next);
    asm.lda(indY(ZP.p0));
    step();
    // The cursor's own flags are in the way, so the control byte is re-tested
    // rather than branched on where it was loaded.
    asm.cmp(imm(0));
    asm.beq(done);
    asm.bmi(run);

    asm.sta(mem(ZP.t2));
    asm.label(literal);
    asm.lda(indY(ZP.p0));
    step();
    asm.sta(abs(R.VDC_LO));
    asm.lda(indY(ZP.p0));
    step();
    asm.sta(abs(R.VDC_HI));
    asm.dec(mem(ZP.t2));
    asm.bne(literal);
    asm.bra(next);

    asm.label(run);
    asm.and(imm(0x7f));
    asm.sta(mem(ZP.t2));
    asm.lda(indY(ZP.p0));
    step();
    asm.sta(mem(ZP.t0));
    asm.lda(indY(ZP.p0));
    step();
    asm.sta(mem(ZP.t1));
    asm.label(runLoop);
    asm.lda(mem(ZP.t0));
    asm.sta(abs(R.VDC_LO));
    asm.lda(mem(ZP.t1));
    asm.sta(abs(R.VDC_HI));
    asm.dec(mem(ZP.t2));
    asm.bne(runLoop);
    asm.bra(next);

    asm.label(done);
    asm.rts();
  });
}

/** The labels holding one scene's map and its two colour blocks. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}
function fontPaletteLabel(scene: SceneCtx): string {
  return `FontPal_${scene.index}`;
}

/**
 * `A` = the character that belongs at `words[tileCol], words[tileRow]`, and its
 * sub-palette in `layout.attr`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(
  ctx: PceCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: PceEmitOptions,
): void {
  const { asm } = ctx;
  void scene;
  const palette = options.levelSubPalette ?? 0;
  if (!level) {
    asm.lda(imm(0));
    emitTileAttr(ctx, 0);
    return;
  }
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  emitTileAttr(ctx, palette);
}

/** Put a cell's sub-palette in `layout.attr`, keeping the character in `A`. */
function emitTileAttr(ctx: PceCtx, palette: number): void {
  const { asm, layout } = ctx;
  asm.ldx(imm((palette & 0x0f) << 4));
  asm.stx(mem(layout.attr));
}

/** `A = the character for the legend index in A`. */
function emitLegendToTile(ctx: PceCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.cmp(imm(GRID_EMPTY));
  ctx.far("eq", empty);
  asm.tax();
  asm.lda(absX(label(level.tileLabel)));
  asm.jmp(done);
  asm.label(empty);
  asm.lda(imm(0));
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: PceCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    copy16(ctx, dst, src);
    for (let index = 0; index < 3; index += 1) {
      asm.lda(mem(dst, 1));
      asm.asl();
      asm.ror(mem(dst, 1));
      asm.ror(mem(dst));
    }
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the map up to date after the camera moved.
 *
 * The map is bigger than the window on both axes, so level column `c` lives at
 * map column `c mod 64` and row `r` at row `r mod 32`, and the scroll registers
 * do the rest. Crossing a cell boundary costs one column or one row of writes,
 * and a jump too large to walk sets the full-redraw flag rather than tearing.
 */
function emitScrollUpdate(ctx: PceCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  // The vertical axis is walked only where the wrap can serve it: a level the map
  // holds whole has every row painted already, and painting a "new" row would
  // overwrite the one the top of the screen is still showing.
  if (scrollsRows(level)) {
    emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  }
  asm.jmp(done);
  asm.label(bail);
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge as
 * it goes. More than four cells in a tick is a teleport, not a scroll.
 */
function emitWalkAxis(
  ctx: PceCtx,
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

  asm.lda(imm(5));
  asm.sta(mem(guard));
  asm.label(loop);
  asm.dec(mem(guard));
  ctx.far("eq", bail);
  // signed compare: want - origin
  asm.sec();
  asm.lda(mem(want));
  asm.sbc(mem(origin));
  asm.sta(mem(ZP.t0));
  asm.lda(mem(want, 1));
  asm.sbc(mem(origin, 1));
  asm.sta(mem(ZP.t1));
  asm.ora(mem(ZP.t0));
  ctx.far("eq", done);
  asm.lda(mem(ZP.t1));
  ctx.far("mi", back);
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
function emitPaintEdge(ctx: PceCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = isColumn ? layout.memory.viewH + 1 : layout.memory.viewW + 1;
  // Not `temp`: the grid lookup uses that word for its row-times-width multiply,
  // and a counter clobbered mid-loop paints a strip of whatever character the
  // count happened to land on.
  const remaining = layout.words + W.lastRow * 2;

  copy16(ctx, across, originAcross);
  if (offset !== 0) {
    asm.clc();
    asm.lda(mem(across));
    asm.adc(imm(offset & 0xff));
    asm.sta(mem(across));
    asm.lda(mem(across, 1));
    asm.adc(imm((offset >> 8) & 0xff));
    asm.sta(mem(across, 1));
  }
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  // One run for the whole strip: a column steps a row at a time through the map,
  // which is what the control byte's top bit asks the flush for.
  asm.lda(imm(isColumn ? 0x80 : 0x00));
  asm.jsr("QueueOpen");
  asm.lda(imm(count));
  asm.sta(mem(remaining));
  asm.label(loop);
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  emitTileAttr(ctx, ctx.levelPalette);
  asm.jsr("QueueTile");
  inc16(ctx, along);
  asm.dec(mem(remaining));
  ctx.far("ne", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(
  ctx: PceCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: PceEmitOptions,
): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.lda(mem(layout.plotPrevCount));
  ctx.far("eq", done);
  asm.lda(imm(0));
  asm.sta(mem(cursor));
  asm.label(loop);
  asm.ldx(mem(cursor));
  asm.lda(absX(layout.plotPrev));
  asm.sta(mem(layout.words + W.tileCol * 2));
  asm.lda(absX(layout.plotPrev + 1));
  asm.sta(mem(layout.words + W.tileCol * 2 + 1));
  asm.lda(absX(layout.plotPrev + 2));
  asm.sta(mem(layout.words + W.tileRow * 2));
  asm.lda(absX(layout.plotPrev + 3));
  asm.sta(mem(layout.words + W.tileRow * 2 + 1));
  emitBackgroundTile(ctx, scene, level, options);
  asm.jsr("QueueOne");
  asm.clc();
  asm.lda(mem(cursor));
  asm.adc(imm(4));
  asm.sta(mem(cursor));
  asm.lda(mem(layout.plotPrevCount));
  asm.asl();
  asm.asl();
  asm.cmp(mem(cursor));
  ctx.far("ne", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("swapLoop");
  const done = ctx.unique("swapDone");
  asm.lda(mem(layout.plotCount));
  asm.sta(mem(layout.plotPrevCount));
  ctx.far("eq", done);
  asm.asl();
  asm.asl();
  asm.tax();
  asm.dex();
  asm.label(loop);
  asm.lda(absX(layout.plot));
  asm.sta(absX(layout.plotPrev));
  asm.dex();
  asm.bpl(loop);
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(
  ctx: PceCtx,
  scene: SceneCtx,
  want: "static" | "dynamic",
  options: PceEmitOptions,
): void {
  const { asm, layout, program } = ctx;
  void options;
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
    asm.lda(mem(base + propOffset("x") + 2));
    asm.sta(mem(layout.words + W.tileCol * 2));
    asm.lda(mem(base + propOffset("x") + 3));
    asm.sta(mem(layout.words + W.tileCol * 2 + 1));
    asm.lda(mem(base + propOffset("y") + 2));
    asm.sta(mem(layout.words + W.tileRow * 2));
    asm.lda(mem(base + propOffset("y") + 3));
    asm.sta(mem(layout.words + W.tileRow * 2 + 1));

    // A static object is painted straight into video RAM with the display already
    // off, so it needs neither the write queue nor a place in the erase list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.lda(imm(ctx.bank.glyph(character)));
        emitTileAttr(ctx, SYSTEM_PALETTE);
        asm.jsr(plot);
      }
    } else {
      ctx.pointer(ZP.p2, base + propOffset("value") + 2);
      asm.jsr(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `A` = a character: write it at the current cell and advance the column. */
function needPokeCell(ctx: PceCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const asm = (inner as PceCtx).asm;
    const layout = inner.layout;
    asm.sta(mem(ZP.t2));
    asm.jsr("VramFor");
    asm.lda(mem(ZP.t2));
    asm.jsr("PokeEntry");
    inc16(inner, layout.words + W.tileCol * 2);
    asm.rts();
  });
}

/** The decimal renderer again, writing straight to video RAM. */
function needPokeNumber(ctx: PceCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner as PceCtx, needPokeCell(inner as PceCtx), SYSTEM_PALETTE);
  });
}

/**
 * `p0` = entity base, `t0`/`t1` = the size in cells → `A` is zero when the object
 * is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * half of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled.
 */
function needOnscreen(ctx: PceCtx): Ref {
  return ctx.need("Onscreen", (inner) => emitOnscreenBody(inner as PceCtx));
}

function emitOnscreenBody(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const camera = layout.camera as number;
  const apart = ctx.unique("cullOff");
  const delta = ZP.spare;

  const axis = (offset: number, margin: number, span: number): void => {
    asm.sec();
    asm.ldy(imm(offset + 2));
    asm.lda(indY(ZP.p0));
    asm.sbc(mem(camera + offset + 2));
    asm.sta(mem(delta));
    asm.ldy(imm(offset + 3));
    asm.lda(indY(ZP.p0));
    asm.sbc(mem(camera + offset + 3));
    asm.sta(mem(delta, 1));
    asm.clc();
    asm.lda(mem(delta));
    asm.adc(mem(margin));
    asm.lda(mem(delta, 1));
    asm.adc(imm(0));
    ctx.far("mi", apart);
    asm.sec();
    asm.lda(mem(delta));
    asm.sbc(imm(span + 1));
    asm.lda(mem(delta, 1));
    asm.sbc(imm(0));
    ctx.far("pl", apart);
  };
  axis(propOffset("x"), ZP.t0, layout.memory.viewW);
  axis(propOffset("y"), ZP.t1, layout.memory.viewH);

  asm.lda(imm(1));
  asm.rts();
  asm.label(apart);
  asm.lda(imm(0));
  asm.rts();
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: PceCtx, scene: SceneCtx, options: PceEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.lda(imm(0));
  asm.sta(mem(layout.oamCount));

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;

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
    if (layout.camera !== null && fixedCells(ctx, id)) {
      ctx.pointer(ZP.p0, base);
      asm.lda(imm(width));
      asm.sta(mem(ZP.t0));
      asm.lda(imm(height));
      asm.sta(mem(ZP.t1));
      asm.jsr(needOnscreen(ctx));
      ctx.far("eq", skip);
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

    // Sixteen pixels to a sprite, so an object is a quarter of the entries it
    // would be anywhere else — and the placeholder block, which is one cell,
    // still costs a whole pattern.
    const across = art ? art.wide : 1;
    const down = art ? art.tall : 1;
    const palette = art?.palette ?? SYSTEM_PALETTE;
    for (let row = 0; row < down; row += 1) {
      for (let column = 0; column < across; column += 1) {
        const pattern = art ? art.pattern + row * across + column : ctx.placeholderPattern();
        emitSpriteCell(ctx, column, row, pattern, palette);
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
 * wrote — only the layer differs. A glyph here costs a whole 16×16 pattern with
 * three quarters of it empty, which is this console's price for having no small
 * sprite; the patterns are *pulled*, so a game with no scrolling HUD ships none.
 */
function emitHudSprites(ctx: PceCtx, scene: SceneCtx): void {
  const { asm, layout, program } = ctx;

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
      emitPixelsFromFixed(ctx, temp, layout.words + W.temp * 2);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera + 4);
      emitPixelsFromFixed(ctx, temp, layout.words + W.count * 2);
    });

    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.lda(imm(ctx.glyphPattern(character)));
        asm.jsr(needHudGlyph(ctx));
      }
    } else {
      ctx.pointer(ZP.p2, base + propOffset("value") + 2);
      asm.jsr(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `A` = a pattern: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: PceCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const self = inner as PceCtx;
    const asm = self.asm;
    const layout = self.layout;
    asm.sta(mem(ZP.count));
    asm.lda(imm(0x80 | SYSTEM_PALETTE));
    asm.sta(mem(ZP.count + 1));
    emitSpritePosition(self, 0, 0, () => {
      asm.jsr(needPushSprite(self));
    });
    asm.clc();
    asm.lda(mem(layout.words + W.temp * 2));
    asm.adc(imm(8));
    asm.sta(mem(layout.words + W.temp * 2));
    asm.lda(mem(layout.words + W.temp * 2 + 1));
    asm.adc(imm(0));
    asm.sta(mem(layout.words + W.temp * 2 + 1));
    asm.rts();
  });
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: PceCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    const self = inner as PceCtx;
    emitDecimal(self, needHudGlyph(self), SYSTEM_PALETTE, (character) =>
      self.glyphPattern(character),
    );
  });
}

/**
 * Compute one cell's biased sprite position and run `body` if the chip can show
 * it.
 *
 * Both axes carry a hardware bias — sixty-four lines and thirty-two pixels,
 * which is where the blanking interval ends — and that bias is why an object
 * partly off the top or the left of the screen still draws correctly here where
 * on the NES it would have to be dropped. What cannot be shown is a position
 * outside 0–287 once biased, which is what this rejects.
 */
function emitSpritePosition(ctx: PceCtx, dx: number, dy: number, body: () => void): void {
  const { asm, layout } = ctx;
  const penX = layout.words + W.temp * 2;
  const penY = layout.words + W.count * 2;
  const offscreen = ctx.unique("spriteOff");

  const axis = (pen: number, delta: number, bias: number, low: number, high: number): void => {
    const inside = ctx.unique("spriteIn");
    asm.clc();
    asm.lda(mem(pen));
    asm.adc(imm((delta + bias) & 0xff));
    asm.sta(mem(low));
    asm.lda(mem(pen, 1));
    asm.adc(imm(((delta + bias) >> 8) & 0xff));
    asm.sta(mem(high));
    // Visible when the biased position is 0–287: a high byte of zero, or one
    // with a low byte below thirty-two.
    asm.beq(inside);
    asm.cmp(imm(1));
    ctx.far("ne", offscreen);
    asm.lda(mem(low));
    asm.cmp(imm(32));
    ctx.far("cs", offscreen);
    asm.label(inside);
  };
  axis(penY, dy, 64, ZP.t0, ZP.t1);
  axis(penX, dx, 32, ZP.t2, ZP.t3);
  body();
  asm.label(offscreen);
}

/** One cell of an object, at the pen, and only if the hardware can put it there. */
function emitSpriteCell(
  ctx: PceCtx,
  column: number,
  row: number,
  pattern: number,
  palette: number,
): void {
  const { asm } = ctx;
  asm.lda(imm(pattern & 0xff));
  asm.sta(mem(ZP.count));
  asm.lda(imm(0x80 | (palette & 0x0f)));
  asm.sta(mem(ZP.count + 1));
  emitSpritePosition(ctx, column * 16, row * 16, () => {
    asm.jsr(needPushSprite(ctx));
  });
}

/**
 * `p1` = the object shadow's entry for the index in `A`.
 *
 * Sixty-four entries of eight bytes is 512, which an index register cannot reach
 * — so this is the one place on this console where a shadow write goes through a
 * pointer rather than through `absX`. It is cheap because the buffer is page
 * aligned (`layout.ts` §`PCE_MEMORY`): the high byte is the index's top bit plus
 * the page, and the low byte is the index times eight.
 */
function needEntryPointer(ctx: PceCtx): Ref {
  return ctx.need("EntryPointer", (inner) => {
    const self = inner as PceCtx;
    const asm = self.asm;
    const shadow = self.layout.memory.oamShadow;
    asm.pha();
    for (let shift = 0; shift < 5; shift += 1) asm.lsr();
    asm.clc();
    asm.adc(imm((shadow >> 8) & 0xff));
    asm.sta(mem(ZP.p1, 1));
    asm.pla();
    asm.asl();
    asm.asl();
    asm.asl();
    asm.sta(mem(ZP.p1));
    asm.rts();
  });
}

/**
 * `t0`/`t1` = the biased Y, `t2`/`t3` = the biased X, `count` = the pattern and
 * `count+1` = the attribute: append an entry to the object shadow.
 *
 * Four words an entry, and the third of them is the pattern number *doubled* —
 * the field the chip reads ignores bit zero, so the value stored is twice the
 * pattern. The base is added here rather than at every call site, which is what
 * keeps the pattern a byte: a build has at most {@link SPRITE_PATTERNS} of them
 * and the base is a compile-time constant.
 */
function needPushSprite(ctx: PceCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const self = inner as PceCtx;
    const asm = self.asm;
    const layout = self.layout;
    const room = self.unique("oamRoom");
    asm.lda(mem(layout.oamCount));
    asm.cmp(imm(layout.memory.oamEntries));
    asm.bcc(room);
    asm.rts();
    asm.label(room);
    asm.jsr(needEntryPointer(self));
    asm.ldy(imm(0));
    for (const byte of [ZP.t0, ZP.t1, ZP.t2, ZP.t3]) {
      asm.lda(mem(byte));
      asm.sta(indY(ZP.p1));
      asm.iny();
    }
    // pattern * 2 + SPRITE_BASE * 2, in sixteen bits. The doubling cannot carry:
    // a build is capped at 128 patterns, and the base is what makes it a word.
    asm.lda(mem(ZP.count));
    asm.asl();
    asm.clc();
    asm.adc(imm((SPRITE_BASE * 2) & 0xff));
    asm.sta(indY(ZP.p1));
    asm.iny();
    asm.lda(imm(0));
    asm.adc(imm(((SPRITE_BASE * 2) >> 8) & 0xff));
    asm.sta(indY(ZP.p1));
    asm.iny();
    asm.lda(mem(ZP.count + 1));
    asm.sta(indY(ZP.p1));
    asm.iny();
    // A 16×16 sprite: both size fields zero, and no flip.
    asm.lda(imm(0));
    asm.sta(indY(ZP.p1));
    asm.inc(mem(layout.oamCount));
    asm.rts();
  });
}

/**
 * Park the entries that are no longer in use.
 *
 * Only the ones *this* frame vacated need clearing: everything above last frame's
 * high-water mark is already parked. Parking means a Y of zero, which is
 * sixty-four lines above the first visible one — an entry left as it was would
 * show last frame's object at last frame's place.
 */
function needClearRestOfOam(ctx: PceCtx): Ref {
  return ctx.need("ClearRestOfOam", (inner) => {
    const self = inner as PceCtx;
    const asm = self.asm;
    const layout = self.layout;
    const sweep = self.unique("oamSweep");
    const step = self.unique("oamStep");
    asm.lda(mem(layout.oamCount));
    asm.cmp(mem(layout.oamPrev));
    asm.bcc(sweep);
    // Nothing was vacated; this frame's count becomes the mark to clear against.
    asm.sta(mem(layout.oamPrev));
    asm.rts();
    asm.label(sweep);
    asm.sta(mem(ZP.t0));
    asm.lda(mem(layout.oamPrev));
    asm.sta(mem(ZP.t1));
    asm.lda(mem(layout.oamCount));
    asm.sta(mem(layout.oamPrev));
    asm.label(step);
    asm.lda(mem(ZP.t0));
    asm.jsr(needEntryPointer(self));
    asm.ldy(imm(0));
    asm.lda(imm(0));
    asm.sta(indY(ZP.p1));
    asm.iny();
    asm.sta(indY(ZP.p1));
    asm.inc(mem(ZP.t0));
    asm.lda(mem(ZP.t0));
    asm.cmp(mem(ZP.t1));
    asm.bne(step);
    asm.rts();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const QUEUE_BYTES = layout.memory.queueMax * layout.queueStride;
  // Where the open run's control byte sits, so appending can count it. A render
  // word rather than the zero page, because the grid lookup between two appends
  // uses every byte of the helper scratch.
  const runIndex = layout.words + W.cell * 2;

  // Point the data port at the cell in words[tileCol]/words[tileRow]. Both wraps
  // are powers of two, so the address is two masks and a shift.
  asm.label("VramFor");
  emitCellAddress(ctx);
  asm.st0(VDC.MAWR);
  asm.lda(mem(ZP.t0));
  asm.sta(abs(R.VDC_LO));
  asm.lda(mem(ZP.t1));
  asm.sta(abs(R.VDC_HI));
  asm.st0(VDC.VWR);
  asm.rts();

  // `A` = a character, `layout.attr` = its sub-palette: write the word.
  asm.label("PokeEntry");
  asm.clc();
  asm.adc(imm(CHAR_BASE & 0xff));
  asm.sta(abs(R.VDC_LO));
  asm.lda(imm((CHAR_BASE >> 8) & 0x0f));
  asm.adc(imm(0));
  asm.ora(mem(layout.attr));
  asm.sta(abs(R.VDC_HI));
  asm.rts();

  // Open a run at the current cell. `A` is zero for a run that steps one cell to
  // the right and `$80` for one that steps a row down — which is what makes a
  // scrolled column a run of its own rather than twenty-nine addressed cells.
  asm.label("QueueOpen");
  const noRoomForRun = ctx.unique("queueRunFull");
  asm.sta(mem(ZP.t3));
  asm.lda(mem(layout.queueCount));
  asm.cmp(imm(QUEUE_BYTES - 3));
  asm.bcc(noRoomForRun);
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.rts();
  asm.label(noRoomForRun);
  emitCellAddress(ctx);
  asm.ldx(mem(layout.queueCount));
  asm.lda(mem(ZP.t0));
  asm.sta(absX(layout.queue));
  asm.lda(mem(ZP.t1));
  asm.sta(absX(layout.queue + 1));
  asm.lda(mem(ZP.t3));
  asm.sta(absX(layout.queue + 2));
  asm.lda(mem(layout.queueCount));
  asm.sta(mem(runIndex));
  asm.clc();
  asm.adc(imm(3));
  asm.sta(mem(layout.queueCount));
  asm.rts();

  // `A` = a character, `layout.attr` = its sub-palette: append to the open run.
  asm.label("QueueTile");
  const roomForTile = ctx.unique("queueTileRoom");
  asm.sta(mem(ZP.t2));
  asm.lda(mem(layout.queueCount));
  asm.cmp(imm(QUEUE_BYTES - 1));
  asm.bcc(roomForTile);
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.rts();
  asm.label(roomForTile);
  asm.ldx(mem(layout.queueCount));
  asm.clc();
  asm.lda(mem(ZP.t2));
  asm.adc(imm(CHAR_BASE & 0xff));
  asm.sta(absX(layout.queue));
  asm.lda(imm((CHAR_BASE >> 8) & 0x0f));
  asm.adc(imm(0));
  asm.ora(mem(layout.attr));
  asm.sta(absX(layout.queue + 1));
  asm.lda(mem(layout.queueCount));
  asm.clc();
  asm.adc(imm(2));
  asm.sta(mem(layout.queueCount));
  asm.ldx(mem(runIndex));
  asm.inc(absX(layout.queue + 2));
  asm.rts();

  // `A` = a character; queue it as a run of one, record the cell for erasing, and
  // advance the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  asm.sta(mem(ZP.saved));
  asm.lda(imm(0));
  asm.jsr("QueueOpen");
  asm.lda(mem(ZP.saved));
  asm.jsr("QueueTile");
  asm.lda(mem(layout.plotCount));
  asm.cmp(imm(layout.memory.plotMax));
  asm.bcc(plotFull);
  asm.jmp("PlotAdvance");
  asm.label(plotFull);
  asm.asl();
  asm.asl();
  asm.tax();
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.sta(absX(layout.plot));
  asm.lda(mem(layout.words + W.tileCol * 2 + 1));
  asm.sta(absX(layout.plot + 1));
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.sta(absX(layout.plot + 2));
  asm.lda(mem(layout.words + W.tileRow * 2 + 1));
  asm.sta(absX(layout.plot + 3));
  asm.inc(mem(layout.plotCount));
  asm.label("PlotAdvance");
  inc16(ctx, layout.words + W.tileCol * 2);
  asm.rts();

  // The same without the erase list: putting a level tile back where the HUD was.
  asm.label("QueueOne");
  asm.sta(mem(ZP.saved));
  asm.lda(imm(0));
  asm.jsr("QueueOpen");
  asm.lda(mem(ZP.saved));
  asm.jmp("QueueTile");

  // Flush the queue and set the scroll. Both fit inside the blanking interval by
  // construction: the queue is capped at what one will hold and anything over
  // sets the redraw flag instead of being dropped.
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const runLoop = ctx.unique("runLoop");
  const cellLoop = ctx.unique("cellLoop");
  asm.lda(mem(layout.queueCount));
  asm.beq(noQueue);
  ctx.pointer(ZP.p0, layout.queue);
  asm.lda(imm(0));
  asm.sta(mem(ZP.t0)); // bytes consumed
  asm.label(runLoop);
  // The control byte decides the address step, which is the data port's
  // auto-increment: one cell to the right, or a whole map row down.
  asm.ldy(imm(2));
  asm.lda(indY(ZP.p0));
  asm.sta(mem(ZP.t1));
  asm.and(imm(0x80));
  const acrossRun = ctx.unique("runAcross");
  asm.beq(acrossRun);
  vdcControl(ctx, CR_ON, CR_STEP_ROW);
  const setStep = ctx.unique("runStep");
  asm.bra(setStep);
  asm.label(acrossRun);
  vdcControl(ctx, CR_ON, CR_STEP_ONE);
  asm.label(setStep);
  asm.st0(VDC.MAWR);
  asm.ldy(imm(0));
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.VDC_LO));
  asm.iny();
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.VDC_HI));
  asm.st0(VDC.VWR);
  // Three bytes of header plus two per cell is both where the cell loop stops and
  // how far the next run is.
  asm.lda(mem(ZP.t1));
  asm.and(imm(0x7f));
  asm.asl();
  asm.clc();
  asm.adc(imm(3));
  asm.sta(mem(ZP.t3));
  asm.ldy(imm(3));
  asm.label(cellLoop);
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.VDC_LO));
  asm.iny();
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.VDC_HI));
  asm.iny();
  asm.cpy(mem(ZP.t3));
  asm.bne(cellLoop);
  // On to the next run.
  asm.clc();
  asm.lda(mem(ZP.p0));
  asm.adc(mem(ZP.t3));
  asm.sta(mem(ZP.p0));
  asm.lda(mem(ZP.p0, 1));
  asm.adc(imm(0));
  asm.sta(mem(ZP.p0, 1));
  asm.clc();
  asm.lda(mem(ZP.t0));
  asm.adc(mem(ZP.t3));
  asm.sta(mem(ZP.t0));
  asm.cmp(mem(layout.queueCount));
  ctx.far("cc", runLoop);
  asm.lda(imm(0));
  asm.sta(mem(layout.queueCount));
  // The step goes back to one, so nothing after this run inherits a row stride.
  vdcControl(ctx, CR_ON, CR_STEP_ONE);
  asm.label(noQueue);

  // The scroll, last, because the registers are latched at the top of the display
  // and this is the last chance before it.
  asm.st0(VDC.BXR);
  asm.lda(mem(layout.words + W.scrollX * 2));
  asm.sta(abs(R.VDC_LO));
  asm.lda(mem(layout.words + W.scrollX * 2 + 1));
  asm.and(imm(0x03));
  asm.sta(abs(R.VDC_HI));
  asm.st0(VDC.BYR);
  asm.lda(mem(layout.words + W.scrollY * 2));
  asm.sta(abs(R.VDC_LO));
  asm.lda(mem(layout.words + W.scrollY * 2 + 1));
  asm.and(imm(0x01));
  asm.sta(abs(R.VDC_HI));
  asm.rts();

  // The object shadow into video RAM, where the chip fetches it from at the top
  // of the next blank. One instruction, and it is called from the main loop
  // rather than the handler for exactly that reason (§the sprite table).
  asm.label("UploadObjects");
  vdcAddress(ctx, SATB_WORD);
  asm.tia(layout.memory.oamShadow, R.VDC_LO, layout.memory.oamEntries * 8);
  asm.rts();

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell", SYSTEM_PALETTE);

  emitDecimalPowers(ctx);
}

/**
 * `t0`/`t1` = the video RAM address of the cell in words[tileCol]/words[tileRow].
 *
 * The whole of this console's scrolling, and it is the cheapest of any backend
 * here: the map is 64×32, so a level column lands at `column & 63` and a row at
 * `row & 31`, and the address is `row * 64 + column`. Both masks, no modulo, no
 * second table to choose between.
 */
function emitCellAddress(ctx: PceCtx): void {
  const { asm, layout } = ctx;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.lda(mem(row));
  asm.and(imm(MAP_H - 1));
  asm.sta(mem(ZP.t0));
  asm.lda(imm(0));
  asm.sta(mem(ZP.t1));
  for (let shift = 0; shift < 6; shift += 1) {
    asm.asl(mem(ZP.t0));
    asm.rol(mem(ZP.t1));
  }
  asm.lda(mem(col));
  asm.and(imm(MAP_W - 1));
  asm.ora(mem(ZP.t0));
  asm.sta(mem(ZP.t0));
}

/**
 * Draw the signed 16-bit value `p2` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the sprite one — which is
 * why it is a parameter rather than a second copy of the digit loop. `glyph`
 * turns a character into whatever that plot routine takes: a character number on
 * the background and a sprite pattern on the object layer.
 */
function emitDecimal(
  ctx: PceCtx,
  plot: Ref,
  palette: number,
  glyph: (character: string) => number = (character) => ctx.bank.glyph(character),
): void {
  const { asm, layout } = ctx;
  const value = layout.words + W.target * 2;
  const flag = layout.words + W.cell * 2;
  const digit = layout.words + W.cell * 2 + 1;
  const power = layout.words + W.firstCol * 2;

  asm.ldy(imm(0));
  asm.lda(indY(ZP.p2));
  asm.sta(mem(value));
  asm.iny();
  asm.lda(indY(ZP.p2));
  asm.sta(mem(value, 1));

  const positive = ctx.unique("numPos");
  asm.lda(mem(value, 1));
  ctx.far("pl", positive);
  asm.sec();
  asm.lda(imm(0));
  asm.sbc(mem(value));
  asm.sta(mem(value));
  asm.lda(imm(0));
  asm.sbc(mem(value, 1));
  asm.sta(mem(value, 1));
  asm.lda(imm(glyph("-")));
  emitTileAttr(ctx, palette);
  asm.jsr(plot);
  asm.label(positive);

  asm.lda(imm(0));
  asm.sta(mem(flag));
  asm.sta(mem(power));
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const digitDone = ctx.unique("numDigit");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");

  asm.label(powerLoop);
  asm.lda(imm(0));
  asm.sta(mem(digit));
  asm.label(subLoop);
  asm.ldx(mem(power));
  asm.sec();
  asm.lda(mem(value));
  asm.sbc(absX(label("DecimalPowers")));
  asm.sta(mem(ZP.t0));
  asm.lda(mem(value, 1));
  asm.sbc(absX(label("DecimalPowers", 1)));
  asm.bcc(digitDone);
  asm.sta(mem(value, 1));
  asm.lda(mem(ZP.t0));
  asm.sta(mem(value));
  asm.inc(mem(digit));
  asm.jmp(subLoop);
  asm.label(digitDone);
  asm.lda(mem(digit));
  ctx.far("ne", emitDigit);
  asm.lda(mem(flag));
  ctx.far("ne", emitDigit);
  asm.lda(mem(power));
  asm.cmp(imm(8));
  ctx.far("ne", skipDigit);
  asm.label(emitDigit);
  asm.lda(imm(1));
  asm.sta(mem(flag));
  asm.clc();
  asm.lda(mem(digit));
  asm.adc(imm(glyph("0")));
  emitTileAttr(ctx, palette);
  asm.jsr(plot);
  asm.label(skipDigit);
  asm.clc();
  asm.lda(mem(power));
  asm.adc(imm(2));
  asm.sta(mem(power));
  asm.cmp(imm(10));
  ctx.far("ne", powerLoop);
  asm.rts();
}

/** The powers of ten a decimal render walks, as little-endian words. */
function emitDecimalPowers(ctx: PceCtx): void {
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}

/**
 * The 16×16 sprite patterns the HUD's glyphs needed, in the order they were
 * asked for.
 *
 * Pulled rather than pushed, the same rule the runtime's helpers run under: a
 * game with no scrolling scene draws its whole HUD on the background layer and
 * ships none of these. They are emitted straight after the object patterns so
 * that one block transfer uploads both.
 */
function emitGlyphPatterns(ctx: PceCtx): void {
  for (const key of ctx.glyphPatterns.keys()) ctx.asm.bytes(ctx.glyphPatternBytes(key));
}

export { packCellPairs };
