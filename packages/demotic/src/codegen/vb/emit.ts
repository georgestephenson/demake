/**
 * The whole-program emitter for the Virtual Boy: boot, the frame, the renderer.
 *
 * Everything here is per *scene*, for the reason every other backend gives: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and on this console five things are worth
 * knowing before touching any of it.
 *
 *   - **A scene is a display list, not a stack of layers.** Thirty-two worlds
 *     at {@link VB_WORLDS} are processed from 31 down to 0 and the one that sets
 *     `END` stops the drawing processor, so what a scene costs is the worlds it
 *     actually uses. This runtime uses seven and they never change: scenery, four
 *     object worlds, the HUD, and the terminator ({@link emitWorlds}).
 *   - **A world says how far apart its two eyes are**, which is this project's
 *     only depth axis. {@link VB_DEPTH} is the ladder — scenery at the display
 *     plane, objects in front of it, captions in front of them — and it is one
 *     table rather than a number per emitter, because a caption behind the object
 *     it labels is not a wrong number anywhere, it is a wrong number relative to
 *     another one.
 *   - **The HUD gets a plane of its own**, which follows from the same fact: a
 *     second BGMap world at the caption depth, whose source origin is written
 *     once at boot and never again. So a caption's cell is `floor(pos) −
 *     floor(camera)` whether the scene scrolls or not, and the sprite HUD every
 *     8-bit console needs, the second decimal renderer that drives it and the
 *     whole pixel-pinning argument are absent rather than reimplemented — the
 *     WonderSwan's arrangement, with a depth on top.
 *   - **The map is 64×64 against a 48×28 window**, so a scrolling scene paints
 *     its leading edge sixteen columns off the right-hand side, both wraps are
 *     powers of two, and neither the NES's row pinning nor the Master System's
 *     seam mask exists here. Scrolling itself is *two halfword stores* — the
 *     world's own `MX` and `MY` — because the hardware reads the map through
 *     them.
 *   - **There is no video memory behind a port**, but there is a drawing
 *     processor reading it. The map, the characters, the worlds and the object
 *     table are ordinary addresses, so a cell is one store; what decides *when*
 *     is that the drawing processor is walking the same memory for most of the
 *     frame. So a frame's cells wait in a queue and go across after `XPEND`, and
 *     the one thing too big to queue — a whole screen at a scene change — turns
 *     drawing off for its own length instead.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 */

import {
  label,
  VB_BGMAP,
  VB_BGMAP_BYTES,
  VB_BKCOL,
  VB_BRTA,
  VB_BRTB,
  VB_BRTC,
  VB_BRIGHTNESS,
  VB_CHR_MIRROR,
  VB_DEPTH,
  VB_DPCTRL,
  VB_DPCTRL_ON,
  VB_FRMCYC,
  VB_GPLT0,
  VB_INTCLR,
  VB_INTENB,
  VB_INTPND,
  VB_INT_XPEND,
  VB_JPLT0,
  VB_OAM,
  VB_OBJ_BYTES,
  VB_OBJ_JLON,
  VB_OBJ_JRON,
  VB_REST,
  VB_SCR,
  VB_SCR_HW_READ,
  VB_SCR_STAT,
  VB_SCREEN_H,
  VB_SCREEN_W,
  VB_SDHR,
  VB_SDLR,
  VB_SPT0,
  VB_WORLDS,
  VB_WORLD_BGM_OBJ,
  VB_WORLD_BYTES,
  VB_WORLD_END,
  VB_WORLD_GP,
  VB_WORLD_GX,
  VB_WORLD_GY,
  VB_WORLD_H,
  VB_WORLD_HEAD,
  VB_WORLD_LON,
  VB_WORLD_MP,
  VB_WORLD_MX,
  VB_WORLD_MY,
  VB_WORLD_RON,
  VB_WORLD_W,
  VB_WRAM,
  VB_WRAM_SIZE,
  VB_XPCTRL,
  VB_XP_XPEN,
  vbParallax,
  type Ref,
} from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import { ACTIONS } from "../../program.js";
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

import type { VbCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import {
  E0,
  E1,
  E2,
  E3,
  E4,
  E5,
  E6,
  HI,
  RAM,
  RAM_BASE,
  SP,
  T0,
  T1,
  T2,
  ZERO,
  ramDisp,
} from "./regs.js";
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
import { branchZero32, copy32, sub32 } from "./val.js";

/** Cells across and down one BGMap — the same on both axes. */
export const MAP_W = 64;
export const MAP_H = 64;

/** Characters the hardware holds, and the bank's whole budget. */
export const BANK_TILES = 2048;

/** Bytes one character is: eight rows of one little-endian halfword. */
export const TILE_BYTES = 16;

/**
 * Which BGMap each plane is.
 *
 * Two of the fourteen, and the numbers are the low four bits of a world's head —
 * so a plane is chosen by the world rather than by an address anybody computes.
 */
const WORLD_MAP = 0;
const HUD_MAP = 1;

/** Where in the display list each of this runtime's worlds sits. */
const WORLD_SCENERY = 31;
const WORLD_OBJECTS = [30, 29, 28, 27] as const;
const WORLD_HUD = 26;
const WORLD_END_AT = 25;

/**
 * Background sub-palettes the art may use, and the one the font keeps.
 *
 * Four of each kind on this console, which is the narrowest palette budget in
 * the set — so the reservation is a whole palette rather than a corner of one,
 * exactly as the Neo Geo Pocket's is. Art takes `GPLT0`/`JPLT0` and the font,
 * the level patterns and the placeholder block take `GPLT1`/`JPLT1`.
 */
export const ART_PALETTES = 1;
export const OBJECT_PALETTES = 1;
export const SYSTEM_PALETTE = 1;
export const SYSTEM_OBJECT_PALETTE = 1;

/**
 * A scene's palette block: four background registers, four object registers and
 * the backdrop.
 *
 * The backdrop is the ninth byte of the same blob rather than a caller's
 * decision, for the reason `codegen/vb.ts` gives about the five-byte one: colour
 * zero is transparent on every layer of this console, so a picture's lightest
 * shade only ever reaches the screen through `BKCOL`.
 */
export const PALETTE_BYTES = 9;

/** One BGMap entry, as the hardware reads it. */
export function mapWord(tile: number, palette: number): number {
  return (tile & 0x07ff) | ((palette & 3) << 14);
}

/** One object attribute word — the same shape, and the same three fields. */
export function objectWord(tile: number, palette: number): number {
  return (tile & 0x07ff) | ((palette & 3) << 14);
}

/** The blank cell: character zero is transparent, whatever palette names it. */
const BLANK_CELL = 0;

/**
 * Read a halfword whose address may be odd.
 *
 * **A V810 masks the low bits of an unaligned access rather than faulting**, so
 * an `ld.h` from an odd address reads the halfword *below* it and reports
 * nothing. Three of this runtime's structures are odd by construction — the tile
 * cell list and both tile-contact lists interleave a count byte with halfword
 * entries, which is the shared stride `layout.ts` allocates and not something a
 * backend may change — so those are read and written a byte at a time, exactly
 * as the Mega Drive's are.
 */
function loadHalfSplit(ctx: VbCtx, disp: number, base: number, dst: number, tmp: number): void {
  const { asm } = ctx;
  asm.inb(disp, base, dst);
  asm.inb(disp + 1, base, tmp);
  asm.shlImm5(8, tmp);
  asm.or(tmp, dst);
}

/** The same, storing. */
function storeHalfSplit(ctx: VbCtx, src: number, disp: number, base: number, tmp: number): void {
  const { asm } = ctx;
  asm.stb(src, disp, base);
  asm.mov(src, tmp);
  asm.shrImm5(8, tmp);
  asm.stb(tmp, disp + 1, base);
}

/** Everything the emitter needs beyond the program itself. */
export interface VbEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number; palette: number }>;
  /** Demade backdrops by scene name: the map the picture fills, packed. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The character bank, copied into the drawing processor's memory at boot. */
  bank?: Uint8Array;
  /** The build's own palette block, for scenes that brought no picture. */
  palette?: Uint8Array;
  /** Per-scene palette blocks, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
  /** Which sub-palette a level's tile art was fitted into. */
  levelPalette?: number;
}

