/**
 * The whole-program emitter for the Game Boy Advance: boot, the frame, the
 * renderer.
 *
 * Everything here is per *scene*, for the reason the other five backends give: a
 * scene is what the machine is doing at any moment and the compiler knows which
 * one. What differs is all hardware, and five differences are load-bearing.
 *
 *   - **The HUD gets a layer of its own.** This is the first console in the set
 *     with more than one background, so a caption is background cells on a layer
 *     that never scrolls rather than hardware sprites. The whole mechanism the
 *     other five need — a sprite HUD for a scrolling scene, a second decimal
 *     renderer to drive it, a pin that jitters by up to seven pixels if anything
 *     goes wrong — is *absent* here, and a HUD cell is `floor(pos) − floor(cam)`
 *     whatever the camera's sub-cell offset is, so it cannot jitter at all.
 *   - **A cell has 256 colours and no palette field.** In 8bpp a screen entry is
 *     ten bits of tile and two flip bits, and the palette-select nibble is
 *     ignored — so a picture is not partitioned into sub-palettes at all and the
 *     art path fits one palette of 256 (`gba-art.ts`). Colour zero is still
 *     transparent, which is what makes it the shared backdrop the spec declares.
 *   - **Backgrounds and objects have separate character memory and separate
 *     palettes.** 64 KiB and 256 colours for the tilemaps, 32 KiB and another 256
 *     for the objects. Every other console here shares one bank between them and
 *     has to divide it; this one does not, so a sprite's colours cost a backdrop
 *     nothing.
 *   - **The map is bigger than the screen on both axes, and it is four blocks.**
 *     64×64 cells against 30×20, so a scrolling scene paints its leading edge
 *     where nobody is looking and there is no seam to mask. But "the cell after
 *     column 31" is a kilobyte away rather than one halfword — the Super
 *     Nintendo's hazard with two more blocks — so {@link needCellOffset} computes
 *     the address the hardware's way rather than as a rectangle.
 *   - **The processor writes video RAM and DMA uploads it.** There is no port and
 *     no control word: video RAM, palette and attribute memory are ordinary
 *     halfword-wide addresses. The boot's bulk copies go across DMA channel 3
 *     because that is what the hardware is for; everything per-frame is the write
 *     queue, exactly as on every other console.
 *
 * The tick order, the rule bodies and every compile-time decision are shared
 * with the other backends (`backend.ts`, `shape.ts`). Nothing in this file
 * decides what the game does.
 *
 * **The register convention this file adds to `regs.ts`:** every routine here
 * preserves `r4`–`r11`. The decimal renderer keeps its whole state in them
 * across a call to the routine that plots a glyph, which is what makes it a
 * register loop where the Mega Drive's is a memory one — and it is only sound
 * because no routine it reaches spends a callee-saved register without saving it.
 */

import {
  armAsr,
  armAt,
  armAtIdx,
  armAtPost,
  armImm,
  armLsl,
  armLsr,
  armReg,
  GBA_HEADER_SIZE,
  GBA_IRQ_VECTOR,
  GBA_ORIGIN,
  label,
  type Ref,
} from "@demake/core";

import type { InstanceDef, RuleDef } from "../../program.js";
import { glyphTile, patternTile } from "../../rom/graphics.js";
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
  tileCellsCacheable,
  type SceneCtx,
  type SpriteArt,
} from "../shape.js";

import type { GbaCtx } from "./ctx.js";
import { emitTest, propOffset, type Binding } from "./expr.js";
import { A0, A1, A2, A3, ADDR, LR, PC, V0, V1, V2, V3 } from "./regs.js";
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
import { at, branchZero32, copy32, mem, sub32 } from "./val.js";

/** Where a cartridge is mapped, and therefore where its code is assembled. */
export const CODE_ORIGIN = GBA_ORIGIN;

/** The hardware register page. */
const IO = 0x04000000;

/** Background palette memory: 256 entries of RGB555. */
const PAL_BG = 0x05000000;

/** Object palette memory: another 256, which nothing shares with the tilemaps. */
const PAL_OBJ = 0x05000200;

/** Video RAM. The first 64 KiB is background character data and maps. */
const VRAM = 0x06000000;

/** Where object character data starts, inside the same region. */
const OBJ_VRAM = 0x06010000;

/** Object attribute memory. */
const OAM = 0x07000000;

/** The registers this backend touches, as offsets into the I/O page. */
const REG = {
  DISPCNT: 0x000,
  BG0CNT: 0x008,
  BG1CNT: 0x00a,
  BG0HOFS: 0x010,
  BG0VOFS: 0x012,
  BG1HOFS: 0x014,
  BG1VOFS: 0x016,
  DMA3SAD: 0x0d4,
  DMA3DAD: 0x0d8,
  DMA3CNT: 0x0dc,
  KEYINPUT: 0x130,
  IE: 0x200,
  IF: 0x202,
  WAITCNT: 0x204,
  IME: 0x208,
} as const;

/** `DISPSTAT`, whose vertical-blank enable is what raises the frame interrupt. */
const REG_DISPSTAT = 0x004;

/** Where the tables live inside video RAM, which the control registers decide. */
const CHAR_BASE = 0x0000;
/** The scrolling background's map: screen blocks 24–27, 64×64 cells. */
const MAP_BASE = 0xc000;
/** The HUD layer's map: screen block 28, 32×32 cells. */
const HUD_BASE = 0xe000;

/** Bytes one 256-colour tile occupies. */
export const TILE_BYTES = 64;

/**
 * Tiles the background bank holds.
 *
 * Everything below the first screen block, which is 48 KiB — three times what a
 * Mega Drive has for the same job, and the reason a demade backdrop here is
 * never the thing that runs out.
 */
export const BANK_TILES = (MAP_BASE - CHAR_BASE) / TILE_BYTES;

/**
 * Tiles the object bank holds: the whole 32 KiB of object character memory.
 *
 * A separate bank, not a share of the background's — which is what makes this
 * console's sprite budget independent of how expensive its backdrops are.
 */
export const OBJ_TILES = 0x8000 / TILE_BYTES;

/** Cells the scrolling map holds. Both are powers of two, so a wrap is a mask. */
const MAP_W = 64;
const MAP_H = 64;

/** Cells the HUD layer's map holds. */
const HUD_W = 32;
const HUD_H = 32;

/** Cells a packed backdrop pads its rows to: one screen block is 32 wide. */
export const PACK_W = 32;

/** Colours in one palette. */
export const PALETTE_COLORS = 256;

/**
 * Colours a demade picture may use, of the 256 each palette holds.
 *
 * The last three are the runtime's — the font's ink ramp on the background side
 * and the placeholder block's on the object side — reserved for the reason every
 * other backend reserves a sub-palette: a caption drawn in a title screen's own
 * colours is a caption nobody can read. Three rather than sixteen because this
 * console has no sub-palette structure to round up to, so the reservation costs
 * a picture 1.2% of its colours instead of a quarter of them.
 */
export const ART_COLORS = PALETTE_COLORS - 3;

/** Where the brightest of the built-in bank's four shades lands. */
export const SYSTEM_INK = PALETTE_COLORS - 1;

/** The cell a blank HUD square and an empty background cell draw. */
const BLANK_CELL = 0;

/**
 * Which layer is in front of which.
 *
 * The HUD is in front of everything, because a score behind the player is a
 * score nobody can read — and because that is what the other five backends
 * already do for a scrolling scene, where the HUD is drawn with sprites. Objects
 * sit between it and the picture.
 */
const HUD_PRIORITY = 0;
const OBJ_PRIORITY = 1;
const BG_PRIORITY = 2;

/** `BG0CNT`: priority 2, character block 0, 256 colours, screen block 24, 64×64. */
const BG0CNT = 0xc000 | ((MAP_BASE / 0x800) << 8) | 0x80 | BG_PRIORITY;

/** `BG1CNT`: priority 0, character block 0, 256 colours, screen block 28, 32×32. */
const BG1CNT = ((HUD_BASE / 0x800) << 8) | 0x80 | HUD_PRIORITY;

/** `DISPCNT`: mode 0, both tilemaps, objects, one-dimensional object mapping. */
const DISPCNT = 0x0040 | 0x0100 | 0x0200 | 0x1000;

/** The same with the forced blank a full redraw runs under. */
const DISPCNT_BLANK = DISPCNT | 0x0080;

/**
 * `WAITCNT` as the boot leaves it: three cycles for a first cartridge access and
 * one for a sequential, with the prefetch buffer on.
 *
 * A game's instructions are fetched from the cartridge on every cycle it runs,
 * so this register is the single largest thing a build can do about its own
 * speed — the reset default is five and eight, which is roughly twice as slow.
 */
const WAITCNT = 0x4317;

/** Where the stack is when a cartridge starts, which nothing here moves. */
const STACK_TOP = 0x03007f00;

/** The byte the frame interrupt raises and the main loop waits on. */
function frameFlag(ctx: GbaCtx): number {
  return ctx.layout.interrupt as number;
}

/** Everything the emitter needs beyond the program itself. */
export interface GbaEmitOptions {
  /** Converted object art, keyed by the asset name a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, SpriteArt>;
  /** Converted level tile art, keyed by the art file a `.dmtl` legend named. */
  tiles?: ReadonlyMap<string, { tile: number }>;
  /** Demade backdrops by scene name: the map the picture fills, packed. */
  backdrops?: ReadonlyMap<string, { map: Uint8Array }>;
  /** The background tile bank, uploaded to video RAM at boot. */
  bank?: Uint8Array;
  /** The object tile bank, uploaded to the other half of video RAM. */
  objectBank?: Uint8Array;
  /** The background palette: 256 little-endian RGB555 halfwords. */
  palette?: Uint8Array;
  /** The object palette, the same shape. */
  objectPalette?: Uint8Array;
  /** Per-scene background palettes, where a backdrop chose its own. */
  scenePalettes?: ReadonlyMap<string, Uint8Array>;
}

