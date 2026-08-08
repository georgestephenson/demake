/**
 * The whole-program emitter for the Neo Geo Pocket Color: boot, the frame, the
 * renderer.
 *
 * Everything here is per *scene*, for the reason every other backend gives: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and five differences are load-bearing:
 *
 *   - **There is no video memory.** The two scroll maps, the character bank, the
 *     object table and the palettes are ordinary addresses in the same space the
 *     variables are in, so nothing is uploaded through a port and there is no
 *     control-word protocol to get half-written. A tile bank reaches the display
 *     by `ldir`, and a cell is one store. This is the WonderSwan's arrangement
 *     one console along, and it deletes about a third of what the Mega Drive's
 *     emitter is.
 *   - **The map is bigger than the screen on both axes, and both wraps are a
 *     byte.** Thirty-two cells square against a twenty-by-nineteen window, so a
 *     scrolling scene paints its leading edge where nobody is looking — and the
 *     plane is exactly 256 pixels on both axes, so the scroll registers *are*
 *     the wrap. The Master System's seam mask and the Mega Drive's `and` are
 *     both absent.
 *   - **A cell carries its own palette**, four bits of the map word, so there is
 *     no attribute table and no 16×16 block to reason about — the PC Engine's
 *     arrangement. The shared level tables' "tile" byte is the low byte of that
 *     word and its "attribute" byte is the high one, which carries the palette,
 *     both flips and the tile's ninth bit.
 *   - **An object is one 8×8 tile and it has no link.** Sixty-four fixed entries
 *     of four bytes; an entry is hidden by setting its priority to zero rather
 *     than by cutting a chain or parking it off screen. And **the per-line budget
 *     is the whole table** — sixty-four — which no other 8-bit console in this
 *     project can say, so a wide object costs entries and never gets clipped
 *     mid-line.
 *   - **An object can sit between the two planes.** Priority one is behind both,
 *     two is between them and three is in front, so the HUD's sprites go in
 *     front of everything while the game's objects sit where the scene wants
 *     them.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 */

import {
  label,
  NGP_BGC,
  NGP_BUTTON_BITS,
  NGP_BUTTONS,
  NGP_CHARACTERS,
  NGP_CONTROL,
  NGP_MODE,
  NGP_PALETTE,
  NGP_PALETTE_STRIDE,
  NGP_PLANE_PRIORITY,
  NGP_PLANE1,
  NGP_PLANE2,
  NGP_PO_H,
  NGP_PO_V,
  NGP_S1SO_H,
  NGP_S1SO_V,
  NGP_SPRITE_PALETTES,
  NGP_SPRITES,
  NGP_VECTOR_VBLANK,
  NGP_WBA_H,
  NGP_WBA_V,
  NGP_WSI_H,
  NGP_WSI_V,
  type Ref,
} from "@demake/core";

import { AUDIO_STOP, type NgpGameAudio } from "@demake/audio";

import type { InstanceDef, RuleDef } from "../../program.js";
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
  scrolls,
  sideMask,
  tileCellsCacheable,
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { NgpcCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { at as based, postinc } from "./ops.js";
import {
  CELL_OFFSET,
  emitAssignments,
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
  emitSound,
  S,
} from "./rules.js";
import {
  collectLevels,
  copy16,
  dec16,
  emitLevelData,
  emitRuleTileTable,
  emitTableLookup,
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
import { at, branchZero32, copy32, sub32 } from "./val.js";

/** Where a cartridge's code starts: the first byte after the header. */
export const CODE_ORIGIN = 0x200040;

/** Cells across and down a scroll plane. Both are powers of two. */
export const MAP_W = 32;
export const MAP_H = 32;

/**
 * Tiles a build may use.
 *
 * The character bank is eight kilobytes of 2bpp 8×8 patterns, so five hundred
 * and twelve of them — shared between the planes and the objects, because there
 * is no second bank. The picture and its sprites therefore come out of one
 * budget, which is the Master System's arrangement rather than the Game Boy
 * Advance's.
 */
export const BANK_TILES = 512;

/** Bytes one 8×8 tile at 2bpp occupies. */
export const TILE_BYTES = 16;

/**
 * Sub-palettes the art may use on each layer, and the one it may not.
 *
 * Sixteen four-entry palettes per layer, of which the last is the system's: a
 * plain ramp the font, the built-in patterns and the placeholder block draw
 * with. Reserving it is what stops a caption being written in the colour of the
 * title screen it sits on — the Game Boy Color's reservation, reached by
 * different hardware.
 */
export const ART_PALETTES = 15;

/** The palette every built-in pattern and every glyph is drawn in. */
export const SYSTEM_PALETTE = 15;

/**
 * A cell of a scroll plane's map.
 *
 * Nine bits of tile and four of palette, which is why a cell is one word store
 * and there is no attribute table anywhere in this backend — the PC Engine's
 * arrangement and the WonderSwan's, reached again. The two bits between them are
 * the horizontal and vertical flips, which this backend does not use: the art
 * path interns a mirrored tile rather than asking the hardware for one, so that
 * an object drawn from the same bank gets the same answer.
 */
export function mapWord(tile: number, palette: number): number {
  return (tile & 0x1ff) | ((palette & 0x0f) << 9);
}

/** The palette bits of a cell word drawn in the system palette. */
const SYSTEM_CELL = mapWord(0, SYSTEM_PALETTE);

/**
 * Which of the three sixteen-palette blocks belongs to each layer.
 *
 * A palette per *layer* rather than a shared pool, so an object and a background
 * cell can never compete for one — which is why `ngpc-art.ts` fits the objects
 * and the picture against their own sixteen apiece rather than partitioning one
 * set between them. Both are read there and the block boundaries are what the
 * upload walks past, so they are stated here beside the map word they pair with.
 */
export const PALETTE_SPRITES = 0;
export const PALETTE_PLANE1 = 1;
export const PALETTE_PLANE2 = 2;

/** Palette blocks the hardware has, and therefore the ones a build fills. */
export const PALETTE_BLOCKS = 3;

/** Object priorities: hidden, behind both planes, between them, in front. */
const PRIORITY_HIDDEN = 0;
const PRIORITY_FRONT = 3;

/** Where the frame flag the handler sets and the loop waits on lives. */
function frameFlag(ctx: NgpcCtx): number {
  return ctx.layout.interrupt as number;
}

/** Everything the emitter needs beyond the program itself. */
export interface NgpcEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette: number }>;
  /** Demade backdrops by scene name: the map the picture fills. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The 2bpp tile bank, copied into the character bank at boot. */
  bank?: Uint8Array;
  /** Palette RAM as the art chose it: RGB444 words, little-endian. */
  palette?: Uint8Array;
  /** Per-scene palette RAM, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
  /** Driver index of each of the program's sounds, or `-1` when unsupplied. */
  effectIndices?: readonly number[];
  /** Which track each scene plays, as an index into the driver's table. */
  sceneTracks?: readonly number[];
  /**
   * The game's audio driver, already built from its demade tracks and effects.
   *
   * Absent for a game with no audio, and then the cartridge is exactly what it
   * was before this console had a driver: the rules still record what they asked
   * for, because that is a field of the trace.
   */
  audio?: NgpGameAudio;
}

