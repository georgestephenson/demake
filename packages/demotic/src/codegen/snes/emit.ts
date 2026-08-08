/**
 * The whole-program emitter for the Super Nintendo: boot, the frame, the
 * renderer, the data.
 *
 * Everything here is per *scene*, for the reason the other backends give: a scene
 * is what the machine is doing at any moment and the compiler knows which one.
 * What differs is all hardware, and six differences are load-bearing:
 *
 *   - **A tilemap entry is a word, and the CPU writes words.** `VMADD` and the
 *     two data ports are consecutive registers, so a queued cell is `sta $2116`
 *     followed by `sta $2118` — two instructions for an address and a cell, where
 *     the NES needs six and the Sega VDP four. That is what makes a per-cell queue
 *     affordable here rather than the run encoding those two consoles need.
 *   - **The map is bigger than the screen in both directions.** Sixty-four columns
 *     against thirty-two and thirty-two rows against twenty-eight, so both axes
 *     scroll by painting a leading edge and neither needs the NES's pinning or the
 *     Master System's seam mask. The scroll registers wrap on their own.
 *   - **The background is scrolled one line late.** Screen line `N` shows
 *     background line `BG1VOFS + N + 1`, so the vertical scroll written is the
 *     camera's minus one. Without it every scene sits a pixel high — the same
 *     `$3FF` the image E2E's harness writes, for the same reason.
 *   - **The tile bank is in a second cartridge bank and reaches video RAM by
 *     DMA.** Sixteen kilobytes of art would be half a LoROM bank, so it lives in
 *     bank one and the transfer takes its source bank as *data*. Not one
 *     instruction in the program addresses it.
 *   - **An object's position is a screen position and its Y is direct.** No
 *     minus-one convention, unlike the NES; what there is instead is a nine-bit X,
 *     and this runtime uses only the eight-bit range and drops what falls outside
 *     it, exactly as the other backends do.
 *   - **The sound is a second computer's, and it is handed its program at boot.**
 *     The S-SMP has its own processor, its own 64 KiB and its own timer, so the
 *     driver is not in this file's instruction set at all: `Reset` performs the
 *     upload handshake through four mailbox bytes and then never calls a driver
 *     again. Asking for a track or an effect is two request bytes and a sequence
 *     byte the other computer watches — which is why this is the one console
 *     where a frame the game overruns costs it no tempo.
 *
 * The tick order, the rule bodies and every compile-time decision are shared with
 * the other backends (`backend.ts`, `shape.ts`). Nothing in this file decides what
 * the game does.
 */

import { SPC_PORT, SPC_STOP, type SpcGameAudio } from "@demake/audio";
import { imm16, imm8, label, longX, SNES_TILE_BANK, SNES_TILE_BASE, type Ref } from "@demake/core";

import { ACTIONS, type InstanceDef, type RuleDef } from "../../program.js";
import {
  BUILTIN_TILES as BUILTIN_TILE_COUNT,
  glyphTile,
  OBJECT_TILE,
  patternTile,
} from "../../rom/graphics.js";
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
  scrolls,
  sideMask,
  tileCellsCacheable,
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { SnesCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { abs, absX, clearByte, clearBytes, DP, incByte, loadByte, mem, setByte } from "./ops.js";
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
import {
  collectLevels,
  copy16,
  dec16,
  emitLevelData,
  emitRuleTileTable,
  emitTileAt,
  emitTileSeparate,
  emitTileSide,
  emitTilesUnder,
  GRID_EMPTY,
  inc16,
  loadTableByte,
  ruleTileTableLabel,
  tileAtLabel,
  tileSlot,
  type LevelData,
} from "./tiles.js";
import { branchZero32, copy32, sub32 } from "./val.js";

/** Hardware registers this backend touches. */
const R = {
  /** Forced blank in bit 7, brightness in bits 0–3. */
  INIDISP: 0x2100,
  /** Object sizes, name select and the object character base. */
  OBSEL: 0x2101,
  /** The object-RAM address, as a word. */
  OAMADD: 0x2102,
  /** The background mode. */
  BGMODE: 0x2105,
  /** BG1's tilemap base and its size in screens. */
  BG1SC: 0x2107,
  /** BG1's and BG2's character bases. */
  BG12NBA: 0x210b,
  /** BG1's scroll, ten bits each, written low byte then high. */
  BG1HOFS: 0x210d,
  BG1VOFS: 0x210e,
  /** Video-RAM address increment. */
  VMAIN: 0x2115,
  /** The video-RAM word address, as a word. */
  VMADD: 0x2116,
  /** The two video-RAM data ports, consecutive so one store fills both. */
  VMDATA: 0x2118,
  /** The colour-RAM index and its data port. */
  CGADD: 0x2121,
  CGDATA: 0x2122,
  /** Which layers reach the main screen. */
  TM: 0x212c,
  /** Interrupt enables and the auto joypad read. */
  NMITIMEN: 0x4200,
  /** Reading it acknowledges the vertical-blank interrupt. */
  RDNMI: 0x4210,
  /** Player one's pad, latched by the console once a frame. */
  JOY1: 0x4218,
  /** DMA channel zero: control and destination, source, count. */
  DMAP0: 0x4300,
  A1T0: 0x4302,
  A1B0: 0x4304,
  DAS0: 0x4305,
  /** Start the channels named in the low eight bits. */
  MDMAEN: 0x420b,
  /**
   * The sound processor's mailbox: four bytes, read and written from both sides.
   *
   * The whole interface between the two computers. `$2140` carries the boot
   * handshake and then the request sequence; `$2141`–`$2143` carry the upload's
   * data and address and then the two request bytes.
   */
  APUIO: 0x2140,
} as const;

/** Where the video hardware's tables live, which the register writes decide. */
const VRAM = {
  /** BG1's tilemap: 64×32 entries of one word, as two 32×32 screens. */
  MAP: 0x0000,
  /** The shared tile bank, in words: 512 tiles of sixteen words each. */
  TILES: 0x2000,
} as const;

/** Cells the tilemap holds. Both are larger than the screen, which is the point. */
const MAP_W = 64;
const MAP_H = 32;

/** Tiles the bank holds, background and objects together. */
export const BANK_TILES = 512;

/**
 * The sub-palette reserved for the font, the level patterns and the placeholder
 * block.
 *
 * The last of the eight, background and objects alike, for the reason the Game
 * Boy Color build keeps one back: everything else is demade art whose palette was
 * chosen *for that art*, and a caption drawn in a title screen's palette is sky
 * on sky. The fitters are given the other seven.
 */
export const SYSTEM_PALETTE = 7;

/** Sub-palettes a build's art may use — every one but the system's. */
export const ART_PALETTES = SYSTEM_PALETTE;

/** Colour index the built-in tiles' ink lands on within their sub-palette. */
export const SYSTEM_INK = 15;

/**
 * The tilemap entry an empty cell draws.
 *
 * Tile zero with no attributes. On this chip colour zero of a background palette
 * is *transparent* and shows the fixed backdrop, so which palette a blank cell
 * names cannot matter — which is why this is a plain zero and why a DMA with a
 * fixed source could fill the map with it if the boot ever needed to be faster.
 */
const BLANK_ENTRY = 0;

/** Everything the emitter needs beyond the program itself. */
export interface SnesEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette?: number }>;
  /** Demade backdrops by scene name: the tilemap the picture fills. */
  backdrops?: ReadonlyMap<string, { map: Uint16Array }>;
  /** The 4bpp tile bank, uploaded to video RAM at boot from the second bank. */
  bank?: Uint8Array;
  /** Colour RAM as the art chose it: 256 entries of BGR555, as bytes. */
  palette?: Uint8Array;
  /** Per-scene colour RAM, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
  /**
   * The sound processor's whole program, already built from the demade audio.
   *
   * Absent for a game with no audio, and then the cartridge is exactly what it
   * was before this existed: no upload, no service call, no table.
   */
  audio?: SpcGameAudio;
  /** Where the image sits in the second cartridge bank, as a long address. */
  audioAt?: number;
  /** The driver's effect index for each of the program's sounds, or `-1`. */
  effectIndices?: readonly number[];
  /** Which track each scene asks for, or `-1` for a scene that plays none. */
  sceneTracks?: readonly number[];
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: SnesCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.jmp(labels[0] as string);
    return;
  }
  loadByte(ctx, layout.scene);
  for (const [index, target] of labels.entries()) {
    if (index === labels.length - 1) {
      asm.jmp(target);
      break;
    }
    asm.cmp(imm16(index));
    ctx.far("eq", target);
  }
}