// --- small shapes ------------------------------------------------------------

/** Write a compile-time halfword to a hardware register. */
function setIo(ctx: GbaCtx, offset: number, value: number): void {
  const { asm } = ctx;
  asm.movImm32(A0, value);
  asm.movImm32(ADDR, IO + offset);
  asm.strh(A0, armAt(ADDR, 0));
}

/**
 * Copy or fill through DMA channel 3.
 *
 * The hardware's own answer to "move forty-eight kilobytes into video RAM", and
 * it is used only at boot: everything per-frame goes through the write queue,
 * which is what the blanking interval is actually for. A fill points the source
 * at one word and holds it there, which is how a map is blanked without a table
 * of zeroes in the cartridge.
 */
function emitDma(ctx: GbaCtx, source: Ref, dest: number, words: number, fill = false): void {
  const { asm } = ctx;
  if (words <= 0) return;
  asm.movImm32(ADDR, IO + REG.DMA3SAD);
  asm.movImm32(A0, source);
  asm.str(A0, armAt(ADDR, 0));
  asm.movImm32(A0, dest);
  asm.str(A0, armAt(ADDR, 4));
  // The count and the control word in one store: the enable bit is the last
  // thing written, which is what starts the transfer.
  asm.movImm32(A0, (((0x8400 | (fill ? 0x0100 : 0)) << 16) | (words & 0xffff)) >>> 0);
  asm.str(A0, armAt(ADDR, 8));
}

/** Copy `bytes` from a cartridge label into work RAM, three words at a time. */
function emitCopyBlock(ctx: GbaCtx, source: Ref, dest: number, bytes: number): void {
  const { asm } = ctx;
  asm.movImm32(A0, source);
  asm.movImm32(A1, dest);
  let left = bytes / 4;
  while (left >= 3) {
    asm.ldm(A0, [A2, A3, ADDR], "ia", true);
    asm.stm(A1, [A2, A3, ADDR], "ia", true);
    left -= 3;
  }
  while (left > 0) {
    asm.ldr(A2, armAtPost(A0, 4));
    asm.str(A2, armAtPost(A1, 4));
    left -= 1;
  }
}

/**
 * Dispatch on the running scene.
 *
 * `ldr pc, [table, index lsl #2]` is the whole of it — one instruction, because
 * this is the only machine in the set whose program counter is an ordinary
 * register a load can write. The Mega Drive needs five instructions for the same
 * table and the three 8-bit consoles emit a chain of comparisons instead.
 */
function emitSceneDispatch(ctx: GbaCtx, labels: readonly string[]): void {
  const { asm, layout } = ctx;
  if (labels.length === 1) {
    asm.b(labels[0] as string);
    return;
  }
  const table = ctx.unique("sceneTable");
  asm.ldrb(A0, mem(ctx, layout.scene));
  asm.movImm32(A1, label(table));
  asm.ldr(PC, armAtIdx(A1, A0, "lsl", 2));
  ctx.data((data) => {
    data.align();
    data.label(table);
    for (const target of labels) data.dw(label(target));
  });
}

/**
 * A routine a dispatcher jumps into rather than calls.
 *
 * The dispatcher saved `lr`, so the body returns by popping it straight into the
 * program counter — the same spelling {@link GbaCtx.exit} uses, and the reason a
 * scene's tick can be a jump target without costing a second stack frame.
 */
function emitTail(ctx: GbaCtx, name: string, body: () => void): void {
  ctx.asm.label(name);
  body();
  ctx.asm.pop([PC]);
  ctx.asm.ltorg();
}

// --- the program -------------------------------------------------------------

/** Emit the whole program. */
export function emitProgram(ctx: GbaCtx, options: GbaEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  // The first word of a cartridge is an instruction, not a vector: the console
  // begins executing at `$08000000` and what has to be there is a branch over
  // the header that follows it (`core/src/asm/gba-cart.ts`).
  asm.b("Reset");
  asm.padTo(CODE_ORIGIN + GBA_HEADER_SIZE);

  emitReset(ctx, options);
  emitVblank(ctx);
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
  asm.align();
  for (const level of levels) {
    const boundTile = (index: number): number => {
      const art = level.file.tiles[index]?.art;
      const bound = art
        ? (options.tiles?.get(artKey(art, 1, 1)) ?? options.tiles?.get(art))
        : undefined;
      // A legend entry with no art draws a built-in pattern, which is in the
      // same bank because this console's background characters are one bank.
      return bound ? bound.tile : patternTile(index, level.file.tiles[index]?.solid ?? false);
    };
    // The two bytes of a screen entry, low first: ten bits of tile and the two
    // flip bits. There is no palette field to carry — in 256-colour mode the
    // hardware ignores it — which is the one place this cell word is *simpler*
    // than the Mega Drive's or the Sega VDP's.
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

  asm.align();
  asm.label("Zero");
  asm.dw(0);
  asm.label("TileBank");
  asm.bytes(options.bank ?? new Uint8Array(0));
  asm.align();
  asm.label("ObjectBank");
  asm.bytes(options.objectBank ?? new Uint8Array(0));
  asm.align();
  asm.label("Palette");
  asm.bytes(options.palette ?? defaultPalette());
  asm.align();
  asm.label("ObjectPalette");
  asm.bytes(options.objectPalette ?? defaultPalette());
}

/**
 * The palette a build with no demade art uses.
 *
 * 256 little-endian RGB555 halfwords, of which only the reserved three at the
 * top are anything but black: a rising grey ramp, so a caption and a placeholder
 * block are legible with nothing else uploaded.
 */
function defaultPalette(): Uint8Array {
  const bytes = new Uint8Array(PALETTE_COLORS * 2);
  const ramp = [
    [12, 12, 12],
    [22, 22, 22],
    [31, 31, 31],
  ];
  for (const [index, codes] of ramp.entries()) {
    const word = encodeColour(codes as number[]);
    const to = (SYSTEM_INK - 2 + index) * 2;
    bytes[to] = word & 0xff;
    bytes[to + 1] = (word >> 8) & 0xff;
  }
  return bytes;
}

/** One palette halfword from three five-bit codes. */
export function encodeColour(codes: readonly number[]): number {
  const r = (codes[0] ?? 0) & 31;
  const g = (codes[1] ?? 0) & 31;
  const b = (codes[2] ?? 0) & 31;
  return r | (g << 5) | (b << 10);
}

// --- boot --------------------------------------------------------------------

function emitReset(ctx: GbaCtx, options: GbaEmitOptions): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  // The cartridge is fetched from on every cycle the program runs, so this is
  // the first thing a build does and the largest thing it can do about speed.
  setIo(ctx, REG.WAITCNT, WAITCNT);
  ctx.loadRamBase();
  asm.movImm32(13, STACK_TOP);

  // Blank the picture before anything is uploaded into it.
  setIo(ctx, REG.DISPCNT, DISPCNT_BLANK);

  // Clear the heap and the object shadow, so a game's state starts from zero
  // rather than from whatever powered up. Not the stack, which is above them and
  // is what this code is standing on.
  const clearEnd = layout.memory.oamShadow + layout.memory.oamEntries * 8;
  emitDma(
    ctx,
    label("Zero"),
    layout.memory.heapStart,
    (clearEnd - layout.memory.heapStart) / 4,
    true,
  );

  emitVideoInit(ctx);
  emitDma(ctx, label("TileBank"), VRAM + CHAR_BASE, ((options.bank?.length ?? 0) + 3) >> 2);
  emitDma(ctx, label("ObjectBank"), OBJ_VRAM, ((options.objectBank?.length ?? 0) + 3) >> 2);
  emitPaletteUpload(ctx, "Palette");
  asm.movImm32(A0, label("ObjectPalette"));
  asm.movImm32(A1, PAL_OBJ);
  asm.bl(needPaletteCopy(ctx));
  // Both maps start blank, so nothing is drawn until the first frame builds it.
  emitDma(ctx, label("Zero"), VRAM + MAP_BASE, (MAP_W * MAP_H * 2) / 4, true);
  emitDma(ctx, label("Zero"), VRAM + HUD_BASE, (HUD_W * HUD_H * 2) / 4, true);

  // Every entity starts from its declared values, not just the entry scene's: a
  // rule may name an object in a scene the game has not reached.
  for (const instance of program.instances) {
    emitCopyBlock(
      ctx,
      label(`Defaults_${instance.id}`),
      layout.entities[instance.id] as number,
      layout.entitySizes[instance.id] as number,
    );
    ctx.poolCheck();
  }

  asm.mov(A0, armImm(0));
  asm.strh(A0, mem(ctx, layout.tick));
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
    asm.strb(A0, mem(ctx, address));
  }
  asm.mov(A0, armImm(layout.memory.oamEntries));
  asm.strb(A0, mem(ctx, layout.oamPrev));
  asm.mov(A0, armImm(0xff));
  asm.strb(A0, mem(ctx, layout.pending));
  asm.mov(A0, armImm(sceneIndexOf(program, program.entryScene)));
  asm.strb(A0, mem(ctx, layout.scene));
  asm.mov(A0, armImm(1));
  asm.strb(A0, mem(ctx, layout.redraw));
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.bl("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the *end* of
  // a tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.mov(A0, armImm(0));
    asm.str(A0, mem(ctx, layout.camera));
    asm.str(A0, mem(ctx, layout.camera + 4));
  }
  asm.bl("BuildFrame");
  asm.bl("UploadFrame");

  // The interrupt: this console cannot install its own vector — `$00000018` is
  // BIOS ROM — so the handler is reached through the pointer the BIOS reads.
  asm.movImm32(A0, label("Vblank"));
  asm.movImm32(ADDR, GBA_IRQ_VECTOR);
  asm.str(A0, armAt(ADDR, 0));
  setIo(ctx, REG_DISPSTAT, 0x0008);
  setIo(ctx, REG.IE, 0x0001);
  setIo(ctx, REG.IME, 0x0001);

  setIo(ctx, REG.DISPCNT, DISPCNT);
  asm.mov(A0, armImm(1));
  asm.strb(A0, mem(ctx, layout.booted));
  asm.b("Main");
  asm.ltorg();
}

