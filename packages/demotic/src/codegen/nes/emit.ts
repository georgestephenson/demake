/**
 * The whole-program emitter for the NES: boot, the frame, the renderer, the data.
 *
 * Everything here is per *scene*, for the reason the Game Boy backend gives: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and five differences are load-bearing:
 *
 *   - **There is no VRAM to write tiles into.** Character data is ROM on the
 *     cartridge, so the pattern tables are built at compile time and the runtime
 *     never uploads a tile. That is why an NES build has *more* room for art than
 *     a Game Boy one rather than less: 256 background patterns and 256 object
 *     patterns, in separate tables, instead of 256 shared.
 *   - **A background cell's palette comes from a 16×16 block.** So there is no
 *     per-cell attribute in the write queue: a scene uploads its whole 64-byte
 *     attribute table during the redraw, when rendering is already off, and
 *     nothing touches it per frame.
 *   - **The nametable is 32×30 and mirrored.** A cartridge wired for vertical
 *     mirroring has two side by side, so the map wraps every 64 columns and every
 *     30 rows — the same trick the Game Boy plays with 32×32, at different moduli.
 *   - **The frame is uploaded through two registers.** An address goes out through
 *     `PPUADDR` a byte at a time and the data through `PPUDATA`, so a queued cell
 *     costs more here than a plain store does there, and the queue is capped
 *     accordingly (`NES_MEMORY`).
 *   - **Objects are transferred by DMA from a page of RAM.** Which is why the
 *     object shadow is page-aligned, exactly as on the Game Boy, and why the
 *     transfer costs 513 cycles of the VBlank rather than 160.
 *
 * The tick order, the rule bodies and every compile-time decision are shared with
 * the Game Boy backend (`backend.ts`, `shape.ts`). Nothing in this file decides
 * what the game does.
 */

import { AUDIO_STOP, type NesGameAudio } from "@demake/audio";
import { abs, absX, imm, immHigh, immLow, indY, label, type Ref } from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import { glyphTile, OBJECT_TILE, patternTile } from "../../rom/graphics.js";
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

import type { NesCtx } from "./ctx.js";
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
import { branchZero32, copy32, sub32 } from "./val.js";
import { mem, ZP } from "./zp.js";

/** Hardware registers this backend touches. */
const R = {
  PPUCTRL: 0x2000,
  PPUMASK: 0x2001,
  PPUSTATUS: 0x2002,
  OAMADDR: 0x2003,
  PPUSCROLL: 0x2005,
  PPUADDR: 0x2006,
  PPUDATA: 0x2007,
  OAMDMA: 0x4014,
  /** The APU's frame counter, and the controller port that shares its address. */
  FRAMECTR: 0x4017,
  JOY1: 0x4016,
} as const;

/** Where the two nametables and the palette live in the PPU's address space. */
const NAMETABLE = 0x2000;
const ATTRIBUTES = 0x23c0;
const PALETTE = 0x3f00;

/**
 * Cells one nametable holds.
 *
 * A cartridge wired for vertical mirroring has two of them side by side, so the
 * horizontal wrap is `2 * MAP_W` — expressed as a mask on bit 5 of the column
 * rather than as a constant, because that is the bit that chooses the table.
 */
const MAP_W = 32;
const MAP_H = 30;

/**
 * Whether this level's vertical axis can be scrolled by repainting.
 *
 * Only where the level is taller than the map. Thirty rows of nametable against
 * thirty rows of screen leave nothing spare, so for a level no taller than the map
 * there is no "next row" to paint — every row is already at its own address and
 * stays there, and the two overscan rows such a level scrolls into show its own
 * top two. That is the NROM constraint stated rather than worked around; a taller
 * level wraps properly and is painted a row at a time like the columns.
 */
function scrollsRows(level: LevelData): boolean {
  return level.file.height > MAP_H;
}

/**
 * The palette reserved for the font, the level patterns and the placeholder block.
 *
 * The last of the four, background and objects alike, for the reason the Game Boy
 * Color build keeps one back: everything else is demade art whose palette was
 * chosen *for that art*, and a caption drawn in a title screen's palette is sky on
 * sky. The fitters are given the other three.
 */
export const SYSTEM_PALETTE = 3;

/** Sub-palettes a build's art may use — every one but the system's. */
export const ART_PALETTES = SYSTEM_PALETTE;

/** Everything the emitter needs beyond the program itself. */
export interface NesEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number }>;
  /**
   * Demade backdrops by scene name: the nametable the picture fills, its packed
   * attribute table, and the sixteen master-palette indices it chose.
   */
  backdrops?: ReadonlyMap<string, { map: Uint8Array; attr: Uint8Array; palette: Uint8Array }>;
  /** The palette a level's tile art and the built-in patterns are drawn with. */
  levelPalette?: Uint8Array;
  /** The object palettes: three the art chose, then the font's ramp. */
  objectPalette?: Uint8Array;
  /**
   * The game's audio driver, already built from its demade tracks and effects.
   *
   * Absent for a game with nothing to play, and then the ROM is exactly what it
   * was before audio existed — no counter in the NMI, no service call in the
   * loop, no page zero set aside.
   */
  audio?: NesGameAudio;
  /** Driver index of each of the program's sounds, or `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Which track each scene plays, as an index, or `-1` for a silent one. */
  sceneTracks?: readonly number[];
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: NesCtx, labels: readonly string[]): void {
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
export function emitProgram(ctx: NesCtx, options: NesEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx, options);
  emitNmi(ctx, options);
  emitMainLoop(ctx, options);
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
  if (options.audio) options.audio.emitCode(ctx.asm);
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

  // One demade nametable per scene that has a backdrop, and one attribute table
  // per scene whatever it draws — see {@link sceneAttributes}.
  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (art) {
      asm.label(backdropLabel(scene));
      asm.bytes(art.map);
      asm.label(backdropPaletteLabel(scene));
      asm.bytes(art.palette);
    }
    asm.label(sceneAttrLabel(scene));
    asm.bytes(sceneAttributes(ctx, scene, options));
  }
  asm.label("LevelPalette");
  asm.bytes(options.levelPalette ?? defaultBackgroundPalette());
  asm.label("ObjectPalette");
  asm.bytes(options.objectPalette ?? defaultObjectPalette());

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
}

/**
 * The background palette a build with no demade art uses.
 *
 * The font's ramp in all four, so a caption is legible whatever it is drawn over:
 * black behind, then the three greys of the master palette's own ramp.
 */
function defaultBackgroundPalette(): Uint8Array {
  const block = new Uint8Array(16);
  for (let palette = 0; palette < 4; palette += 1) {
    block[palette * 4] = 0x0f; // the universal backdrop: black
    block[palette * 4 + 1] = 0x00;
    block[palette * 4 + 2] = 0x10;
    block[palette * 4 + 3] = 0x30;
  }
  return block;
}