/**
 * Dispatch on the running scene, through a table.
 *
 * A chain of comparisons is what the 8-bit backends emit; here a jump table is
 * both shorter and the form that always reaches, because a scene's tick routine
 * can be anywhere in a 512 KiB cartridge.
 */
function emitSceneDispatch(ctx: NgpcCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.jp(label(labels[0] as string));
    return;
  }
  const table = ctx.unique("sceneTable");
  asm.ldn("xwa", 0);
  asm.ldm("a", at(layout.scene));
  asm.shift("sla", 2, "xwa");
  asm.ldn("xhl", label(table));
  asm.alu("add", "xhl", "xwa");
  asm.ldm("xhl", based("xhl"));
  asm.jpm("t", based("xhl"));
  ctx.data((data) => {
    data.label(table);
    for (const target of labels) data.dd(label(target));
  });
}

/** Emit the whole program. */
export function emitProgram(ctx: NgpcCtx, options: NgpcEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx, options);
  emitVint(ctx);
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
      // A legend entry with no art draws a built-in pattern, in the system
      // palette — which is where every built-in tile's colours are.
      if (bound) return mapWord(bound.tile, bound.palette);
      return mapWord(patternTile(index, level.file.tiles[index]?.solid ?? false), SYSTEM_PALETTE);
    };
    // The two tables the shared emitter writes are exactly the low and high
    // bytes of a map word, which is what makes a cell one store rather than an
    // assembly of fields.
    emitLevelData(
      asm,
      level,
      (index) => boundTile(index) & 0xff,
      (index) => (boundTile(index) >> 8) & 0xff,
    );
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
      // As the art path packed it. Packing it again here encodes the *stream*
      // as a run of literal cells, which the blit then unpacks into the plane
      // verbatim: a title screen that boots as its own compression format
      // (AGENTS.md §The V30MZ half, where this happened once already).
      asm.bytes(art.map);
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
  asm.bytes(options.palette ?? defaultPalette());
}

/**
 * The palette RAM a build with no demade art uses.
 *
 * Three blocks of sixteen four-entry palettes, RGB444 and little-endian, of
 * which only the system palette's four entries are anything but black: a rising
 * ramp, so a caption and a placeholder block are legible with nothing else
 * copied in.
 */
function defaultPalette(): Uint8Array {
  const bytes = new Uint8Array(PALETTE_BLOCKS * NGP_PALETTE_STRIDE);
  const ramp = [0x000, 0x555, 0xaaa, 0xfff];
  for (let block = 0; block < PALETTE_BLOCKS; block += 1) {
    const base = block * NGP_PALETTE_STRIDE + SYSTEM_PALETTE * 8;
    for (const [index, colour] of ramp.entries()) {
      bytes[base + index * 2] = colour & 0xff;
      bytes[base + index * 2 + 1] = (colour >> 8) & 0x0f;
    }
  }
  return bytes;
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: NgpcCtx, options: NgpcEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.di();
  asm.ldn("xsp", layout.memory.heapEnd);

  // Clear the RAM a cartridge owns, so a game's state starts from zero rather
  // than from whatever powered up. The boot ROM's own page above it is left
  // alone except for the one vector installed below.
  emitFill(ctx, layout.memory.heapStart, layout.memory.heapEnd - layout.memory.heapStart, 0);

  // The display controller. Everything here is a plain store: there is no port
  // and no control word, which is the whole of why this boot is short.
  asm.stmi(at(NGP_MODE), "b", 0x00); // the Color's palettes rather than the mono ramps
  asm.stmi(at(NGP_WBA_H), "b", 0);
  asm.stmi(at(NGP_WBA_V), "b", 0);
  asm.stmi(at(NGP_WSI_H), "b", layout.memory.viewW * 8);
  asm.stmi(at(NGP_WSI_V), "b", layout.memory.viewH * 8);
  asm.stmi(at(NGP_PLANE_PRIORITY), "b", 0x00); // plane one in front of plane two
  asm.stmi(at(NGP_PO_H), "b", 0);
  asm.stmi(at(NGP_PO_V), "b", 0);
  asm.stmi(at(NGP_CONTROL), "b", 0x00); // out-of-window colour: entry zero
  asm.stmi(at(NGP_BGC), "b", 0x80); // the backdrop is on, and it is entry zero

  emitTileUpload(ctx, options.bank?.length ?? 0);
  emitPaletteUpload(ctx, "Palette");
  // Both maps at once, because plane two follows plane one — and plane two is
  // then never written again: every cell of it stays tile zero, whose pixels are
  // index 0 and therefore transparent, so the backdrop shows through it.
  emitFill(ctx, NGP_PLANE1, NGP_PLANE2 - NGP_PLANE1 + MAP_W * MAP_H * 2, 0);
  emitHideAllSprites(ctx);

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

  asm.stmi(at(layout.tick), "w", 0);
  for (const address of [
    layout.ready,
    layout.booted,
    layout.held,
    layout.pressed,
    layout.released,
    layout.plotCount,
    layout.plotPrevCount,
    layout.queueCount,
    frameFlag(ctx),
  ]) {
    asm.stmi(at(address), "b", 0);
  }
  asm.stmi(at(layout.oamPrev), "b", layout.memory.oamEntries);
  asm.stmi(at(layout.pending), "b", 0xff);
  asm.stmi(at(layout.scene), "b", sceneIndexOf(program, program.entryScene));
  asm.stmi(at(layout.redraw), "b", 1);
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.call(label("ResetScene"));
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.stmi(at(layout.camera), "w", 0);
    asm.stmi(at(layout.camera + 2), "w", 0);
    asm.stmi(at(layout.camera + 4), "w", 0);
    asm.stmi(at(layout.camera + 6), "w", 0);
  }
  asm.call(label("BuildFrame"));
  asm.call(label("UploadFrame"));

  // The handler goes in last, so nothing above it can be interrupted, and it is
  // a *pointer in RAM* rather than a vector in the processor's own table: the
  // boot ROM owns that one and dispatches through this.
  if (options.audio) {
    asm.call(label("AudioInit"));
    if (program.tracks.length > 0) asm.call(label("SceneMusic"));
  }

  asm.ldn("xwa", label("Vint"));
  asm.stm(at(NGP_VECTOR_VBLANK), "xwa");
  asm.stmi(at(layout.booted), "b", 1);
  asm.ei(0);
  asm.jp(label("Main"));
}

/**
 * The vertical interrupt, and the whole of what it does: say that the frame
 * happened.
 *
 * The upload is the main loop's, exactly as on the other consoles, so the loop
 * owns the scratch the renderer uses and no interrupt can arrive in the middle
 * of a tick's use of it.
 */