/**
 * A run of constant halfword stores that shares one base register.
 *
 * A load or store reaches ±32 KiB from a base, and the video processor's whole
 * register page is a hundred and twenty bytes — so thirty registers written at
 * boot cost one `movImm32` and thirty stores rather than ninety instructions.
 * The base is reloaded only when a store would not reach, which is what makes
 * one poker safe to point at the registers, the worlds and the map in turn.
 */
function poker(ctx: VbCtx, reg = E0, valueReg = E1): (address: number, value: number) => void {
  let base: number | null = null;
  return (address, value) => {
    const { asm } = ctx;
    if (base === null || address - base < -0x8000 || address - base > 0x7ffe) {
      base = address;
      asm.movImm32(address, reg);
    }
    if ((value & 0xffff) === 0) {
      asm.sth(ZERO, address - base, reg);
      return;
    }
    asm.movImm32(value & 0xffff, valueReg);
    asm.sth(valueReg, address - base, reg);
  };
}

/** Dispatch on the running scene to one of a set of labels. */
function emitSceneDispatch(ctx: VbCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    ctx.jump(labels[0] as string);
    return;
  }
  asm.inb(ramDisp(layout.scene), RAM, E0);
  for (const [index, target] of labels.entries()) {
    if (index === labels.length - 1) {
      ctx.jump(target);
      break;
    }
    asm.movImm32(index, E1);
    asm.cmp(E1, E0);
    ctx.far("e", target);
  }
}

/** Emit the whole program. */
export function emitProgram(ctx: VbCtx, options: VbEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx, options);
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
  // A grid lookup is a *routine*, so it belongs with the code rather than beside
  // the table it reads: an instruction stream that resumed after a byte table of
  // odd length would start on an odd address, and this processor jumps to the
  // even one below it.
  for (const level of levels) emitTileAt(ctx, level);
  ctx.finish();

  // --- data ------------------------------------------------------------------
  asm.align(4);
  for (const level of levels) {
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
    // The two tables are exactly the low and high halves of a map word, so
    // nothing has to be assembled at run time.
    emitLevelData(
      asm,
      level,
      (index) => mapWord(boundTile(index).tile, boundTile(index).palette) & 0xff,
      (index) => (mapWord(boundTile(index).tile, boundTile(index).palette) >> 8) & 0xff,
    );
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
      }
    }
  }
  asm.align(4);
  emitInstanceDefaults(asm, program, PROPS, ctx.layout.entitySizes);

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (art) {
      // Already packed: `vb-art.ts` encodes the map as it interns the tiles,
      // exactly as the PC Engine's and the WonderSwan's do, because the pool is
      // what decides a cell's number. Packing it again here would encode the
      // *stream* as a run of literal cells — a title screen that boots as its
      // own compression format.
      asm.align(4);
      asm.label(backdropLabel(scene));
      asm.bytes(art.map);
    }
    const palette = options.scenePalettes?.get(scene.def.name);
    if (palette) {
      asm.align(4);
      asm.label(scenePaletteLabel(scene));
      asm.bytes(palette);
    }
  }

  asm.align(4);
  asm.label("TileBank");
  asm.bytes(options.bank ?? new Uint8Array(0));
  asm.align(4);
  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette());
}

/**
 * The palette block a build with no demade art uses.
 *
 * Both art palettes are the plain ramp and both system palettes are the font's,
 * so a caption and a placeholder block are legible with nothing else copied in.
 * The backdrop is shade zero — the LEDs off — which on this display is the one
 * thing a scene with nothing in it should look like.
 */
function defaultPalette(): Uint8Array {
  const ramp = systemPaletteByte(0);
  return Uint8Array.from([ramp, ramp, ramp, ramp, ramp, ramp, ramp, ramp, 0]);
}

/**
 * The font's palette, chosen against the shade a caption will be read on.
 *
 * Colour zero is transparent on every layer of this console, so a caption has no
 * paper of its own and only its ink is decided — the NES's rule and the PC
 * Engine's, reached here by the same hardware fact. A dark background takes a
 * rising ramp so the ink is the brightest shade; a bright one takes a falling
 * ramp so the ink is the LEDs off.
 *
 * What `behind` is takes one more step here than on those two consoles, and
 * `vb-art.ts` is where it is worked out: a caption is on a **plane of its own,
 * in front of the picture**, so what shows through its paper is the picture
 * itself rather than the one colour the picture leaves to the backdrop
 * register. Handed the backdrop instead, a caption over a mostly-dark title
 * screen whose *lightest* colour happens to be rare comes out dark on dark —
 * invisible, and invisible in a way no register comparison can see.
 */
export function systemPaletteByte(behind: number): number {
  const shades = behind >= 2 ? [2, 1, 0] : [1, 2, 3];
  return (
    (((shades[0] as number) & 3) << 2) |
    (((shades[1] as number) & 3) << 4) |
    (((shades[2] as number) & 3) << 6)
  );
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: VbCtx, options: VbEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Boot");
  // The base every work-RAM access is measured from, and the stack, which grows
  // down from the top of the region the allocator stopped short of.
  asm.movImm32(RAM_BASE, RAM);
  asm.movImm32(VB_WRAM + VB_WRAM_SIZE, SP);

  // This cartridge takes no interrupt anywhere — the main loop reads `INTPND`
  // instead — so the video processor is told to raise none and everything it is
  // holding is acknowledged before the loop first looks.
  const vip = poker(ctx);
  vip(VB_INTENB, 0);
  vip(VB_INTCLR, 0xffff);
  vip(VB_REST, 0);
  vip(VB_FRMCYC, 0);
  vip(VB_XPCTRL, 0);

  // Work RAM, then the two BGMaps and the object table. All three are read by
  // the drawing processor where they lie, so a byte nobody wrote is a cell of
  // whatever powered up.
  emitFill(ctx, layout.memory.heapStart, layout.memory.heapEnd - layout.memory.heapStart);
  emitFill(ctx, layout.memory.oamShadow, (layout.memory.oamEntries + 1) * VB_OBJ_BYTES);
  emitFill(ctx, VB_BGMAP + WORLD_MAP * VB_BGMAP_BYTES, VB_BGMAP_BYTES);
  emitFill(ctx, VB_BGMAP + HUD_MAP * VB_BGMAP_BYTES, VB_BGMAP_BYTES);
  emitFill(ctx, VB_OAM, (layout.memory.oamEntries + 1) * VB_OBJ_BYTES);

  emitCopyWords(ctx, label("TileBank"), VB_CHR_MIRROR, options.bank?.length ?? 0);
  emitPaletteBlock(ctx, label("Palette"));

  const brightness = poker(ctx);
  brightness(VB_BRTA, VB_BRIGHTNESS.a);
  brightness(VB_BRTB, VB_BRIGHTNESS.b);
  brightness(VB_BRTC, VB_BRIGHTNESS.c);
  emitWorlds(ctx);

  // Every entity starts from its declared values, not just the entry scene's: a
  // rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    emitCopyBytes(
      ctx,
      label(`Defaults_${instance.id}`),
      layout.entities[instance.id] as number,
      layout.entitySizes[instance.id] as number,
    );
  }

  storeByte(ctx, layout.pending, 0xff);
  storeByte(ctx, layout.scene, sceneIndexOf(program, program.entryScene));
  storeByte(ctx, layout.redraw, 1);
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.jal("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    for (let index = 0; index < 8; index += 4) {
      asm.stw(ZERO, ramDisp(layout.camera + index), RAM);
    }
  }
  asm.jal("BuildFrame");
  asm.jal("UploadFrame");

  // Drawing, and then the screen, come on last: nothing above this was visible.
  const on = poker(ctx);
  on(VB_XPCTRL, VB_XP_XPEN);
  on(VB_DPCTRL, VB_DPCTRL_ON);
  storeByte(ctx, layout.booted, 1);
  ctx.jump("Main");
}