/** Emit the whole program. */
export function emitProgram(ctx: SnesCtx, options: SnesEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx, options);
  emitNmi(ctx);
  emitMainLoop(ctx, options.audio !== undefined);
  if (options.audio) emitAudio(ctx, options);
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
    const boundTile = (index: number): { tile: number; palette: number } => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern, in the system palette.
      if (!bound) {
        return {
          tile: patternTile(index, level.file.tiles[index]?.solid ?? false),
          palette: SYSTEM_PALETTE,
        };
      }
      return { tile: bound.tile, palette: bound.palette ?? 0 };
    };
    emitLevelData(asm, level, (index) => boundTile(index).tile & 0xff);
    // The word table the renderer really reads: one whole tilemap entry per
    // legend index, so turning a cell into something the video hardware takes is
    // a shift and an indexed load rather than two byte tables and a merge.
    asm.label(levelEntryLabel(level));
    for (const [index] of level.file.tiles.entries()) {
      const bound = boundTile(index);
      asm.dw(tilemapEntry(bound.tile, bound.palette));
    }
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
      for (const word of packCells(art.map)) asm.dw(word);
    }
    const palette = options.scenePalettes?.get(scene.def.name);
    if (palette) {
      asm.label(scenePaletteLabel(scene));
      asm.bytes(palette);
    }
  }

  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette());
}

/** One tilemap entry: ten bits of tile, three of palette, and no flip. */
function tilemapEntry(tile: number, palette: number): number {
  return (tile & 0x3ff) | ((palette & 7) << 10);
}

/**
 * The colour RAM a build with no demade art uses.
 *
 * Every sub-palette is the font's ramp, so a caption and a placeholder block are
 * legible with nothing else uploaded: the reserved entries hold three rising
 * greys. Entry zero is the backdrop every transparent pixel shows, and it is
 * black so those greys read.
 */
function defaultPalette(): Uint8Array {
  const bytes = new Uint8Array(512);
  const write = (entry: number, r: number, g: number, b: number): void => {
    const word = ((b & 31) << 10) | ((g & 31) << 5) | (r & 31);
    bytes[entry * 2] = word & 0xff;
    bytes[entry * 2 + 1] = (word >> 8) & 0xff;
  };
  for (let palette = 0; palette < 16; palette += 1) {
    for (const [offset, level] of [10, 20, 31].entries()) {
      write(palette * 16 + SYSTEM_INK - 2 + offset, level, level, level);
    }
  }
  return bytes;
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: SnesCtx, options: SnesEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.sei();
  // The console comes up pretending to be a 6502, so the first thing a cartridge
  // does is stop it: `xce` swaps the carry with the emulation flag, and `rep`
  // then makes the accumulator and the index registers sixteen bits — which is
  // the width every label in this backend promises (`ctx.ts`).
  asm.clc();
  asm.xce();
  asm.rep(0x38); // sixteen-bit accumulator and index, decimal off
  asm.ldx(imm16(STACK_TOP));
  asm.txs();
  asm.lda(imm16(0));
  asm.tcd(); // the direct page is bank zero's first page, where the scratch lives

  emitPpuInit(ctx);

  // Clear the whole of the work RAM bank zero can see, so a game's state starts
  // from zero rather than from whatever powered up — including the object
  // shadow, whose sprites would otherwise appear before the first frame.
  const clear = ctx.unique("clearRam");
  asm.ldx(imm16(0x1ffe));
  asm.label(clear);
  asm.stz(absX(0));
  asm.dex();
  asm.dex();
  asm.bpl(clear);

  emitTileUpload(ctx, options.bank?.length ?? 0);
  emitPaletteUpload(ctx, "Palette");
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

  asm.stz(mem(layout.tick));
  clearBytes(ctx, layout.ready, 1);
  clearBytes(ctx, layout.booted, 1);
  clearBytes(ctx, layout.held, 1);
  clearBytes(ctx, layout.pressed, 1);
  clearBytes(ctx, layout.released, 1);
  clearBytes(ctx, layout.plotCount, 1);
  clearBytes(ctx, layout.plotPrevCount, 1);
  clearBytes(ctx, layout.queueCount, 1);
  setByte(ctx, layout.oamPrev, layout.memory.oamEntries);
  setByte(ctx, layout.pending, 0xff);
  setByte(ctx, layout.scene, sceneIndexOf(program, program.entryScene));
  setByte(ctx, layout.redraw, 1);

  // The sound processor is handed its program here, and asked for the entry
  // scene's music in the same breath. The order is the point: its timer starts
  // when its program does, so a request posted after anything long — the first
  // full redraw, say — would arrive a tick or two into a schedule that had
  // already been playing to nobody. No scene *change* will ever ask for the
  // entry scene's track either, which is the other half of why this is here.
  if (options.audio) {
    asm.jsr("AudioUpload");
    if (program.tracks.length > 0) {
      asm.jsr("SceneMusic");
      asm.jsr("AudioService");
    }
  }
  if (layout.interrupt !== null) clearBytes(ctx, layout.interrupt, 1);
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.jsr("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    for (let index = 0; index < 8; index += 2) asm.stz(mem(layout.camera + index));
  }
  asm.jsr("BuildFrame");
  asm.jsr("UploadFrame");

  // The picture on, and the interrupt with it. Everything above ran under forced
  // blank, which is what makes a screenful of tilemap safe to write.
  setByte(ctx, layout.booted, 1);
  ctx.narrow(() => {
    asm.lda(imm8(0x0f));
    asm.sta(mem(R.INIDISP));
    asm.lda(imm8(0x81)); // vertical-blank interrupt, and the automatic pad read
    asm.sta(mem(R.NMITIMEN));
  });
  asm.jmp("Main");
}

/** Where the stack starts, growing down through the page below the object shadow. */
const STACK_TOP = 0x03ff;

/**
 * The video hardware, as the boot leaves it.
 *
 * Mode 1 with BG1 alone, its tilemap two screens wide at word zero and its
 * characters at word `$2000` — which is also where the objects read theirs, so
 * the bank is one budget and a glyph a HUD draws with an object is the same tile
 * the background would have used. `OBSEL`'s name-select is zero, which puts the
 * second half of the object bank exactly where the first half's tiles run out:
 * one contiguous five hundred and twelve.
 */
function emitPpuInit(ctx: SnesCtx): void {
  const { asm } = ctx;
  ctx.narrow(() => {
    asm.lda(imm8(0x80)); // forced blank while everything below is written
    asm.sta(mem(R.INIDISP));
    asm.lda(imm8(0x00));
    asm.sta(mem(R.NMITIMEN));
    asm.lda(imm8(0x01)); // mode 1
    asm.sta(mem(R.BGMODE));
    asm.lda(imm8((VRAM.MAP >> 8) | 0x01)); // tilemap at word 0, 64×32
    asm.sta(mem(R.BG1SC));
    asm.lda(imm8(VRAM.TILES >> 12)); // BG1 characters, in 4096-word units
    asm.sta(mem(R.BG12NBA));
    asm.lda(imm8(VRAM.TILES >> 13)); // objects, 8×8 and 16×16, same bank
    asm.sta(mem(R.OBSEL));
    asm.lda(imm8(0x80)); // increment the video-RAM address after the high byte
    asm.sta(mem(R.VMAIN));
    asm.lda(imm8(0x11)); // BG1 and the objects on the main screen
    asm.sta(mem(R.TM));
  });
}

/**
 * Copy the tile bank from the second cartridge bank into video RAM.
 *
 * By DMA, and that is the whole reason the bank can be sixteen kilobytes: the
 * controller takes its source bank as a *data byte*, so nothing in the program
 * has to address bank one — no long addressing, no data-bank switching, and no
 * loop.
 */