/**
 * The register file, as the boot leaves it.
 *
 * `BG0CNT` and `BG1CNT` are where the two maps live and are the reason
 * {@link MAP_BASE} and {@link HUD_BASE} are what they are. The HUD layer's
 * scroll is written once, here, and never again — that is what "the HUD layer
 * never moves" means, and it is why a caption cannot jitter.
 */
function emitVideoInit(ctx: GbaCtx): void {
  setIo(ctx, REG.BG0CNT, BG0CNT);
  setIo(ctx, REG.BG1CNT, BG1CNT);
  setIo(ctx, REG.BG0HOFS, 0);
  setIo(ctx, REG.BG0VOFS, 0);
  setIo(ctx, REG.BG1HOFS, 0);
  setIo(ctx, REG.BG1VOFS, 0);
}

/** Upload one background palette, by label. */
function emitPaletteUpload(ctx: GbaCtx, source: string): void {
  const { asm } = ctx;
  asm.movImm32(A0, label(source));
  asm.movImm32(A1, PAL_BG);
  asm.bl(needPaletteCopy(ctx));
}

/**
 * `r0` = a 256-entry palette, `r1` = where it goes: copy it, four colours at a
 * time.
 *
 * A routine rather than a DMA because a scene change performs one and a scene
 * change is not boot: the transfer is 512 bytes, and charging the processor for
 * it is both what the hardware does under `demake build`'s own scroll timing and
 * what keeps the speed figure honest.
 */
function needPaletteCopy(ctx: GbaCtx): Ref {
  return ctx.need("PaletteCopy", (inner) => {
    const { asm } = inner;
    const loop = inner.unique("palLoop");
    // Four colours a pass, in the two scratch registers the caller has not used
    // — not the callee-saved ones, because this routine is reached from a scene
    // change as well as from the boot and every routine here keeps `r4`-`r11`.
    asm.mov(A2, armImm(PALETTE_COLORS / 4));
    asm.label(loop);
    asm.ldm(A0, [A3, ADDR], "ia", true);
    asm.stm(A1, [A3, ADDR], "ia", true);
    asm.subs(A2, A2, armImm(1));
    inner.far("ne", loop);
    asm.ret();
    asm.ltorg();
  });
}

/**
 * The vertical interrupt, and the whole of what it does: say that the frame
 * happened.
 *
 * The upload is the main loop's, exactly as on the other five consoles, so the
 * loop owns the scratch the renderer uses and no interrupt can arrive in the
 * middle of a tick's use of it.
 *
 * What is this console's rather than a restatement: **the handler is reached
 * through the BIOS**, which has already saved `r0`–`r3`, `r12` and `lr` and left
 * the I/O page's base in `r0`. So the handler may spend exactly those registers
 * and returns with `bx lr`; `r11` is untouched and still holds the work-RAM
 * base, which is what lets the frame flag be one store.
 */
function emitVblank(ctx: GbaCtx): void {
  const { asm } = ctx;
  asm.label("Vblank");
  // Acknowledge, in both places: `IF`, and the copy the BIOS keeps for its own
  // `IntrWait`. A handler that clears one and not the other leaves a program
  // that ever calls the second waiting for ever.
  asm.add(A2, A0, armImm(0x200));
  asm.mov(A1, armImm(1));
  asm.strh(A1, armAt(A2, 2));
  asm.movImm32(ADDR, 0x03007ff8);
  asm.ldrh(A3, armAt(ADDR, 0));
  asm.orr(A3, A3, armReg(A1));
  asm.strh(A3, armAt(ADDR, 0));

  asm.strb(A1, mem(ctx, frameFlag(ctx)));
  asm.bx(LR);
  asm.ltorg();
}

/** Put the program's seed back into the generator. */
function emitSeedRng(ctx: GbaCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  asm.movImm32(A0, program.seed >>> 0);
  asm.str(A0, mem(ctx, layout.rng));
}

/** Zero the contact, hold and reach bookkeeping — a fresh scene inherits none. */
function emitClearState(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  asm.mov(A0, armImm(0));
  for (let index = 0; index < layout.contactBytes; index += 1) {
    asm.strb(A0, mem(ctx, layout.contacts + index));
    asm.strb(A0, mem(ctx, layout.contactsPrev + index));
  }
  const holds = Math.max(1, ctx.analysis.holdSlots);
  for (let index = 0; index < holds; index += 1) asm.strb(A0, mem(ctx, layout.holdFlags + index));
  const reaches = Math.max(1, layout.reachSlots.size);
  for (let index = 0; index < reaches; index += 1)
    asm.strb(A0, mem(ctx, layout.reachFlags + index));
  if (ctx.analysis.usesTiles) {
    for (let index = 0; index < layout.tileContactSlots.size; index += 1) {
      asm.strb(A0, mem(ctx, layout.tileContacts + index * layout.tileContactStride));
    }
  }
}

function emitMainLoop(ctx: GbaCtx): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  // The flag is cleared *after* it is seen, not before the wait: a tick that
  // overran its frame would otherwise wait for the next one and run at half rate.
  asm.label("Main");
  asm.label(wait);
  asm.ldrb(A0, mem(ctx, frameFlag(ctx)));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", wait);
  asm.mov(A0, armImm(0));
  asm.strb(A0, mem(ctx, frameFlag(ctx)));
  asm.bl("UploadFrame");
  asm.bl("ReadInput");
  asm.bl("Tick");
  asm.bl("BuildFrame");
  asm.b("Main");
  asm.ltorg();
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * One halfword, active low, and every button the portable vocabulary names is a
 * real button on this pad — a dedicated Start, and A and B where the language
 * expects them. The shoulder buttons exist and the language has no word for
 * them, so they are simply not looked at.
 *
 * Each abstract bit is a `tst` and a predicated `orr`: no branches at all, which
 * is what the other five backends spend a label apiece on.
 */
function emitInput(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  /** Which `KEYINPUT` bit each abstract button comes from. */
  const SOURCE: Readonly<Record<string, number>> = {
    a: 0,
    b: 1,
    start: 3,
    right: 4,
    left: 5,
    up: 6,
    down: 7,
  };
  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;

  asm.label("ReadInput");
  asm.movImm32(ADDR, IO + REG.KEYINPUT);
  asm.ldrh(A0, armAt(ADDR, 0));
  asm.mov(A2, armImm(0));
  for (const [to, action] of ABSTRACT.entries()) {
    const from = SOURCE[action];
    if (from === undefined) continue;
    // Active low, so the button is down when the bit is *clear*.
    asm.tst(A0, armImm(1 << from));
    asm.orr(A2, A2, armImm(1 << to), "eq");
  }

  // held → pressed and released, against last tick's set.
  asm.ldrb(A3, mem(ctx, layout.held));
  asm.strb(A2, mem(ctx, layout.held));
  asm.bic(A1, A2, armReg(A3));
  asm.strb(A1, mem(ctx, layout.pressed));
  asm.bic(A1, A3, armReg(A2));
  asm.strb(A1, mem(ctx, layout.released));
  asm.ret();
  asm.ltorg();
}

function emitTickDispatch(ctx: GbaCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("Tick");
  asm.push([LR]);
  // Nothing has asked for a sound yet this tick. Cleared here rather than after
  // the rules run, because the byte is what a trace reads at the end of a tick.
  if (layout.sound !== null) {
    asm.mov(A0, armImm(0xff));
    asm.strb(A0, mem(ctx, layout.sound));
  }
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );

  asm.label("TickDone");
  asm.bl("SceneChange");
  // The tick counter, then the handshake byte the harness watches — in that
  // order, so a reader can never see the counter half-updated.
  asm.ldrh(A0, mem(ctx, layout.tick));
  asm.add(A0, A0, armImm(1));
  asm.strh(A0, mem(ctx, layout.tick));
  asm.ldrb(A0, mem(ctx, layout.ready));
  asm.add(A0, A0, armImm(1));
  asm.strb(A0, mem(ctx, layout.ready));
  asm.pop([PC]);
  asm.ltorg();
}