/** Store a constant byte into work RAM. */
function storeByte(ctx: VbCtx, address: number, value: number): void {
  const { asm } = ctx;
  if ((value & 0xff) === 0) {
    asm.stb(ZERO, ramDisp(address), RAM);
    return;
  }
  asm.movImm32(value & 0xff, E0);
  asm.stb(E0, ramDisp(address), RAM);
}

/** Zero a run of memory, a word at a time. */
function emitFill(ctx: VbCtx, dest: number, bytes: number): void {
  const { asm } = ctx;
  const words = bytes >> 2;
  if (words === 0) return;
  const loop = ctx.unique("fill");
  asm.movImm32(dest, E0);
  asm.movImm32(words, E1);
  asm.label(loop);
  asm.stw(ZERO, 0, E0);
  asm.addImm5(4, E0);
  asm.addImm5(-1, E1);
  asm.bcond("nz", loop);
}

/** Copy a run of cartridge words somewhere — the boot's only bulk move. */
function emitCopyWords(ctx: VbCtx, source: Ref, dest: number, bytes: number): void {
  const { asm } = ctx;
  const words = (bytes + 3) >> 2;
  if (words === 0) return;
  const loop = ctx.unique("copy");
  asm.movImm32(source, E0);
  asm.movImm32(dest, E1);
  asm.movImm32(words, E2);
  asm.label(loop);
  asm.ldw(0, E0, E3);
  asm.stw(E3, 0, E1);
  asm.addImm5(4, E0);
  asm.addImm5(4, E1);
  asm.addImm5(-1, E2);
  asm.bcond("nz", loop);
}

/**
 * The same, a byte at a time, for a blob whose length is not a whole number of
 * words.
 *
 * An entity record is as long as the object needs (`layout.ts` §entityBytes), so
 * rounding one up to a word would write into the record beside it — which is the
 * next object's collision box.
 */
function emitCopyBytes(ctx: VbCtx, source: Ref, dest: number, bytes: number): void {
  const { asm } = ctx;
  if (bytes === 0) return;
  const loop = ctx.unique("copyb");
  asm.movImm32(source, E0);
  asm.movImm32(dest, E1);
  asm.movImm32(bytes, E2);
  asm.label(loop);
  asm.ldb(0, E0, E3);
  asm.stb(E3, 0, E1);
  asm.addImm5(1, E0);
  asm.addImm5(1, E1);
  asm.addImm5(-1, E2);
  asm.bcond("nz", loop);
}

/**
 * Put a palette block where this console keeps its palettes, which is nine
 * registers rather than a region of memory.
 *
 * Four background bytes, four object bytes and the backdrop — and each is the
 * low byte of its own halfword register, so this is a load and a store apiece
 * rather than a copy. Every scene brings one, whether it has a picture or not
 * (see {@link emitFullRedraw}).
 */
function emitPaletteBlock(ctx: VbCtx, source: Ref): void {
  const { asm } = ctx;
  const registers = [
    VB_GPLT0,
    VB_GPLT0 + 2,
    VB_GPLT0 + 4,
    VB_GPLT0 + 6,
    VB_JPLT0,
    VB_JPLT0 + 2,
    VB_JPLT0 + 4,
    VB_JPLT0 + 6,
    VB_BKCOL,
  ];
  asm.movImm32(source, E0);
  asm.movImm32(VB_GPLT0, E1);
  for (const [index, register] of registers.entries()) {
    asm.inb(index, E0, E2);
    asm.sth(E2, register - VB_GPLT0, E1);
  }
}

/**
 * The display list, written once and never rewritten.
 *
 * Seven entries and their order is the whole of what this console draws:
 * scenery, four object worlds, the HUD, and the terminator. Nothing at run time
 * touches any of it but the scenery world's two source-origin halfwords, which
 * is what scrolling is here.
 *
 * The four object worlds are four rather than one because the drawing processor
 * counts them: the group a world draws is decided by *how many object worlds
 * came before it*, from three downward, so reaching group 0 means meeting four.
 * All four are enabled and the other three groups are left empty by the `SPT`
 * registers ({@link emitUploadFrame}) — which is a fact about the hardware
 * rather than a trick, and costs nothing to draw.
 */
function emitWorlds(ctx: VbCtx): void {
  const world = poker(ctx);
  const at = (index: number, field: number): number => VB_WORLDS + index * VB_WORLD_BYTES + field;

  const plane = (index: number, map: number, depth: number): void => {
    world(at(index, VB_WORLD_HEAD), VB_WORLD_LON | VB_WORLD_RON | map);
    world(at(index, VB_WORLD_GX), 0);
    world(at(index, VB_WORLD_GP), vbParallax(depth));
    world(at(index, VB_WORLD_GY), 0);
    world(at(index, VB_WORLD_MX), 0);
    // The source parallax stays zero: both eyes read the *same* map pixels and
    // put them in two places, which is a layer at a depth rather than a layer
    // sheared.
    world(at(index, VB_WORLD_MP), 0);
    world(at(index, VB_WORLD_MY), 0);
    world(at(index, VB_WORLD_W), VB_SCREEN_W - 1);
    world(at(index, VB_WORLD_H), VB_SCREEN_H - 1);
  };

  plane(WORLD_SCENERY, WORLD_MAP, VB_DEPTH.background);
  for (const index of WORLD_OBJECTS) {
    world(at(index, VB_WORLD_HEAD), VB_WORLD_LON | VB_WORLD_RON | VB_WORLD_BGM_OBJ);
  }
  plane(WORLD_HUD, HUD_MAP, VB_DEPTH.hud);
  world(at(WORLD_END_AT, VB_WORLD_HEAD), VB_WORLD_END);
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: VbCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  asm.movImm32(program.seed | 0, E0);
  asm.stw(E0, ramDisp(layout.rng), RAM);
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.stb(ZERO, ramDisp(layout.contacts + index), RAM);
    asm.stb(ZERO, ramDisp(layout.contactsPrev + index), RAM);
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) {
    asm.stb(ZERO, ramDisp(layout.holdFlags + index), RAM);
  }
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1) {
    asm.stb(ZERO, ramDisp(layout.reachFlags + index), RAM);
  }
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.stb(ZERO, ramDisp(layout.tileContacts + index * layout.tileContactStride), RAM);
    }
  }
}

/**
 * The frame, built first and waited for afterwards.
 *
 * The tick and the frame it builds run while the drawing processor is busy, and
 * everything that touches the processor's own memory waits for it to finish —
 * which is what `XPEND` says. This cartridge takes no interrupt to learn that:
 * it reads `INTPND` and acknowledges what it found, the WonderSwan's arrangement
 * on a machine that could have had the interrupt and gains nothing from it,
 * because a loop that waits either way is a loop that waits.
 */
function emitMainLoop(ctx: VbCtx): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  asm.label("Main");
  asm.jal("ReadInput");
  asm.jal("Tick");
  asm.jal("BuildFrame");
  asm.movImm32(VB_INTPND, E0);
  asm.label(wait);
  asm.ldh(0, E0, E1);
  asm.andi(VB_INT_XPEND, E1, E1);
  asm.bcond("e", wait);
  asm.movImm32(0xffff, E1);
  asm.sth(E1, VB_INTCLR - VB_INTPND, E0);
  asm.jal("UploadFrame");
  ctx.jump("Main");
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * The controller is a shift register: writing `HW_READ` starts a read and `STAT`
 * stays set while it runs, after which the sixteen bits are two byte-wide
 * registers. **A pressed key reads as a one**, and two of the sixteen bits are
 * not keys at all — one is always set and one carries the low-battery signal —
 * so a runtime that treated the word as sixteen buttons would find one of them
 * held from power-on.
 */