function emitTileUpload(ctx: SnesCtx, bytes: number): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  asm.lda(imm16(VRAM.TILES));
  asm.sta(mem(R.VMADD));
  // The low byte of `$4300` is the control and the high byte is the destination
  // register, so one sixteen-bit store programs both: mode 1 writes two
  // consecutive ports, which is exactly the pair of video-RAM data registers.
  asm.lda(imm16(0x1801 | ((R.VMDATA & 0xff) << 8)));
  asm.sta(mem(R.DMAP0));
  asm.lda(imm16(SNES_TILE_BASE));
  asm.sta(mem(R.A1T0));
  asm.lda(imm16(bytes));
  asm.sta(mem(R.DAS0));
  ctx.narrow(() => {
    asm.lda(imm8(SNES_TILE_BANK));
    asm.sta(mem(R.A1B0));
    asm.lda(imm8(0x01));
    asm.sta(mem(R.MDMAEN));
  });
}

/** Upload 256 colours of BGR555, which is two bytes each. */
function emitPaletteUpload(ctx: SnesCtx, source: string): void {
  const { asm } = ctx;
  ctx.narrow(() => {
    asm.lda(imm8(0));
    asm.sta(mem(R.CGADD));
  });
  asm.lda(imm16(0x0000 | ((R.CGDATA & 0xff) << 8)));
  asm.sta(mem(R.DMAP0));
  asm.lda(imm16(label(source)));
  asm.sta(mem(R.A1T0));
  asm.lda(imm16(512));
  asm.sta(mem(R.DAS0));
  ctx.narrow(() => {
    asm.lda(imm8(0x00));
    asm.sta(mem(R.A1B0));
    asm.lda(imm8(0x01));
    asm.sta(mem(R.MDMAEN));
  });
}

/** Fill the whole tilemap with the empty cell, so nothing stale shows through. */
function emitBlankMap(ctx: SnesCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("blankMap");
  asm.lda(imm16(VRAM.MAP));
  asm.sta(mem(R.VMADD));
  asm.ldx(imm16(MAP_W * MAP_H));
  asm.lda(imm16(BLANK_ENTRY));
  asm.label(loop);
  asm.sta(mem(R.VMDATA));
  asm.dex();
  asm.bne(loop);
}

/** Copy a compile-time run of bytes from the cartridge into work RAM. */
function emitCopyBlock(ctx: SnesCtx, source: Ref, dest: number, count: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("copyLoop");
  asm.ldx(imm16(count - 2));
  asm.label(loop);
  asm.lda(absX(source));
  asm.sta(absX(dest));
  asm.dex();
  asm.dex();
  asm.bpl(loop);
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: SnesCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  const seed = program.seed | 0;
  asm.lda(imm16(seed & 0xffff));
  asm.sta(mem(layout.rng));
  asm.lda(imm16((seed >>> 16) & 0xffff));
  asm.sta(mem(layout.rng + 2));
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: SnesCtx): void {
  const { layout } = ctx;
  clearBytes(ctx, layout.contacts, layout.contactBytes);
  clearBytes(ctx, layout.contactsPrev, layout.contactBytes);
  clearBytes(ctx, layout.holdFlags, Math.max(1, ctx.analysis.holdSlots));
  clearBytes(ctx, layout.reachFlags, Math.max(1, layout.reachSlots.size));
  if (ctx.analysis.usesTiles) {
    ctx.narrow(() => {
      for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
        ctx.asm.stz(mem(layout.tileContacts + index * layout.tileContactStride));
      }
    });
  }
}

/**
 * The vertical-blank handler, and the whole of what it does: say that the frame
 * happened.
 *
 * The upload is the main loop's, exactly as on the Master System and for the same
 * reason — the loop owns the render scratch, so no interrupt can arrive in the
 * middle of a tick's use of it. What this *cannot* assume is the accumulator's
 * width: an interrupt can land inside a narrowed block, so the handler widens
 * first and lets `rti` put back whatever it interrupted.
 */
function emitNmi(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  asm.label("Nmi");
  asm.rep(0x30);
  asm.pha();
  asm.phx();
  asm.phy();
  asm.sep(0x20);
  // Reading it is what acknowledges the interrupt; the value is of no interest.
  asm.lda(mem(R.RDNMI));
  asm.lda(imm8(1));
  asm.sta(mem(layout.interrupt as number));
  asm.rep(0x20);
  asm.ply();
  asm.plx();
  asm.pla();
  asm.rti();

  // Nothing else can raise one: the timers are disabled and a cartridge with no
  // coprocessor has nothing to ask for attention.
  asm.label("Irq");
  asm.rti();
}

function emitMainLoop(ctx: SnesCtx, audio: boolean): void {
  const { asm, layout } = ctx;
  const wait = ctx.unique("waitFrame");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  asm.label("Main");
  asm.label(wait);
  loadByte(ctx, layout.interrupt as number);
  ctx.far("eq", wait);
  clearByte(ctx, layout.interrupt as number);
  asm.jsr("UploadFrame");
  asm.jsr("ReadInput");
  asm.jsr("Tick");
  if (audio) asm.jsr("AudioService");
  asm.jsr("BuildFrame");
  asm.jmp("Main");
}

/**
 * Everything the sound processor needs from this one: a program and a request.
 *
 * Three routines, and the shortest audio path of any backend here — because none
 * of it is a driver. `AudioUpload` hands the other computer its whole program at
 * boot through four mailbox bytes; `AudioService` posts whatever the tick asked
 * for; `SceneMusic` decides what a scene asks for. After that the two processors
 * share nothing but the mailbox, and the tempo is the sound side's problem.
 *
 * All three run under {@link SnesCtx.narrow}, because a mailbox byte is a *byte*:
 * a sixteen-bit store to `$2140` would write `$2141` as well, which in the middle
 * of the handshake is the data byte being overwritten by the counter.
 */