/** The same for objects, whose colour 0 is transparency rather than a colour. */
function defaultObjectPalette(): Uint8Array {
  return defaultBackgroundPalette();
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: NesCtx, options: NesEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.sei();
  asm.cld();
  asm.ldx(imm(0xff));
  asm.txs();
  // Rendering and interrupts off while the PPU warms up, and the APU's frame
  // counter parked so it cannot raise an interrupt this runtime has no handler for.
  asm.lda(imm(0));
  asm.sta(abs(R.PPUCTRL));
  asm.sta(abs(R.PPUMASK));
  asm.lda(imm(0x40));
  asm.sta(abs(R.FRAMECTR));

  // The PPU needs two frames before its registers can be trusted; the status
  // register's top bit is the only clock available before the NMI is enabled.
  const warm = ctx.unique("warm");
  const warmAgain = ctx.unique("warmAgain");
  asm.bit(abs(R.PPUSTATUS));
  asm.label(warm);
  asm.bit(abs(R.PPUSTATUS));
  asm.bpl(warm);
  asm.label(warmAgain);
  asm.bit(abs(R.PPUSTATUS));
  asm.bpl(warmAgain);

  // Clear the console's whole 2 KiB, so a game's state starts from zero rather
  // than from whatever powered up — including the object shadow, whose sprites
  // would otherwise appear at the top left before the first frame is built.
  const clear = ctx.unique("clearRam");
  asm.lda(imm(0));
  asm.ldx(imm(0));
  asm.label(clear);
  for (const page of [0x0000, 0x0100, 0x0200, 0x0300, 0x0400, 0x0500, 0x0600, 0x0700]) {
    asm.sta(absX(page));
  }
  asm.inx();
  asm.bne(clear);

  emitPalettes(ctx, options);
  emitBlankNametables(ctx);

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
  if (layout.rng !== null) {
    const seed = program.seed | 0;
    for (let index = 0; index < 4; index += 1) {
      asm.lda(imm((seed >> (index * 8)) & 0xff));
      asm.sta(mem(layout.rng + index));
    }
  }

  asm.jsr("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of a
  // tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.lda(imm(0));
    for (let index = 0; index < 8; index += 1) asm.sta(mem(layout.camera + index));
  }
  asm.jsr("BuildFrame");
  asm.jsr("UploadFrame");

  if (options.audio) {
    asm.jsr("AudioInit");
    if (program.tracks.length > 0) asm.jsr("SceneMusic");
  }

  // Rendering on, and the NMI with it: background and objects, patterns at
  // $0000 for the background and $1000 for the objects.
  asm.lda(imm(0x1e));
  asm.sta(abs(R.PPUMASK));
  asm.lda(imm(0x88));
  asm.sta(abs(R.PPUCTRL));
  asm.lda(imm(1));
  asm.sta(mem(layout.booted));
  asm.jmp("Main");
}

/** Upload both palette blocks: the background's, then the objects'. */
function emitPalettes(ctx: NesCtx, options: NesEmitOptions): void {
  const { asm } = ctx;
  void options;
  emitPpuAddress(ctx, PALETTE);
  const loop = ctx.unique("palLoop");
  asm.ldx(imm(0));
  asm.label(loop);
  asm.lda(absX("LevelPalette"));
  asm.sta(abs(R.PPUDATA));
  asm.inx();
  asm.cpx(imm(16));
  asm.bne(loop);
  const objects = ctx.unique("objPalLoop");
  asm.ldx(imm(0));
  asm.label(objects);
  asm.lda(absX("ObjectPalette"));
  asm.sta(abs(R.PPUDATA));
  asm.inx();
  asm.cpx(imm(16));
  asm.bne(objects);
}

/** Fill both nametables and their attributes, so nothing stale shows through. */
function emitBlankNametables(ctx: NesCtx): void {
  const { asm } = ctx;
  emitPpuAddress(ctx, NAMETABLE);
  const outer = ctx.unique("blankOuter");
  const inner = ctx.unique("blankInner");
  asm.ldy(imm(8)); // eight pages: two nametables with their attribute tables
  asm.label(outer);
  asm.ldx(imm(0));
  asm.lda(imm(0));
  asm.label(inner);
  asm.sta(abs(R.PPUDATA));
  asm.inx();
  asm.bne(inner);
  asm.dey();
  asm.bne(outer);
}

/** Point `PPUADDR` at a compile-time address, high byte first. */
function emitPpuAddress(ctx: NesCtx, address: number): void {
  const { asm } = ctx;
  asm.lda(imm((address >> 8) & 0xff));
  asm.sta(abs(R.PPUADDR));
  asm.lda(imm(address & 0xff));
  asm.sta(abs(R.PPUADDR));
}