function emitInput(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const poll = ctx.unique("padPoll");
  /** Which bit of the pad word each abstract button is. */
  const KEYS: Record<string, number> = {
    left: 0x0200,
    right: 0x0100,
    up: 0x0800,
    down: 0x0400,
    a: 0x0004,
    b: 0x0008,
    start: 0x1000,
  };

  asm.label("ReadInput");
  asm.movImm32(VB_SCR, E0);
  asm.movImm32(VB_SCR_HW_READ, E1);
  asm.stb(E1, 0, E0);
  asm.label(poll);
  asm.inb(0, E0, E1);
  asm.andi(VB_SCR_STAT, E1, E1);
  asm.bcond("nz", poll);

  asm.movImm32(VB_SDLR, E0);
  asm.inb(0, E0, E1);
  asm.inb(VB_SDHR - VB_SDLR, E0, E2);
  asm.shlImm5(8, E2);
  asm.or(E2, E1);

  asm.mov(ZERO, E4);
  for (const [to, action] of ACTIONS.entries()) {
    const bit = KEYS[action];
    if (bit === undefined) continue;
    const skip = ctx.unique("padSkip");
    asm.andi(bit, E1, E2);
    asm.bcond("e", skip);
    asm.ori(1 << to, E4, E4);
    asm.label(skip);
  }

  // held → pressed and released, against last tick's set.
  asm.inb(ramDisp(layout.held), RAM, E3);
  asm.stb(E4, ramDisp(layout.held), RAM);
  asm.not(E3, E5);
  asm.and(E4, E5);
  asm.stb(E5, ramDisp(layout.pressed), RAM);
  asm.not(E4, E5);
  asm.and(E3, E5);
  asm.stb(E5, ramDisp(layout.released), RAM);
  asm.ret();
}

function emitTickDispatch(ctx: VbCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  // The tick is a `jal`, so its return address is a register a scene body would
  // destroy the moment it called anything — stacked here, restored at `TickDone`.
  ctx.enter();
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) storeByte(ctx, layout.sound, 0xff);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.jal("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  inc16(ctx, layout.tick);
  asm.inb(ramDisp(layout.ready), RAM, E0);
  asm.addImm5(1, E0);
  asm.stb(E0, ramDisp(layout.ready), RAM);
  ctx.leave();
}