function emitVint(ctx: NgpcCtx): void {
  const { asm } = ctx;
  asm.label("Vint");
  asm.pushReg("xwa");
  asm.stmi(at(frameFlag(ctx)), "b", 1);
  asm.popReg("xwa");
  asm.reti();
}

/** Fill a run of memory with one byte. */
function emitFill(ctx: NgpcCtx, dest: number, bytes: number, value: number): void {
  const { asm } = ctx;
  if (bytes <= 0) return;
  // The first byte is stored and the rest copied from it, which is what makes a
  // fill one `ldir` rather than a loop of stores.
  asm.stmi(at(dest), "b", value);
  if (bytes === 1) return;
  asm.ldn("xhl", dest);
  asm.ldn("xde", dest + 1);
  asm.ldn("bc", bytes - 1);
  asm.ldir(based("xde"), "b");
}

/** Copy the tile bank from the cartridge into the character bank. */
function emitTileUpload(ctx: NgpcCtx, bytes: number): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  asm.ldn("xhl", label("TileBank"));
  asm.ldn("xde", NGP_CHARACTERS);
  asm.ldn("bc", bytes);
  asm.ldir(based("xde"), "b");
}

/** Copy all three palette blocks: sprites, plane one, plane two. */
function emitPaletteUpload(ctx: NgpcCtx, source: string): void {
  const { asm } = ctx;
  asm.ldn("xhl", label(source));
  asm.ldn("xde", NGP_PALETTE);
  asm.ldn("bc", PALETTE_BLOCKS * NGP_PALETTE_STRIDE);
  asm.ldir(based("xde"), "b");
}

/**
 * Hide every object.
 *
 * A priority of zero is what stops the hardware drawing an entry, so a table
 * whose priorities are all zero draws nothing — there is no link to cut and
 * nothing to park off screen.
 */
function emitHideAllSprites(ctx: NgpcCtx): void {
  emitFill(ctx, NGP_SPRITES, ctx.layout.memory.oamEntries * 4, 0);
  emitFill(ctx, NGP_SPRITE_PALETTES, ctx.layout.memory.oamEntries, 0);
}

/** Copy an entity's defaults from the cartridge into work RAM. */
function emitCopyBlock(ctx: NgpcCtx, source: Ref, dest: number, bytes: number): void {
  const { asm } = ctx;
  asm.ldn("xhl", source);
  asm.ldn("xde", dest);
  asm.ldn("bc", bytes);
  asm.ldir(based("xde"), "b");
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: NgpcCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  asm.ldn("xwa", program.seed >>> 0);
  asm.stm(at(layout.rng), "xwa");
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.stmi(at(layout.contacts + index), "b", 0);
    asm.stmi(at(layout.contactsPrev + index), "b", 0);
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) {
    asm.stmi(at(layout.holdFlags + index), "b", 0);
  }
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) {
    asm.stmi(at(layout.reachFlags + index), "b", 0);
  }
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.stmi(at(layout.tileContacts + index * layout.tileContactStride), "b", 0);
    }
  }
}

function emitMainLoop(ctx: NgpcCtx, audio: boolean): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half
  // rate.
  asm.label("Main");
  asm.label(wait);
  asm.aluMemImm("cp", at(frameFlag(ctx)), "b", 0);
  ctx.far("z", wait);
  asm.stmi(at(frameFlag(ctx)), "b", 0);
  asm.call(label("UploadFrame"));
  if (audio) {
    // The frame the loop just waited for, counted before anything else spends
    // it — and the ticks it owes performed *outside* the blanking interval,
    // which belongs to the picture. `AudioFrame` is not in the handler for that
    // reason: the handler's whole job is to say the frame happened.
    asm.call(label("AudioFrame"));
    asm.call(label("AudioService"));
  }
  asm.call(label("ReadInput"));
  asm.call(label("Tick"));
  asm.call(label("BuildFrame"));
  asm.jp(label("Main"));
}

/**
 * Read the controller into the abstract button set, and derive this tick's
 * edges.
 *
 * The console keeps the controller in one byte of the boot ROM's page, so the
 * read is a load and seven bit tests. **Which bit is which is unverified** —
 * `NGP_BUTTON_BITS` is the one place it is written down and the reason is stated
 * there.
 */
function emitInput(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  asm.label("ReadInput");
  asm.ldm("c", at(NGP_BUTTONS));
  asm.ldn("b", 0);

  // The abstract set is `ACTIONS` order — left right up down a b start — which
  // doc 14 §Buttons chose as the portable floor. This console has no separate
  // start, so Option stands in for it.
  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  for (const [to, action] of ABSTRACT.entries()) {
    const from = NGP_BUTTON_BITS[action === "start" ? "option" : action];
    if (from === undefined) continue;
    const skip = ctx.unique("padSkip");
    asm.bit(from, "c");
    ctx.far("z", skip);
    asm.set(to, "b");
    asm.label(skip);
  }

  // held → pressed and released, against last tick's set.
  asm.ldm("d", at(layout.held));
  asm.stm(at(layout.held), "b");
  asm.ld("e", "d");
  asm.cpl("e");
  asm.alu("and", "e", "b");
  asm.stm(at(layout.pressed), "e");
  asm.ld("e", "b");
  asm.cpl("e");
  asm.alu("and", "e", "d");
  asm.stm(at(layout.released), "e");
  asm.ret();
}

function emitTickDispatch(ctx: NgpcCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) asm.stmi(at(layout.sound), "b", 0xff);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.call(label("SceneChange"));
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  asm.incMem(1, at(layout.tick), "w");
  asm.incMem(1, at(layout.ready), "b");
  asm.ret();
}