function emitSceneChange(ctx: GbaCtx, scenes: readonly SceneCtx[]): void {
  const { asm, layout } = ctx;
  asm.label("SceneChange");
  asm.push([LR]);
  const go = ctx.unique("changeGo");
  asm.ldrb(A0, mem(ctx, layout.pending));
  asm.cmp(A0, armImm(0xff));
  ctx.far("ne", go);
  asm.pop([PC]);
  asm.label(go);
  asm.strb(A0, mem(ctx, layout.scene));
  asm.mov(A0, armImm(0xff));
  asm.strb(A0, mem(ctx, layout.pending));
  asm.bl("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.bl("UpdateCamera");
  asm.mov(A0, armImm(1));
  asm.strb(A0, mem(ctx, layout.redraw));
  asm.pop([PC]);
  asm.ltorg();

  asm.label("ResetScene");
  asm.push([LR]);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneReset_${scene.index}`),
  );
  asm.ltorg();

  asm.label("UpdateCamera");
  asm.push([LR]);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneCamera_${scene.index}`),
  );
  asm.ltorg();

  asm.label("BuildFrame");
  asm.push([LR]);
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneRender_${scene.index}`),
  );
  asm.ltorg();
}

// --- per-scene ---------------------------------------------------------------

/** This console's instructions for each of doc 14's tick steps. */
function tickSteps(ctx: GbaCtx): TickSteps {
  const { asm, layout } = ctx;
  return {
    controls: (scene) => emitControls(ctx, scene),
    levelRules: (scene) => emitLevelRules(ctx, scene),
    integrate: (scene) => emitIntegrate(ctx, scene),
    beginContacts: () => {
      asm.mov(A0, armImm(0));
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.strb(A0, mem(ctx, layout.contacts + index));
      }
    },
    collisions: (scene) => emitCollisions(ctx, scene),
    endContacts: () => {
      for (let index = 0; index < layout.contactBytes; index += 1) {
        asm.ldrb(A0, mem(ctx, layout.contacts + index));
        asm.strb(A0, mem(ctx, layout.contactsPrev + index));
      }
    },
    tileRules: (scene, level) => emitTileRules(ctx, scene, level),
    edgeRules: (scene) => emitEdgeRules(ctx, scene),
    camera: (scene) => emitCamera(ctx, scene),
  };
}

function emitSceneTick(ctx: GbaCtx, scene: SceneCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  asm.label(`SceneTick_${scene.index}`);
  emitTickSteps(tickSteps(ctx), scene, level);
  asm.b("TickDone");
  asm.ltorg();
}

function emitSceneReset(ctx: GbaCtx, scene: SceneCtx): void {
  const { layout } = ctx;
  emitTail(ctx, `SceneReset_${scene.index}`, () => {
    for (const id of scene.def.instanceIds) {
      emitCopyBlock(
        ctx,
        label(`Defaults_${id}`),
        layout.entities[id] as number,
        layout.entitySizes[id] as number,
      );
      ctx.poolCheck();
    }
  });
}

function emitSceneCamera(ctx: GbaCtx, scene: SceneCtx): void {
  emitTail(ctx, `SceneCamera_${scene.index}`, () => emitCamera(ctx, scene));
}

// --- 6. tiles ----------------------------------------------------------------

/** Where one subject's cell list lives. */
function cellSlot(ctx: GbaCtx, subjectId: number): number {
  const index = ctx.layout.tileCellSlots.get(subjectId);
  if (index === undefined) throw new Error(`no tile cell list for object ${subjectId}`);
  return ctx.layout.tileCells + index * ctx.layout.tileCellStride;
}

/** Walk the grid once and record every cell this object overlaps. */
function emitFillCells(ctx: GbaCtx, subjectId: number, level: LevelData): void {
  const { asm, layout } = ctx;
  const base = layout.entities[subjectId] as number;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;

  asm.mov(A1, armImm(0));
  asm.strb(A1, mem(ctx, list));
  emitTilesUnder(ctx, base, level, () => {
    const next = ctx.unique("cellSkip");
    asm.cmp(A0, armImm(GRID_EMPTY));
    ctx.far("eq", next);
    asm.mov(A3, armReg(A0)); // the legend index, held across the arithmetic
    asm.ldrb(A1, mem(ctx, list));
    asm.cmp(A1, armImm(TILE_CONTACT_MAX));
    ctx.far("cs", next);
    // The entry is five bytes: the column, the row, and the legend index.
    asm.add(A2, A1, armLsl(A1, 2));
    asm.movImm32(A1, list + 1);
    asm.add(A1, A1, armReg(A2));
    // A byte at a time, because a five-byte entry after a count byte lands on an
    // odd address every other time — and a halfword access to an odd address
    // reads the wrong halfword on this core rather than faulting, which is worse.
    asm.ldrb(A2, mem(ctx, col));
    asm.strb(A2, armAt(A1, 0));
    asm.ldrb(A2, mem(ctx, col + 1));
    asm.strb(A2, armAt(A1, 1));
    asm.ldrb(A2, mem(ctx, row));
    asm.strb(A2, armAt(A1, 2));
    asm.ldrb(A2, mem(ctx, row + 1));
    asm.strb(A2, armAt(A1, 3));
    asm.strb(A3, armAt(A1, 4));
    asm.ldrb(A2, mem(ctx, list));
    asm.add(A2, A2, armImm(1));
    asm.strb(A2, mem(ctx, list));
    asm.label(next);
  });
}

/** Run `body` for each recorded cell, with its legend index in `r0`. */
function emitOverCells(ctx: GbaCtx, subjectId: number, body: () => void): void {
  const { asm, layout } = ctx;
  const list = cellSlot(ctx, subjectId);
  const col = layout.words + W.tileCol * 2;
  const row = layout.words + W.tileRow * 2;
  const cursor = layout.words + W.count * 2;
  const loop = ctx.unique("cellLoop");
  const done = ctx.unique("cellDone");

  asm.ldrb(A0, mem(ctx, list));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", done);
  asm.mov(A0, armImm(0));
  asm.strh(A0, mem(ctx, cursor));
  asm.label(loop);
  asm.ldrh(A1, mem(ctx, cursor));
  asm.movImm32(A2, list + 1);
  asm.add(A1, A2, armReg(A1));
  asm.ldrb(A2, armAt(A1, 0));
  asm.strb(A2, mem(ctx, col));
  asm.ldrb(A2, armAt(A1, 1));
  asm.strb(A2, mem(ctx, col + 1));
  asm.ldrb(A2, armAt(A1, 2));
  asm.strb(A2, mem(ctx, row));
  asm.ldrb(A2, armAt(A1, 3));
  asm.strb(A2, mem(ctx, row + 1));
  asm.ldrb(A0, armAt(A1, 4));
  body();
  ctx.poolCheck();
  // Five bytes on, and stop when the count is reached. The cursor is in memory
  // because a rule body uses every register there is.
  asm.ldrh(A0, mem(ctx, cursor));
  asm.add(A0, A0, armImm(5));
  asm.strh(A0, mem(ctx, cursor));
  asm.ldrb(A1, mem(ctx, list));
  asm.add(A1, A1, armLsl(A1, 2));
  asm.cmp(A0, armReg(A1));
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Tile collision, in the interpreter's two passes: fire the rules that name a
 * tile, then push objects out of the solid ones.
 */
function emitTileRules(ctx: GbaCtx, scene: SceneCtx, level: LevelData): void {
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
        asm.cmp(A0, armImm(GRID_EMPTY));
        ctx.far("eq", next);
        // Is this legend entry one the rule names?
        asm.movImm32(A1, label(ruleTileTableLabel(rule, level)));
        asm.ldrb(A1, armAtIdx(A1, A0));
        asm.cmp(A1, armImm(0));
        ctx.far("eq", next);

        emitCellId(ctx);
        emitRecordContact(ctx);
        if (!event.level) {
          asm.movImm32(A1, listBase + 1);
          asm.ldrb(A2, mem(ctx, listBase));
          asm.bl("TileContactSeen");
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
      ctx.poolCheck();
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
      asm.cmp(A0, armImm(GRID_EMPTY));
      ctx.far("eq", next);
      asm.movImm32(A1, label(level.solidLabel));
      asm.ldrb(A1, armAtIdx(A1, A0));
      asm.cmp(A1, armImm(0));
      ctx.far("eq", next);
      asm.movImm32(A1, label(namedTable));
      asm.ldrb(A1, armAtIdx(A1, A0));
      asm.cmp(A1, armImm(0));
      ctx.far("eq", next);
      emitTileSeparate(ctx, base);
      asm.label(next);
    });
    asm.label(skip);
    ctx.poolCheck();
    // The table of tiles that can stop this subject, by legend index.
    ctx.data((data) => {
      data.label(namedTable);
      for (const tile of level.file.tiles) data.db(named.has(tile.name) ? 1 : 0);
      data.align();
    });
  }
}

/** Fire a tile rule's body — the guard and assignments, with no trigger test. */
function emitFireTileRule(ctx: GbaCtx, rule: RuleDef, bind: Binding): void {
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
    asm.b(done);
    asm.label(elseLabel);
    emitAssignments(ctx, rule.otherwise, bind);
    asm.label(done);
  } else {
    asm.label(elseLabel);
  }
}

/** The key a contact list stores: the cell's coordinates, packed into a word. */
function emitCellId(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  asm.ldrb(A1, mem(ctx, layout.words + W.tileCol * 2));
  asm.ldrb(A2, mem(ctx, layout.words + W.tileRow * 2));
  asm.orr(A1, A1, armLsl(A2, 8));
  asm.strh(A1, mem(ctx, layout.words + W.cell * 2));
}

/** Start a pair's list: nothing recorded yet, and the stored count remembered. */
function emitBeginContacts(ctx: GbaCtx, listBase: number): void {
  const { asm, layout } = ctx;
  asm.mov(A0, armImm(0));
  asm.strb(A0, mem(ctx, layout.tileScratch));
  asm.ldrb(A0, mem(ctx, listBase));
  asm.strh(A0, mem(ctx, layout.words + W.target * 2));
}

/** Append the current cell to this tick's list. */
function emitRecordContact(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  const full = ctx.unique("contactFull");
  asm.ldrb(A1, mem(ctx, layout.tileScratch));
  asm.cmp(A1, armImm(TILE_CONTACT_MAX));
  ctx.far("cs", full);
  asm.movImm32(A2, layout.tileScratch + 1);
  asm.add(A2, A2, armLsl(A1, 1));
  asm.ldrh(A3, mem(ctx, layout.words + W.cell * 2));
  // Two byte stores rather than one halfword store: the entries sit after a
  // count byte, so half of them are at odd addresses.
  asm.strb(A3, armAt(A2, 0));
  asm.mov(A3, armLsr(A3, 8));
  asm.strb(A3, armAt(A2, 1));
  asm.add(A1, A1, armImm(1));
  asm.strb(A1, mem(ctx, layout.tileScratch));
  asm.label(full);
}

/** Replace the pair's stored list with the one just built. */
function emitCommitContacts(ctx: GbaCtx, listBase: number): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("commitLoop");
  const done = ctx.unique("commitDone");
  asm.ldrb(A0, mem(ctx, layout.tileScratch));
  asm.strb(A0, mem(ctx, listBase));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", done);
  asm.add(A0, A0, armReg(A0)); // two bytes an entry
  asm.movImm32(A1, layout.tileScratch + 1);
  asm.movImm32(A2, listBase + 1);
  asm.label(loop);
  asm.ldrb(A3, armAtPost(A1, 1));
  asm.strb(A3, armAtPost(A2, 1));
  asm.subs(A0, A0, armImm(1));
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Was this cell in the pair's list at the end of last tick?
 *
 * That question is the whole of `hits` versus `touches` for tiles. The list to
 * search arrives in `r1` and its length in `r2`, and the answer is the zero flag
 * — set when the cell was not there, because the last thing before the return is
 * a `movs` and neither `pop` nor `bx` writes a flag.
 */
function emitTileContactHelper(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  if (!ctx.analysis.usesTiles) return;
  const loop = ctx.unique("seenLoop");
  const found = ctx.unique("seenFound");
  const missing = ctx.unique("seenMissing");
  asm.label("TileContactSeen");
  asm.ldrh(A3, mem(ctx, layout.words + W.cell * 2));
  asm.cmp(A2, armImm(0));
  ctx.far("eq", missing);
  asm.label(loop);
  // A byte at a time, for the reason the writes are: half the entries are at
  // odd addresses.
  asm.ldrb(ADDR, armAtPost(A1, 1));
  asm.ldrb(A0, armAtPost(A1, 1));
  asm.orr(ADDR, ADDR, armLsl(A0, 8));
  asm.cmp(ADDR, armReg(A3));
  ctx.far("eq", found);
  asm.subs(A2, A2, armImm(1));
  ctx.far("ne", loop);
  asm.label(missing);
  asm.movs(A0, armImm(0));
  asm.ret();
  asm.label(found);
  asm.movs(A0, armImm(1));
  asm.ret();
  asm.ltorg();
}

// --- rendering ---------------------------------------------------------------

function emitSceneRender(
  ctx: GbaCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: GbaEmitOptions,
): void {
  const { asm, layout } = ctx;
  emitTail(ctx, `SceneRender_${scene.index}`, () => {
    // Camera in pixels: a 16.16 cell coordinate shifted right thirteen places.
    if (layout.camera !== null) {
      emitPixelsFromFixed(ctx, layout.camera, layout.words + W.camX * 2);
      emitPixelsFromFixed(ctx, layout.camera + 4, layout.words + W.camY * 2);
    } else {
      asm.mov(A0, armImm(0));
      asm.strh(A0, mem(ctx, layout.words + W.camX * 2));
      asm.strh(A0, mem(ctx, layout.words + W.camY * 2));
    }
    copy16(ctx, layout.words + W.scrollX * 2, layout.words + W.camX * 2);
    copy16(ctx, layout.words + W.scrollY * 2, layout.words + W.camY * 2);

    const noRedraw = ctx.unique("noRedraw");
    const afterScroll = ctx.unique("afterScroll");
    asm.ldrb(A0, mem(ctx, layout.redraw));
    asm.cmp(A0, armImm(0));
    ctx.far("eq", noRedraw);
    emitFullRedraw(ctx, scene, level, options);
    asm.mov(A0, armImm(0));
    asm.strb(A0, mem(ctx, layout.redraw));
    asm.strb(A0, mem(ctx, layout.plotPrevCount));
    asm.b(afterScroll);
    asm.label(noRedraw);
    if (level) emitScrollUpdate(ctx, level);
    asm.label(afterScroll);

    // The HUD is background cells on a layer of its own, whether the scene
    // scrolls or not — this is the console where that mechanism exists, so
    // there is no sprite HUD here at all.
    emitHudErase(ctx);
    asm.mov(A0, armImm(0));
    asm.strb(A0, mem(ctx, layout.plotCount));
    emitHud(ctx, scene, "dynamic");
    emitSwapPlots(ctx);
    emitOam(ctx, scene, options);
  });
}

/** `dst16 = floor(value × 8 / 65536)` — cells to pixels. */
function emitPixelsFromFixed(ctx: GbaCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.ldr(A0, mem(ctx, src));
  asm.mov(A0, armAsr(A0, 13));
  asm.strh(A0, mem(ctx, dst));
}

/** Draw the whole visible window, with the picture forced blank. */
function emitFullRedraw(
  ctx: GbaCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: GbaEmitOptions,
): void {
  const { asm, layout } = ctx;
  // Forced blank for the whole of it: a screenful of map does not fit in one
  // blanking interval, and this runs from the main loop rather than from the
  // interrupt. One frame of white at a scene change, exactly as on the other
  // five consoles, and the alternative is a frame of tearing.
  setIo(ctx, REG.DISPCNT, DISPCNT_BLANK);

  // Every scene uploads a palette, whether it has one of its own or not. A scene
  // with a backdrop brings that picture's colours; one without brings the
  // build's — the level tiles' fit. Leaving palette memory alone would mean a
  // level scene wore whichever title screen the player came from.
  const palette = options.scenePalettes?.get(scene.def.name);
  emitPaletteUpload(ctx, palette ? scenePaletteLabel(scene) : "Palette");

  // The HUD layer is cleared here and repainted below: a caption belonging to
  // the scene the player just left has nothing to do with this one.
  asm.bl(needClearHud(ctx));

  const backdrop = options.backdrops?.get(scene.def.name);
  if (backdrop) {
    // A backdrop is a run of whole rows padded to one screen block's width, so
    // painting it is a single stream into the map — thirty-two cells to a row
    // and not sixty-four, because "the left half of a 64-wide row" is not a
    // thing this hardware has (see {@link needCellOffset}).
    asm.movImm32(A1, label(backdropLabel(scene)));
    asm.movImm32(A2, VRAM + MAP_BASE);
    asm.bl(needBlitBackdrop(ctx));
  } else {
    // A scene with a level paints from its grid, and one with neither is blank.
    //
    // The window *plus one cell on each axis*, which is the same invariant the
    // Sega and Mega Drive emitters state and holds for the same reason: a scroll
    // of part of a cell shows a sliver of the next one, and the walk only paints
    // a strip once the origin has actually moved.
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
    asm.mov(A0, armImm(height));
    asm.strh(A0, mem(ctx, rows));
    asm.label(rowLoop);
    copy16(ctx, layout.words + W.tileCol * 2, layout.words + W.firstCol * 2);
    asm.mov(A0, armImm(width));
    asm.strh(A0, mem(ctx, columns));
    asm.label(colLoop);
    emitBackgroundTile(ctx, level);
    asm.bl(needCellOffset(ctx));
    asm.movImm32(A2, VRAM);
    asm.strh(A0, armAtIdx(A2, A1));
    inc16(ctx, layout.words + W.tileCol * 2);
    asm.ldrh(A0, mem(ctx, columns));
    asm.subs(A0, A0, armImm(1));
    asm.strh(A0, mem(ctx, columns));
    ctx.far("ne", colLoop);
    inc16(ctx, layout.words + W.tileRow * 2);
    asm.ldrh(A0, mem(ctx, rows));
    asm.subs(A0, A0, armImm(1));
    asm.strh(A0, mem(ctx, rows));
    ctx.far("ne", rowLoop);
  }

  // Captions that cannot change go on now, straight into the map: with the
  // picture blank they need neither the write queue nor a place in the erase
  // list, and they are most of the HUD in a small game.
  emitHud(ctx, scene, "static");
  setIo(ctx, REG.DISPCNT, DISPCNT);
}

/**
 * A packed map: literals and runs of whole *cells*, and the walk that unpacks it.
 *
 * ```text
 *   $00        the end
 *   $01..$7F   n cells follow, two bytes each, low byte first
 *   $81..$FF   the next two bytes, (n & $7F) times
 * ```
 *
 * The unit is a cell rather than a byte because an entry here is two of them, so
 * a run of identical cells has no byte runs in it at all — the Mega Drive's and
 * the Sega 8-bits' reasoning exactly, reached by different hardware.
 *
 * The format is the encoder's and the decoder's business and nothing else's:
 * what is guaranteed is the halfwords that reach video RAM.
 */
export function packCells(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  const same = (a: number, b: number): boolean =>
    cells[a * 2] === cells[b * 2] && cells[a * 2 + 1] === cells[b * 2 + 1];
  const total = cells.length >> 1;
  let index = 0;
  while (index < total) {
    let run = 1;
    while (run < 127 && index + run < total && same(index + run, index)) run += 1;
    // Two of a kind is a wash — three bytes either way — so a run has to be
    // worth the control byte before it is taken, and pairs go through as
    // literals.
    if (run >= 3) {
      out.push(0x80 | run, cells[index * 2] as number, cells[index * 2 + 1] as number);
      index += run;
      continue;
    }
    const start = index;
    while (index < total && index - start < 127) {
      let ahead = 1;
      while (ahead < 3 && index + ahead < total && same(index + ahead, index)) ahead += 1;
      if (ahead >= 3) break;
      index += 1;
    }
    out.push(index - start, ...cells.subarray(start * 2, index * 2));
  }
  out.push(0x00);
  return Uint8Array.from(out);
}

/** `r1` = a packed map, `r2` = where it goes: stream it into video RAM. */
function needBlitBackdrop(ctx: GbaCtx): Ref {
  return ctx.need("BlitBackdrop", (inner) => {
    const { asm } = inner;
    const next = inner.unique("blitNext");
    const run = inner.unique("blitRun");
    const literal = inner.unique("blitLiteral");
    const runLoop = inner.unique("blitRunLoop");
    const out = inner.unique("blitOut");

    asm.label(next);
    asm.ldrb(A0, armAtPost(A1, 1));
    asm.cmp(A0, armImm(0));
    inner.far("eq", out);
    asm.tst(A0, armImm(0x80));
    inner.far("ne", run);

    asm.sub(A0, A0, armImm(1));
    asm.label(literal);
    emitPackedCell(inner);
    asm.strh(A3, armAtPost(A2, 2));
    asm.subs(A0, A0, armImm(1));
    inner.far("pl", literal);
    asm.b(next);

    asm.label(run);
    asm.and(A0, A0, armImm(0x7f));
    emitPackedCell(inner);
    asm.sub(A0, A0, armImm(1));
    asm.label(runLoop);
    asm.strh(A3, armAtPost(A2, 2));
    asm.subs(A0, A0, armImm(1));
    inner.far("pl", runLoop);
    asm.b(next);

    asm.label(out);
    asm.ret();
    asm.ltorg();
  });
}

/**
 * Read the next cell of a packed stream into `r3`, a byte at a time.
 *
 * Not `ldrh`: a cell in this stream follows a control *byte*, so half of them
 * are at odd addresses — and an unaligned halfword load reads the halfword below
 * it on this core rather than faulting, which is a wrong picture with no fault
 * to trace it to.
 */
function emitPackedCell(ctx: GbaCtx): void {
  const { asm } = ctx;
  asm.ldrb(A3, armAtPost(A1, 1));
  asm.ldrb(ADDR, armAtPost(A1, 1));
  asm.orr(A3, A3, armLsl(ADDR, 8));
}

/** The labels holding one scene's packed map and its palette. */
function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}
function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePal_${scene.index}`;
}