function emitSceneChange(ctx: VbCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("SceneChange");
  ctx.enter();
  const go = ctx.unique("changeGo");
  asm.inb(ramDisp(layout.pending), RAM, E0);
  asm.movImm32(0xff, E1);
  asm.cmp(E1, E0);
  ctx.far("ne", go);
  ctx.leave();
  asm.label(go);
  asm.stb(E0, ramDisp(layout.scene), RAM);
  storeByte(ctx, layout.pending, 0xff);
  asm.jal("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.jal("UpdateCamera");
  storeByte(ctx, layout.redraw, 1);
  ctx.leave();

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
function tickSteps(ctx: VbCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.stb(ZERO, ramDisp(layout.contacts + index), RAM);
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.inb(ramDisp(layout.contacts + index), RAM, E0);
        asm.stb(E0, ramDisp(layout.contactsPrev + index), RAM);
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: VbCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  ctx.jump("TickDone");
}

function emitSceneReset(ctx: VbCtx, scene: SceneCtx): void {
  const { asm, layout } = ctx;
  asm.label(`SceneReset_${scene.index}`);
  for (const id of scene.def.instanceIds) {
    emitCopyBytes(
      ctx,
      label(`Defaults_${id}`),
      layout.entities[id] as number,
      layout.entitySizes[id] as number,
    );
  }
  asm.ret();
}

function emitSceneCamera(ctx: VbCtx, scene: SceneCtx): void {
  const { asm } = ctx;
  asm.label(`SceneCamera_${scene.index}`);
  emitCamera(ctx, scene);
  asm.ret();
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: VbCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: VbCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.stb(ZERO, ramDisp(list), RAM);
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.movImm32(GRID_EMPTY, T1);
    asm.cmp(T1, T0);
    ctx.far("e", next);
    asm.mov(T0, E3); // the legend index, held across the arithmetic
    asm.inb(ramDisp(list), RAM, E4);
    asm.movImm32(TILE_CONTACT_MAX, E5);
    asm.cmp(E5, E4);
    ctx.far("nl", next);
    // Five bytes an entry: the column, the row and the legend index. The stride
    // is a shift and an add, which every backend does — but here it is because a
    // `mul` would leave its high half in `r30`, and this machine has thirty-two
    // registers to spare rather than one to lose.
    asm.mov(E4, E5);
    asm.shlImm5(2, E5);
    asm.add(E4, E5);
    asm.add(RAM, E5);
    asm.ldh(ramDisp(col), RAM, E6);
    storeHalfSplit(ctx, E6, ramDisp(list) + 1, E5, E2);
    asm.ldh(ramDisp(row), RAM, E6);
    storeHalfSplit(ctx, E6, ramDisp(list) + 3, E5, E2);
    asm.stb(E3, ramDisp(list) + 5, E5);
    asm.addImm5(1, E4);
    asm.stb(E4, ramDisp(list), RAM);
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `T0`. */
function emitOverCells(ctx: VbCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const limit = layout.words + W.temp * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.inb(ramDisp(list), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", done);
  // Where the walk stops, in bytes. Computed once: the list cannot grow while it
  // is being read.
  asm.mov(E0, E1);
  asm.shlImm5(2, E1);
  asm.add(E0, E1);
  asm.sth(E1, ramDisp(limit), RAM);
  asm.sth(ZERO, ramDisp(cursor), RAM);
  asm.label(loop);
  // The cursor is in memory rather than a register because a rule body fires
  // between one iteration and the next and helps itself to everything.
  asm.ldh(ramDisp(cursor), RAM, E0);
  asm.add(RAM, E0);
  loadHalfSplit(ctx, ramDisp(list) + 1, E0, E1, E2);
  asm.sth(E1, ramDisp(col), RAM);
  loadHalfSplit(ctx, ramDisp(list) + 3, E0, E1, E2);
  asm.sth(E1, ramDisp(row), RAM);
  asm.inb(ramDisp(list) + 5, E0, T0);
  body();
  asm.ldh(ramDisp(cursor), RAM, E0);
  asm.addImm5(5, E0);
  asm.sth(E0, ramDisp(cursor), RAM);
  asm.ldh(ramDisp(limit), RAM, E1);
  asm.cmp(E1, E0);
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: VbCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.movImm32(GRID_EMPTY, T1);
        asm.cmp(T1, T0);
        ctx.far("e", next);
        // Is this legend entry one the rule names?
        emitTableLookup(ctx, ruleTileTableLabel(rule, level));
        asm.cmpImm5(0, T0);
        ctx.far("e", next);

        // A side the rule did not name is a contact that never happened: it does
        // not fire and it is not recorded either, so next tick's "was this seen
        // before" answers as the interpreter's does. Separation is unaffected —
        // what can hold an object up is not what a rule asked about.
        const mask = sideMask(event.sides);
        if (mask !== 0) {
          emitTileSide(ctx, base);
          asm.andi(mask, E0, E0);
          ctx.far("e", next);
        }
        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.movImm32(listBase + 1, E6);
          asm.jal("TileContactSeen");
          asm.cmpImm5(0, E6);
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
      asm.movImm32(GRID_EMPTY, T1);
      asm.cmp(T1, T0);
      ctx.far("e", next);
      asm.mov(T0, E3);
      emitTableLookup(ctx, level.solidLabel);
      asm.cmpImm5(0, T0);
      ctx.far("e", next);
      asm.mov(E3, T0);
      emitTableLookup(ctx, namedTable);
      asm.cmpImm5(0, T0);
      ctx.far("e", next);
      emitTileSeparate(ctx, base);
      asm.label(next);
    });
    asm.label(skip);
    // The table of tiles that can stop this subject, by legend index. A table
    // rather than a helper, because a helper is a *routine* here: `finish` emits
    // them one after another, so a byte table among them would leave the next
    // one starting on an odd address.
    ctx.data((data) => {
      data.label(namedTable);
      for (const tile of level.file.tiles) data.db(named.has(tile.name) ? 1 : 0);
      data.align(4);
    });
  }
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: VbCtx, rule: RuleDef, bind: Binding): void {
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
    ctx.jump(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  asm.inb(ramDisp(layout.words + W.tileCol * 2), RAM, E0);
  asm.inb(ramDisp(layout.words + W.tileRow * 2), RAM, E1);
  asm.shlImm5(8, E1);
  asm.or(E1, E0);
  asm.sth(E0, ramDisp(layout.words + W.cell * 2), RAM);
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: VbCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.stb(ZERO, ramDisp(layout.tileScratch), RAM);
  asm.inb(ramDisp(listBase), RAM, E0);
  asm.sth(E0, ramDisp(layout.words + W.target * 2), RAM);
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.inb(ramDisp(layout.tileScratch), RAM, E0);
  asm.movImm32(TILE_CONTACT_MAX, E1);
  asm.cmp(E1, E0);
  ctx.far("nl", full);
  asm.mov(E0, E1);
  asm.shlImm5(1, E1);
  asm.add(RAM, E1);
  asm.ldh(ramDisp(layout.words + W.cell * 2), RAM, E2);
  storeHalfSplit(ctx, E2, ramDisp(layout.tileScratch) + 1, E1, E3);
  asm.addImm5(1, E0);
  asm.stb(E0, ramDisp(layout.tileScratch), RAM);
  asm.label(full);
}

/**
 * Replace the pair's stored list with the one just built — only the entries that
 * exist, not the whole slot.
 */
function emitCommitContacts(ctx: VbCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("commit");
  asm.inb(ramDisp(layout.tileScratch), RAM, E0);
  asm.shlImm5(1, E0);
  asm.addImm5(1, E0); // the count byte itself travels with the entries
  asm.movImm32(layout.tileScratch, E1);
  asm.movImm32(listBase, E2);
  asm.label(loop);
  asm.ldb(0, E1, E3);
  asm.stb(E3, 0, E2);
  asm.addImm5(1, E1);
  asm.addImm5(1, E2);
  asm.addImm5(-1, E0);
  asm.bcond("nz", loop);
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles: an entry
 * event fires only when the answer is no, a level one fires regardless. The list
 * to search arrives in `E6` and the answer goes back the same way — one for
 * found, zero for not — because a decision on this processor is a register
 * rather than a flag (`rules.ts` §ANSWER).
 */
function emitTileContactHelper(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  asm.label("TileContactSeen");
  const loop = ctx.unique("seenLoop");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.inb(ramDisp(layout.words + W.target * 2), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", missing);
  asm.ldh(ramDisp(layout.words + W.cell * 2), RAM, E1);
  asm.label(loop);
  loadHalfSplit(ctx, 0, E6, E2, E3);
  asm.cmp(E1, E2);
  ctx.far("e", found);
  asm.addImm5(2, E6);
  asm.addImm5(-1, E0);
  asm.bcond("nz", loop);
  asm.label(missing);
  asm.mov(ZERO, E6);
  asm.ret();
  asm.label(found);
  asm.movImm32(1, E6);
  asm.ret();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: VbCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: VbEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);
  ctx.enter();

  // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places —
  // one instruction on this machine, because a register is the whole value.
  if (layout.camera !== null) {
    emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
    emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
  } else {
    asm.sth(ZERO, ramDisp(layout.words + W.camX * 2), RAM);
    asm.sth(ZERO, ramDisp(layout.words + W.camY * 2), RAM);
  }
  copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
  copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

  const noRedraw = ctx.unique("noRedraw");
  const afterScroll = ctx.unique("afterScroll");
  asm.inb(ramDisp(layout.redraw), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", noRedraw);
  emitFullRedraw(ctx, scene, level, options);
  storeByte(ctx, layout.redraw, 0);
  storeByte(ctx, layout.plotPrevCount, 0);
  ctx.jump(afterScroll);
  asm.label(noRedraw);
  if (level) emitScrollUpdate(ctx, level);
  asm.label(afterScroll);

  // One HUD, whether the scene scrolls or not: the caption plane holds still
  // under a moving camera, so there is nothing to pin and no sprite version of
  // any of this.
  emitHudErase(ctx);
  storeByte(ctx, layout.plotCount, 0);
  emitHud(ctx, scene, "dynamic");
  emitSwapPlots(ctx);
  emitOam(ctx, scene, options);
  ctx.leave();
}

/** `dst16 = floor(value * 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: VbCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldw(ramDisp(src), RAM, E0);
  asm.sarImm5(13, E0);
  asm.sth(E0, ramDisp(dst), RAM);
}

/**
 * Draw the whole visible window, with the drawing processor stopped.
 *
 * A screenful of map does not fit in one gap between frames, and the drawing
 * processor reads the map where the runtime writes it — so drawing goes off for
 * the length of the redraw and the frame it spans is the one the player does not
 * see change. It happens once a scene.
 */
function emitFullRedraw(
  ctx: VbCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: VbEmitOptions,
): void {
  const { asm, layout } = ctx;
  const off = poker(ctx);
  off(VB_XPCTRL, 0);

  // Every scene brings a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours and its backdrop; one without
  // brings the build's — the level tiles' and the objects' fit. Leaving the nine
  // registers alone would mean a level scene wearing whichever title screen the
  // player came from.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteBlock(ctx, label(palette ? scenePaletteLabel(scene) : "Palette"));

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is packed as whole map rows, so painting it is one walk with a
    // destination that only ever moves forward.
    asm.movImm32(label(backdropLabel(scene)), E4);
    asm.movImm32(VB_BGMAP + WORLD_MAP * VB_BGMAP_BYTES, E5);
    asm.jal(needBlitBackdrop(ctx));
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
    // sixteen columns and thirty-six rows the window never shows, so there is
    // always somewhere to put it.
    const height = layout.memory.viewH + (level !== undefined ? 1 : 0);
    const width = layout.memory.viewW + (level !== undefined ? 1 : 0);
    storeWord(ctx, rows, height);
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    storeWord(ctx, columns, width);
    asm.label(colLoop);
    emitBackgroundTile(ctx, level);
    asm.jal("PokeCellAt");
    inc16(ctx, layout.words + W.tileCol * 2);
    dec16(ctx, columns);
    asm.ldh(ramDisp(columns), RAM, E0);
    asm.cmpImm5(0, E0);
    ctx.far("ne", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    dec16(ctx, rows);
    asm.ldh(ramDisp(rows), RAM, E0);
    asm.cmpImm5(0, E0);
    ctx.far("ne", rowLoop);
  }

  // Captions go on now, with the plane they sit on: a static one is painted once
  // and never touches the per-frame queue again.
  emitFill(ctx, VB_BGMAP + HUD_MAP * VB_BGMAP_BYTES, VB_BGMAP_BYTES);
  emitHud(ctx, scene, "static");
  const on = poker(ctx);
  on(VB_XPCTRL, VB_XP_XPEN);
}

/** Store a constant into a render word. */
function storeWord(ctx: VbCtx, address: number, value: number): void {
  const { asm } = ctx;
  if ((value & 0xffff) === 0) {
    asm.sth(ZERO, ramDisp(address), RAM);
    return;
  }
  asm.movImm32(value & 0xffff, E0);
  asm.sth(E0, ramDisp(address), RAM);
}

/** `E4` = a packed map, `E5` = where it goes; unpack it into the BGMap. */
function needBlitBackdrop(ctx: VbCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");
    const out = inner.unique("blitDone");

    asm.label(next);
    asm.inb(0, E4, E0);
    asm.addImm5(1, E4);
    asm.cmpImm5(0, E0);
    inner.far("e", out);
    asm.andi(0x80, E0, E1);
    inner.far("ne", run);

    // The cells are read a byte at a time because the stream interleaves them
    // with control bytes, so half of them sit at odd addresses — and an odd
    // `ld.h` on this processor reads the halfword below it and says nothing.
    asm.label(literal);
    loadHalfSplit(inner, 0, E4, E1, E2);
    asm.addImm5(2, E4);
    asm.sth(E1, 0, E5);
    asm.addImm5(2, E5);
    asm.addImm5(-1, E0);
    asm.bcond("nz", literal);
    inner.jump(next);

    asm.label(run);
    asm.andi(0x7f, E0, E0);
    loadHalfSplit(inner, 0, E4, E1, E2);
    asm.addImm5(2, E4);
    asm.label(runLoop);
    asm.sth(E1, 0, E5);
    asm.addImm5(2, E5);
    asm.addImm5(-1, E0);
    asm.bcond("nz", runLoop);
    inner.jump(next);

    asm.label(out);
    asm.ret();
  });
}

/** The labels holding one scene's map and palette block. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}

/**
 * `E3` = the map word that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: VbCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.movImm32(BLANK_CELL, E3);
    return;
  }
  asm.jal(tileAtLabel(level));
  emitLegendToTile(ctx, level);
}

/** `E3` = the map word for the legend index in `T0`. */
function emitLegendToTile(ctx: VbCtx, level: LevelData): void {
  const { asm } = ctx;
  const empty = ctx.unique("legendEmpty");
  const done = ctx.unique("legendDone");
  asm.movImm32(GRID_EMPTY, T1);
  asm.cmp(T1, T0);
  ctx.far("e", empty);
  // The two tables are the low and high halves of the word, so this is two
  // indexed loads and one shift.
  asm.movImm32(label(level.tileLabel), T1);
  asm.add(T0, T1);
  asm.inb(0, T1, E3);
  asm.movImm32(label(level.attrLabel), T1);
  asm.add(T0, T1);
  asm.inb(0, T1, T2);
  asm.shlImm5(8, T2);
  asm.or(T2, E3);
  ctx.jump(done);
  asm.label(empty);
  asm.movImm32(BLANK_CELL, E3);
  asm.label(done);
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: VbCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.ldh(ramDisp(src), RAM, E0);
    asm.sarImm5(3, E0);
    asm.sth(E0, ramDisp(dst), RAM);
  };
  shift(layout.words + W.camX * 2, dstCol);
  shift(layout.words + W.camY * 2, dstRow);
}

/**
 * Bring the map up to date after the camera moved.
 *
 * The world's own source origin does the moving, so crossing a cell boundary
 * costs one column or one row of writes and nothing else. A jump too large to
 * walk sets the full-redraw flag instead of silently dropping cells off the end
 * of the queue.
 */
function emitScrollUpdate(ctx: VbCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  ctx.jump(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  storeByte(ctx, layout.redraw, 1);
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
 * is sixteen columns wider and thirty-six rows taller than the window.
 */
function emitWalkAxis(
  ctx: VbCtx,
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

  storeWord(ctx, guard, 5);
  asm.label(loop);
  dec16(ctx, guard);
  asm.ldh(ramDisp(guard), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", bail);
  asm.ldh(ramDisp(want), RAM, E0);
  asm.ldh(ramDisp(origin), RAM, E1);
  asm.cmp(E1, E0);
  ctx.far("e", done);
  ctx.far("lt", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  ctx.jump(loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, 0);
  ctx.jump(loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: VbCtx, level: LevelData, isColumn: boolean, offset: number): void {
  const { asm, layout } = ctx;
  const along = isColumn ? layout.words + W.tileRow * 2 : layout.words + W.tileCol * 2;
  const across = isColumn ? layout.words + W.tileCol * 2 : layout.words + W.tileRow * 2;
  const originAcross = isColumn ? layout.words + W.mapCol * 2 : layout.words + W.mapRow * 2;
  const originAlong = isColumn ? layout.words + W.mapRow * 2 : layout.words + W.mapCol * 2;
  const count = (isColumn ? layout.memory.viewH : layout.memory.viewW) + 1;
  const remaining = layout.words + W.lastRow * 2;
  // Not `temp` and not `count`: the cached cell walk uses one for its limit and
  // the scroll walk uses the other for its guard, and a counter clobbered
  // mid-loop paints a strip of whatever tile the count happened to land on.

  copy16(ctx, across, originAcross);
  if (offset !== 0) {
    asm.ldh(ramDisp(across), RAM, E0);
    asm.movImm32(offset, E1);
    asm.add(E1, E0);
    asm.sth(E0, ramDisp(across), RAM);
  }
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  storeWord(ctx, remaining, count);
  asm.label(loop);
  asm.jal(tileAtLabel(level));
  emitLegendToTile(ctx, level);
  asm.jal("QueueCellAt");
  inc16(ctx, along);
  dec16(ctx, remaining);
  asm.ldh(ramDisp(remaining), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("ne", loop);
}

/** Blank the cells the HUD covered last frame. */
function emitHudErase(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  asm.inb(ramDisp(layout.plotPrevCount), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", done);
  asm.movImm32(layout.plotPrev, E6);
  asm.label(loop);
  // The caption plane is transparent where nothing is drawn, so erasing is one
  // blank cell rather than a lookup into whatever the world put there — which is
  // the whole saving of giving the HUD a plane of its own. The list stores the
  // cell itself, so nothing has to be recomputed.
  asm.ldh(0, E6, E1);
  asm.ori(HUD_MAP << 12, E1, E1);
  asm.movImm32(BLANK_CELL, E3);
  asm.jal("QueueEntry");
  asm.addImm5(2, E6);
  asm.inb(ramDisp(layout.plotPrevCount), RAM, E0);
  asm.addImm5(-1, E0);
  asm.stb(E0, ramDisp(layout.plotPrevCount), RAM);
  asm.cmpImm5(0, E0);
  ctx.far("ne", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  const loop = ctx.unique("swapLoop");
  asm.inb(ramDisp(layout.plotCount), RAM, E0);
  asm.stb(E0, ramDisp(layout.plotPrevCount), RAM);
  asm.cmpImm5(0, E0);
  ctx.far("e", done);
  asm.movImm32(layout.plot, E1);
  asm.movImm32(layout.plotPrev, E2);
  asm.label(loop);
  asm.ldh(0, E1, E3);
  asm.sth(E3, 0, E2);
  asm.addImm5(2, E1);
  asm.addImm5(2, E2);
  asm.addImm5(-1, E0);
  asm.bcond("nz", loop);
  asm.label(done);
}

/** Draw the scene's `number` and `text` objects on the caption plane. */
function emitHud(ctx: VbCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    asm.ldh(ramDisp(base + propOffset("x") + 2), RAM, E0);
    if (layout.camera !== null) {
      asm.ldh(ramDisp(layout.camera + 2), RAM, E1);
      asm.sub(E1, E0);
    }
    asm.sth(E0, ramDisp(layout.words + W.tileCol * 2), RAM);
    asm.ldh(ramDisp(base + propOffset("y") + 2), RAM, E0);
    if (layout.camera !== null) {
      asm.ldh(ramDisp(layout.camera + 6), RAM, E1);
      asm.sub(E1, E0);
    }
    asm.sth(E0, ramDisp(layout.words + W.tileRow * 2), RAM);

    // A static caption is painted straight into the plane with drawing already
    // stopped, so it needs neither the write queue nor a place in the erase list.
    const plot = want === "static" ? needPokeGlyph(ctx) : "PlotCell";
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.movImm32(mapWord(glyphTile(character), SYSTEM_PALETTE), E3);
        asm.jal(plot);
      }
    } else {
      asm.movImm32(base + propOffset("value") + 2, E6);
      asm.jal(want === "static" ? needPokeNumber(ctx) : "DrawNumber");
    }
    asm.label(skip);
  }
}

/** `E3` = a map word: write it into the caption plane and advance the column. */
function needPokeGlyph(ctx: VbCtx): Ref {
  return ctx.need("PokeGlyph", (inner) => {
    const { asm, layout } = inner;
    inner.enter();
    asm.jal("PokeHudAt");
    inc16(inner, layout.words + W.tileCol * 2);
    inner.leave();
  });
}

/** The decimal renderer again, writing straight into the plane. */
function needPokeNumber(ctx: VbCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => {
    emitDecimal(inner, needPokeGlyph(inner));
  });
}

/**
 * `E1` = entity base, `E2`/`E3` = the size in cells → `E0` is one when the object
 * may be inside the view and zero when it is certainly outside.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * half of a 16.16 coordinate *is* the cell it sits in. The margins are rounded
 * outward by a cell, so an object straddling the edge is never culled — the test
 * may say "maybe" when the answer is no, and never the other way round.
 */
function needOnscreen(ctx: VbCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");

    const axis = (offset: number, margin: number, span: number): void => {
      asm.ldh(offset + 2, E1, E0);
      asm.ldh(ramDisp(camera + offset + 2), RAM, E4);
      asm.sub(E4, E0);
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.mov(E0, E5);
      asm.add(margin, E5);
      asm.cmpImm5(0, E5);
      inner.far("lt", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.movImm32(span + 1, E4);
      asm.cmp(E4, E0);
      inner.far("ge", apart);
    };
    axis(propOffset("x"), E2, layout.memory.viewW);
    axis(propOffset("y"), E3, layout.memory.viewH);

    asm.movImm32(1, E0);
    asm.ret();
    asm.label(apart);
    asm.mov(ZERO, E0);
    asm.ret();
  });
}

/** Build the object shadow from the scene's sprite objects. */
function emitOam(ctx: VbCtx, scene: SceneCtx, options: VbEmitOptions): void {
  const { asm, layout, program } = ctx;
  storeByte(ctx, layout.oamCount, 0);

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
      asm.movImm32(base, E1);
      asm.movImm32(width, E2);
      asm.movImm32(height, E3);
      asm.jal(needOnscreen(ctx));
      asm.cmpImm5(0, E0);
      ctx.far("e", skip);
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

    const palette = art ? (art.palette ?? 0) : SYSTEM_OBJECT_PALETTE;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE;
        asm.ldh(ramDisp(layout.words + W.cell * 2), RAM, E4);
        if (column !== 0) {
          asm.movImm32(column * 8, E0);
          asm.add(E0, E4);
        }
        asm.ldh(ramDisp(layout.words + W.count * 2), RAM, E5);
        if (row !== 0) {
          asm.movImm32(row * 8, E0);
          asm.add(E0, E5);
        }
        asm.movImm32(objectWord(tile, palette), E3);
        asm.jal(needPushSprite(ctx));
      }
    }
    asm.label(skip);
  }

  // The entry one past the end is the list's terminator: both eye bits clear, so
  // the drawing processor evaluates it and draws nothing. That is what makes a
  // frame with no objects at all expressible — the `SPT` registers name a *last*
  // entry rather than a count, so there is no way to say "none".
  asm.inb(ramDisp(layout.oamCount), RAM, E0);
  asm.shlImm5(3, E0);
  asm.movImm32(layout.memory.oamShadow, E1);
  asm.add(E0, E1);
  asm.sth(ZERO, 2, E1);
}

/**
 * `E3` = the attribute word, `E4` = x, `E5` = y; append an entry to the shadow.
 *
 * **An entry off the screen is dropped rather than clipped.** An object's
 * vertical position here is eight unsigned bits, so a sprite four pixels above
 * the screen is not a coordinate this hardware has — and the horizontal test
 * follows it rather than using the ten signed bits it does have, because two
 * axes with different rules is the kind of asymmetry that shows up as one edge
 * of the screen behaving differently from the other.
 *
 * The parallax is a constant: every object in a demade scene sits at
 * {@link VB_DEPTH}`.object`, in front of the scenery it is drawn over.
 */
function needPushSprite(ctx: VbCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const skip = inner.unique("oamOff");
    asm.movImm32(layout.memory.viewW * 8, E0);
    asm.cmp(E0, E4);
    inner.far("nl", skip);
    asm.movImm32(layout.memory.viewH * 8, E0);
    asm.cmp(E0, E5);
    inner.far("nl", skip);
    asm.inb(ramDisp(layout.oamCount), RAM, E0);
    asm.movImm32(layout.memory.oamEntries, E1);
    asm.cmp(E1, E0);
    inner.far("nl", skip);
    asm.mov(E0, E1);
    asm.shlImm5(3, E1);
    asm.movImm32(layout.memory.oamShadow, E2);
    asm.add(E2, E1);
    asm.sth(E4, 0, E1);
    asm.movImm32((VB_OBJ_JRON | VB_OBJ_JLON | (vbParallax(VB_DEPTH.object) & 0x3fff)) & 0xffff, E2);
    asm.sth(E2, 2, E1);
    asm.sth(E5, 4, E1);
    asm.sth(E3, 6, E1);
    asm.addImm5(1, E0);
    asm.stb(E0, ramDisp(layout.oamCount), RAM);
    asm.label(skip);
    asm.ret();
  });
}