function emitSceneChange(ctx: NgpcCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout, program } = ctx;
  const audio = ctx.audio?.driver === true && program.tracks.length > 0;
  asm.label("SceneChange");
  const go = ctx.unique("changeGo");
  asm.aluMemImm("cp", at(layout.pending), "b", 0xff);
  ctx.far("nz", go);
  asm.ret();
  asm.label(go);
  asm.ldm("a", at(layout.pending));
  asm.stm(at(layout.scene), "a");
  asm.stmi(at(layout.pending), "b", 0xff);
  if (audio) asm.call(label("SceneMusic"));
  asm.call(label("ResetScene"));
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.call(label("UpdateCamera"));
  asm.stmi(at(layout.redraw), "b", 1);
  asm.ret();

  // Music follows the scene, so it starts where the scene does. Asking for it
  // rather than starting it here is what keeps the request one byte: the driver
  // is serviced from the loop, and a scene change is not where it happens.
  if (audio) {
    asm.label("SceneMusic");
    asm.ldn("xwa", 0);
    asm.ldm("a", at(layout.scene));
    asm.ldn("xhl", label("SceneTracks"));
    asm.alu("add", "xhl", "xwa");
    asm.ldm("a", based("xhl"));
    asm.stm(at(ctx.audio?.music as number), "a");
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

/** This console's instructions for each of doc 14's tick steps. */
function tickSteps(ctx: NgpcCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.stmi(at(layout.contacts + index), "b", 0);
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.ldm("a", at(layout.contacts + index));
        asm.stm(at(layout.contactsPrev + index), "a");
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: NgpcCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.jp(label("TickDone"));
}

function emitSceneReset(ctx: NgpcCtx, scene: SceneCtx): void {
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
  asm.ret();
}

function emitSceneCamera(ctx: NgpcCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.ret();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: NgpcCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: NgpcCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.stmi(at(list), "b", 0);
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.aluImm("cp", "xwa", GRID_EMPTY);
    ctx.far("z", next);
    asm.ld("xiy", "xwa"); // the legend index, held across the arithmetic
    asm.ldm("a", at(list));
    asm.aluImm("cp", "a", TILE_CONTACT_MAX);
    ctx.far("uge", next);
    // The entry is five bytes: the column, the row, and the legend index.
    asm.ldn("xwa", 0);
    asm.ldm("a", at(list));
    asm.ld("xbc", "xwa");
    asm.shift("sla", 2, "xbc");
    asm.alu("add", "xbc", "xwa");
    asm.ldn("xhl", list + 1);
    asm.alu("add", "xhl", "xbc");
    asm.ldm("wa", at(col));
    asm.stm(based("xhl"), "wa");
    asm.ldm("wa", at(row));
    asm.stm(based("xhl", 2), "wa");
    // The legend index comes back down through `XWA`: the index registers have
    // no byte name this encoder will take, so a long move is how a byte held in
    // one is reached.
    asm.ld("xwa", "xiy");
    asm.stm(based("xhl", 4), "a");
    asm.incMem(1, at(list), "b");
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `XWA`. */
function emitOverCells(ctx: NgpcCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.aluMemImm("cp", at(list), "b", 0);
  ctx.far("z", done);
  asm.stmi(at(cursor), "w", 0);
  asm.label(loop);
  asm.ldn("xhl", list + 1);
  asm.ldm("wa", at(cursor));
  asm.extz("xwa");
  asm.alu("add", "xhl", "xwa");
  asm.ldm("wa", based("xhl"));
  asm.stm(at(col), "wa");
  asm.ldm("wa", based("xhl", 2));
  asm.stm(at(row), "wa");
  asm.ldn("xwa", 0);
  asm.ldm("a", based("xhl", 4));
  body();
  // Five bytes on, and stop when the count is reached. The cursor is in memory
  // because a rule body uses every register there is.
  asm.ldm("hl", at(cursor));
  asm.aluImm("add", "hl", 5);
  asm.stm(at(cursor), "hl");
  asm.ldn("xwa", 0);
  asm.ldm("a", at(list));
  asm.ld("xbc", "xwa");
  asm.shift("sla", 2, "xbc");
  asm.alu("add", "xbc", "xwa");
  asm.aluMem("cp", "bc", at(cursor));
  ctx.far("nz", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: NgpcCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.aluImm("cp", "xwa", GRID_EMPTY);
        ctx.far("z", next);
        // Is this legend entry one the rule names?
        ctx.scoped(() => {
          asm.ld("xiy", "xwa");
          emitTableLookup(ctx, ruleTileTableLabel(rule, level));
          asm.alu("or", "a", "a");
          asm.ld("xwa", "xiy");
        });
        ctx.far("z", next);

        // A side the rule did not name is a contact that never happened: it
        // does not fire and it is not recorded either, so next tick's "was this
        // seen before" answers as the interpreter's does (`sim.ts`
        // §resolveTiles). Separation is unaffected — what can hold an object up
        // is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.aluImm("and", "a", mask);
          ctx.far("z", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.ldn("xiy", listBase + 1);
          asm.ldm("b", at(listBase));
          asm.call(label("TileContactSeen"));
          ctx.far("c", next);
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
      asm.aluImm("cp", "xwa", GRID_EMPTY);
      ctx.far("z", next);
      ctx.scoped(() => {
        asm.ld("xiy", "xwa");
        emitTableLookup(ctx, level.solidLabel);
        asm.alu("or", "a", "a");
        asm.ld("xwa", "xiy");
      });
      ctx.far("z", next);
      ctx.scoped(() => {
        asm.ld("xiy", "xwa");
        emitTableLookup(ctx, namedTable);
        asm.alu("or", "a", "a");
        asm.ld("xwa", "xiy");
      });
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

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: NgpcCtx, rule: RuleDef, bind: Binding): void {
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
    ctx.far("t", done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  asm.ldm("a", at(layout.words + W.tileCol * 2));
  asm.stm(at(layout.words + W.cell * 2), "a");
  asm.ldm("a", at(layout.words + W.tileRow * 2));
  asm.stm(at(layout.words + W.cell * 2 + 1), "a");
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: NgpcCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.stmi(at(layout.tileScratch), "b", 0);
  asm.ldm("a", at(listBase));
  asm.stm(at(layout.words + W.target * 2), "a");
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.ldm("a", at(layout.tileScratch));
  asm.aluImm("cp", "a", TILE_CONTACT_MAX);
  ctx.far("uge", full);
  ctx.scoped(() => {
    asm.ld("xiy", "xwa"); // the legend index the caller is still holding
    asm.ldn("xwa", 0);
    asm.ldm("a", at(layout.tileScratch));
    asm.shift("sla", 1, "xwa"); // an entry is two bytes
    asm.ldn("xhl", layout.tileScratch + 1);
    asm.alu("add", "xhl", "xwa");
    asm.ldm("wa", at(layout.words + W.cell * 2));
    asm.stm(based("xhl"), "wa");
    asm.incMem(1, at(layout.tileScratch), "b");
    asm.ld("xwa", "xiy");
  });
  asm.label(full);
}

/** Replace the pair's stored list with the one just built. */
function emitCommitContacts(ctx: NgpcCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("commitDone");
  asm.ldm("a", at(layout.tileScratch));
  asm.stm(at(listBase), "a");
  asm.alu("or", "a", "a");
  ctx.far("z", done);
  asm.ldn("xbc", 0);
  asm.ld("c", "a");
  asm.shift("sla", 1, "xbc"); // two bytes an entry
  asm.ldn("xhl", layout.tileScratch + 1);
  asm.ldn("xde", listBase + 1);
  asm.ldir(based("xde"), "b");
  asm.label(done);
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles. The list to
 * search arrives in `XIY` and its length in `B`, and the answer is the carry —
 * set when the cell *was* there, which is the convention every predicate in this
 * backend uses.
 */
function emitTileContactHelper(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.alu("or", "b", "b");
  ctx.far("z", missing);
  asm.ldm("hl", at(layout.words + W.cell * 2));
  asm.label(loop);
  asm.ldm("de", based("xiy"));
  asm.alu("cp", "de", "hl");
  ctx.far("z", found);
  asm.ldn("xwa", 2);
  asm.alu("add", "xiy", "xwa");
  asm.djnz("b", loop);
  asm.label(missing);
  asm.rcf();
  asm.ret();
  asm.label(found);
  asm.scf();
  asm.ret();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: NgpcCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NgpcEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.stmi(at(layout.words + W.camX * 2), "w", 0);
    asm.stmi(at(layout.words + W.camY * 2), "w", 0);
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.aluMemImm("cp", at(layout.redraw), "b", 0);
  ctx.far("z", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  asm.stmi(at(layout.redraw), "b", 0);
  asm.stmi(at(layout.plotPrevCount), "b", 0);
  ctx.far("t", afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // A scene that scrolls draws its HUD with sprites; one that does not gets it
  // as background cells, which costs no objects at all.
  if (!scrolls(ctx, scene)) {
    emitHudErase(ctx, level);
    asm.stmi(at(layout.plotCount), "b", 0);
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
  }
  emitOam(ctx, scene, options);
  asm.ret();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: NgpcCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldm("xwa", at(src));
  asm.shift("sra", 13, "xwa");
  asm.stm(at(dst), "wa");
}

/** Draw the whole visible window. */
function emitFullRedraw(
  ctx: NgpcCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NgpcEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Interrupts off for the whole of it. Not for the Mega Drive's reason — there
  // is no half-written control word here — but because a screenful of map does
  // not fit in one blanking interval, and the display would show the walk
  // happening. The frame it spends here is owed rather than lost.
  asm.di();

  // Every scene uploads a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours; one without brings the
  // build's — the level tiles' and the objects' fit. Leaving palette RAM alone
  // would mean a level scene wore whichever title screen the player came from.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteUpload(ctx, palette ? scenePaletteLabel(scene) : "Palette");

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a run of whole rows padded to the plane's width, so painting
    // it is one walk into the map.
    asm.ldn("xhl", label(backdropLabel(scene)));
    asm.ldn("xde", NGP_PLANE1);
    asm.call(needBlitBackdrop(ctx));
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    //
    // The window *plus one cell on each axis*: a scroll of part of a cell shows
    // a sliver of the next one, and the walk only paints a strip once the origin
    // has actually moved.
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
    asm.stmi(at(rows), "w", height);
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.stmi(at(columns), "w", width);
    asm.label(colLoop);
    emitBackgroundTile(ctx, level);
    ctx.scoped(() => {
      asm.ld("xiy", "xwa");
      asm.call(label("CellAddr"));
      asm.ld("xwa", "xiy");
      asm.stm(based("xhl"), "wa");
    });
    inc16(ctx, layout.words + W.tileCol * 2);
    dec16(ctx, columns);
    asm.aluMemImm("cp", at(columns), "w", 0);
    ctx.far("nz", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    dec16(ctx, rows);
    asm.aluMemImm("cp", at(rows), "w", 0);
    ctx.far("nz", rowLoop);
  }

  // Captions go on now, with the background they sit on. A scrolling scene draws
  // its whole HUD with sprites, so it has none to paint here.
  if (!scrolls(ctx, scene)) emitHud(ctx, scene, "static");
  asm.ei(0);
}

/**
 * `XHL` = a packed map, `XDE` = where it goes; unpack it into the plane.
 *
 * The format is `pack.ts`'s `packCellPairs`, which two other consoles already
 * use for the same reason this one does: an entry here is *two* bytes — the
 * character's low byte and the byte carrying its palette, its flips and its
 * ninth bit — so a run of identical cells has no byte runs in it at all.
 *
 * ```text
 *   $00        the end
 *   $01..$7F   n cells follow, two bytes each
 *   $81..$FF   the next two bytes, (n & $7F) times
 * ```
 *
 * The encoding is never the contract: what is guaranteed is the bytes that
 * reach the map, which is what `ngpc-rom.test.ts` reads back.
 */
function needBlitBackdrop(ctx: NgpcCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");
    const out = inner.unique("blitOut");

    asm.label(next);
    asm.ldm("b", postinc("xhl"));
    asm.alu("or", "b", "b");
    inner.far("z", out);
    asm.bit(7, "b");
    inner.far("nz", run);

    // A literal run is a straight copy of `n` cells, which is two bytes each.
    asm.label(literal);
    asm.ldm("wa", postinc("xhl", 2));
    asm.stm(based("xde"), "wa");
    asm.ldn("xwa", 2);
    asm.alu("add", "xde", "xwa");
    asm.djnz("b", literal);
    inner.far("t", next);

    asm.label(run);
    asm.aluImm("and", "b", 0x7f);
    asm.ldm("wa", postinc("xhl", 2));
    asm.label(runLoop);
    asm.stm(based("xde"), "wa");
    asm.pushReg("xwa");
    asm.ldn("xwa", 2);
    asm.alu("add", "xde", "xwa");
    asm.popReg("xwa");
    asm.djnz("b", runLoop);
    inner.far("t", next);

    asm.label(out);
    asm.ret();
  });
}

/** The labels holding one scene's map and palette RAM. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}

/**
 * `XWA` = the cell word that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: NgpcCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.ldn("xwa", SYSTEM_CELL);
    return;
  }
  asm.call(label(tileAtLabel(level)));
  emitLegendToTile(ctx, level);
}

/** `XWA` = the cell word for the legend index in `XWA`. */
function emitLegendToTile(ctx: NgpcCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.aluImm("cp", "xwa", GRID_EMPTY);
  ctx.far("z", empty);
  asm.ld("xiy", "xwa");
  emitTableLookup(ctx, level.tileLabel);
  asm.ld("xiz", "xwa"); // the tile's low byte
  asm.ld("xwa", "xiy");
  emitTableLookup(ctx, level.attrLabel);
  asm.shift("sll", 8, "xwa");
  asm.alu("or", "xwa", "xiz");
  ctx.far("t", done);
  asm.label(empty);
  asm.ldn("xwa", SYSTEM_CELL);
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: NgpcCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    // Sign-extended into the long, because a camera left of the origin is a
    // negative pixel count and an arithmetic shift is what floors it. `exts`
    // rather than a shift pair: this processor's shift count is one to sixteen,
    // so widening by shifting up and back down is two instructions and a
    // sign-extend is one.
    asm.ldm("hl", at(src));
    asm.exts("xhl");
    asm.shift("sra", 3, "xhl");
    asm.stm(at(dst), "hl");
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
function emitScrollUpdate(ctx: NgpcCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  ctx.far("t", done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.stmi(at(layout.redraw), "b", 1);
  asm.label(done);
}

/**
 * Step one axis of the plane origin toward the camera, painting the leading edge
 * as it goes. More than four cells in a tick is a teleport, not a scroll.
 *
 * The forward offset is the window's own size on both axes, because the plane is
 * bigger than the window on both: a new column goes twelve columns off the
 * right-hand edge and a new row thirteen rows below the bottom, and neither is
 * seen until the scroll brings it round. The Master System has to write its new
 * column into the cell straddling the screen's left edge and mask it; here there
 * is nothing to hide.
 */
function emitWalkAxis(
  ctx: NgpcCtx,
  level: LevelData,
  origin: number,
  want: number,
  bail: string,
  isColumn: boolean,
): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("walkAxis");
  const done = ctx.unique("walkDone");
  const back = ctx.unique("walkBack");
  const guard = layout.words + W.count * 2;

  asm.stmi(at(guard), "w", 5);
  asm.label(loop);
  dec16(ctx, guard);
  asm.aluMemImm("cp", at(guard), "w", 0);
  ctx.far("z", bail);
  asm.ldm("hl", at(want));
  asm.aluMem("cp", "hl", at(origin));
  ctx.far("z", done);
  ctx.far("lt", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  ctx.far("t", loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, 0);
  ctx.far("t", loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: NgpcCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = (isColumn ? layout.memory.viewH : layout.memory.viewW) + 1;
  // Not `count`: the grid lookup uses that word, and a counter clobbered
  // mid-loop paints a strip of whatever tile the count happened to land on.
  const remaining = layout.words + W.lastRow * 2;

  copy16(ctx, across, originAcross);
  if (offset !== 0) {
    asm.ldm("hl", at(across));
    asm.aluImm("add", "hl", offset);
    asm.stm(at(across), "hl");
  }
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.stmi(at(remaining), "w", count);
  asm.label(loop);
  asm.call(label("CellAddrQueue"));
  asm.call(label(tileAtLabel(level)));
  emitLegendToTile(ctx, level);
  asm.call(label("QueueEntry"));
  inc16(ctx, along);
  dec16(ctx, remaining);
  asm.aluMemImm("cp", at(remaining), "w", 0);
  ctx.far("nz", loop);
}

/** Put back the level tiles the HUD covered last frame. */
function emitHudErase(ctx: NgpcCtx, level: LevelData | undefined): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.aluMemImm("cp", at(layout.plotPrevCount), "b", 0);
  ctx.far("z", done);
  asm.stmi(at(cursor), "w", 0);
  asm.label(loop);
  asm.ldn("xhl", layout.plotPrev);
  asm.ldm("wa", at(cursor));
  asm.extz("xwa");
  asm.alu("add", "xhl", "xwa");
  asm.ldm("wa", based("xhl"));
  asm.stm(at(layout.words + W.tileCol * 2), "wa");
  asm.ldm("wa", based("xhl", 2));
  asm.stm(at(layout.words + W.tileRow * 2), "wa");
  asm.call(label("CellAddrQueue"));
  emitBackgroundTile(ctx, level);
  asm.call(label("QueueEntry"));
  asm.ldm("hl", at(cursor));
  asm.aluImm("add", "hl", 4);
  asm.stm(at(cursor), "hl");
  asm.ldn("xbc", 0);
  asm.ldm("c", at(layout.plotPrevCount));
  asm.shift("sla", 2, "xbc");
  asm.aluMem("cp", "bc", at(cursor));
  ctx.far("nz", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  asm.ldm("a", at(layout.plotCount));
  asm.stm(at(layout.plotPrevCount), "a");
  asm.alu("or", "a", "a");
  ctx.far("z", done);
  // Four bytes an entry: a column and a row, both words.
  asm.ldn("xbc", 0);
  asm.ld("c", "a");
  asm.shift("sla", 2, "xbc");
  asm.ldn("xhl", layout.plot);
  asm.ldn("xde", layout.plotPrev);
  asm.ldir(based("xde"), "b");
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the background layer. */
function emitHud(ctx: NgpcCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    asm.ldm("wa", at(base + propOffset("x") + CELL_OFFSET));
    asm.stm(at(layout.words + W.tileCol * 2), "wa");
    asm.ldm("wa", at(base + propOffset("y") + CELL_OFFSET));
    asm.stm(at(layout.words + W.tileRow * 2), "wa");

    // A static object is painted straight into the map with the display already
    // showing the redraw, so it needs neither the write queue nor a place in the
    // erase list.
    const plot = want === "static" ? needPokeCell(ctx) : label("PlotCell");
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.ldn("xwa", glyphTile(character));
        asm.call(plot);
      }
    } else {
      asm.ldn("xiy", base + propOffset("value") + CELL_OFFSET);
      asm.call(want === "static" ? needPokeNumber(ctx) : label("DrawNumber"));
    }
    asm.label(skip);
  }
}

/** `XWA = tile`: write it at the current cell and advance the column. */
function needPokeCell(ctx: NgpcCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    asm.aluImm("or", "xwa", SYSTEM_CELL);
    asm.ld("xiz", "xwa");
    asm.call(label("CellAddr"));
    asm.ld("xwa", "xiz");
    asm.stm(based("xhl"), "wa");
    inc16(inner, layout.words + W.tileCol * 2);
    asm.ret();
  });
}

/** The decimal renderer again, writing straight into the map. */
function needPokeNumber(ctx: NgpcCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeCell(inner));
  });
}

/**
 * `XIY` = entity base, the size in cells in two scratch words → the carry clear
 * when the object is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * word of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled.
 */
function needOnscreen(ctx: NgpcCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");

    const axis = (offset: number, margin: number, span: number): void => {
      asm.ldm("hl", based("xiy", offset + CELL_OFFSET));
      asm.aluMem("sub", "hl", at(camera + offset + CELL_OFFSET));
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.ld("de", "hl");
      asm.aluMem("add", "de", at(margin));
      inner.far("mi", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.ld("de", "hl");
      asm.aluImm("sub", "de", span + 1);
      inner.far("pl", apart);
    };
    axis(propOffset("x"), layout.scratch + S.w2, layout.memory.viewW);
    axis(propOffset("y"), layout.scratch + S.w3, layout.memory.viewH);

    asm.scf();
    asm.ret();
    asm.label(apart);
    asm.rcf();
    asm.ret();
  });
}

/** Build the object table from the scene's sprite objects. */
function emitOam(ctx: NgpcCtx, scene: SceneCtx, options: NgpcEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.stmi(at(layout.oamCount), "b", 0);

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
      asm.ldn("xiy", base);
      asm.stmi(at(layout.scratch + S.w2), "w", width);
      asm.stmi(at(layout.scratch + S.w3), "w", height);
      asm.call(needOnscreen(ctx));
      ctx.far("nc", skip);
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
        const palette = art ? (art.palette ?? 0) : SYSTEM_PALETTE;
        asm.ldm("hl", at(layout.words + W.cell * 2));
        if (column !== 0) asm.aluImm("add", "hl", column * 8);
        asm.ldm("de", at(layout.words + W.count * 2));
        if (row !== 0) asm.aluImm("add", "de", row * 8);
        asm.ldn("bc", tile & 0x1ff);
        asm.ldn("iz", palette);
        asm.call(needPushSprite(ctx));
      }
    }
    asm.label(skip);
  }
  if (scrolls(ctx, scene)) emitHudSprites(ctx, scene);
  asm.call(needHideRestOfOam(ctx));
}