/**
 * `r0` = the cell halfword that belongs at `words[tileCol], words[tileRow]`.
 *
 * Two kinds of scene answer it two ways — a level looks the cell up in its grid
 * and through its legend, and a scene without one is blank. A backdrop scene
 * never reaches here: its picture is a block copy.
 */
function emitBackgroundTile(ctx: GbaCtx, level: LevelData | undefined): void {
  const { asm } = ctx;
  if (!level) {
    asm.mov(A0, armImm(BLANK_CELL));
    return;
  }
  asm.bl(tileAtLabel(level));
  asm.bl(needLegendToTile(ctx, level));
}

/** `r0 = the cell halfword for the legend index in r0` — one routine per level. */
function needLegendToTile(ctx: GbaCtx, level: LevelData): Ref {
  return ctx.need(`LegendCell_${level.index}`, (inner) => {
    const { asm } = inner;
    const empty = inner.unique("legendEmpty");
    asm.cmp(A0, armImm(GRID_EMPTY));
    inner.far("eq", empty);
    asm.movImm32(A1, label(level.tileLabel));
    asm.ldrb(A2, armAtIdx(A1, A0));
    asm.movImm32(A1, label(level.attrLabel));
    asm.ldrb(A1, armAtIdx(A1, A0));
    asm.orr(A0, A2, armLsl(A1, 8));
    asm.ret();
    asm.label(empty);
    asm.mov(A0, armImm(BLANK_CELL));
    asm.ret();
    asm.ltorg();
  });
}