// --- shared render routines --------------------------------------------------

/**
 * `E1` = the cell in `words[tileCol]`/`words[tileRow]`, as an index into a
 * BGMap.
 *
 * Both wraps are powers of two, so this is two masks, a shift and an `or` — the
 * whole of scrolling's arithmetic on this console. Inlined rather than called
 * because `jal` returns through a register: four call sites at six instructions
 * apiece is cheaper than four routines that have to stack a return address.
 */
function emitCellOffset(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  asm.ldh(ramDisp(layout.words + W.tileRow * 2), RAM, E1);
  asm.andi(MAP_H - 1, E1, E1);
  asm.shlImm5(6, E1);
  asm.ldh(ramDisp(layout.words + W.tileCol * 2), RAM, E2);
  asm.andi(MAP_W - 1, E2, E2);
  asm.or(E2, E1);
}

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: VbCtx): void {
  const { asm, layout } = ctx;

  // `E3` = a map word: write it straight into the world plane, or the caption's.
  const poke = (name: string, map: number): void => {
    asm.label(name);
    emitCellOffset(ctx);
    asm.shlImm5(1, E1);
    asm.movImm32(VB_BGMAP + map * VB_BGMAP_BYTES, E2);
    asm.add(E2, E1);
    asm.sth(E3, 0, E1);
    asm.ret();
  };
  poke("PokeCellAt", WORLD_MAP);
  poke("PokeHudAt", HUD_MAP);

  // The same two, queued rather than written: the drawing processor reads the
  // map for most of the frame, so anything built outside the gap after it
  // finishes waits in a list until there is one.
  const queue = (name: string, map: number): void => {
    asm.label(name);
    emitCellOffset(ctx);
    if (map !== 0) asm.ori(map << 12, E1, E1);
    ctx.jump("QueueEntry");
  };
  queue("QueueCellAt", WORLD_MAP);
  queue("QueueHudAt", HUD_MAP);

  // `E1` = the cell and its plane, `E3` = the word: append a four-byte entry.
  // The plane rides in bits above the cell rather than being a second field,
  // because a BGMap is four thousand and ninety-six cells and a halfword holds
  // both with three bits to spare.
  asm.label("QueueEntry");
  const room = ctx.unique("queueRoom");
  asm.inb(ramDisp(layout.queueCount), RAM, E0);
  asm.movImm32(layout.memory.queueMax, E2);
  asm.cmp(E2, E0);
  ctx.far("lt", room);
  // No room: repaint the whole background next frame rather than leave a strip
  // of it stale for ever.
  storeByte(ctx, layout.redraw, 1);
  asm.ret();
  asm.label(room);
  asm.mov(E0, E2);
  asm.shlImm5(2, E2);
  asm.add(RAM, E2);
  asm.sth(E1, ramDisp(layout.queue), E2);
  asm.sth(E3, ramDisp(layout.queue) + 2, E2);
  asm.addImm5(1, E0);
  asm.stb(E0, ramDisp(layout.queueCount), RAM);
  asm.ret();

  // `E3` = a map word: queue it as one caption cell, record the cell for
  // erasing, and advance the column.
  asm.label("PlotCell");
  const plotFull = ctx.unique("plotFull");
  emitCellOffset(ctx);
  asm.inb(ramDisp(layout.plotCount), RAM, E0);
  asm.movImm32(layout.memory.plotMax, E2);
  asm.cmp(E2, E0);
  ctx.far("nl", plotFull);
  asm.mov(E0, E2);
  asm.shlImm5(1, E2);
  asm.add(RAM, E2);
  asm.sth(E1, ramDisp(layout.plot), E2);
  asm.addImm5(1, E0);
  asm.stb(E0, ramDisp(layout.plotCount), RAM);
  asm.label(plotFull);
  asm.ori(HUD_MAP << 12, E1, E1);
  inc16(ctx, layout.words + W.tileCol * 2);
  ctx.jump("QueueEntry");

  emitUploadFrame(ctx);

  asm.label("DrawNumber");
  emitDecimal(ctx, "PlotCell");

  asm.align(4);
  asm.label("DecimalPowers");
  for (const power of [10000, 1000, 100, 10, 1]) asm.dw(power);
}