/**
 * Draw a scrolling scene's `number` and `text` objects as hardware sprites.
 *
 * Same objects, same coordinates, same `camera.x + 1` rule the game already
 * wrote — only the layer differs. Sixty-four objects to a scanline is this
 * hardware's limit, which is the whole table, so a caption in a scrolling scene
 * is not constrained at all.
 */
function emitHudSprites(ctx: NgpcCtx, scene: SceneCtx): void {
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
        asm.ldn("xwa", glyphTile(character));
        asm.call(needHudGlyph(ctx));
      }
    } else {
      asm.ldn("xiy", base + propOffset("value") + CELL_OFFSET);
      asm.call(needHudNumber(ctx));
    }
    asm.label(skip);
  }
}

/** `XWA = tile`: put one glyph at the pen, on the object layer, and advance it. */
function needHudGlyph(ctx: NgpcCtx): Ref {
  return ctx.need("HudGlyph", (inner) => {
    const { asm, layout } = inner;
    asm.ld("xbc", "xwa");
    asm.ldn("iz", SYSTEM_PALETTE);
    asm.ldm("hl", at(layout.words + W.cell * 2));
    asm.ldm("de", at(layout.words + W.count * 2));
    asm.call(needPushSprite(inner));
    asm.ldm("hl", at(layout.words + W.cell * 2));
    asm.aluImm("add", "hl", 8);
    asm.stm(at(layout.words + W.cell * 2), "hl");
    asm.ret();
  });
}