/** The cell a pixel scroll sits in: an arithmetic shift by three. */
function emitOriginFromScroll(ctx: GbaCtx, dstCol: number, dstRow: number): void {
  const { asm, layout } = ctx;
  const shift = (src: number, dst: number): void => {
    asm.ldrsh(A0, mem(ctx, src));
    asm.mov(A0, armAsr(A0, 3));
    asm.strh(A0, mem(ctx, dst));
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
function emitScrollUpdate(ctx: GbaCtx, level: LevelData): void {
  const { asm, layout } = ctx;
  const wantCol = layout.words + W.firstCol * 2;
  const wantRow = layout.words + W.lastCol * 2;
  emitOriginFromScroll(ctx, wantCol, wantRow);

  const bail = ctx.unique("scrollBail");
  const done = ctx.unique("scrollDone");
  emitWalkAxis(ctx, level, layout.words + W.mapCol * 2, wantCol, bail, true);
  emitWalkAxis(ctx, level, layout.words + W.mapRow * 2, wantRow, bail, false);
  asm.b(done);
  asm.label(bail);
  // Too far to walk: repaint everything next frame rather than tear.
  asm.mov(A0, armImm(1));
  asm.strb(A0, mem(ctx, layout.redraw));
  asm.label(done);
}

/**
 * Step one axis of the map origin toward the camera, painting the leading edge
 * as it goes. More than four cells in a tick is a teleport, not a scroll.
 *
 * The forward offset is the window's own size on both axes, because the map is
 * bigger than the window on both: a new column goes thirty-four columns off the
 * right-hand edge and a new row forty-four rows below the bottom, and neither is
 * seen until the scroll brings it round. The Master System has to write its new
 * column into the cell straddling the screen's left edge and mask it; here there
 * is nothing to hide.
 */
function emitWalkAxis(
  ctx: GbaCtx,
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

  asm.mov(A0, armImm(5));
  asm.strh(A0, mem(ctx, guard));
  asm.label(loop);
  asm.ldrh(A0, mem(ctx, guard));
  asm.subs(A0, A0, armImm(1));
  asm.strh(A0, mem(ctx, guard));
  ctx.far("eq", bail);
  asm.ldrsh(A0, mem(ctx, want));
  asm.ldrsh(A1, mem(ctx, origin));
  asm.cmp(A0, armReg(A1));
  ctx.far("eq", done);
  ctx.far("lt", back);
  // Moving on: the origin advances and the far edge becomes visible.
  inc16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, isColumn ? layout.memory.viewW : layout.memory.viewH);
  asm.b(loop);
  asm.label(back);
  dec16(ctx, origin);
  emitPaintEdge(ctx, level, isColumn, 0);
  asm.b(loop);
  asm.label(done);
}

/** Paint one column or row of the window, `offset` cells from the origin. */
function emitPaintEdge(ctx: GbaCtx, level: LevelData, isColumn: boolean, offset: number): void {
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
  if (offset !== 0) {
    asm.ldrh(A0, mem(ctx, across));
    asm.add(A0, A0, armImm(offset));
    asm.strh(A0, mem(ctx, across));
  }
  copy16(ctx, along, originAlong);

  const loop = ctx.unique("paintLoop");
  asm.mov(A0, armImm(count));
  asm.strh(A0, mem(ctx, remaining));
  asm.label(loop);
  emitBackgroundTile(ctx, level);
  asm.bl(needCellOffset(ctx));
  asm.strh(A1, mem(ctx, layout.words + W.target * 2));
  asm.bl(needQueueEntry(ctx));
  inc16(ctx, along);
  asm.ldrh(A0, mem(ctx, remaining));
  asm.subs(A0, A0, armImm(1));
  asm.strh(A0, mem(ctx, remaining));
  ctx.far("ne", loop);
}

/** Blank the HUD layer's whole map, two cells at a time. */
function needClearHud(ctx: GbaCtx): Ref {
  return ctx.need("ClearHud", (inner) => {
    const { asm } = inner;
    const loop = inner.unique("hudClear");
    asm.movImm32(A0, VRAM + HUD_BASE);
    asm.mov(A1, armImm(0));
    asm.mov(A2, armImm((HUD_W * HUD_H * 2) / 4));
    asm.label(loop);
    asm.str(A1, armAtPost(A0, 4));
    asm.subs(A2, A2, armImm(1));
    inner.far("ne", loop);
    asm.ret();
    asm.ltorg();
  });
}

/** Put back the blank cells the HUD covered last frame. */
function emitHudErase(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  const loop = ctx.unique("eraseLoop");
  const done = ctx.unique("eraseDone");
  const cursor = layout.words + W.count * 2;
  asm.ldrb(A0, mem(ctx, layout.plotPrevCount));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", done);
  asm.mov(A0, armImm(0));
  asm.strh(A0, mem(ctx, cursor));
  asm.label(loop);
  // Two bytes an entry: a column and a row, and both fit a byte because the HUD
  // layer's map is thirty-two cells square.
  asm.ldrh(A1, mem(ctx, cursor));
  asm.movImm32(A2, layout.plotPrev);
  asm.add(A1, A2, armLsl(A1, 1));
  asm.ldrb(A2, armAt(A1, 0));
  asm.strh(A2, mem(ctx, layout.words + W.tileCol * 2));
  asm.ldrb(A2, armAt(A1, 1));
  asm.strh(A2, mem(ctx, layout.words + W.tileRow * 2));
  asm.mov(A0, armImm(BLANK_CELL));
  asm.bl(needHudOffset(ctx));
  asm.strh(A1, mem(ctx, layout.words + W.target * 2));
  asm.bl(needQueueEntry(ctx));
  asm.ldrh(A0, mem(ctx, cursor));
  asm.add(A0, A0, armImm(1));
  asm.strh(A0, mem(ctx, cursor));
  asm.ldrb(A1, mem(ctx, layout.plotPrevCount));
  asm.cmp(A0, armReg(A1));
  ctx.far("ne", loop);
  asm.label(done);
}

function emitSwapPlots(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  const done = ctx.unique("swapDone");
  const loop = ctx.unique("swapLoop");
  asm.ldrb(A0, mem(ctx, layout.plotCount));
  asm.strb(A0, mem(ctx, layout.plotPrevCount));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", done);
  asm.movImm32(A1, layout.plot);
  asm.movImm32(A2, layout.plotPrev);
  asm.label(loop);
  asm.ldrh(A3, armAtPost(A1, 2));
  asm.strh(A3, armAtPost(A2, 2));
  asm.subs(A0, A0, armImm(1));
  ctx.far("ne", loop);
  asm.label(done);
}

/**
 * Draw the scene's `number` and `text` objects on the HUD layer.
 *
 * The cell is `floor(pos) − floor(camera)`, in whole cells on both sides — which
 * is what makes a caption pinned to `camera.x + 1` land on the same cell every
 * frame whatever the camera's sub-cell offset is. The other five backends
 * compute a *pixel* position for a scrolling scene and hand it to a sprite,
 * because on those machines the background moves as one piece; here the HUD
 * layer simply does not move.
 */
function emitHud(ctx: GbaCtx, scene: SceneCtx, want: "static" | "dynamic"): void {
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
    emitHudCell(ctx, base);

    const plot = want === "static" ? needPokeCell(ctx) : needPlotCell(ctx);
    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, layout.memory.viewW)) {
        asm.mov(A0, armImm(glyphTile(character)));
        asm.bl(plot);
      }
    } else {
      asm.movImm32(A1, base + propOffset("value") + CELL_OFFSET);
      asm.bl(want === "static" ? needPokeNumber(ctx) : needPlotNumber(ctx));
    }
    asm.label(skip);
    ctx.poolCheck();
  }
}