/**
 * Flush the queue, copy the objects across, and move the scenery world.
 *
 * All three run in the gap after the drawing processor has finished the frame,
 * which is the only time this console's memory is nobody else's. The queue is
 * capped at what the gap will hold and anything over sets the redraw flag
 * instead of being dropped.
 */
function emitUploadFrame(ctx: VbCtx): void {
  const { asm, layout } = ctx;
  asm.label("UploadFrame");

  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.inb(ramDisp(layout.queueCount), RAM, E0);
  asm.cmpImm5(0, E0);
  ctx.far("e", noQueue);
  asm.movImm32(layout.queue, E1);
  asm.movImm32(VB_BGMAP, E6);
  asm.label(flush);
  asm.ldh(0, E1, E2);
  asm.ldh(2, E1, E3);
  // The plane's own BGMap is eight kilobytes on, and a cell is a halfword —
  // so the entry's two fields become one address with two shifts.
  asm.mov(E2, E4);
  asm.shrImm5(12, E4);
  asm.shlImm5(13, E4);
  asm.andi(0x0fff, E2, E2);
  asm.shlImm5(1, E2);
  asm.add(E4, E2);
  asm.add(E6, E2);
  asm.sth(E3, 0, E2);
  asm.addImm5(4, E1);
  asm.addImm5(-1, E0);
  asm.bcond("nz", flush);
  asm.stb(ZERO, ramDisp(layout.queueCount), RAM);
  asm.label(noQueue);

  // The objects, and the terminator past them. The `SPT` registers name the last
  // entry of each of the four groups; three are left empty by giving them all the
  // same value, so the fourth object world draws group 0 and it holds everything.
  const copyObj = ctx.unique("copyObj");
  asm.inb(ramDisp(layout.oamCount), RAM, E0);
  asm.movImm32(VB_SPT0, E4);
  asm.sth(E0, 0, E4);
  asm.sth(E0, 2, E4);
  asm.sth(E0, 4, E4);
  asm.sth(E0, 6, E4);
  asm.addImm5(1, E0);
  asm.movImm32(layout.memory.oamShadow, E1);
  asm.movImm32(VB_OAM, E2);
  asm.label(copyObj);
  asm.ldw(0, E1, E3);
  asm.stw(E3, 0, E2);
  asm.ldw(4, E1, E3);
  asm.stw(E3, 4, E2);
  asm.addImm5(8, E1);
  asm.addImm5(8, E2);
  asm.addImm5(-1, E0);
  asm.bcond("nz", copyObj);

  // Scrolling: the world's source origin, and nothing else. The map wraps at 512
  // pixels on both axes, which is a power of two, so there is no arithmetic here
  // at all.
  asm.movImm32(VB_WORLDS + WORLD_SCENERY * VB_WORLD_BYTES, E0);
  asm.ldh(ramDisp(layout.words + W.scrollX * 2), RAM, E1);
  asm.sth(E1, VB_WORLD_MX, E0);
  asm.ldh(ramDisp(layout.words + W.scrollY * 2), RAM, E1);
  asm.sth(E1, VB_WORLD_MY, E0);
  asm.ret();
}