/** The decimal renderer again, plotting sprites instead of background cells. */
function needHudNumber(ctx: NgpcCtx): Ref {
  return ctx.need("DrawNumberOam", (inner) => {
    emitDecimal(inner, needHudGlyph(inner));
  });
}

/**
 * `HL` = x, `DE` = y, `BC` = the tile, `IZ` = the palette; append an entry.
 *
 * There is no position bias on this console and no link field: an entry is four
 * bytes of tile, flags, x and y, with its colour palette in a parallel table.
 * The flags carry the priority, and **priority is what hides an entry** — the
 * frame's unused ones are set to zero by {@link needHideRestOfOam} rather than
 * being parked off screen or cut out of a chain.
 */
function needPushSprite(ctx: NgpcCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    asm.ldm("a", at(layout.oamCount));
    asm.aluImm("cp", "a", layout.memory.oamEntries);
    inner.far("ult", room);
    asm.ret();
    asm.label(room);
    // The entry's address: four bytes each, from the hardware's own table.
    asm.ldn("xwa", 0);
    asm.ldm("a", at(layout.oamCount));
    asm.ld("xiy", "xwa");
    asm.shift("sla", 2, "xiy");
    asm.ldn("xwa", NGP_SPRITES);
    asm.alu("add", "xiy", "xwa");
    asm.ld("a", "c");
    asm.stm(based("xiy"), "a"); // the tile's low eight bits
    // The flags: the tile's ninth bit, and the priority that makes it visible.
    asm.ld("a", "b");
    asm.aluImm("and", "a", 0x01);
    asm.aluImm("or", "a", PRIORITY_FRONT << 3);
    asm.stm(based("xiy", 1), "a");
    asm.ld("a", "l");
    asm.stm(based("xiy", 2), "a");
    asm.ld("a", "e");
    asm.stm(based("xiy", 3), "a");
    // The colour palette lives in a table of its own, one byte an object. `HL`
    // held the caller's x and has already been stored, so it is free to address
    // it; the palette comes down out of `IZ` through `XWA`, because the index
    // registers have no byte name this encoder will take.
    asm.ldn("xwa", 0);
    asm.ldm("a", at(layout.oamCount));
    asm.ldn("xhl", NGP_SPRITE_PALETTES);
    asm.alu("add", "xhl", "xwa");
    asm.ld("xwa", "xiz");
    asm.stm(based("xhl"), "a");
    asm.incMem(1, at(layout.oamCount), "b");
    asm.ret();
  });
}