/** `words[tileCol]`, `words[tileRow]` = the HUD cell this object sits on. */
function emitHudCell(ctx: GbaCtx, base: number): void {
  const { asm, layout } = ctx;
  const camera = layout.camera;
  const axis = (prop: string, offset: number, dst: number): void => {
    asm.ldr(A0, mem(ctx, base + propOffset(prop)));
    asm.mov(A0, armAsr(A0, 16));
    if (camera !== null) {
      asm.ldr(A1, mem(ctx, camera + offset));
      asm.mov(A1, armAsr(A1, 16));
      asm.sub(A0, A0, armReg(A1));
    }
    asm.strh(A0, mem(ctx, dst));
  };
  axis("x", 0, layout.words + W.tileCol * 2);
  axis("y", 4, layout.words + W.tileRow * 2);
}

/**
 * Build the object shadow from the scene's sprite objects.
 *
 * An object cell is one 8×8 hardware sprite, as on every other console — but the
 * limit here is a *cycle* budget rather than a count of eight, so a hundred and
 * twenty-eight of them are affordable and nothing in a demade game comes close.
 */
function emitOam(ctx: GbaCtx, scene: SceneCtx, options: GbaEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.mov(A0, armImm(0));
  asm.strb(A0, mem(ctx, layout.oamCount));

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
      asm.movImm32(A1, base);
      asm.mov(A2, armImm(width));
      asm.mov(A3, armImm(height));
      asm.bl(needOnscreen(ctx));
      ctx.far("eq", skip);
    }
    // Screen pixels are level pixels minus the camera's.
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, at(base + propOffset("x")));
      if (layout.camera !== null) sub32(ctx, temp, at(layout.camera));
      emitPixelsFromFixed(ctx, temp, layout.words + W.cell * 2);
      copy32(ctx, temp, at(base + propOffset("y")));
      if (layout.camera !== null) sub32(ctx, temp, at(layout.camera + 4));
      emitPixelsFromFixed(ctx, temp, layout.words + W.count * 2);
    });

    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const tile = art ? art.tile + row * art.width + column : OBJECT_TILE_GBA;
        asm.ldrsh(A0, mem(ctx, layout.words + W.count * 2));
        if (row !== 0) asm.add(A0, A0, armImm(row * 8));
        asm.ldrsh(A1, mem(ctx, layout.words + W.cell * 2));
        if (column !== 0) asm.add(A1, A1, armImm(column * 8));
        // A 256-colour object's tile number counts thirty-two-byte units, so a
        // sixty-four-byte tile is at twice its index — the one place this
        // console's object format is not simply the background's.
        asm.movImm32(A2, ((tile * 2) & 0x3ff) | (OBJ_PRIORITY << 10));
        asm.bl(needPushSprite(ctx));
      }
    }
    asm.label(skip);
    ctx.poolCheck();
  }
}

/** The object bank's placeholder block, which is its first tile. */
const OBJECT_TILE_GBA = 0;

/**
 * `r1` = entity base, `r2`/`r3` = the size in cells → `r0` zero when the object
 * is certainly outside the view.
 *
 * It compares whole cells, not positions, which is what makes it cheap: the high
 * halfword of a 16.16 coordinate *is* the cell it sits in, signed, in one
 * instruction. The margins are rounded outward by a cell, so an object
 * straddling the edge is never culled.
 */
function needOnscreen(ctx: GbaCtx): Ref {
  return ctx.need("Onscreen", (inner) => {
    const { asm, layout } = inner;
    const camera = layout.camera as number;
    const apart = inner.unique("cullOff");

    const axis = (offset: number, size: number, span: number): void => {
      asm.ldrsh(A0, armAt(A1, offset + CELL_OFFSET));
      asm.ldrsh(ADDR, mem(inner, camera + offset + CELL_OFFSET));
      asm.sub(A0, A0, armReg(ADDR));
      // Off the near side: the object's far edge is left of (or above) the view.
      asm.add(ADDR, A0, armReg(size));
      asm.cmp(ADDR, armImm(0));
      inner.far("mi", apart);
      // Off the far side: the object's near edge is past the last visible cell.
      asm.cmp(A0, armImm(span));
      inner.far("gt", apart);
    };
    axis(propOffset("x"), A2, layout.memory.viewW);
    axis(propOffset("y"), A3, layout.memory.viewH);

    asm.movs(A0, armImm(1));
    asm.ret();
    asm.label(apart);
    asm.movs(A0, armImm(0));
    asm.ret();
    asm.ltorg();
  });
}

/**
 * `r0` = y, `r1` = x, `r2` = the third attribute halfword; append an object.
 *
 * Positions are screen pixels and go in unbiased — this hardware expresses an
 * object hanging off the top or left as a wrapped coordinate rather than through
 * a bias, so a Y of −4 is stored as 252 and read back as −4. That only works
 * inside one wrap, which is why anything further out is dropped here rather than
 * appearing at the opposite edge.
 */
function needPushSprite(ctx: GbaCtx): Ref {
  return ctx.need("PushSprite", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("oamRoom");
    const off = inner.unique("oamOff");
    // Outside the screen by more than one object: nothing to draw, and drawing
    // it would put it back on at the other edge.
    asm.add(A3, A0, armImm(8));
    asm.cmp(A3, armImm(168));
    inner.far("cs", off);
    asm.add(A3, A1, armImm(8));
    asm.cmp(A3, armImm(248));
    inner.far("cs", off);

    asm.ldrb(A3, mem(inner, layout.oamCount));
    asm.cmp(A3, armImm(layout.memory.oamEntries));
    inner.far("cc", room);
    asm.label(off);
    asm.ret();
    asm.label(room);
    asm.movImm32(ADDR, layout.memory.oamShadow);
    asm.add(ADDR, ADDR, armLsl(A3, 3));
    // The first attribute: eight bits of Y, and the bit that says this object
    // reads 256-colour tiles.
    asm.and(A0, A0, armImm(0xff));
    asm.orr(A0, A0, armImm(0x2000));
    asm.strh(A0, armAt(ADDR, 0));
    // The second: nine bits of X, and a shape and size that mean 8×8 — so the
    // mask is load-bearing, because a negative X is expressed as a wrap and its
    // sign bits would otherwise land on the flip and size fields.
    asm.and(A1, A1, armImm(0x1ff));
    asm.strh(A1, armAt(ADDR, 2));
    asm.strh(A2, armAt(ADDR, 4));
    asm.add(A3, A3, armImm(1));
    asm.strb(A3, mem(inner, layout.oamCount));
    asm.ret();
    asm.ltorg();
  });
}

// --- shared render routines --------------------------------------------------

/** Emit the render helpers the scene code calls. */
export function emitRenderHelpers(ctx: GbaCtx): void {
  emitUploadFrame(ctx);
}

/**
 * `r1` = the video-RAM offset of the cell at `words[tileCol]`, `words[tileRow]`,
 * leaving `r0` alone.
 *
 * The map is 64×64 cells, which the hardware stores as *four* 32×32 screen
 * blocks a kilobyte apart rather than as a rectangle — so column 32 is `$800`
 * from column 0 and row 32 is `$1000` from row 0. A reader that assumed a
 * rectangle would agree with a renderer that made the same mistake, which is
 * exactly the Super Nintendo's trap with two more blocks in it.
 */
function needCellOffset(ctx: GbaCtx): Ref {
  return ctx.need("CellOffset", (inner) => {
    const { asm, layout } = inner;
    asm.ldrh(A1, mem(inner, layout.words + W.tileRow * 2));
    asm.ldrh(A2, mem(inner, layout.words + W.tileCol * 2));
    asm.and(A3, A1, armImm(MAP_H / 2));
    asm.mov(A3, armLsl(A3, 7));
    asm.and(ADDR, A2, armImm(MAP_W / 2));
    asm.orr(A3, A3, armLsl(ADDR, 6));
    asm.and(A1, A1, armImm(MAP_H / 2 - 1));
    asm.orr(A3, A3, armLsl(A1, 6));
    asm.and(A2, A2, armImm(MAP_W / 2 - 1));
    asm.orr(A3, A3, armLsl(A2, 1));
    asm.movImm32(A1, MAP_BASE);
    asm.add(A1, A1, armReg(A3));
    asm.ret();
    asm.ltorg();
  });
}

/** The same, for the HUD layer's single 32×32 block. */
function needHudOffset(ctx: GbaCtx): Ref {
  return ctx.need("HudOffset", (inner) => {
    const { asm, layout } = inner;
    asm.ldrh(A1, mem(inner, layout.words + W.tileRow * 2));
    asm.ldrh(A2, mem(inner, layout.words + W.tileCol * 2));
    asm.and(A1, A1, armImm(HUD_H - 1));
    asm.and(A2, A2, armImm(HUD_W - 1));
    asm.mov(A1, armLsl(A1, 6));
    asm.orr(A1, A1, armLsl(A2, 1));
    asm.movImm32(A2, HUD_BASE);
    asm.add(A1, A1, armReg(A2));
    asm.ret();
    asm.ltorg();
  });
}

/**
 * `r0` = a cell halfword, `words[target]` = its video-RAM offset: append a
 * four-byte entry to the queue.
 */