/**
 * Draw the signed 16-bit value `E6` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the static HUD and the queued one — which is why
 * it is a parameter rather than a second copy of the digit loop.
 *
 * **A digit is a division here.** This processor divides in hardware, so a digit
 * is `div` against the power and the remainder is what is left to print; the
 * leading zeroes are then never produced rather than suppressed, because four
 * comparisons pick the power to start at. Every 8-bit backend in this project
 * walks the powers of ten by subtraction instead, and on the console with the
 * shortest frame in the set that cost an eighth of a tick.
 */
function emitDecimal(ctx: VbCtx, plot: Ref): void {
  const { asm, layout } = ctx;
  // Everything here has to survive a call to `plot`, and `plot` reaches the write
  // queue — which uses every emitter register there is. So the digit loop keeps
  // its state in the render words instead, in slots nothing on that path touches:
  // not the pen, not the cell being written, and — the one that actually bites —
  // **not the map origin**, which has to survive from one frame to the next.
  const value = layout.words + W.firstCol * 2;
  const power = layout.words + W.lastCol * 2;

  ctx.enter();
  asm.ldh(0, E6, E0);

  const positive = ctx.unique("numPos");
  const chosen = ctx.unique("numChosen");
  asm.cmpImm5(0, E0);
  ctx.far("ge", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.mov(ZERO, E1);
  asm.sub(E0, E1);
  asm.sth(E1, ramDisp(value), RAM);
  asm.movImm32(mapWord(glyphTile("-"), SYSTEM_PALETTE), E3);
  asm.jal(plot);
  asm.ldh(ramDisp(value), RAM, E0);
  ctx.jump(chosen);
  asm.label(positive);
  asm.sth(E0, ramDisp(value), RAM);
  asm.label(chosen);

  // The power to start at, as a byte offset into `DecimalPowers`. The value is
  // known non-negative by here, and every target is a few instructions along, so
  // these are short branches with no call between them.
  const picked = ctx.unique("numPicked");
  asm.movImm32(8, E2);
  asm.movImm32(10, E1);
  asm.cmp(E1, E0);
  asm.bcond("lt", picked);
  asm.movImm32(6, E2);
  asm.movImm32(100, E1);
  asm.cmp(E1, E0);
  asm.bcond("lt", picked);
  asm.movImm32(4, E2);
  asm.movImm32(1000, E1);
  asm.cmp(E1, E0);
  asm.bcond("lt", picked);
  asm.movImm32(2, E2);
  asm.movImm32(10000, E1);
  asm.cmp(E1, E0);
  asm.bcond("lt", picked);
  asm.mov(ZERO, E2);
  asm.label(picked);
  asm.sth(E2, ramDisp(power), RAM);

  const digitLoop = ctx.unique("numDigit");
  asm.label(digitLoop);
  asm.ldh(ramDisp(power), RAM, E0);
  asm.movImm32(label("DecimalPowers"), E1);
  asm.add(E0, E1);
  asm.ldh(0, E1, E1);
  asm.ldh(ramDisp(value), RAM, E0);
  // The quotient is the digit and the remainder is the rest of the number, and
  // the remainder arrives in `r30` whether the caller wanted it or not — so what
  // is left has to be stored before anything else touches that register.
  asm.div(E1, E0);
  asm.sth(HI, ramDisp(value), RAM);
  asm.movImm32(mapWord(glyphTile("0"), SYSTEM_PALETTE), E3);
  asm.add(E0, E3);
  asm.jal(plot);
  asm.ldh(ramDisp(power), RAM, E0);
  asm.addImm5(2, E0);
  asm.sth(E0, ramDisp(power), RAM);
  asm.movImm32(10, E1);
  asm.cmp(E1, E0);
  ctx.far("ne", digitLoop);
  ctx.leave();
}

/** What the emitter re-exports for the backend and its tests. */
export { MAP_W as VB_MAP_W, MAP_H as VB_MAP_H };