/**
 * Hide every object the frame did not use.
 *
 * A priority of zero is what stops the hardware drawing an entry, so this walks
 * from the count to the end of the table clearing the flags byte. Only as far as
 * the *previous* frame reached, because everything beyond that is already zero.
 */
function needHideRestOfOam(ctx: NgpcCtx): Ref {
  return ctx.need("HideRestOfOam", (inner) => {
    const { asm, layout } = inner;
    const loop = inner.unique("hideLoop");
    const done = inner.unique("hideDone");
    asm.ldm("a", at(layout.oamCount));
    asm.ld("b", "a");
    asm.ldm("a", at(layout.oamPrev));
    asm.alu("cp", "a", "b");
    inner.far("ule", done);
    // `XIY` walks the flags byte of each entry from the count upward. `B` is
    // still the count here and is what the loop's own bound is taken from, so
    // the address is built before it is overwritten.
    asm.ldn("xwa", 0);
    asm.ld("a", "b");
    asm.ld("xiy", "xwa");
    asm.shift("sla", 2, "xiy");
    asm.ldn("xwa", NGP_SPRITES + 1);
    asm.alu("add", "xiy", "xwa");
    asm.ldm("a", at(layout.oamPrev));
    asm.alu("sub", "a", "b");
    asm.ld("b", "a");
    asm.label(loop);
    asm.stmi(based("xiy"), "b", PRIORITY_HIDDEN);
    asm.ldn("xwa", 4);
    asm.alu("add", "xiy", "xwa");
    asm.djnz("b", loop);
    asm.label(done);
    asm.ldm("a", at(layout.oamCount));
    asm.stm(at(layout.oamPrev), "a");
    asm.ret();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;

  // `XHL` = the address of the cell in words[tileCol]/words[tileRow]. The plane
  // wraps every thirty-two columns and every thirty-two rows, and both are
  // powers of two — so the wrap is two masks rather than the Master System's
  // subtraction loop.
  asm.label("CellAddr");
  asm.ldm("hl", at(layout.words + W.tileRow * 2));
  asm.aluImm("and", "hl", MAP_H - 1);
  asm.shift("sla", 5, "hl"); // thirty-two cells to a row
  asm.ldm("de", at(layout.words + W.tileCol * 2));
  asm.aluImm("and", "de", MAP_W - 1);
  asm.alu("add", "hl", "de");
  asm.shift("sla", 1, "hl"); // two bytes a cell
  asm.extz("xhl");
  asm.ldn("xwa", NGP_PLANE1);
  asm.alu("add", "xhl", "xwa");
  asm.ret();

  asm.label("CellAddrQueue");
  asm.call(label("CellAddr"));
  asm.stm(at(layout.words + W.target * 2), "hl");
  asm.ret();

  // `XWA` = a cell word, `words[target]` = the low half of the address: append a
  // four-byte entry to the queue.
  asm.label("QueueEntry");
  const room = ctx.unique("queueRoom");
  asm.ld("xiz", "xwa");
  asm.ldm("a", at(layout.queueCount));
  asm.aluImm("cp", "a", layout.memory.queueMax);
  ctx.far("ult", room);
  // No room: repaint the whole background next frame rather than leave a strip
  // of it stale for ever.
  asm.stmi(at(layout.redraw), "b", 1);
  asm.ret();
  asm.label(room);
  asm.ldn("xwa", 0);
  asm.ldm("a", at(layout.queueCount));
  asm.shift("sla", 2, "xwa"); // four bytes an entry
  asm.ldn("xhl", layout.queue);
  asm.alu("add", "xhl", "xwa");
  asm.ldm("de", at(layout.words + W.target * 2));
  asm.stm(based("xhl"), "de");
  asm.ld("xwa", "xiz");
  asm.stm(based("xhl", 2), "wa");
  asm.incMem(1, at(layout.queueCount), "b");
  asm.ret();

  // `XWA` = tile: queue it as one cell, record the cell for erasing, and advance
  // the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  asm.aluImm("or", "xwa", SYSTEM_CELL);
  asm.ld("xiz", "xwa");
  asm.call(label("CellAddrQueue"));
  asm.ld("xwa", "xiz");
  asm.call(label("QueueEntry"));
  asm.ldm("a", at(layout.plotCount));
  asm.aluImm("cp", "a", layout.memory.plotMax);
  ctx.far("uge", plotFull);
  asm.ldn("xwa", 0);
  asm.ldm("a", at(layout.plotCount));
  asm.shift("sla", 2, "xwa");
  asm.ldn("xhl", layout.plot);
  asm.alu("add", "xhl", "xwa");
  asm.ldm("wa", at(layout.words + W.tileCol * 2));
  asm.stm(based("xhl"), "wa");
  asm.ldm("wa", at(layout.words + W.tileRow * 2));
  asm.stm(based("xhl", 2), "wa");
  asm.incMem(1, at(layout.plotCount), "b");
  asm.label(plotFull);
  inc16(ctx, layout.words + W.tileCol * 2);
  asm.ret();

  emitUploadFrame(ctx);

  asm.label("DrawNumber");
  emitDecimal(ctx, label("PlotCell"));
}

/**
 * Flush the queue and set the scroll.
 *
 * The objects need no upload at all: the display reads the table where
 * `PushSprite` wrote it, so there is nothing to copy. The queue is capped at
 * what a blanking interval will hold and anything over sets the redraw flag
 * instead of being dropped.
 */
function emitUploadFrame(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.ldm("b", at(layout.queueCount));
  asm.alu("or", "b", "b");
  ctx.far("z", noQueue);
  asm.ldn("xiy", layout.queue);
  asm.label(flush);
  asm.ldm("hl", based("xiy"));
  asm.extz("xhl");
  asm.ldn("xwa", NGP_PLANE1 & 0xff0000);
  asm.alu("add", "xhl", "xwa");
  asm.ldm("wa", based("xiy", 2));
  asm.stm(based("xhl"), "wa");
  asm.ldn("xwa", 4);
  asm.alu("add", "xiy", "xwa");
  asm.djnz("b", flush);
  asm.stmi(at(layout.queueCount), "b", 0);
  asm.label(noQueue);

  emitScrollWrite(ctx);
  asm.ret();
}

/**
 * Write the two scroll registers.
 *
 * Both are single bytes and the plane is exactly 256 pixels on both axes, so the
 * *register is the wrap*: there is no mask, no negation and no subtraction loop.
 * That is this console's one free gift to a scrolling game, and it comes from
 * the plane being square and byte-sized rather than from anything the runtime
 * does.
 */
function emitScrollWrite(ctx: NgpcCtx): void {
  const { asm, layout } = ctx;
  asm.ldm("a", at(layout.words + W.scrollX * 2));
  asm.stm(at(NGP_S1SO_H), "a");
  asm.ldm("a", at(layout.words + W.scrollY * 2));
  asm.stm(at(NGP_S1SO_V), "a");
}

/**
 * Draw the signed 16-bit value `XIY` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the background HUD and the sprite one — which is
 * why it is a parameter rather than a second copy of the digit loop. Leading
 * zeroes are suppressed and a lone zero still prints.
 *
 * **A digit is a division here, not a subtraction loop.** Every 8-bit backend in
 * this project walks the powers of ten subtracting one at a time because none of
 * their processors can divide; this one can, so each digit is one `div` whose
 * quotient is the digit and whose remainder is what is left to print. The
 * WonderSwan's renderer makes the same trade for the same reason.
 */
function emitDecimal(ctx: NgpcCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the cell
  // address routine, the write queue and the object builder — which between them
  // use every register there is. So the digit loop keeps its state in the render
  // words instead, in slots nothing on that path touches: not the pen, not the
  // cell being written, not the queued address, and above all not the map
  // origin, which has to survive from one frame to the next.
  const value = layout.words + W.firstCol * 2;
  const flag = layout.words + W.firstRow * 2;
  const power = layout.words + W.lastCol * 2;

  asm.ldm("hl", based("xiy"));
  asm.stm(at(value), "hl");

  const positive = ctx.unique("numPos");
  asm.aluMemImm("cp", at(value), "w", 0);
  ctx.far("pl", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.ldm("hl", at(value));
  asm.neg("hl");
  asm.stm(at(value), "hl");
  asm.ldn("xwa", glyphTile("-"));
  asm.call(plot);
  asm.label(positive);

  asm.stmi(at(flag), "b", 0);
  asm.stmi(at(power), "w", 10000);

  const powerLoop = ctx.unique("numPower");
  const skipDigit = ctx.unique("numSkip");
  const emitDigit = ctx.unique("numEmit");
  const next = ctx.unique("numNext");

  asm.label(powerLoop);
  // digit = value / power, value = value % power — one instruction for both,
  // because a divide leaves its remainder in the register's high half.
  asm.ldm("wa", at(value));
  asm.extz("xwa");
  asm.ldm("hl", at(power));
  asm.div("xwa", "hl");
  asm.ld("xiz", "xwa");
  asm.shift("srl", 16, "xiz");
  asm.stm(at(value), "iz");
  asm.aluImm("and", "xwa", 0xffff);
  asm.ld("xiz", "xwa");

  asm.alu("or", "wa", "wa");
  ctx.far("nz", emitDigit);
  asm.aluMemImm("cp", at(flag), "b", 0);
  ctx.far("nz", emitDigit);
  asm.aluMemImm("cp", at(power), "w", 1);
  ctx.far("nz", skipDigit);
  asm.label(emitDigit);
  asm.stmi(at(flag), "b", 1);
  asm.ld("xwa", "xiz");
  asm.aluImm("add", "xwa", glyphTile("0"));
  asm.call(plot);
  asm.label(skipDigit);
  // The next power of ten down, and stop once the units have been printed.
  asm.aluMemImm("cp", at(power), "w", 1);
  ctx.far("z", next);
  ctx.scoped(() => {
    asm.ldm("wa", at(power));
    asm.extz("xwa");
    asm.ldn("hl", 10);
    asm.div("xwa", "hl");
    asm.stm(at(power), "wa");
  });
  ctx.far("t", powerLoop);
  asm.label(next);
  asm.ret();
}