function needQueueEntry(ctx: GbaCtx): Ref {
  return ctx.need("QueueEntry", (inner) => {
    const { asm, layout } = inner;
    const room = inner.unique("queueRoom");
    asm.ldrb(A1, mem(inner, layout.queueCount));
    asm.cmp(A1, armImm(layout.memory.queueMax));
    inner.far("cc", room);
    // No room: repaint the whole background next frame rather than leave a strip
    // of it stale for ever.
    asm.mov(A2, armImm(1));
    asm.strb(A2, mem(inner, layout.redraw));
    asm.ret();
    asm.label(room);
    asm.movImm32(A2, layout.queue);
    asm.add(A2, A2, armLsl(A1, 2));
    asm.ldrh(A3, mem(inner, layout.words + W.target * 2));
    asm.strh(A3, armAt(A2, 0));
    asm.strh(A0, armAt(A2, 2));
    asm.add(A1, A1, armImm(1));
    asm.strb(A1, mem(inner, layout.queueCount));
    asm.ret();
    asm.ltorg();
  });
}

/**
 * `r0` = a tile: queue it on the HUD layer, record the cell for erasing, and
 * advance the column.
 */
function needPlotCell(ctx: GbaCtx): Ref {
  return ctx.need("PlotCell", (inner) => {
    const { asm, layout } = inner;
    const full = inner.unique("plotFull");
    asm.push([LR]);
    asm.bl(needHudOffset(inner));
    asm.strh(A1, mem(inner, layout.words + W.target * 2));
    asm.bl(needQueueEntry(inner));
    asm.ldrb(A1, mem(inner, layout.plotCount));
    asm.cmp(A1, armImm(layout.memory.plotMax));
    inner.far("cs", full);
    asm.movImm32(A2, layout.plot);
    asm.add(A2, A2, armLsl(A1, 1));
    asm.ldrb(A3, mem(inner, layout.words + W.tileCol * 2));
    asm.strb(A3, armAt(A2, 0));
    asm.ldrb(A3, mem(inner, layout.words + W.tileRow * 2));
    asm.strb(A3, armAt(A2, 1));
    asm.add(A1, A1, armImm(1));
    asm.strb(A1, mem(inner, layout.plotCount));
    asm.label(full);
    inc16(inner, layout.words + W.tileCol * 2);
    asm.pop([PC]);
    asm.ltorg();
  });
}

/** The same, straight into video RAM, for a caption painted under forced blank. */
function needPokeCell(ctx: GbaCtx): Ref {
  return ctx.need("PokeCell", (inner) => {
    const { asm, layout } = inner;
    asm.push([LR]);
    asm.bl(needHudOffset(inner));
    asm.movImm32(A2, VRAM);
    asm.strh(A0, armAtIdx(A2, A1));
    inc16(inner, layout.words + W.tileCol * 2);
    asm.pop([PC]);
    asm.ltorg();
  });
}

/** The decimal renderer, queued. */
function needPlotNumber(ctx: GbaCtx): Ref {
  return ctx.need("DrawNumber", (inner) => emitDecimal(inner, needPlotCell(inner)));
}

/** The decimal renderer again, writing straight to video RAM. */
function needPokeNumber(ctx: GbaCtx): Ref {
  return ctx.need("DrawNumberPoke", (inner) => emitDecimal(inner, needPokeCell(inner)));
}

/**
 * Flush the queue, upload the objects, and set the scroll.
 *
 * All three fit inside the blanking interval by construction — this console's is
 * some eighty-three thousand cycles, against a Game Boy's eleven hundred — and
 * the queue is capped at far less than that, so anything over sets the redraw
 * flag rather than being dropped.
 */
function emitUploadFrame(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  asm.label("UploadFrame");
  const noQueue = ctx.unique("noQueue");
  const flush = ctx.unique("flushLoop");
  asm.ldrb(A0, mem(ctx, layout.queueCount));
  asm.cmp(A0, armImm(0));
  ctx.far("eq", noQueue);
  asm.movImm32(A1, layout.queue);
  asm.movImm32(A2, VRAM);
  asm.label(flush);
  asm.ldrh(A3, armAtPost(A1, 2));
  asm.ldrh(ADDR, armAtPost(A1, 2));
  asm.add(A3, A2, armReg(A3));
  asm.strh(ADDR, armAt(A3, 0));
  asm.subs(A0, A0, armImm(1));
  ctx.far("ne", flush);
  asm.mov(A0, armImm(0));
  asm.strb(A0, mem(ctx, layout.queueCount));
  asm.label(noQueue);

  emitOamUpload(ctx);
  emitScrollWrite(ctx);
  asm.ret();
  asm.ltorg();
}

/**
 * Send the object shadow, and hide whatever last frame drew that this one did
 * not.
 *
 * There is no link field on this hardware — an entry is hidden by its own mode
 * bits — so the count that matters is the *larger* of this frame's and last
 * frame's, and everything above this frame's count is parked before the copy.
 */
function emitOamUpload(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  const hideLoop = ctx.unique("oamHide");
  const hidden = ctx.unique("oamHidden");
  const copyLoop = ctx.unique("oamCopy");
  const noObjects = ctx.unique("noObjects");

  asm.ldrb(A0, mem(ctx, layout.oamCount));
  asm.ldrb(A1, mem(ctx, layout.oamPrev));
  asm.strb(A0, mem(ctx, layout.oamPrev));
  // total = max(count, prev)
  asm.cmp(A1, armReg(A0));
  asm.mov(A1, armReg(A0), "cc");
  asm.cmp(A0, armReg(A1));
  ctx.far("cs", hidden);
  asm.movImm32(A2, layout.memory.oamShadow);
  asm.add(A2, A2, armLsl(A0, 3));
  asm.mov(A3, armImm(0x0200));
  asm.label(hideLoop);
  asm.strh(A3, armAt(A2, 0));
  asm.add(A2, A2, armImm(8));
  asm.add(A0, A0, armImm(1));
  asm.cmp(A0, armReg(A1));
  ctx.far("cc", hideLoop);
  asm.label(hidden);

  asm.cmp(A1, armImm(0));
  ctx.far("eq", noObjects);
  asm.movImm32(A2, layout.memory.oamShadow);
  asm.movImm32(A3, OAM);
  asm.label(copyLoop);
  asm.ldr(A0, armAtPost(A2, 4));
  asm.str(A0, armAtPost(A3, 4));
  asm.ldr(A0, armAtPost(A2, 4));
  asm.str(A0, armAtPost(A3, 4));
  asm.subs(A1, A1, armImm(1));
  ctx.far("ne", copyLoop);
  asm.label(noObjects);
}

/**
 * Write the two scroll registers.
 *
 * Both carry the camera directly — this hardware's scroll is the *source*
 * offset, not the amount the picture moves — and both wrap at the map's size in
 * pixels, 512 either way, which the nine-bit registers do for nothing.
 */
function emitScrollWrite(ctx: GbaCtx): void {
  const { asm, layout } = ctx;
  asm.movImm32(ADDR, IO + REG.BG0HOFS);
  asm.ldrh(A0, mem(ctx, layout.words + W.scrollX * 2));
  asm.strh(A0, armAt(ADDR, 0));
  asm.ldrh(A0, mem(ctx, layout.words + W.scrollY * 2));
  asm.strh(A0, armAt(ADDR, 2));
}

/**
 * Draw the signed 16-bit value `r1` points at in decimal, one glyph at a time.
 *
 * `plot` is the routine that puts a glyph down and advances the pen, and it is
 * the *only* difference between the queued HUD and the one painted under forced
 * blank — which is why it is a parameter rather than a second copy of the digit
 * loop. Leading zeroes are suppressed and a lone zero still prints.
 *
 * The whole state is in callee-saved registers across the call, which no other
 * backend can do: the Mega Drive's version keeps its digit, its power and its
 * running value in render words precisely because a 68000 helper helps itself to
 * every register there is. Here the convention says `r4`–`r11` survive a call,
 * and every routine in this backend keeps it.
 */
function emitDecimal(ctx: GbaCtx, plot: Ref): void {
  const { asm } = ctx;
  const positive = ctx.unique("numPos");
  const powerLoop = ctx.unique("numPower");
  const subLoop = ctx.unique("numSub");
  const subDone = ctx.unique("numSubDone");
  const emitDigit = ctx.unique("numEmit");
  const skipDigit = ctx.unique("numSkip");

  asm.push([V0, V1, V2, V3, LR]);
  asm.ldrsh(V0, armAt(A1, 0)); // the running value
  asm.cmp(V0, armImm(0));
  ctx.far("ge", positive);
  // Negate, then print the sign. The pen has to advance first, which is why the
  // minus is emitted before the digits rather than after the negation.
  asm.rsb(V0, V0, armImm(0));
  asm.mov(A0, armImm(glyphTile("-")));
  asm.bl(plot);
  asm.label(positive);

  asm.mov(V1, armImm(0)); // has anything been printed yet
  asm.movImm32(V2, label("DecimalPowers"));
  asm.mov(V3, armImm(0)); // which power

  asm.label(powerLoop);
  asm.ldr(A1, armAtIdx(V2, V3, "lsl", 2));
  asm.mov(A2, armImm(0)); // this digit
  asm.label(subLoop);
  asm.cmp(V0, armReg(A1));
  ctx.far("lt", subDone);
  asm.sub(V0, V0, armReg(A1));
  asm.add(A2, A2, armImm(1));
  asm.b(subLoop);
  asm.label(subDone);
  asm.cmp(A2, armImm(0));
  ctx.far("ne", emitDigit);
  asm.cmp(V1, armImm(0));
  ctx.far("ne", emitDigit);
  asm.cmp(V3, armImm(4));
  ctx.far("ne", skipDigit);
  asm.label(emitDigit);
  asm.mov(V1, armImm(1));
  asm.add(A0, A2, armImm(glyphTile("0")));
  asm.bl(plot);
  asm.label(skipDigit);
  asm.add(V3, V3, armImm(1));
  asm.cmp(V3, armImm(5));
  ctx.far("lt", powerLoop);
  asm.pop([V0, V1, V2, V3, PC]);
  asm.ltorg();
  ctx.data((data) => {
    if (data.has("DecimalPowers")) return;
    data.align();
    data.label("DecimalPowers");
    for (const power of [10000, 1000, 100, 10, 1]) data.dw(power);
  });
}