function emitAudio(ctx: SnesCtx, options: SnesEmitOptions): void {
  const { asm, layout, program } = ctx;
  const driver = options.audio as SpcGameAudio;
  const at = options.audioAt as number;
  const music = layout.audio as number;
  const effect = music + 1;
  const sequence = music + 2;

  // --- the boot upload -------------------------------------------------------
  //
  // The protocol, from this side: wait for `$AA`/`$BB`, state the destination,
  // kick with `$CC`, then send each byte with its own counter and wait for the
  // counter to come back. A counter *two* past the last one ends the block, and
  // a zero in port 1 with it means "jump to the address in ports 2 and 3".
  asm.label("AudioUpload");
  ctx.narrow(() => {
    const ready = ctx.unique("apuReady");
    asm.label(ready);
    asm.lda(abs(R.APUIO));
    asm.cmp(imm8(0xaa));
    asm.bne(ready);
    asm.lda(abs(R.APUIO + 1));
    asm.cmp(imm8(0xbb));
    asm.bne(ready);

    asm.lda(imm8(driver.address & 0xff));
    asm.sta(abs(R.APUIO + 2));
    asm.lda(imm8((driver.address >> 8) & 0xff));
    asm.sta(abs(R.APUIO + 3));
    asm.lda(imm8(0x01));
    asm.sta(abs(R.APUIO + 1));
    asm.lda(imm8(0xcc));
    asm.sta(abs(R.APUIO));
    const kicked = ctx.unique("apuKicked");
    asm.label(kicked);
    asm.cmp(abs(R.APUIO));
    asm.bne(kicked);

    // The counter is the low byte of the index, because the bytes go in order
    // from zero — so there is nothing to keep in step with it.
    asm.ldx(imm16(0));
    const byte = ctx.unique("apuByte");
    asm.label(byte);
    asm.lda(longX(at));
    asm.sta(abs(R.APUIO + 1));
    asm.txa();
    asm.sta(abs(R.APUIO));
    const acked = ctx.unique("apuAcked");
    asm.label(acked);
    asm.cmp(abs(R.APUIO));
    asm.bne(acked);
    asm.inx();
    asm.cpx(imm16(driver.image.length));
    asm.bne(byte);

    asm.lda(imm8(driver.entry & 0xff));
    asm.sta(abs(R.APUIO + 2));
    asm.lda(imm8((driver.entry >> 8) & 0xff));
    asm.sta(abs(R.APUIO + 3));
    asm.stz(abs(R.APUIO + 1));
    asm.txa();
    asm.inc();
    asm.sta(abs(R.APUIO));
  });
  asm.rts();

  // --- posting a request -----------------------------------------------------
  //
  // The sequence byte is what makes this safe without a handshake: the sound
  // side acts only when it *changes*, so a frame that asks for nothing costs
  // three instructions and a frame that asks twice cannot be seen once.
  asm.label("AudioService");
  ctx.narrow(() => {
    const idle = ctx.unique("apuIdle");
    asm.lda(mem(music));
    asm.ora(mem(effect));
    asm.beq(idle);
    asm.lda(mem(music));
    asm.sta(abs(R.APUIO + SPC_PORT.music));
    asm.lda(mem(effect));
    asm.sta(abs(R.APUIO + SPC_PORT.sfx));
    asm.lda(mem(sequence));
    asm.inc();
    asm.sta(mem(sequence));
    asm.sta(abs(R.APUIO + SPC_PORT.sequence));
    asm.stz(mem(music));
    asm.stz(mem(effect));
    asm.label(idle);
  });
  asm.rts();

  // --- what a scene plays ----------------------------------------------------
  //
  // Music follows the scene, so it is asked for where the scene changes. Asking
  // rather than starting is what keeps it one byte: the request is posted from
  // the loop, and a scene change is not where that happens.
  asm.label("SceneMusic");
  loadByte(ctx, layout.scene);
  asm.tax();
  ctx.narrow(() => {
    asm.lda(absX(label("SceneTracks")));
    asm.sta(mem(music));
  });
  asm.rts();

  asm.label("SceneTracks");
  for (let index = 0; index < program.scenes.length; index += 1) {
    const track = options.sceneTracks?.[index] ?? -1;
    // A scene with no music of its own stops whatever the last one started,
    // rather than letting a title theme run under a level.
    asm.db(track < 0 ? SPC_STOP : track + 1);
  }
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * The console latches and shifts the controller itself once a frame, so `$4218`
 * already holds a word when the handler runs: B, Y, Select, Start, Up, Down,
 * Left, Right, A, X, L, R from bit 15 down to bit 4, *active high*. The abstract
 * set is `ACTIONS` order — left right up down a b start — which doc 14 §Buttons
 * chose as the portable floor, so the read is a permutation.
 *
 * Which physical buttons those are is the one mapping decision here, and it is
 * the conventional one: this pad's B and Y sit where the NES's A and B sat, so
 * that is what they are.
 */
function emitInput(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const raw = DP.t0;
  const out = DP.t1;
  const previous = DP.t2;
  const pressed = DP.t3;
  const released = DP.saved;

  asm.label("ReadInput");
  asm.lda(mem(R.JOY1));
  asm.sta(mem(raw));
  asm.stz(mem(out));

  // Which bit of that word each of this pad's buttons is.
  const HARDWARE: Readonly<Record<string, number>> = {
    b: 15,
    y: 14,
    select: 13,
    start: 12,
    up: 11,
    down: 10,
    left: 9,
    right: 8,
    a: 7,
    x: 6,
  };
  // And which of them each abstract button is. Read off `ACTIONS` rather than
  // restated, so the bit an emitted `when a pressed` tests (`emitButton`) and the
  // bit this fills in cannot drift apart.
  const PHYSICAL: Readonly<Record<string, string>> = {
    left: "left",
    right: "right",
    up: "up",
    down: "down",
    a: "b",
    b: "y",
    start: "start",
  };
  for (const [to, action] of ACTIONS.entries()) {
    const from = HARDWARE[PHYSICAL[action] as string] as number;
    const skip = ctx.unique("padSkip");
    asm.lda(mem(raw));
    asm.and(imm16(1 << from));
    asm.beq(skip);
    asm.lda(mem(out));
    asm.ora(imm16(1 << to));
    asm.sta(mem(out));
    asm.label(skip);
  }

  // held → pressed and released, against last tick's set. All three land as one
  // narrowed run of stores, because they are three adjacent bytes and a
  // sixteen-bit store to any of them would take its neighbour along.
  loadByte(ctx, layout.held);
  asm.sta(mem(previous));
  asm.lda(mem(previous));
  asm.eor(imm16(0x00ff));
  asm.and(mem(out));
  asm.sta(mem(pressed));
  asm.lda(mem(out));
  asm.eor(imm16(0x00ff));
  asm.and(mem(previous));
  asm.sta(mem(released));
  ctx.narrow(() => {
    asm.lda(mem(out));
    asm.sta(mem(layout.held));
    asm.lda(mem(pressed));
    asm.sta(mem(layout.pressed));
    asm.lda(mem(released));
    asm.sta(mem(layout.released));
  });
  asm.rts();
}

function emitTickDispatch(ctx: SnesCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) setByte(ctx, layout.sound, 0xff);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.jsr("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  inc16(ctx, layout.tick);
  incByte(ctx, layout.ready);
  asm.rts();
}

function emitSceneChange(ctx: SnesCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("SceneChange");
  const go = ctx.unique("changeGo");
  loadByte(ctx, layout.pending);
  asm.cmp(imm16(0x00ff));
  asm.bne(go);
  asm.rts();
  asm.label(go);
  ctx.narrow(() => {
    asm.lda(mem(layout.pending));
    asm.sta(mem(layout.scene));
  });
  setByte(ctx, layout.pending, 0xff);
  if (ctx.audio?.driver === true) asm.jsr("SceneMusic");
  asm.jsr("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.jsr("UpdateCamera");
  setByte(ctx, layout.redraw, 1);
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
 * The Super Nintendo's instructions for each of doc 14's tick steps.
 *
 * The *order* is not here: `emitTickSteps` runs them, so this backend supplies
 * the code for a step and has no say in the sequence (`backend.ts` §The tick's).
 */
function tickSteps(ctx: SnesCtx): TickSteps {
  const { layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => clearBytes(ctx, layout.contacts, layout.contactBytes),
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      ctx.narrow(() => {
        for (let index = 0; index < layout.contactBytes; index += 1) {
          ctx.asm.lda(mem(layout.contacts + index));
          ctx.asm.sta(mem(layout.contactsPrev + index));
        }
      });
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: SnesCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jmp("TickDone");
}

function emitSceneReset(ctx: SnesCtx, scene: SceneCtx): void {
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

function emitSceneCamera(ctx: SnesCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.rts();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: SnesCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: SnesCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  clearBytes(ctx, list, 1);
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.cmp(imm16(GRID_EMPTY));
    ctx.far("eq", next);
    asm.sta(mem(DP.t2));
    loadByte(ctx, list);
    asm.cmp(imm16(TILE_CONTACT_MAX));
    ctx.far("cs", next);
    // The entry is five bytes: the column, the row, and the legend index — so
    // the offset is the count times five, which is two doublings and an add.
    asm.sta(mem(DP.t3));
    asm.asl();
    asm.asl();
    asm.clc();
    asm.adc(mem(DP.t3));
    asm.tax();
    asm.lda(mem(col));
    asm.sta(absX(list + 1));
    asm.lda(mem(row));
    asm.sta(absX(list + 3));
    ctx.narrow(() => {
      asm.lda(mem(DP.t2));
      asm.sta(absX(list + 5));
    });
    incByte(ctx, list);
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `A`. */
function emitOverCells(ctx: SnesCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const limit = layout.words + W.lastRow * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  loadByte(ctx, list);
  ctx.far("eq", done);
  // The end of the list, worked out once: the count times five.
  asm.sta(mem(DP.t3));
  asm.asl();
  asm.asl();
  asm.clc();
  asm.adc(mem(DP.t3));
  asm.sta(mem(limit));
  asm.stz(mem(cursor));
  asm.label(loop);
  asm.ldx(mem(cursor));
  asm.lda(absX(list + 1));
  asm.sta(mem(col));
  asm.lda(absX(list + 3));
  asm.sta(mem(row));
  asm.lda(absX(list + 5));
  asm.and(imm16(0x00ff));
  body();
  // Five bytes on, and stop when the end is reached. The cursor is in memory
  // because a rule body uses every register there is.
  asm.clc();
  asm.lda(mem(cursor));
  asm.adc(imm16(5));
  asm.sta(mem(cursor));
  asm.cmp(mem(limit));
  ctx.far("cc", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: SnesCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.cmp(imm16(GRID_EMPTY));
        ctx.far("eq", next);
        // Is this legend entry one the rule names?
        asm.tax();
        loadTableByte(ctx, ruleTileTableLabel(rule, level));
        ctx.far("eq", next);

        // A side the rule did not name is a contact that never happened: it
        // does not fire and it is not recorded either, so next tick's "was this
        // seen before" answers as the interpreter's does (`sim.ts`
        // §resolveTiles). Separation is unaffected — what can hold an object up
        // is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.and(imm16(mask));
          ctx.far("eq", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.ldx(imm16(listBase + 1));
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
      asm.cmp(imm16(GRID_EMPTY));
      ctx.far("eq", next);
      asm.tax();
      loadTableByte(ctx, level.solidLabel);
      ctx.far("eq", next);
      loadTableByte(ctx, namedTable);
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
function emitFireTileRule(ctx: SnesCtx, rule: RuleDef, bind: Binding): void {
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
function emitCellId(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.and(imm16(0x00ff));
  asm.xba();
  asm.sta(mem(DP.t3));
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.and(imm16(0x00ff));
  asm.ora(mem(DP.t3));
  asm.sta(mem(layout.words + W.cell * 2));
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: SnesCtx, listBase: number): void {
  const { asm, layout } = ctx;
  clearBytes(ctx, layout.tileScratch, 1);
  loadByte(ctx, listBase);
  asm.sta(mem(layout.words + W.target * 2));
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  loadByte(ctx, layout.tileScratch);
  asm.cmp(imm16(TILE_CONTACT_MAX));
  ctx.far("cs", full);
  asm.asl();
  asm.tax();
  asm.lda(mem(layout.words + W.cell * 2));
  asm.sta(absX(layout.tileScratch + 1));
  incByte(ctx, layout.tileScratch);
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries that
 * exist, not the whole slot. An object usually touches two or three cells, and
 * copying sixteen of them every tick would cost more than the walk.
 */
function emitCommitContacts(ctx: SnesCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("commitContacts");
  loadByte(ctx, layout.tileScratch);
  asm.asl();
  asm.tax();
  ctx.narrow(() => {
    asm.label(loop);
    asm.lda(absX(layout.tileScratch));
    asm.sta(absX(listBase));
    asm.dex();
    asm.bpl(loop);
  });
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry event
 * fires only when the answer is no, a level one fires regardless. `X` holds the
 * list to search and the answer is the Z flag.
 */
function emitTileContactHelper(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.lda(mem(layout.words + W.target * 2));
  asm.beq(missing);
  asm.sta(mem(DP.t0));
  asm.label(loop);
  asm.lda(absX(0));
  asm.cmp(mem(layout.words + W.cell * 2));
  asm.beq(found);
  asm.inx();
  asm.inx();
  asm.dec(mem(DP.t0));
  asm.bne(loop);
  asm.label(missing);
  asm.lda(imm16(0));
  asm.rts();
  asm.label(found);
  asm.lda(imm16(1));
  asm.rts();
}

// --- rendering ---------------------------------------------------------------

/**
 * Plot entries this console records, which is half what the plan allows cells.
 *
 * The shared allocator gives the erase list two bytes a cell, and an entry here
 * is a column *word* and a row word — because a level may be wider than a byte,
 * and an entry that quietly dropped the high half would erase the wrong cell in
 * exactly the game that has one. Forty-eight cells is more HUD than any example
 * draws, and a scene that overran it would simply stop recording rather than
 * write past the list.
 */
function plotEntries(ctx: SnesCtx): number {
  return Math.floor(ctx.layout.memory.plotMax / 2);
}

function emitSceneRender(
  ctx: SnesCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: SnesEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.stz(mem(layout.words + W.camX * 2));
    asm.stz(mem(layout.words + W.camY * 2));
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  loadByte(ctx, layout.redraw);
  ctx.far("eq", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  clearByte(ctx, layout.redraw);
  clearByte(ctx, layout.plotPrevCount);
  asm.jmp(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with objects; one that does not gets it as
  // background cells, which costs no objects at all.
  if (!scrolls(ctx, scene)) {
    emitHudErase(ctx, scene, level);
    clearByte(ctx, layout.plotCount);
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options);
  asm.rts();
}

/**
 * `dst16 = floor(value * 8 / 65536)` — a 16.16 cell coordinate as a pixel one.
 *
 * Thirteen places right of a thirty-two bit value, which in sixteen-bit words is
 * the high word shifted up three and the low word's top three bits dropped in
 * beside it. The shift is arithmetic because the camera can be negative for a
 * frame before the clamp catches it.
 */
function emitPixelsFromFixed(ctx: SnesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.lda(mem(src, 2));
  asm.asl();
  asm.asl();
  asm.asl();
  asm.sta(mem(DP.t0));
  asm.lda(mem(src));
  asm.xba();
  asm.and(imm16(0x00ff));
  for (let shift = 0; shift < 5; shift += 1) asm.lsr();
  asm.ora(mem(DP.t0));
  asm.sta(mem(dst));
}

/** Draw the whole visible window, with the picture off. */
function emitFullRedraw(
  ctx: SnesCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: SnesEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Forced blank: video RAM is only writable outside the active display, and a
  // screenful is far more than a blanking interval holds.
  ctx.narrow(() => {
    asm.lda(imm8(0x80));
    asm.sta(mem(R.INIDISP));
  });

  const scenePalette = options.scenePalettes?.get(scene.def.name);
  if (scenePalette) emitPaletteUpload(ctx, scenePaletteLabel(scene));

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a screenful in tilemap order, so painting it is one walk from
    // the first cell — and it is *packed*, because a screen of words is nearly two
    // kilobytes a picture raw and a demade screen is mostly runs.
    asm.lda(imm16(VRAM.MAP));
    asm.sta(mem(R.VMADD));
    asm.ldx(imm16(label(backdropLabel(scene))));
    asm.jsr(needBlitCells(ctx));
  } else {
    // The window, and the one column and row the first scroll step will need
    // before it has had a chance to paint them — and nothing else. Painting a
    // whole level here instead would draw cells nobody has looked at yet and hold
    // the picture off while it did.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    copy16(ctx, layout.words + W.firstCol * 2, layout.words + W.mapCol * 2);
    copy16(ctx, layout.words + W.tileRow * 2, layout.words + W.mapRow * 2);

    const rowLoop = ctx.unique("fullRow");
    const colLoop = ctx.unique("fullCol");
    const rows = layout.words + W.firstRow * 2;
    const columns = layout.words + W.lastCol * 2;
    const height = layout.memory.viewH + (level === undefined ? 0 : 1);
    const width = layout.memory.viewW + (level === undefined ? 0 : 1);
    asm.lda(imm16(height));
    asm.sta(mem(rows));
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.lda(imm16(width));
    asm.sta(mem(columns));
    // The address is set once per row and the chip steps it — the whole point of
    // an auto-incrementing port. It has to be reset where the column crosses into
    // the other 32×32 screen, because those two are a kilobyte apart.
    asm.jsr("VramFor");
    asm.label(colLoop);
    emitBackgroundTile(ctx, level);
    asm.sta(mem(R.VMDATA));
    inc16(ctx, layout.words + W.tileCol * 2);
    const noWrap = ctx.unique("fullNoWrap");
    asm.lda(mem(layout.words + W.tileCol * 2));
    asm.and(imm16(31));
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
  // its whole HUD with objects, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  ctx.narrow(() => {
    asm.lda(imm8(0x0f));
    asm.sta(mem(R.INIDISP));
  });
}

/**
 * A packed tilemap: literals and runs, and the walk that unpacks it.
 *
 * ```text
 *   $0000          the end
 *   $0001..$7FFF   n entries follow, one word each
 *   $8001..$FFFF   the next entry, (n & $7FFF) times
 * ```
 *
 * A screenful here is 896 *words*, so two pictures stored raw would be more than
 * a tenth of the program bank. A demade screen is mostly runs — sky, a floor, a
 * wall — and packs to a fraction of that.
 *
 * The format is the encoder's and the decoder's business and nothing else's: what
 * is guaranteed is the entries that reach video RAM, and `snes-rom.test.ts`
 * checks those against the map the build produced rather than checking this
 * encoding. Same rule the audio driver's packing runs under (doc 16 §The driver
 * format is not part of the contract).
 */
export function packCells(cells: Uint16Array): Uint16Array {
  const out: number[] = [];
  let at = 0;
  while (at < cells.length) {
    let run = 1;
    while (run < 0x7fff && at + run < cells.length && cells[at + run] === cells[at]) run += 1;
    // Two of a kind is a wash — two words either way — so a run has to be worth
    // the control word before it is taken, and pairs go through as literals.
    if (run >= 3) {
      out.push(0x8000 | run, cells[at] as number);
      at += run;
      continue;
    }
    const start = at;
    while (at < cells.length && at - start < 0x7fff) {
      let ahead = 1;
      while (ahead < 3 && at + ahead < cells.length && cells[at + ahead] === cells[at]) ahead += 1;
      if (ahead >= 3) break;
      at += 1;
    }
    out.push(at - start, ...cells.subarray(start, at));
  }
  out.push(0x0000);
  return Uint16Array.from(out);
}

/** `X` = a packed tilemap's address; write it to the video-RAM data port. */
function needBlitCells(ctx: SnesCtx): Ref {
  return ctx.need("BlitCells", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const literal = inner.unique("blitLiteral");
    const run = inner.unique("blitRun");
    const runLoop = inner.unique("blitRunLoop");
    const done = inner.unique("blitDone");

    asm.label(next);
    asm.lda(absX(0));
    asm.inx();
    asm.inx();
    // The index's own flags are in the way, so the control word is re-tested
    // rather than branched on where it was loaded. `cmp #0` restores both: zero
    // for the terminator, and the sign bit that tells a run from a literal.
    asm.cmp(imm16(0));
    asm.beq(done);
    asm.bmi(run);
    asm.tay();
    asm.label(literal);
    asm.lda(absX(0));
    asm.inx();
    asm.inx();
    asm.sta(mem(R.VMDATA));
    asm.dey();
    asm.bne(literal);
    asm.bra(next);

    asm.label(run);
    asm.and(imm16(0x7fff));
    asm.tay();
    asm.lda(absX(0));
    asm.inx();
    asm.inx();
    asm.label(runLoop);
    asm.sta(mem(R.VMDATA));
    asm.dey();
    asm.bne(runLoop);
    asm.bra(next);

    asm.label(done);
    asm.rts();
  });
}

/** The labels holding one scene's packed tilemap and its colours. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}
function levelEntryLabel(level: LevelData): string {
  return `LevelEntry_${level.index}`;
}

/**
 * `A` = the tilemap entry that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: SnesCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.lda(imm16(BLANK_ENTRY));
    return;
  }
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/** `A` = the tilemap entry for the legend index in `A`. */
function emitLegendToTile(ctx: SnesCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.cmp(imm16(GRID_EMPTY));
  ctx.far("eq", empty);
  asm.asl();
  asm.tax();
  asm.lda(absX(label(levelEntryLabel(level))));
  asm.jmp(done);
  asm.label(empty);
  asm.lda(imm16(BLANK_ENTRY));
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: SnesCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.lda(mem(src));
    for (let index = 0; index < 3; index += 1) {
      asm.cmp(imm16(0x8000));
      asm.ror();
    }
    asm.sta(mem(dst));
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the tilemap up to date after the camera moved.
 *
 * The map is sixty-four columns and thirty-two rows against a screen of
 * thirty-two by twenty-eight, so level column `c` lives at map column `c mod 64`
 * and row `r` at map row `r mod 32`, and the scroll registers wrap on their own.
 * Crossing a cell boundary therefore costs one column or one row of writes, not a
 * screen — and a jump too large to walk sets the full-redraw flag instead of
 * silently dropping cells off the end of the queue.
 */
function emitScrollUpdate(ctx: SnesCtx, level: LevelData): void {
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
  setByte(ctx, layout.redraw, 1);
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge as
 * it goes. More than four cells in a tick is a teleport, not a scroll.
 */
function emitWalkAxis(
  ctx: SnesCtx,
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

  asm.lda(imm16(5));
  asm.sta(mem(guard));
  asm.label(loop);
  asm.dec(mem(guard));
  ctx.far("eq", bail);
  asm.sec();
  asm.lda(mem(want));
  asm.sbc(mem(origin));
  ctx.far("eq", done);
  ctx.far("mi", back);
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
function emitPaintEdge(ctx: SnesCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  // One cell more than the window in each direction, because the perpendicular
  // scroll may take a step before this strip is painted again.
  const count = isColumn ? layout.memory.viewH + 1 : layout.memory.viewW + 1;
  // Not `temp`: the grid lookup uses that word for its row-times-width multiply,
  // and a counter clobbered mid-loop paints a strip of whatever tile the count
  // happened to land on.
  const remaining = layout.words + W.lastRow * 2;

  asm.lda(mem(originAcross));
  if (offset !== 0) {
    asm.clc();
    asm.adc(imm16(offset));
  }
  asm.sta(mem(across));
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.lda(imm16(count));
  asm.sta(mem(remaining));
  asm.label(loop);
  emitBackgroundTile(ctx, level);
  asm.jsr("QueueCell");
  inc16(ctx, along);
  asm.dec(mem(remaining));
  ctx.far("ne", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(ctx: SnesCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  void scene;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  const limit = layout.words + W.lastRow * 2;
  loadByte(ctx, layout.plotPrevCount);
  ctx.far("eq", done);
  asm.asl();
  asm.asl();
  asm.sta(mem(limit));
  asm.stz(mem(cursor));
  asm.label(loop);
  asm.ldx(mem(cursor));
  asm.lda(absX(layout.plotPrev));
  asm.sta(mem(layout.words + W.tileCol * 2));
  asm.lda(absX(layout.plotPrev + 2));
  asm.sta(mem(layout.words + W.tileRow * 2));
  emitBackgroundTile(ctx, level);
  asm.jsr("QueueCell");
  asm.clc();
  asm.lda(mem(cursor));
  asm.adc(imm16(4));
  asm.sta(mem(cursor));
  asm.cmp(mem(limit));
  ctx.far("cc", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: SnesCtx): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("swapLoop");
  const done = ctx.unique("swapDone");
  ctx.narrow(() => {
    asm.lda(mem(layout.plotCount));
    asm.sta(mem(layout.plotPrevCount));
  });
  loadByte(ctx, layout.plotCount);
  ctx.far("eq", done);
  asm.asl();
  asm.asl();
  asm.tax();
  asm.dex();
  asm.dex();
  asm.label(loop);
  asm.lda(absX(layout.plot));
  asm.sta(absX(layout.plotPrev));
  asm.dex();
  asm.dex();
  asm.bpl(loop);
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(ctx: SnesCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    // wrapped tilemap puts it in the right place with no extra work.
    asm.lda(mem(base + propOffset("x") + 2));
    asm.sta(mem(layout.words + W.tileCol * 2));
    asm.lda(mem(base + propOffset("y") + 2));
    asm.sta(mem(layout.words + W.tileRow * 2));

    // A static object is painted straight into video RAM with the picture already
    // off, so it needs neither the write queue nor a place in the erase list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.lda(imm16(tilemapEntry(glyphTile(character), SYSTEM_PALETTE)));
        asm.jsr(plot);
      }
    } else {
      asm.lda(mem(base + propOffset("value") + 2));
      asm.sta(mem(layout.words + W.target * 2));
      asm.jsr(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `A` = an entry: write it at the current cell and advance the column. */
function needPokeCell(ctx: SnesCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    asm.sta(mem(DP.t2));
    asm.jsr("VramFor");
    asm.lda(mem(DP.t2));
    asm.sta(mem(R.VMDATA));
    inc16(inner, layout.words + W.tileCol * 2);
    asm.rts();
  });
}

/** The decimal renderer again, writing straight to video RAM. */
function needPokeNumber(ctx: SnesCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeCell(inner), cellGlyph);
  });
}

/**
 * `X` = an entity's base, `t0`/`t1` = its size in cells → `A` is zero when the
 * object is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * word of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled — the test
 * may say "maybe" when the answer is no, and never the other way round.
 */
function needOnscreen(ctx: SnesCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");
    const delta = DP.spare;

    const axis = (offset: number, margin: number, span: number): void => {
      asm.sec();
      asm.lda(absX(offset + 2));
      asm.sbc(mem(camera + offset + 2));
      asm.sta(mem(delta));
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.clc();
      asm.adc(mem(margin));
      inner.far("mi", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.sec();
      asm.lda(mem(delta));
      asm.sbc(imm16(span + 1));
      inner.far("pl", apart);
    };
    axis(propOffset("x"), DP.t0, layout.memory.viewW);
    axis(propOffset("y"), DP.t1, layout.memory.viewH);

    asm.lda(imm16(1));
    asm.rts();
    asm.label(apart);
    asm.lda(imm16(0));
    asm.rts();
  });
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: SnesCtx, scene: SceneCtx, options: SnesEmitOptions): void {
  const { asm, layout, program } = ctx;
  clearByte(ctx, layout.oamCount);

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
      asm.lda(imm16(width));
      asm.sta(mem(DP.t0));
      asm.lda(imm16(height));
      asm.sta(mem(DP.t1));
      asm.ldx(imm16(base));
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

    const palette = art?.palette ?? SYSTEM_PALETTE;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE;
        emitSpriteCell(ctx, column, row, tile, palette);
      }
    }
    asm.label(skip);
  }
  if (scrolls(ctx, scene)) emitHudSprites(ctx, scene);
  asm.jsr(needClearRestOfOam(ctx));
}

/**
 * Draw a scrolling scene's `number` and `text` objects as hardware objects.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already
 * wrote — only the layer differs. Thirty-two objects to a scanline is this
 * hardware's limit, four times the NES's, so a caption in a scrolling scene is
 * comfortable here where there it is the one HUD that cannot be drawn.
 */
function emitHudSprites(ctx: SnesCtx, scene: SceneCtx): void {
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
        asm.lda(imm16(objectEntry(glyphTile(character), SYSTEM_PALETTE)));
        asm.jsr(needHudGlyph(ctx));
      }
    } else {
      asm.lda(mem(base + propOffset("value") + 2));
      asm.sta(mem(layout.words + W.target * 2));
      asm.jsr(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/**
 * The second word of an object's entry: its tile's low byte, then its
 * attributes.
 *
 * Priority two puts objects in front of a background cell of ordinary priority,
 * which is where a game's sprites belong; bit zero of the attribute byte is the
 * tile's ninth bit, which is what makes the bank five hundred and twelve tiles
 * rather than two hundred and fifty-six.
 */
function objectEntry(tile: number, palette: number): number {
  const attributes = 0x20 | ((palette & 7) << 1) | ((tile >> 8) & 1);
  return ((attributes & 0xff) << 8) | (tile & 0xff);
}

/** `A` = an object entry: put one glyph at the pen and advance it. */
function needHudGlyph(ctx: SnesCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const { asm, layout } = inner;
    asm.sta(mem(DP.t2));
    const offscreen = inner.unique("hudOff");
    asm.lda(mem(layout.words + W.count * 2));
    asm.cmp(imm16(SCREEN_LINES));
    asm.bcs(offscreen);
    asm.sta(mem(DP.t0));
    asm.lda(mem(layout.words + W.temp * 2));
    asm.cmp(imm16(0x0100));
    asm.bcs(offscreen);
    asm.sta(mem(DP.t1));
    asm.jsr(needPushSprite(inner));
    asm.label(offscreen);
    asm.clc();
    asm.lda(mem(layout.words + W.temp * 2));
    asm.adc(imm16(8));
    asm.sta(mem(layout.words + W.temp * 2));
    asm.rts();
  });
}

/** The decimal renderer again, plotting objects instead of background cells. */
function needHudNumber(ctx: SnesCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    emitDecimal(inner, needHudGlyph(inner), objectGlyph);
  });
}

/** Lines the picture has, which is what an object's Y is compared against. */
const SCREEN_LINES = 224;

/**
 * One cell of an object, at the pen, and only if the hardware can put it there.
 *
 * An object's position is a *screen* position and can be off either edge; the
 * eight bits this runtime uses of the nine-bit X cannot express one that is. So
 * the cell's position is computed sixteen bits wide and pushed only when it is
 * inside the screen — which one unsigned comparison answers, because a negative
 * position arrives as `$FFxx` and is therefore above the limit too.
 *
 * There is no minus-one convention here, unlike the NES: this chip draws an
 * object's top row *on* the line its Y names, so `y 0` is the top of the screen
 * and needs no exception.
 */
function emitSpriteCell(
  ctx: SnesCtx,
  column: number,
  row: number,
  tile: number,
  palette: number,
): void {
  const { asm, layout } = ctx;
  const penX = layout.words + W.temp * 2;
  const penY = layout.words + W.count * 2;
  const offscreen = ctx.unique("spriteOff");

  asm.clc();
  asm.lda(mem(penX));
  asm.adc(imm16(column * 8));
  asm.cmp(imm16(0x0100));
  asm.bcs(offscreen);
  asm.sta(mem(DP.t1));
  asm.clc();
  asm.lda(mem(penY));
  asm.adc(imm16(row * 8));
  asm.cmp(imm16(SCREEN_LINES));
  asm.bcs(offscreen);
  asm.sta(mem(DP.t0));
  asm.lda(imm16(objectEntry(tile, palette)));
  asm.sta(mem(DP.t2));
  asm.jsr(needPushSprite(ctx));
  asm.label(offscreen);
}

/**
 * `t0` = y, `t1` = x, `t2` = the tile-and-attribute word; append an object entry.
 *
 * Two words, because that is what an entry is: the low table holds X and Y in one
 * and the tile with its attributes in the other. The high table — the ninth bit
 * of X and the size bit — is left at the zeros the boot clear put there, which is
 * exactly right for an eight-pixel object inside the screen.
 */
function needPushSprite(ctx: SnesCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    loadByte(inner, layout.oamCount);
    asm.cmp(imm16(layout.memory.oamEntries));
    asm.bcc(room);
    asm.rts();
    asm.label(room);
    asm.asl();
    asm.asl();
    asm.tax();
    asm.lda(mem(DP.t0));
    asm.xba();
    asm.ora(mem(DP.t1));
    asm.sta(absX(layout.memory.oamShadow));
    asm.lda(mem(DP.t2));
    asm.sta(absX(layout.memory.oamShadow + 2));
    incByte(inner, layout.oamCount);
    asm.rts();
  });
}

/**
 * Park the entries that are no longer in use.
 *
 * Only the ones *this* frame vacated need clearing: everything above last frame's
 * high-water mark is already parked. Parking means `Y = 240`, which is below the
 * visible area — an object left at zero would be a visible artefact in the top
 * left corner.
 */
function needClearRestOfOam(ctx: SnesCtx): Ref {
  return ctx.need("ClearRestOfOam", (inner) => {
    const { asm, layout } = inner;
    const sweep = inner.unique("oamSweep");
    const step = inner.unique("oamStep");
    loadByte(inner, layout.oamCount);
    asm.sta(mem(DP.t1));
    loadByte(inner, layout.oamPrev);
    asm.sta(mem(DP.t2));
    inner.narrow(() => {
      asm.lda(mem(layout.oamCount));
      asm.sta(mem(layout.oamPrev));
    });
    asm.lda(mem(DP.t1));
    asm.cmp(mem(DP.t2));
    asm.bcc(sweep);
    asm.rts();
    asm.label(sweep);
    // From this frame's count up to last frame's, four bytes an entry. Both are
    // scaled here rather than compared as entry numbers, because the index is
    // what walks the shadow.
    asm.asl();
    asm.asl();
    asm.tax();
    asm.lda(mem(DP.t2));
    asm.asl();
    asm.asl();
    asm.sta(mem(DP.t3));
    inner.narrow(() => {
      asm.lda(imm8(240));
      asm.label(step);
      asm.sta(absX(layout.memory.oamShadow + 1));
      asm.inx();
      asm.inx();
      asm.inx();
      asm.inx();
      asm.cpx(mem(DP.t3));
      asm.bne(step);
    });
    asm.rts();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: SnesCtx): void {
  const { asm, layout } = ctx;

  // `A` = the tilemap word address of the cell in words[tileCol]/words[tileRow].
  // The map is two 32×32 screens side by side, so bit 5 of the column chooses
  // which — and it chooses it by moving the address a kilobyte, not by moving it
  // one cell, which is the whole of what a "64-wide" tilemap means on this chip.
  asm.label("CellAddress");
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.and(imm16(32));
  for (let shift = 0; shift < 5; shift += 1) asm.asl();
  asm.sta(mem(DP.t0));
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.and(imm16(31));
  for (let shift = 0; shift < 5; shift += 1) asm.asl();
  asm.ora(mem(DP.t0));
  asm.sta(mem(DP.t0));
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.and(imm16(31));
  asm.ora(mem(DP.t0));
  asm.clc();
  asm.adc(imm16(VRAM.MAP));
  asm.rts();

  // Point the video-RAM address at that cell, for a direct write.
  asm.label("VramFor");
  asm.jsr("CellAddress");
  asm.sta(mem(R.VMADD));
  asm.rts();

  // `A` = a tilemap entry: queue it for the next blanking interval. An entry is
  // its address and its data, four bytes, because both are words and both go out
  // in one store each.
  asm.label("QueueCell");
  const room = ctx.unique("queueRoom");
  asm.sta(mem(DP.t2));
  loadByte(ctx, layout.queueCount);
  asm.cmp(imm16(layout.memory.queueMax));
  asm.bcc(room);
  // No room: repaint the whole background next frame rather than leave a strip of
  // it stale for ever.
  setByte(ctx, layout.redraw, 1);
  asm.rts();
  asm.label(room);
  asm.jsr("CellAddress");
  asm.sta(mem(DP.t3));
  loadByte(ctx, layout.queueCount);
  asm.asl();
  asm.asl();
  asm.tax();
  asm.lda(mem(DP.t3));
  asm.sta(absX(layout.queue));
  asm.lda(mem(DP.t2));
  asm.sta(absX(layout.queue + 2));
  incByte(ctx, layout.queueCount);
  asm.rts();

  // `A` = an entry: queue it, record the cell for erasing, and advance the
  // column. The HUD is scattered cells rather than a strip, so each is its own
  // queue entry — and there are never many of them.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  asm.jsr("QueueCell");
  loadByte(ctx, layout.plotCount);
  asm.cmp(imm16(plotEntries(ctx)));
  asm.bcs(plotFull);
  asm.asl();
  asm.asl();
  asm.tax();
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.sta(absX(layout.plot));
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.sta(absX(layout.plot + 2));
  incByte(ctx, layout.plotCount);
  asm.label(plotFull);
  inc16(ctx, layout.words + W.tileCol * 2);
  asm.rts();

  // Flush the queue, hand the objects to the transfer controller, and set the
  // scroll. All three fit inside the blanking interval by construction: the queue
  // is capped at what one will hold and anything over sets the redraw flag
  // instead of being dropped.
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  loadByte(ctx, layout.queueCount);
  ctx.far("eq", noQueue);
  asm.asl();
  asm.asl();
  asm.sta(mem(DP.t0));
  asm.ldx(imm16(0));
  asm.label(flush);
  asm.lda(absX(layout.queue));
  asm.sta(mem(R.VMADD));
  asm.lda(absX(layout.queue + 2));
  asm.sta(mem(R.VMDATA));
  asm.inx();
  asm.inx();
  asm.inx();
  asm.inx();
  asm.cpx(mem(DP.t0));
  ctx.far("cc", flush);
  clearByte(ctx, layout.queueCount);
  asm.label(noQueue);

  // The objects, by transfer: five hundred and forty-four bytes out of the shadow
  // into the chip's own memory.
  asm.stz(mem(R.OAMADD));
  asm.lda(imm16(0x0000 | ((0x04 & 0xff) << 8)));
  asm.sta(mem(R.DMAP0));
  asm.lda(imm16(layout.memory.oamShadow));
  asm.sta(mem(R.A1T0));
  asm.lda(imm16(544));
  asm.sta(mem(R.DAS0));
  ctx.narrow(() => {
    asm.lda(imm8(0x00));
    asm.sta(mem(R.A1B0));
    asm.lda(imm8(0x01));
    asm.sta(mem(R.MDMAEN));
  });

  // The scroll, last. Ten bits through an eight-bit port, so each register takes
  // the low byte and then the high one — which `xba` supplies without a second
  // load. The vertical one is the camera *minus one*, because this chip shows
  // background line `VOFS + N + 1` on screen line `N`.
  emitScrollWrite(ctx, R.BG1HOFS, layout.words + W.scrollX * 2, 0);
  emitScrollWrite(ctx, R.BG1VOFS, layout.words + W.scrollY * 2, -1);
  asm.rts();

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell", cellGlyph);

  emitDecimalPowers(ctx);
}

/** Write one ten-bit scroll register, low byte then high. */
function emitScrollWrite(ctx: SnesCtx, register: number, source: number, bias: number): void {
  const { asm } = ctx;
  asm.lda(mem(source));
  if (bias !== 0) {
    asm.clc();
    asm.adc(imm16(bias & 0xffff));
  }
  ctx.narrow(() => {
    asm.sta(mem(register));
    asm.xba();
    asm.sta(mem(register));
  });
}

/**
 * Draw the signed sixteen-bit value in `words[target]` in decimal, one glyph at a
 * time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the object one — which is
 * why it is a parameter rather than a second copy of the digit loop. Leading
 * zeroes are suppressed and a lone zero still prints.
 */
function emitDecimal(ctx: SnesCtx, plot: Ref, entry: (character: string) => number): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine, the write queue and the object builder — which between them
  // use every word of the direct-page scratch. So the digit loop keeps its state
  // in the render words instead, in slots nothing on that path touches: not the
  // pen (`temp`, `count`), not the cell being written (`tileCol`, `tileRow`), and
  // not the scroll the frame is about to be uploaded with.
  const value = layout.words + W.target * 2;
  const flag = layout.words + W.cell * 2;
  const digit = layout.words + W.lastCol * 2;
  const power = layout.words + W.firstCol * 2;

  const positive = ctx.unique("numPos");
  asm.lda(mem(value));
  ctx.far("pl", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.eor(imm16(0xffff));
  asm.inc();
  asm.sta(mem(value));
  asm.lda(imm16(entry("-")));
  asm.jsr(plot);
  asm.label(positive);

  asm.stz(mem(flag));
  asm.stz(mem(power));
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const digitDone = ctx.unique("numDigit");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");

  asm.label(powerLoop);
  asm.stz(mem(digit));
  asm.label(subLoop);
  // value -= power, keeping it only while it does not go negative.
  asm.ldx(mem(power));
  asm.sec();
  asm.lda(mem(value));
  asm.sbc(absX(label("DecimalPowers")));
  asm.bcc(digitDone);
  asm.sta(mem(value));
  asm.inc(mem(digit));
  asm.bra(subLoop);
  asm.label(digitDone);
  asm.lda(mem(digit));
  ctx.far("ne", emitDigit);
  asm.lda(mem(flag));
  ctx.far("ne", emitDigit);
  asm.lda(mem(power));
  asm.cmp(imm16(8));
  ctx.far("ne", skipDigit);
  asm.label(emitDigit);
  asm.lda(imm16(1));
  asm.sta(mem(flag));
  asm.clc();
  asm.lda(mem(digit));
  asm.adc(imm16(entry("0")));
  asm.jsr(plot);
  asm.label(skipDigit);
  asm.lda(mem(power));
  asm.inc();
  asm.inc();
  asm.sta(mem(power));
  asm.cmp(imm16(10));
  ctx.far("ne", powerLoop);
  asm.rts();
}

/**
 * The word one glyph draws as, on each of the two layers.
 *
 * The encodings differ — a tilemap entry puts the palette in bits 10 to 12 and an
 * object entry puts it in the attribute byte — but a digit's *arithmetic* is the
 * same either way, because adding a digit to the base glyph only ever touches the
 * low byte. That is what lets one decimal renderer serve both, told which
 * spelling to use rather than working it out.
 */
function cellGlyph(character: string): number {
  return tilemapEntry(glyphTile(character), SYSTEM_PALETTE);
}

function objectGlyph(character: string): number {
  return objectEntry(glyphTile(character), SYSTEM_PALETTE);
}

/** The powers of ten a decimal render walks, as little-endian words. */
function emitDecimalPowers(ctx: SnesCtx): void {
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}

/** The built-in bank's size, which is where a build's own art starts. */
export const BUILTIN_TILES = BUILTIN_TILE_COUNT;