/** Copy a compile-time run of bytes from ROM into RAM. */
function emitCopyBlock(ctx: NesCtx, source: Ref, dest: number, count: number): void {
  const { asm } = ctx;
  const loop = ctx.unique("copyLoop");
  asm.ldx(imm(count - 1));
  asm.label(loop);
  asm.lda(absX(source));
  asm.sta(absX(dest));
  asm.dex();
  asm.bpl(loop);
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: NesCtx): void {
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
 * The two flags the frame loop runs on, in page zero beside the render scratch.
 *
 * `VBLANKED` is the clock: the handler raises it and the main loop consumes it.
 * `FRAME_READY` is the hand-off: the main loop raises it when a frame's worth of
 * queue and object shadow is *complete*, and the handler lowers it once that
 * frame has been uploaded. A half-built queue is never uploaded, because the flag
 * that offers it is set only after `BuildFrame` returns.
 */
const VBLANKED = 7;
const FRAME_READY = 6;

/**
 * The VBlank handler, which is where the picture is uploaded.
 *
 * Not from the main loop, and this is the one place the NES departs from the
 * Game Boy's shape deliberately. The loop's flag says "a VBlank *happened*", not
 * "we are in one" — so a tick that overran its frame made the loop upload
 * immediately, in the middle of active rendering, where the PPU reloads its
 * address register from the scroll latch at the pre-render line. The last rows of
 * a scrolled column then landed back at the top of the column, which is the
 * flickering a scrolling level showed every few frames.
 *
 * Uploading from the handler puts the writes inside the window by construction,
 * whatever the tick costs. The price is that the handler now interrupts a tick
 * that owns the render scratch, so it saves the seven bytes the upload uses —
 * about a hundred cycles out of a window of two thousand two hundred.
 */
function emitNmi(ctx: NesCtx, options: NesEmitOptions): void {
  const { asm, layout } = ctx;
  const idle = ctx.unique("nmiNoFrame");
  // The scratch the upload borrows, saved because the tick may be mid-expression.
  const borrowed = [ZP.p0, ZP.p0 + 1, ZP.t0, ZP.t1, ZP.t3, ZP.spare, ZP.spare + 1];

  asm.label("Nmi");
  asm.pha();
  asm.txa();
  asm.pha();
  asm.tya();
  asm.pha();

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
  // The audio driver is *counted* here and performed in the main loop. The
  // vertical blank is the picture's — a driver tick taken in the handler is a
  // tick the tilemap upload waits behind — and the frame is still what keeps the
  // tempo, because a frame the game overran is owed rather than lost. It runs
  // before the registers are restored, so it may use them freely.
  if (options.audio) asm.jsr(options.audio.routines.frame);
  asm.pla();
  asm.tay();
  asm.pla();
  asm.tax();
  asm.pla();
  asm.rti();

  // There is no interrupt to serve: the frame counter is parked at boot, and a
  // cartridge with no mapper has nothing else that can raise one.
  asm.label("Irq");
  asm.rti();
}

function emitMainLoop(ctx: NesCtx, options: NesEmitOptions): void {
  const { asm, layout } = ctx;
  const wait = ctx.unique("waitVblank");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  // It is safe to run on from a stale one now, because what the loop does next is
  // the tick — the *upload* waits for a real window, in the handler.
  asm.label("Main");
  asm.label(wait);
  asm.lda(mem(layout.scratch + VBLANKED));
  asm.beq(wait);
  asm.lda(imm(0));
  asm.sta(mem(layout.scratch + VBLANKED));
  asm.jsr("ReadInput");
  asm.jsr("Tick");
  // After the tick, so an effect a rule asked for is heard this frame rather
  // than next; after the upload, so the frame it delays is nobody's.
  if (options.audio) asm.jsr(options.audio.routines.service);
  asm.jsr("BuildFrame");
  // The frame is whole: the next window may show it.
  asm.lda(imm(1));
  asm.sta(mem(layout.scratch + FRAME_READY));
  asm.jmp("Main");
}

/**
 * Read the controller into the abstract button set, and derive this tick's edges.
 *
 * The shift register reports A, B, Select, Start, Up, Down, Left, Right in that
 * order; the abstract set is `ACTIONS` order — left right up down a b start — which
 * doc 14 §Buttons chose as the portable floor. So the read is eight rotations into
 * a byte and then a permutation, which is unrolled because it is seven bits.
 */
function emitInput(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  const raw = ZP.t0;
  asm.label("ReadInput");
  asm.lda(imm(1));
  asm.sta(abs(R.JOY1));
  asm.lda(imm(0));
  asm.sta(abs(R.JOY1));
  // Eight reads, low bit first, rotated into one byte: bit 0 ends up A, bit 7
  // Right, which is the hardware's own order.
  const loop = ctx.unique("padLoop");
  asm.lda(imm(0));
  asm.sta(mem(raw));
  asm.ldx(imm(8));
  asm.label(loop);
  asm.lda(abs(R.JOY1));
  asm.lsr();
  asm.ror(mem(raw));
  asm.dex();
  asm.bne(loop);

  // Hardware order → abstract order. `raw` holds A B Select Start Up Down Left
  // Right from bit 7 down to bit 0 after the rotations above.
  const HARDWARE = ["a", "b", "select", "start", "up", "down", "left", "right"] as const;
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

function emitTickDispatch(ctx: NesCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
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
  // The tick counter, then the handshake byte the harness watches — in that order,
  // so a reader can never see the counter half-updated.
  inc16(ctx, layout.tick);
  asm.inc(mem(layout.ready));
  asm.rts();
}

function emitSceneChange(ctx: NesCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout, program } = ctx;
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
  if (ctx.audio?.driver === true && program.tracks.length > 0) asm.jsr("SceneMusic");
  asm.jsr("ResetScene");
  if (layout.rng !== null) {
    const seed = program.seed | 0;
    for (let index = 0; index < 4; index += 1) {
      asm.lda(imm((seed >> (index * 8)) & 0xff));
      asm.sta(mem(layout.rng + index));
    }
  }
  emitClearState(ctx);
  asm.jsr("UpdateCamera");
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.rts();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request one byte: the driver
  // is serviced from the loop, and a scene change is not where it happens.
  if (ctx.audio?.driver === true && program.tracks.length > 0) {
    asm.label("SceneMusic");
    asm.ldx(mem(layout.scene));
    asm.lda(absX("SceneTracks"));
    asm.sta(mem(ctx.audio.music));
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

/**
 * The NES's instructions for each of doc 14's tick steps.
 *
 * The *order* is not here: `emitTickSteps` runs them, so this backend supplies the
 * code for a step and has no say in the sequence (`backend.ts` §The tick's).
 */
function tickSteps(ctx: NesCtx): TickSteps {
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

function emitSceneTick(ctx: NesCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jmp("TickDone");
}

function emitSceneReset(ctx: NesCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    emitCopyBlock(ctx, label(`Defaults_${id}`), layout.entities[id] as number, ENTITY_SIZE);
  }
  asm.rts();
}

function emitSceneCamera(ctx: NesCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.rts();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: NesCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: NesCtx, subjectId: number, level: LevelData): void {
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
function emitOverCells(ctx: NesCtx, subjectId: number, body: () => void): void {
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
function emitTileRules(ctx: NesCtx, scene: SceneCtx, level: LevelData): void {
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
function emitFireTileRule(ctx: NesCtx, rule: RuleDef, bind: Binding): void {
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
function emitCellId(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  asm.lda(mem(layout.words + W.tileCol * 2));
  asm.sta(mem(layout.words + W.cell * 2));
  asm.lda(mem(layout.words + W.tileRow * 2));
  asm.sta(mem(layout.words + W.cell * 2 + 1));
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: NesCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.lda(imm(0));
  asm.sta(mem(layout.tileScratch));
  asm.lda(mem(listBase));
  asm.sta(mem(layout.words + W.target * 2));
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: NesCtx): void {
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
function emitCommitContacts(ctx: NesCtx, listBase: number): void {
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
function emitTileContactHelper(ctx: NesCtx): void {
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

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: NesCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NesEmitOptions,
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
  // A level the nametable already holds whole does not scroll vertically, however
  // far the *game's* camera travels down it: the map is thirty rows and so is the
  // raster, so a scroll of even one row would bring the level's own top back in at
  // the bottom. That is what the game camera's two rows of vertical travel were
  // doing — the screen is 28 rows because the last two are overscan, and those two
  // showed the ceiling. Pinned, the same two rows show the level's real bottom,
  // which is what a television would have cropped anyway.
  if (pinsRows(level)) {
    asm.lda(imm(0));
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
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options, pinsRows(level));
  asm.rts();
}

/**
 * Whether this scene's vertical scroll is pinned, and objects with it.
 *
 * The background and the objects have to agree about where the top of the view
 * is, or a coin sits sixteen pixels off the ledge it is resting on. So the same
 * question decides both, and it is a compile-time one.
 */
function pinsRows(level: LevelData | undefined): boolean {
  return level !== undefined && !scrollsRows(level);
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: NesCtx, src: number, dst: number): void {
  const { asm } = ctx;
  // Five places right of the middle two bytes, sign-extended through the top.
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

/** Draw the whole visible window, with rendering off. */
function emitFullRedraw(
  ctx: NesCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NesEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Rendering off: the PPU's address register is the scroll position, so writing
  // a screenful with it on would tear and take three frames.
  asm.lda(imm(0));
  asm.sta(abs(R.PPUMASK));

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a whole nametable in order, so painting it is a block copy.
    emitPpuAddress(ctx, NAMETABLE);
    emitPpuBlock(ctx, backdropLabel(scene), MAP_W * MAP_H);
    emitPpuAddress(ctx, PALETTE);
    emitPpuBlock(ctx, backdropPaletteLabel(scene), 16);
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    // The attribute table stays as the boot left it: a level's tile art is fitted
    // to one background palette, because a 16×16 attribute cell covers four map
    // cells and two adjacent legend entries would otherwise fight over it.
    emitPpuAddress(ctx, PALETTE);
    emitPpuBlock(ctx, "LevelPalette", 16);
    // The window, and the one column the first scroll step will need before it has
    // had a chance to paint one — and nothing else. Painting a whole level here
    // instead would draw cells nobody has looked at yet and hold the screen off
    // while it did; the rule on both consoles is that a cell is drawn when it is
    // about to be seen.
    emitOriginFromScroll(ctx, layout.words + W.mapCol * 2, layout.words + W.mapRow * 2);
    // A level no taller than the map does not scroll vertically at all, so its rows
    // sit at their own addresses from the origin and the redraw starts at row zero.
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
    // One spare column for a level, because the first scroll step needs it; a
    // spare row only where the level is tall enough for the wrap to serve one,
    // since otherwise the row after the last *is* the first.
    const height = layout.memory.viewH + (level !== undefined && scrollsRows(level) ? 1 : 0);
    const width = layout.memory.viewW + (level === undefined ? 0 : 1);
    asm.lda(imm(height));
    asm.sta(mem(rows));
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.lda(imm(width));
    asm.sta(mem(columns));
    // The address is set once per row and the PPU steps it — the whole point of
    // an auto-incrementing port. It has to be reset where the map wraps into the
    // other nametable, because the attribute table sits between the two, so the
    // column's low five bits rolling over is the signal.
    asm.jsr("VramFor");
    asm.label(colLoop);
    emitBackgroundTile(ctx, scene, level);
    asm.sta(abs(R.PPUDATA));
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

  // The attribute table, whatever the scene drew: a picture's own, or a level's
  // single palette, with the blocks a caption covers switched to the font's ramp.
  emitPpuAddress(ctx, ATTRIBUTES);
  emitPpuBlock(ctx, sceneAttrLabel(scene), 64);

  // Captions go on now, with the background they sit on. A scrolling scene draws
  // its whole HUD with sprites instead, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  asm.lda(imm(0x1e));
  asm.sta(abs(R.PPUMASK));
}

/** Copy a compile-time block of bytes straight into the PPU. */
function emitPpuBlock(ctx: NesCtx, source: string, count: number): void {
  const { asm } = ctx;
  if (count <= 256) {
    const loop = ctx.unique("ppuBlock");
    asm.ldx(imm(0));
    asm.label(loop);
    asm.lda(absX(label(source)));
    asm.sta(abs(R.PPUDATA));
    asm.inx();
    asm.cpx(imm(count & 0xff));
    asm.bne(loop);
    return;
  }
  // Longer than an index reaches: walk it in pages through a pointer.
  const loop = ctx.unique("ppuPage");
  const page = ctx.unique("ppuPageOuter");
  const pages = Math.floor(count / 256);
  const tail = count % 256;
  ctx.pointer(ZP.p0, label(source));
  asm.ldy(imm(0));
  asm.lda(imm(pages));
  asm.sta(mem(ZP.t0));
  asm.label(page);
  asm.label(loop);
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.PPUDATA));
  asm.iny();
  asm.bne(loop);
  asm.inc(mem(ZP.p0, 1));
  asm.dec(mem(ZP.t0));
  asm.bne(page);
  if (tail > 0) {
    const rest = ctx.unique("ppuTail");
    asm.ldy(imm(0));
    asm.label(rest);
    asm.lda(indY(ZP.p0));
    asm.sta(abs(R.PPUDATA));
    asm.iny();
    asm.cpy(imm(tail));
    asm.bne(rest);
  }
}

/** The labels holding one scene's nametable, attribute table and palette. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function sceneAttrLabel(scene: SceneCtx): string {
  return `SceneAttr_${scene.index}`;
}
function backdropPaletteLabel(scene: SceneCtx): string {
  return `BackdropPal_${scene.index}`;
}

/**
 * One scene's attribute table, decided at compile time.
 *
 * A background palette covers a 16×16 block on this console, so *where* the font's
 * palette is needed is a question about cells rather than about pixels — and every
 * cell a caption occupies is known when the game is compiled. So the table is
 * built here: a picture's own attributes, or a level's single palette, with the
 * blocks a background HUD covers switched to the font's ramp.
 *
 * That is the same reservation the Game Boy Color build makes with its
 * `SYSTEM_PALETTE`, arriving a different way. There it is an attribute per cell
 * written as the cell is drawn; here it is sixty-four bytes uploaded with the
 * redraw and never touched again, which is why a HUD costs nothing per frame.
 *
 * An object whose *position* a rule can change is skipped: its blocks are not
 * knowable here, and switching a block it has left would leave the picture behind
 * it wearing the font's colours. Nothing in the example library moves a caption.
 */
function sceneAttributes(ctx: NesCtx, scene: SceneCtx, options: NesEmitOptions): Uint8Array {
  const table = new Uint8Array(64);
  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) table.set(backdrop.attr.subarray(0, 64), 0);
  if (scrolls(ctx, scene)) return table; // a scrolling scene draws its HUD with objects

  const set = (column: number, row: number): void => {
    if (column < 0 || row < 0 || column >= MAP_W || row >= MAP_H) return;
    const at = (row >> 2) * 8 + (column >> 2);
    const quadrant = ((row & 2) << 1) | (column & 2);
    table[at] = ((table[at] as number) & ~(3 << quadrant)) | (SYSTEM_PALETTE << quadrant);
  };
  for (const id of scene.def.instanceIds) {
    const instance = ctx.program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;
    if (isMutable(ctx.analysis, id, "x") || isMutable(ctx.analysis, id, "y")) continue;
    const column = Math.round((instance.numbers["x"] ?? 0) / 65536);
    const row = Math.round((instance.numbers["y"] ?? 0) / 65536);
    // A caption is as wide as its text; a counter is as wide as the decimal
    // renderer can print, which is five digits and a sign.
    const width = isText ? [...(instance.strings["text"] ?? "")].length : 6;
    for (let cell = 0; cell < width; cell += 1) set(column + cell, row);
  }
  return table;
}

/**
 * `A` = the background tile that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid and
 * through its legend, and a scene without one is blank. A backdrop scene never
 * reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: NesCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  void scene;
  if (!level) {
    asm.lda(imm(0));
    return;
  }
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/** `A = the background tile for the legend index in A`. */
function emitLegendToTile(ctx: NesCtx, level: LevelData): void {
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
function emitOriginFromScroll(ctx: NesCtx, dstCol: number, dstRow: number): void {
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
 * Bring the nametable up to date after the camera moved.
 *
 * With vertical mirroring the two nametables sit side by side, so level column `c`
 * always lives at map column `c mod 64` and row `r` at map row `r mod 30`, and the
 * scroll registers do the rest. Crossing a cell boundary therefore costs one column
 * or one row of writes, not a screen — and a jump too large to walk sets the
 * full-redraw flag instead of silently dropping cells off the end of the queue.
 */
function emitScrollUpdate(ctx: NesCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  // The vertical axis is walked only where the wrap can serve it: a level no
  // taller than the map has every row painted already, and painting a "new" row
  // would overwrite the one the top of the screen is still showing.
  if (scrollsRows(level)) {
    emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  }
  asm.jmp(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge as
 * it goes. More than four cells in a tick is a teleport, not a scroll.
 */
function emitWalkAxis(
  ctx: NesCtx,
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
function emitPaintEdge(ctx: NesCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  // A column is the height of the view plus the row the next vertical step will
  // need — but only where there *is* a next vertical step. A level the map holds
  // whole does not scroll rows, and a thirty-first row would wrap onto the first
  // and blank the top of the very column being painted.
  // A column is the height of the view plus the row the next vertical step will
  // need — but only where there *is* a next vertical step. A level the map holds
  // whole does not scroll rows, and a thirty-first write does not wrap onto the
  // first row: it lands in the attribute table, one 16×16 block of the wrong
  // palette per column the camera crosses.
  const count = isColumn
    ? layout.memory.viewH + (scrollsRows(level) ? 1 : 0)
    : layout.memory.viewW + 1;
  // Not `temp`: the grid lookup uses that word for its row-times-width multiply,
  // and a counter clobbered mid-loop paints a strip of whatever tile the count
  // happened to land on — which is how a scrolled edge came to show the font.
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
  // One run for the whole strip: a column steps a row at a time through the
  // nametable, which is what the control byte's top bit asks the flush for.
  asm.lda(imm(isColumn ? 0x80 : 0x00));
  asm.jsr("QueueOpen");
  asm.lda(imm(count));
  asm.sta(mem(remaining));
  asm.label(loop);
  asm.jsr(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  asm.jsr("QueueTile");
  inc16(ctx, along);
  asm.dec(mem(remaining));
  ctx.far("ne", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(
  ctx: NesCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NesEmitOptions,
): void {
  const { asm, layout } = ctx;
  void options;
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
  emitBackgroundTile(ctx, scene, level);
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

function emitSwapPlots(ctx: NesCtx): void {
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
function emitHud(ctx: NesCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    // The cell the object sits in; positions are level coordinates, so the wrapped
    // nametable puts it in the right place with no extra work.
    asm.lda(mem(base + propOffset("x") + 2));
    asm.sta(mem(layout.words + W.tileCol * 2));
    asm.lda(mem(base + propOffset("x") + 3));
    asm.sta(mem(layout.words + W.tileCol * 2 + 1));
    asm.lda(mem(base + propOffset("y") + 2));
    asm.sta(mem(layout.words + W.tileRow * 2));
    asm.lda(mem(base + propOffset("y") + 3));
    asm.sta(mem(layout.words + W.tileRow * 2 + 1));

    // A static object is painted straight into the PPU with rendering already off,
    // so it needs neither the write queue nor a place in the erase list.
    const plot = want === "static" ? needPokeCell(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, MAP_W)) {
        asm.lda(imm(glyphTile(character)));
        asm.jsr(plot);
      }
    } else {
      ctx.pointer(ZP.p2, base + propOffset("value") + 2);
      asm.jsr(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `A = tile`: write it at the current cell and advance the column. */
function needPokeCell(ctx: NesCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    asm.sta(mem(ZP.t2));
    asm.jsr("VramFor");
    asm.lda(mem(ZP.t2));
    asm.sta(abs(R.PPUDATA));
    inc16(inner, layout.words + W.tileCol * 2);
    asm.rts();
  });
}

/** The decimal renderer again, writing straight to the PPU. */
function needPokeNumber(ctx: NesCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeCell(inner));
  });
}

/**
 * `p0` = entity base, `t0`/`t1` = the size in cells → `A` is zero when the object
 * is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * half of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled — the test
 * may say "maybe" when the answer is no, and never the other way round.
 */
function needOnscreen(ctx: NesCtx, pinnedRows: boolean): Ref {
  // A pinned scene shows every row its level has, so there is nothing for the
  // vertical half to reject — and asking it anyway would reject the top of the
  // level, whose cells are *above* a game camera that has scrolled down.
  if (pinnedRows) {
    return ctx.need("OnscreenColumns", (inner) => emitOnscreenBody(inner, false));
  }
  return ctx.need("Onscreen", (inner) => emitOnscreenBody(inner, true));
}

/** The cull itself: the horizontal axis always, the vertical one on request. */
function emitOnscreenBody(ctx: NesCtx, rows: boolean): void {
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
    // Off the near side: the object's far edge is left of (or above) the view.
    asm.clc();
    asm.lda(mem(delta));
    asm.adc(mem(margin));
    asm.lda(mem(delta, 1));
    asm.adc(imm(0));
    ctx.far("mi", apart);
    // Off the far side: the object's near edge is past the last visible cell.
    asm.sec();
    asm.lda(mem(delta));
    asm.sbc(imm(span + 1));
    asm.lda(mem(delta, 1));
    asm.sbc(imm(0));
    ctx.far("pl", apart);
  };
  axis(propOffset("x"), ZP.t0, layout.memory.viewW);
  if (rows) axis(propOffset("y"), ZP.t1, layout.memory.viewH);

  asm.lda(imm(1));
  asm.rts();
  asm.label(apart);
  asm.lda(imm(0));
  asm.rts();
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: NesCtx, scene: SceneCtx, options: NesEmitOptions, pinnedRows = false): void {
  const { asm, layout, program } = ctx;
  asm.lda(imm(0));
  asm.sta(mem(layout.oamCount));

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;

    // The collision box is the sprite's footprint, in whole cells — *this*
    // object's box, not its class's and not the largest one the file was converted
    // at. Anything else draws ledge where nothing can be stood on.
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
      ctx.pointer(ZP.p0, base);
      asm.lda(imm(width));
      asm.sta(mem(ZP.t0));
      asm.lda(imm(height));
      asm.sta(mem(ZP.t1));
      asm.jsr(needOnscreen(ctx, pinnedRows));
      ctx.far("eq", skip);
    }
    // Screen pixels are level pixels minus the camera's.
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, base + propOffset("x"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera);
      emitPixelsFromFixed(ctx, temp, layout.words + W.temp * 2);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null && !pinnedRows) sub32(ctx, temp, layout.camera + 4);
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
 * Draw a scrolling scene's `number` and `text` objects as hardware sprites.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already wrote —
 * only the layer differs. Eight objects to a scanline is the hardware's limit
 * (doc 14 §Budgets), which is why a *long* caption in a scrolling scene is the one
 * HUD this cannot draw; a counter is one to five glyphs and fits.
 */
function emitHudSprites(ctx: NesCtx, scene: SceneCtx): void {
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
      for (const character of [...text].slice(0, MAP_W)) {
        asm.lda(imm(glyphTile(character)));
        asm.jsr(needHudGlyph(ctx));
      }
    } else {
      ctx.pointer(ZP.p2, base + propOffset("value") + 2);
      asm.jsr(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `A = tile`: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: NesCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const { asm, layout } = inner;
    asm.sta(mem(ZP.t2));
    // Same bounds rule as an object's cell: the pen is sixteen bits and a sprite's
    // position is a byte, so a glyph the screen does not hold is skipped rather
    // than wrapped. The pen still advances, so the rest of a caption lands where
    // it would have.
    const offscreen = inner.unique("hudOff");
    asm.sec();
    asm.lda(mem(layout.words + W.count * 2));
    asm.sbc(imm(1));
    asm.sta(mem(ZP.t0));
    asm.lda(mem(layout.words + W.count * 2 + 1));
    asm.sbc(imm(0));
    asm.bne(offscreen);
    asm.lda(mem(layout.words + W.temp * 2 + 1));
    asm.bne(offscreen);
    asm.lda(mem(layout.words + W.temp * 2));
    asm.sta(mem(ZP.t1));
    // The font's own palette, which stays the plain ramp: the art's own palette is
    // chosen for the art and may map the font's ink onto its lightest colour.
    asm.lda(imm(SYSTEM_PALETTE));
    asm.sta(mem(ZP.t3));
    asm.jsr(needPushSprite(inner));
    asm.label(offscreen);
    asm.clc();
    asm.lda(mem(layout.words + W.temp * 2));
    asm.adc(imm(8));
    asm.sta(mem(layout.words + W.temp * 2));
    asm.rts();
  });
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: NesCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    emitDecimal(inner, needHudGlyph(inner));
  });
}

/**
 * One cell of an object, at the pen, and only if the hardware can put it there.
 *
 * An object's position is a *screen* position and can be off either edge; a
 * sprite's is a byte and cannot. So the cell's position is computed sixteen bits
 * wide and pushed only when the high byte is zero — which is the whole of the
 * check, because both ways of failing it show up there: a negative position
 * arrives as `$FFxx` and one past the right edge as `$01xx`.
 *
 * Getting this wrong does not clip, it *wraps*: a coin one pixel off the right of
 * a scrolling level reappears inside the wall on the left, and blinks in and out
 * as the camera moves. The Game Boy is not exposed to it — 160 pixels of screen
 * against a 256-value byte leaves the wrapped positions in the hidden range — so
 * this is a real difference between the machines rather than a copy of one.
 *
 * The vertical arithmetic carries the PPU's own convention: an object is drawn on
 * the line *after* its Y, so the shadow holds the position minus one, and a cell
 * whose top row is the screen's first line is one this hardware cannot show.
 */
function emitSpriteCell(
  ctx: NesCtx,
  column: number,
  row: number,
  tile: number,
  palette: number,
): void {
  const { asm, layout } = ctx;
  const penX = layout.words + W.temp * 2;
  const penY = layout.words + W.count * 2;
  const offscreen = ctx.unique("spriteOff");
  const dx = column * 8;
  const dy = (row * 8 - 1) & 0xffff;

  asm.clc();
  asm.lda(mem(penX));
  asm.adc(imm(dx & 0xff));
  asm.sta(mem(ZP.t1));
  asm.lda(mem(penX, 1));
  asm.adc(imm((dx >> 8) & 0xff));
  asm.bne(offscreen);
  asm.clc();
  asm.lda(mem(penY));
  asm.adc(imm(dy & 0xff));
  asm.sta(mem(ZP.t0));
  asm.lda(mem(penY, 1));
  asm.adc(imm((dy >> 8) & 0xff));
  asm.bne(offscreen);
  asm.lda(imm(tile & 0xff));
  asm.sta(mem(ZP.t2));
  asm.lda(imm(palette & 0x03));
  asm.sta(mem(ZP.t3));
  asm.jsr(needPushSprite(ctx));
  asm.label(offscreen);
}

/** `t0` = y, `t1` = x, `t2` = tile, `t3` = palette; append an object entry. */
function needPushSprite(ctx: NesCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    asm.lda(mem(layout.oamCount));
    asm.cmp(imm(layout.memory.oamEntries));
    asm.bcc(room);
    asm.rts();
    asm.label(room);
    asm.asl();
    asm.asl();
    asm.tax();
    asm.lda(mem(ZP.t0));
    asm.sta(absX(layout.memory.oamShadow));
    asm.lda(mem(ZP.t2));
    asm.sta(absX(layout.memory.oamShadow + 1));
    asm.lda(mem(ZP.t3));
    asm.sta(absX(layout.memory.oamShadow + 2));
    asm.lda(mem(ZP.t1));
    asm.sta(absX(layout.memory.oamShadow + 3));
    asm.inc(mem(layout.oamCount));
    asm.rts();
  });
}

/**
 * Park the entries that are no longer in use.
 *
 * Only the ones *this* frame vacated need clearing: everything above last frame's
 * high-water mark is already parked. Parking means Y = $FF, which is below the
 * visible area — an object at the top left would be a visible artefact.
 */
function needClearRestOfOam(ctx: NesCtx): Ref {
  return ctx.need("ClearRestOfOam", (inner) => {
    const { asm, layout } = inner;
    const sweep = inner.unique("oamSweep");
    const step = inner.unique("oamStep");
    asm.lda(mem(layout.oamCount));
    asm.cmp(mem(layout.oamPrev));
    asm.bcc(sweep);
    // Nothing was vacated; this frame's count becomes the mark to clear against.
    asm.sta(mem(layout.oamPrev));
    asm.rts();
    asm.label(sweep);
    // From this frame's count up to last frame's, four bytes an entry. Both are
    // scaled here rather than compared as entry numbers, because the index is what
    // walks the shadow.
    asm.asl();
    asm.asl();
    asm.tax();
    asm.lda(mem(layout.oamPrev));
    asm.asl();
    asm.asl();
    asm.sta(mem(ZP.t0));
    asm.lda(mem(layout.oamCount));
    asm.sta(mem(layout.oamPrev));
    asm.label(step);
    // `$FF` is below the visible area, which is how an unused entry is parked; an
    // entry left at zero would draw a sprite in the top-left corner.
    asm.lda(imm(0xff));
    asm.sta(absX(layout.memory.oamShadow));
    asm.inx();
    asm.inx();
    asm.inx();
    asm.inx();
    asm.cpx(mem(ZP.t0));
    asm.bne(step);
    asm.rts();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  // The queue is a byte stream of runs rather than a list of cells, so its size is
  // the bytes the plan allowed for it. A scrolled column is one run of thirty-one
  // tiles — thirty-four bytes — where a cell at a time would have been ninety-three
  // and would not have fitted beside the row a diagonal scroll also paints.
  const QUEUE_BYTES = layout.memory.queueMax * layout.queueStride;
  // Where the open run's control byte sits, so appending can count it. A render
  // word rather than page zero, because the grid lookup between two appends uses
  // every byte of the helper scratch.
  const runIndex = layout.words + W.cell * 2;

  // Point PPUADDR at the cell in words[tileCol]/words[tileRow]. The map wraps
  // every 64 columns and every 30 rows, and the column's bit 5 chooses which of
  // the two nametables the cartridge's vertical mirroring puts side by side.
  asm.label("VramFor");
  emitCellAddress(ctx);
  asm.lda(mem(ZP.t1));
  asm.sta(abs(R.PPUADDR));
  asm.lda(mem(ZP.t0));
  asm.sta(abs(R.PPUADDR));
  asm.rts();

  // Open a run at the current cell. `A` is zero for a run that steps one cell to
  // the right and `$80` for one that steps a row down — which is what makes a
  // scrolled column thirty-four bytes of queue instead of ninety-three, and a
  // handful of cycles a cell in the vertical blank instead of a dozen.
  asm.label("QueueOpen");
  const noRoomForRun = ctx.unique("queueRunFull");
  asm.sta(mem(ZP.t3));
  asm.lda(mem(layout.queueCount));
  asm.cmp(imm(QUEUE_BYTES - 3));
  asm.bcc(noRoomForRun);
  // No room for even an empty run: repaint the whole background next frame rather
  // than leave a strip of it stale for ever.
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
  // Remember where this run's control byte is, so appending can count it.
  asm.lda(mem(layout.queueCount));
  asm.sta(mem(runIndex));
  asm.clc();
  asm.adc(imm(3));
  asm.sta(mem(layout.queueCount));
  asm.rts();

  // `A` = a tile: append it to the open run.
  asm.label("QueueTile");
  const roomForTile = ctx.unique("queueTileRoom");
  asm.sta(mem(ZP.t2));
  asm.lda(mem(layout.queueCount));
  asm.cmp(imm(QUEUE_BYTES));
  asm.bcc(roomForTile);
  asm.lda(imm(1));
  asm.sta(mem(layout.redraw));
  asm.rts();
  asm.label(roomForTile);
  asm.ldx(mem(layout.queueCount));
  asm.lda(mem(ZP.t2));
  asm.sta(absX(layout.queue));
  asm.inc(mem(layout.queueCount));
  asm.ldx(mem(runIndex));
  asm.inc(absX(layout.queue + 2));
  asm.rts();

  // A = tile; queue it as a run of one, record the cell for erasing, and advance
  // the column. The HUD is scattered cells rather than a strip, so each is its own
  // run — four bytes against a strip's one, and there are never many of them.
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

  // Flush the queue, hand the objects to the DMA, and set the scroll. All three
  // fit inside the vertical blank by construction: the queue is capped at what one
  // will hold and anything over sets the redraw flag instead of being dropped.
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const runLoop = ctx.unique("runLoop");
  const tileLoop = ctx.unique("tileLoop");
  asm.lda(mem(layout.queueCount));
  asm.beq(noQueue);
  ctx.pointer(ZP.p0, layout.queue);
  asm.lda(imm(0));
  asm.sta(mem(ZP.t0)); // bytes consumed
  asm.label(runLoop);
  // The control byte decides the address step, which is bit 2 of PPUCTRL.
  asm.ldy(imm(2));
  asm.lda(indY(ZP.p0));
  asm.sta(mem(ZP.t1));
  asm.and(imm(0x80));
  const acrossRun = ctx.unique("runAcross");
  asm.beq(acrossRun);
  asm.lda(imm(0x8c));
  const setStep = ctx.unique("runStep");
  asm.bne(setStep);
  asm.label(acrossRun);
  asm.lda(imm(0x88));
  asm.label(setStep);
  asm.sta(abs(R.PPUCTRL));
  asm.ldy(imm(1));
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.PPUADDR));
  asm.ldy(imm(0));
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.PPUADDR));
  // Three bytes of header plus the run's tiles is both where the tile loop stops
  // and how far the next run is.
  asm.clc();
  asm.lda(mem(ZP.t1));
  asm.and(imm(0x7f));
  asm.adc(imm(3));
  asm.sta(mem(ZP.t3));
  asm.ldy(imm(3));
  asm.label(tileLoop);
  asm.lda(indY(ZP.p0));
  asm.sta(abs(R.PPUDATA));
  asm.iny();
  asm.cpy(mem(ZP.t3));
  asm.bne(tileLoop);
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
  asm.label(noQueue);
  // Objects: 256 bytes out of the shadow page, which costs 513 cycles.
  asm.lda(imm(0));
  asm.sta(abs(R.OAMADDR));
  asm.lda(imm(layout.memory.oamShadow >> 8));
  asm.sta(abs(R.OAMDMA));
  // The scroll goes last, because writing PPUADDR above left the PPU's address
  // register pointing into the nametable — and that register *is* the scroll
  // position. PPUCTRL first, since the horizontal nametable is one of its bits.
  asm.lda(mem(layout.words + W.scrollX * 2 + 1));
  asm.and(imm(1));
  asm.ora(imm(0x88));
  asm.sta(abs(R.PPUCTRL));
  asm.lda(mem(layout.words + W.scrollX * 2));
  asm.sta(abs(R.PPUSCROLL));
  // The vertical scroll wraps at 240 rather than 256, because the last two rows of
  // a nametable are its attribute table — the same thirty the cell address wraps
  // at, and for the same reason.
  const wrapped = ctx.unique("scrollWrap");
  const wrapDone = ctx.unique("scrollWrapDone");
  const wrapSub = ctx.unique("scrollSub");
  copy16(ctx, ZP.spare, layout.words + W.scrollY * 2);
  asm.label(wrapped);
  asm.lda(mem(ZP.spare, 1));
  asm.bne(wrapSub);
  asm.lda(mem(ZP.spare));
  asm.cmp(imm(MAP_H * 8));
  asm.bcc(wrapDone);
  asm.label(wrapSub);
  asm.sec();
  asm.lda(mem(ZP.spare));
  asm.sbc(imm(MAP_H * 8));
  asm.sta(mem(ZP.spare));
  asm.lda(mem(ZP.spare, 1));
  asm.sbc(imm(0));
  asm.sta(mem(ZP.spare, 1));
  asm.jmp(wrapped);
  asm.label(wrapDone);
  asm.lda(mem(ZP.spare));
  asm.sta(abs(R.PPUSCROLL));
  asm.rts();

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell");

  emitDecimalPowers(ctx);
}

/**
 * `t0`/`t1` = the PPU address of the cell in words[tileCol]/words[tileRow].
 *
 * The wrap is the whole of NES scrolling: with the cartridge wired for vertical
 * mirroring the two nametables are side by side, so a level column lands at
 * `column mod 64` and bit 5 of that picks the table. Rows wrap at 30, because the
 * last two rows of a nametable are its attribute table.
 */
function emitCellAddress(ctx: NesCtx): void {
  const { asm, layout } = ctx;
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  // Only `t0`/`t1` and the spare word: a caller may be holding the tile it is
  // about to write in `t2`, which is exactly the mistake that would make every
  // cell of a redraw draw the same pattern.
  const work = ZP.spare;

  // row mod 30. Thirty does not divide 256, so the high byte matters and this
  // cannot be a mask the way the column can — it is a subtraction loop, and a
  // level is never more than a few multiples of thirty tall.
  const rowLoop = ctx.unique("rowMod");
  const rowDone = ctx.unique("rowModDone");
  const subtract = ctx.unique("rowSub");
  copy16(ctx, work, row);
  asm.label(rowLoop);
  asm.lda(mem(work, 1));
  asm.bne(subtract);
  asm.lda(mem(work));
  asm.cmp(imm(MAP_H));
  asm.bcc(rowDone);
  asm.label(subtract);
  asm.sec();
  asm.lda(mem(work));
  asm.sbc(imm(MAP_H));
  asm.sta(mem(work));
  asm.lda(mem(work, 1));
  asm.sbc(imm(0));
  asm.sta(mem(work, 1));
  asm.jmp(rowLoop);
  asm.label(rowDone);

  // address = row * 32, which is a shift of five through two bytes.
  asm.lda(mem(work));
  asm.sta(mem(ZP.t0));
  asm.lda(imm(0));
  asm.sta(mem(ZP.t1));
  for (let shift = 0; shift < 5; shift += 1) {
    asm.asl(mem(ZP.t0));
    asm.rol(mem(ZP.t1));
  }
  // `column mod 64` *is* a mask, because 64 divides 256: the high byte can only
  // contribute a multiple of it. The low five bits are the cell within a
  // nametable and bit 5 chooses which of the two the mirroring puts beside it.
  asm.lda(mem(col));
  asm.and(imm(MAP_W - 1));
  asm.clc();
  asm.adc(mem(ZP.t0));
  asm.sta(mem(ZP.t0));
  asm.lda(mem(ZP.t1));
  asm.adc(imm(0));
  asm.ora(imm(NAMETABLE >> 8));
  asm.sta(mem(ZP.t1));
  asm.lda(mem(col));
  asm.and(imm(MAP_W));
  const oneTable = ctx.unique("sameTable");
  asm.beq(oneTable);
  asm.lda(mem(ZP.t1));
  asm.ora(imm(0x04));
  asm.sta(mem(ZP.t1));
  asm.label(oneTable);
}

/**
 * Draw the signed 16-bit value `p2` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is the
 * *only* difference between the background HUD and the sprite one — which is why it
 * is a parameter rather than a second copy of the digit loop. Leading zeroes are
 * suppressed and a lone zero still prints.
 */
function emitDecimal(ctx: NesCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine, the write queue and the object builder — which between them
  // use every byte of the helper scratch in page zero. So the digit loop keeps its
  // state in the render words instead, in slots nothing on that path touches: not
  // the pen (`temp`, `count`), not the cell being written (`tileCol`, `tileRow`),
  // and not the scroll the frame is about to be uploaded with.
  const value = layout.words + W.target * 2; // the number being consumed
  const flag = layout.words + W.cell * 2; // whether a significant digit has been seen
  const digit = layout.words + W.cell * 2 + 1;
  const power = layout.words + W.firstCol * 2; // index into the table of powers

  asm.ldy(imm(0));
  asm.lda(indY(ZP.p2));
  asm.sta(mem(value));
  asm.iny();
  asm.lda(indY(ZP.p2));
  asm.sta(mem(value, 1));

  const positive = ctx.unique("numPos");
  asm.lda(mem(value, 1));
  ctx.far("pl", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.sec();
  asm.lda(imm(0));
  asm.sbc(mem(value));
  asm.sta(mem(value));
  asm.lda(imm(0));
  asm.sbc(mem(value, 1));
  asm.sta(mem(value, 1));
  asm.lda(imm(glyphTile("-")));
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
  // value -= power, keeping it only while it does not go negative.
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
  asm.adc(imm(glyphTile("0")));
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
function emitDecimalPowers(ctx: NesCtx): void {
  ctx.asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) ctx.asm.dw(power);
}
