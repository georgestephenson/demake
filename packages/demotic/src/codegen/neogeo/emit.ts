/**
 * The Neo Geo's renderer — the only thing this backend owns.
 *
 * The value layer, the expression compiler, the rule bodies, the tile walk and
 * the tile rules are all `codegen/m68k/`'s, shared verbatim with the Mega Drive
 * because a 68000 is a 68000. What is left is how a frame reaches the screen,
 * and on this console that is unlike every other machine in the set in four
 * ways.
 *
 *   - **The playfield is sprites.** Twenty-one vertical strips, each a column of
 *     tile numbers in SCB1, with every strip after the first *sticky* — chained
 *     to the one before it. So the whole plane carries one position between all
 *     of them and scrolling is two writes: the anchor's SCB3 and SCB4.
 *   - **There is no edge painter, and that is the 16×16 cell paying off.** The
 *     plane is 21×15 cells where a Mega Drive's map is 64×32, so repainting the
 *     whole thing is 630 words through the VRAM port — a few thousand cycles out
 *     of a frame's two hundred thousand. Every other backend in the project
 *     paints a leading edge because a full redraw is too dear; here it simply is
 *     not, so that entire mechanism is absent rather than reimplemented.
 *   - **The HUD is the fix layer**, 8×8 and always in front of every sprite, and
 *     its grid *is* the language's cell grid. So a caption is written to the cell
 *     the rules name and held still while the plane slides under it, with none of
 *     the sprite-HUD machinery the 8-bit consoles need.
 *   - **The watchdog has to be kicked.** A cartridge that never writes `$300001`
 *     is rebooted after about eight frames, so the frame handler does it — the
 *     one thing here whose absence produces a perfect cartridge and a console in
 *     a reset loop.
 */

import { eaA, eaAbs, eaD, eaImm, eaInd, eaPost, eaPre, label, type Ref } from "@demake/core";
import {
  encodeScb3,
  encodeScb4,
  FIX_MAP,
  FIX_ROWS,
  SCB1,
  SCB1_STRIDE,
  SCB3,
  SCB4,
  SPRITE_COUNT,
} from "@demake/neogeo";

import type { InstanceDef } from "../../program.js";
import { glyphTile, OBJECT_TILE } from "../../rom/graphics.js";
import { isMutable } from "../analyze.js";
import { emitTickSteps, type TickSteps } from "../backend.js";
import { PROPS, W } from "../layout.js";
import type { M68kCtx } from "../m68k/ctx.js";
import { propOffset } from "../m68k/expr.js";
import {
  emitCamera,
  emitCollisions,
  emitControls,
  emitEdgeRules,
  emitIntegrate,
  emitLevelRules,
} from "../m68k/rules.js";
import {
  collectLevels,
  emitLevelData,
  emitRuleTileTable,
  emitTileAt,
  type LevelData,
} from "../m68k/tiles.js";
import { emitTileContactHelper, emitTileRules } from "../m68k/tilerules.js";
import { at, branchZero32, copy32, sub32 } from "../m68k/val.js";
import { CELL_OFFSET } from "../m68k/rules.js";
import type { NeogeoArtOptions } from "../neogeo-art.js";
import {
  artKey,
  emitInstanceDefaults,
  instanceCells,
  sceneContexts,
  sceneIndexOf,
  scrolls,
  type SceneCtx,
} from "../shape.js";

import {
  CELLS_PER_TILE,
  FIX_VIEW_H,
  FIX_VIEW_W,
  OBJECT_SPRITE0,
  PLANE_ROWS,
  PLANE_SPRITE0,
  PLANE_STRIPS,
  SYSTEM_PALETTE,
  TILE_PIXELS,
} from "./machine.js";

/** Where a demade program's own code starts, past the vectors and the header. */
export const CODE_ORIGIN = 0x200;

/** The top of this console's work RAM, kept even. */
export const STACK_TOP = 0x10f300;

/** The LSPC's ports. */
const LSPC = {
  ADDRESS: 0x3c0000,
  DATA: 0x3c0002,
  MODULO: 0x3c0004,
  IRQACK: 0x3c000c,
} as const;

/** Byte writes where the *address* is the command. */
const SYSTEM = {
  WATCHDOG: 0x300001,
  ENABLE_SPRITES: 0x3a0019,
  ENABLE_FIX: 0x3a001b,
  PALBANK0: 0x3a001f,
} as const;

/** Player one's buttons, and the register start and select live in. */
const INPUT = { PAD: 0x300000, STATUS: 0x380000 } as const;

/** Palette RAM in the 68000's map — ordinary memory, not a port. */
const PALETTE_BASE = 0x400000;

/** Words a staged object strip occupies: SCB3, SCB4, and two rows of SCB1. */
const STRIP_WORDS = 6;

/** Tiles tall an object strip may be. Two covers every object in the library. */
const STRIP_TILES = 2;

/** The byte the frame interrupt raises and the main loop waits on. */
function frameFlag(ctx: M68kCtx): number {
  return ctx.layout.interrupt as number;
}

/** Everything the emitter needs beyond the program itself. */
export type NeogeoEmitOptions = NeogeoArtOptions;

/** Point the data port at a compile-time VRAM address, stepping by `step`. */
function emitVramAddress(ctx: M68kCtx, address: number, step = 1): void {
  const { asm } = ctx;
  asm.move("w", eaImm(address & 0xffff), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaImm(step & 0xffff), eaAbs(LSPC.MODULO));
}

/** Dispatch on the running scene, through a table — the Mega Drive's reasoning. */
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
export function emitProgram(ctx: M68kCtx, options: NeogeoEmitOptions = {}): void {
  const { asm, program } = ctx;
  const scenes = sceneContexts(ctx);
  const levels = collectLevels(program.scenes);
  const levelFor = new Map<number, LevelData>();
  for (const scene of scenes) {
    const found = levels.find((data) => data.file === scene.level);
    if (found) levelFor.set(scene.index, found);
  }

  emitReset(ctx);
  emitVint(ctx);
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
    // The tile a legend entry draws is not used by this renderer — the plane is
    // composed at build time — but the tile *walk* still reads the grid and the
    // solid table, so the level data is emitted exactly as it is elsewhere.
    emitLevelData(asm, level, () => 0);
    asm.align();
    emitTileAt(ctx, level);
    for (const rule of program.rules) {
      if (rule.event.kind === "hits" && rule.event.tiles.length > 0) {
        emitRuleTileTable(asm, rule, level);
        asm.align();
      }
    }
    asm.align();
    const plane = options.levelPlanes?.get(level.index);
    if (plane) {
      asm.label(planeLabel(level.index));
      for (const word of plane.words) asm.dw(word);
      asm.align();
    }
  }
  asm.align();
  emitInstanceDefaults(asm, program, PROPS, ctx.layout.entitySizes);

  for (const scene of scenes) {
    const art = options.backdrops?.get(scene.def.name);
    if (!art) continue;
    asm.align();
    asm.label(backdropLabel(scene));
    for (const word of art.map) asm.dw(word);
    asm.align();
    asm.label(scenePaletteLabel(scene));
    for (const word of art.palette) asm.dw(word);
    asm.align();
  }

  asm.align();
  asm.label("Palette");
  for (const word of options.palette ?? new Uint16Array(256 * 16)) asm.dw(word);
}

function backdropLabel(scene: SceneCtx): string {
  return `Backdrop_${scene.index}`;
}

function scenePaletteLabel(scene: SceneCtx): string {
  return `ScenePalette_${scene.index}`;
}

function planeLabel(index: number): string {
  return `LevelPlane_${index}`;
}

/**
 * Boot.
 *
 * Entered from the header's `JMP USER`, which is where this console's boot ROM
 * hands over — a cartridge has no reset vector of its own to run first.
 */
function emitReset(ctx: M68kCtx): void {
  const { asm, layout, program } = ctx;

  asm.label("Reset");
  asm.moveToSr(eaImm(0x2700));
  asm.movea("l", eaImm(STACK_TOP), 7);

  // Clear work RAM below the stack, so a game's state starts from zero rather
  // than from whatever powered up.
  const clearLoop = ctx.unique("clearRam");
  asm.movea("l", eaImm(0x100000), 0);
  asm.move("w", eaImm((STACK_TOP - 0x100000) / 4 - 1), eaD(0));
  asm.label(clearLoop);
  asm.clr("l", eaPost(0));
  asm.dbra(0, clearLoop);
  asm.movea("l", eaImm(STACK_TOP), 7);

  emitParkSprites(ctx);
  emitClearFix(ctx);
  emitPlaneSetup(ctx);
  asm.lea(eaAbs(label("Palette")), 0);
  asm.jsr("UploadPalette");

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
    layout.oamCount,
  ]) {
    asm.clr("b", at(address));
  }
  asm.move("b", eaImm(0xff), at(layout.pending));
  asm.move("b", eaImm(sceneIndexOf(program, program.entryScene)), at(layout.scene));
  emitClearState(ctx);
  emitSeedRng(ctx);

  asm.jsr("ResetScene");
  // The interpreter's camera starts at the origin and only moves at the end of a
  // tick, so a rule reading it on tick one sees zero.
  if (layout.camera !== null) {
    asm.clr("l", at(layout.camera));
    asm.clr("l", at(layout.camera + 4));
  }
  asm.jsr("BuildFrame");
  asm.jsr("UploadFrame");

  // The layers on, and the interrupt unmasked. Everything above ran with the
  // display off, which is what makes a screenful of SCB1 safe to write.
  asm.move("b", eaImm(0), eaAbs(SYSTEM.PALBANK0));
  asm.move("b", eaImm(0), eaAbs(SYSTEM.ENABLE_SPRITES));
  asm.move("b", eaImm(0), eaAbs(SYSTEM.ENABLE_FIX));
  asm.move("b", eaImm(1), at(layout.booted));
  asm.moveToSr(eaImm(0x2000));
  asm.jmp("Main");
}

/**
 * The vertical interrupt: acknowledge, kick the watchdog, say the frame
 * happened.
 *
 * **The acknowledge writes all three source bits rather than the one.** Clearing
 * a flag that is not set is a no-op, and getting the bit wrong is the failure the
 * Sega audio suite exists to catch — an interrupt left pending re-enters the
 * moment the mask drops, and the whole game runs thousands of times too fast
 * with every write correct. Acking the lot cannot be wrong in that direction.
 *
 * The watchdog is kicked here because here is the one routine that runs whatever
 * the main loop is doing.
 */
function emitVint(ctx: M68kCtx): void {
  const { asm } = ctx;
  asm.label("Vint");
  asm.move("l", eaD(0), eaPre(7));
  asm.move("w", eaImm(7), eaAbs(LSPC.IRQACK));
  asm.move("b", eaImm(0), eaAbs(SYSTEM.WATCHDOG));
  asm.move("b", eaImm(1), at(frameFlag(ctx)));
  asm.move("l", eaPost(7), eaD(0));
  asm.rte();
}

function emitMainLoop(ctx: M68kCtx): void {
  const { asm } = ctx;
  const wait = ctx.unique("waitFrame");
  asm.label("Main");
  asm.label(wait);
  asm.tst("b", at(frameFlag(ctx)));
  ctx.far("eq", wait);
  asm.clr("b", at(frameFlag(ctx)));
  asm.jsr("UploadFrame");
  asm.jsr("ReadInput");
  asm.jsr("Tick");
  asm.jsr("BuildFrame");
  asm.jmp("Main");
}

/**
 * Read the pad into the abstract button set, and derive this tick's edges.
 *
 * Both registers are active low, so each is complemented on the way in. `c` and
 * `d` are simply not looked at — the language has no word for them.
 */
function emitInput(ctx: M68kCtx): void {
  const { asm, layout } = ctx;
  asm.label("ReadInput");
  asm.move("b", eaAbs(INPUT.PAD), eaD(0));
  asm.not("b", eaD(0));
  asm.move("b", eaAbs(INPUT.STATUS), eaD(1));
  asm.not("b", eaD(1));

  const ABSTRACT = ["left", "right", "up", "down", "a", "b", "start"] as const;
  const SOURCE: Readonly<Record<string, [number, number]>> = {
    up: [0, 0],
    down: [0, 1],
    left: [0, 2],
    right: [0, 3],
    a: [0, 4],
    b: [0, 5],
    start: [1, 0],
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
  if (layout.sound !== null) asm.move("b", eaImm(0xff), at(layout.sound));
  emitSceneDispatch(
    ctx,
    scenes.map((scene) => `SceneTick_${scene.index}`),
  );
  asm.label("TickDone");
  asm.jsr("SceneChange");
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
  asm.jsr("ResetScene");
  emitSeedRng(ctx);
  emitClearState(ctx);
  asm.jsr("UpdateCamera");
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

/**
 * Build one scene's frame.
 *
 * The plane is repainted whole rather than at its edges, which is what the 16×16
 * cell buys: 315 cells against a Mega Drive's 2048, so the redraw is a few
 * thousand cycles and the leading-edge painter every other backend needs does not
 * exist here.
 */
function emitSceneRender(
  ctx: M68kCtx,
  scene: SceneCtx,
  level: LevelData | undefined,
  options: NeogeoEmitOptions,
): void {
  const { asm, layout } = ctx;
  asm.label(`SceneRender_${scene.index}`);

  const backdrop = options.backdrops?.get(scene.def.name);
  const plane = level ? options.levelPlanes?.get(level.index) : undefined;

  if (backdrop) {
    asm.lea(eaAbs(label(scenePaletteLabel(scene))), 0);
    asm.jsr("UploadPalette");
  }

  // The plane's origin, in whole hardware cells: a backdrop is screen-fixed, a
  // level scrolls with the camera.
  if (plane) {
    emitPlaneOrigin(ctx, plane.wide, plane.high);
    asm.lea(eaAbs(label(planeLabel(level!.index))), 0);
    asm.move("w", eaImm(plane.wide), eaD(1));
  } else if (backdrop) {
    asm.clr("w", at(layout.words + W.mapCol * 2));
    asm.clr("w", at(layout.words + W.mapRow * 2));
    asm.lea(eaAbs(label(backdropLabel(scene))), 0);
    asm.move("w", eaImm(PLANE_STRIPS), eaD(1));
  }
  if (plane || backdrop) asm.jsr("PaintPlane");

  emitScroll(ctx, scene, plane !== undefined);
  emitObjects(ctx, scene, options);
  emitHud(ctx, scene);
  asm.rts();
}

/**
 * Where the plane's top-left cell sits in the map, clamped to its edges.
 *
 * The camera is level pixels; a hardware cell is sixteen of them, so the origin
 * is the camera's whole cell and the remainder is what the scroll registers
 * carry. Clamped because the map is exactly as wide as it is and a strip reading
 * past its end would paint whatever followed it in the cartridge.
 */
function emitPlaneOrigin(ctx: M68kCtx, wide: number, high: number): void {
  const { asm, layout } = ctx;
  const maxCol = Math.max(0, wide - PLANE_STRIPS);
  const maxRow = Math.max(0, high - PLANE_ROWS);
  const axis = (source: number | null, slot: number, limit: number): void => {
    if (source === null) {
      asm.clr("w", at(layout.words + slot * 2));
      return;
    }
    asm.move("l", at(source), eaD(0));
    asm.asr("l", 8, 0);
    asm.asr("l", 8, 0);
    asm.asr("w", 4, 0);
    const low = ctx.unique("originLow");
    const done = ctx.unique("originDone");
    asm.tst("w", eaD(0));
    ctx.far("pl", low);
    asm.moveq(0, 0);
    asm.label(low);
    asm.cmpi("w", limit, eaD(0));
    ctx.far("le", done);
    asm.move("w", eaImm(limit), eaD(0));
    asm.label(done);
    asm.move("w", eaD(0), at(layout.words + slot * 2));
  };
  axis(layout.camera, W.mapCol, maxCol);
  axis(layout.camera === null ? null : layout.camera + 4, W.mapRow, maxRow);
}

/**
 * Move the plane, which is two writes.
 *
 * Every strip after the anchor is sticky, so all twenty-one take the anchor's Y
 * and are drawn sixteen pixels apart from its X. What the registers carry is the
 * camera's *remainder* within a cell, because the whole cells were spent choosing
 * which part of the map to paint.
 */
function emitScroll(ctx: M68kCtx, scene: SceneCtx, moves: boolean): void {
  const { asm, layout } = ctx;
  if (!moves || layout.camera === null || !scrolls(ctx, scene)) return;

  // X: the sub-cell remainder, negated, so the plane slides left as the camera
  // moves right.
  asm.move("l", at(layout.camera), eaD(0));
  asm.asr("l", 8, 0);
  asm.asr("l", 8, 0);
  asm.andi("w", TILE_PIXELS - 1, eaD(0));
  asm.neg("w", eaD(0));
  asm.andi("w", 0x1ff, eaD(0));
  asm.lsl("w", 7, 0);
  emitVramAddress(ctx, SCB4 + PLANE_SPRITE0);
  asm.move("w", eaD(0), eaAbs(LSPC.DATA));

  asm.move("l", at(layout.camera + 4), eaD(0));
  asm.asr("l", 8, 0);
  asm.asr("l", 8, 0);
  asm.andi("w", TILE_PIXELS - 1, eaD(0));
  asm.neg("w", eaD(0));
  // SCB3 stores `496 - y` in its top nine bits, with the height below.
  asm.addi("w", 496, eaD(0));
  asm.andi("w", 0x1ff, eaD(0));
  asm.lsl("w", 7, 0);
  asm.ori("w", PLANE_ROWS, eaD(0));
  emitVramAddress(ctx, SCB3 + PLANE_SPRITE0);
  asm.move("w", eaD(0), eaAbs(LSPC.DATA));
}

/**
 * Stage this scene's objects.
 *
 * One strip per sixteen pixels of width, because that is the narrowest sprite
 * this hardware has — the PC Engine's arithmetic, into a per-line budget of
 * ninety-six rather than sixteen.
 */
function emitObjects(ctx: M68kCtx, scene: SceneCtx, options: NeogeoEmitOptions): void {
  const { asm, layout, program } = ctx;
  asm.clr("b", at(layout.oamCount));

  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const asset = instance.strings["sprite"];
    if (asset === undefined) continue;

    const width = instanceCells(instance, "width");
    const height = instanceCells(instance, "height");
    const art = options.sprites?.get(artKey(asset, width, height)) ?? options.sprites?.get(asset);

    const skip = ctx.unique("objSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      branchZero32(ctx, (layout.entities[id] as number) + propOffset("visible"), skip);
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      continue;
    }

    const base = layout.entities[id] as number;
    ctx.scoped(() => {
      const temp = ctx.pushTemp();
      copy32(ctx, temp, base + propOffset("x"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera);
      emitPixelsFromFixed(ctx, temp, layout.words + W.cell * 2);
      copy32(ctx, temp, base + propOffset("y"));
      if (layout.camera !== null) sub32(ctx, temp, layout.camera + 4);
      emitPixelsFromFixed(ctx, temp, layout.words + W.count * 2);
    });

    const tilesWide = art ? art.tilesWide : Math.max(1, Math.ceil(width / CELLS_PER_TILE));
    for (let column = 0; column < tilesWide; column += 1) {
      asm.move("w", at(layout.words + W.count * 2), eaD(0));
      asm.move("w", at(layout.words + W.cell * 2), eaD(1));
      if (column !== 0) asm.addi("w", column * TILE_PIXELS, eaD(1));
      const tile = art ? art.tile + column : OBJECT_TILE;
      asm.move("w", eaImm(tile & 0xffff), eaD(2));
      asm.move("w", eaImm(((art ? art.palette : SYSTEM_PALETTE) & 0xff) << 8), eaD(3));
      asm.jsr(needPushStrip(ctx));
    }
    asm.label(skip);
  }
}

/** Whole pixels from a 16.16 value: the high word, sign-extended. */
function emitPixelsFromFixed(ctx: M68kCtx, src: number, dst: number): void {
  const { asm } = ctx;
  asm.move("l", at(src), eaD(0));
  asm.asr("l", 8, 0);
  asm.asr("l", 8, 0);
  asm.move("w", eaD(0), at(dst));
}

/**
 * Draw this scene's captions into the fix layer, every frame.
 *
 * Simpler than every other backend's HUD, and the fix layer is why. On a console
 * whose captions share the background plane, a changing counter needs a write
 * queue, an erase list and a repaint of whatever it covered; here the layer is
 * separate and in front, so a caption is overwritten in place and a number is
 * blank-padded to a fixed width rather than erased. There is no queue, no plot
 * list and no `PlotCell` on this console at all.
 */
function emitHud(ctx: M68kCtx, scene: SceneCtx): void {
  const { asm, layout, program } = ctx;
  for (const id of scene.def.instanceIds) {
    const instance = program.instances[id] as InstanceDef;
    const isNumber = instance.className === "number";
    const isText = instance.className === "text";
    if (!isNumber && !isText) continue;

    const skip = ctx.unique("hudSkip");
    if (isMutable(ctx.analysis, id, "visible")) {
      branchZero32(ctx, (layout.entities[id] as number) + propOffset("visible"), skip);
    } else if ((instance.numbers["visible"] ?? 0) === 0) {
      continue;
    }
    const base = layout.entities[id] as number;
    asm.move("w", at(base + propOffset("x") + CELL_OFFSET), at(layout.words + W.tileCol * 2));
    asm.move("w", at(base + propOffset("y") + CELL_OFFSET), at(layout.words + W.tileRow * 2));

    if (isText) {
      const text = instance.strings["text"] ?? "";
      for (const character of [...text].slice(0, FIX_VIEW_W)) {
        asm.move("w", eaImm(fixWord(glyphTile(character))), eaD(0));
        asm.jsr(needPokeFix(ctx));
      }
    } else {
      asm.lea(at(base + propOffset("value") + CELL_OFFSET), 1);
      asm.jsr(needDrawFixNumber(ctx));
    }
    asm.label(skip);
  }
}

/** A fix-map entry: the font's palette above the glyph's tile. */
function fixWord(tile: number): number {
  return ((SYSTEM_PALETTE & 0xf) << 12) | (tile & 0x0fff);
}

/**
 * `d0` a fix-map word: write it at the cursor and step one cell right.
 *
 * The map is column-major, so a cell's word is `column × 32 + row` — the one
 * piece of arithmetic on this layer that is not the obvious one, and the reason
 * a transposed HUD is the failure it is easy to ship.
 */
function needPokeFix(ctx: M68kCtx): Ref {
  return ctx.need("PokeFix", (inner) => {
    const { asm, layout } = inner;
    const skip = inner.unique("pokeSkip");
    asm.move("w", at(layout.words + W.tileCol * 2), eaD(1));
    asm.cmpi("w", FIX_VIEW_W, eaD(1));
    inner.far("ge", skip);
    asm.move("w", at(layout.words + W.tileRow * 2), eaD(2));
    asm.cmpi("w", FIX_VIEW_H, eaD(2));
    inner.far("ge", skip);
    asm.mulu(eaImm(FIX_ROWS), 1);
    asm.add("w", eaD(2), 1);
    asm.addi("w", FIX_MAP, eaD(1));
    asm.move("w", eaD(1), eaAbs(LSPC.ADDRESS));
    asm.move("w", eaImm(1), eaAbs(LSPC.MODULO));
    asm.move("w", eaD(0), eaAbs(LSPC.DATA));
    asm.label(skip);
    asm.addq("w", 1, at(layout.words + W.tileCol * 2));
    asm.rts();
  });
}

/**
 * `a1` a 16.16 value's whole word: draw it right-aligned in three cells.
 *
 * Blank-padded rather than erased, which is the fix layer's dividend: a counter
 * falling from 100 to 99 leaves no stale digit because the leading cell is
 * written with a space every frame.
 */
function needDrawFixNumber(ctx: M68kCtx): Ref {
  return ctx.need("DrawFixNumber", (inner) => {
    const { asm } = inner;
    asm.movem("l", 0x00f0, eaPre(7), true);
    asm.moveq(0, 4);
    asm.move("w", eaInd(1), eaD(4));
    // Three digits, most significant first, each a division by the power below.
    for (const power of [100, 10, 1]) {
      asm.move("w", eaD(4), eaD(5));
      asm.ext("l", 5);
      if (power !== 1) {
        asm.divu(eaImm(power), 5);
        asm.andi("l", 0xffff, eaD(5));
      }
      if (power !== 1) {
        asm.move("w", eaD(5), eaD(6));
        asm.mulu(eaImm(power), 6);
        asm.sub("w", eaD(6), 4);
      }
      asm.andi("w", 0x000f, eaD(5));
      asm.addi("w", glyphTile("0"), eaD(5));
      asm.ori("w", (SYSTEM_PALETTE & 0xf) << 12, eaD(5));
      asm.move("w", eaD(5), eaD(0));
      asm.jsr("PokeFix");
    }
    asm.movem("l", 0x00f0, eaPost(7), false);
    asm.rts();
  });
}

/** Park every sprite: height zero draws nothing, whatever SCB1 holds. */
function emitParkSprites(ctx: M68kCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("parkLoop");
  emitVramAddress(ctx, SCB3);
  asm.move("w", eaImm(SPRITE_COUNT - 1), eaD(0));
  asm.moveq(0, 1);
  asm.label(loop);
  asm.move("w", eaD(1), eaAbs(LSPC.DATA));
  asm.dbra(0, loop);
}

/** Blank the fix layer, so nothing shows before the first caption is written. */
function emitClearFix(ctx: M68kCtx): void {
  const { asm } = ctx;
  const loop = ctx.unique("fixLoop");
  emitVramAddress(ctx, FIX_MAP);
  asm.move("w", eaImm(FIX_VIEW_W * FIX_ROWS - 1), eaD(0));
  asm.moveq(0, 1);
  asm.label(loop);
  asm.move("w", eaD(1), eaAbs(LSPC.DATA));
  asm.dbra(0, loop);
}

/**
 * Set the plane's strips up once, at boot.
 *
 * The anchor carries the position and the height; every strip after it is
 * sticky, which is the whole mechanism. SCB1 is written per scene by
 * `PaintPlane`, not here.
 */
function emitPlaneSetup(ctx: M68kCtx): void {
  const { asm } = ctx;
  emitVramAddress(ctx, SCB3 + PLANE_SPRITE0);
  asm.move("w", eaImm(encodeScb3({ y: 0, sticky: false, height: PLANE_ROWS })), eaAbs(LSPC.DATA));
  for (let strip = 1; strip < PLANE_STRIPS; strip += 1) {
    asm.move("w", eaImm(encodeScb3({ y: 0, sticky: true, height: PLANE_ROWS })), eaAbs(LSPC.DATA));
  }
  emitVramAddress(ctx, SCB4 + PLANE_SPRITE0);
  asm.move("w", eaImm(encodeScb4(0)), eaAbs(LSPC.DATA));
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

function emitSeedRng(ctx: M68kCtx): void {
  const { asm, layout, program } = ctx;
  if (layout.rng === null) return;
  asm.move("l", eaImm(program.seed >>> 0), at(layout.rng));
}

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

/**
 * Append one strip to the shadow: `d0` y, `d1` x, `d2` tile, `d3` attribute.
 *
 * Six words an entry — SCB3, SCB4, and two rows of SCB1 — because those three
 * live in different regions of VRAM and the upload visits each in turn. An
 * object taller than two tiles is not staged; nothing in the example library is,
 * and a third row would be a third address write per object per frame.
 */
function needPushStrip(ctx: M68kCtx): Ref {
  return ctx.need("PushStrip", () => {
    const { asm, layout } = ctx;
    const full = ctx.unique("stripFull");
    asm.moveq(0, 4);
    asm.move("b", at(layout.oamCount), eaD(4));
    asm.cmpi("w", layout.memory.oamEntries, eaD(4));
    ctx.far("ge", full);

    asm.move("w", eaD(4), eaD(5));
    asm.mulu(eaImm(STRIP_WORDS * 2), 5);
    asm.lea(at(layout.memory.oamShadow), 1);
    asm.adda("l", eaD(5), 1);

    // SCB3: `496 - y` in the top nine bits, the height in the low six.
    asm.move("w", eaD(0), eaD(5));
    asm.neg("w", eaD(5));
    asm.addi("w", 496, eaD(5));
    asm.andi("w", 0x1ff, eaD(5));
    asm.lsl("w", 7, 5);
    asm.ori("w", STRIP_TILES, eaD(5));
    asm.move("w", eaD(5), eaPost(1));

    // SCB4: x in the top nine bits.
    asm.move("w", eaD(1), eaD(5));
    asm.andi("w", 0x1ff, eaD(5));
    asm.lsl("w", 7, 5);
    asm.move("w", eaD(5), eaPost(1));

    // Two rows of SCB1. The second is blank: tile zero draws nothing, which is
    // what makes a one-tile object legal in a two-tile strip.
    asm.move("w", eaD(2), eaPost(1));
    asm.move("w", eaD(3), eaPost(1));
    asm.clr("w", eaPost(1));
    asm.clr("w", eaPost(1));

    asm.addq("b", 1, at(layout.oamCount));
    asm.label(full);
    asm.rts();
  });
}

/** The routines every scene shares. */
function emitRenderHelpers(ctx: M68kCtx): void {
  const { asm, layout } = ctx;

  // Palette RAM is ordinary memory in the 68000's map, so this is a copy rather
  // than a port walk — the only upload on this console that is.
  asm.label("UploadPalette");
  const palLoop = ctx.unique("palLoop");
  asm.lea(eaAbs(PALETTE_BASE), 1);
  asm.move("w", eaImm(256 * 16 - 1), eaD(0));
  asm.label(palLoop);
  asm.move("w", eaPost(0), eaPost(1));
  asm.dbra(0, palLoop);
  asm.rts();

  // `a0` the map, `d1` its width in cells, the origin in the render words. A
  // strip is a column, so the walk is column-major over a row-major source and
  // `d7` carries the stride from one row of the source to the next.
  asm.label("PaintPlane");
  const column = ctx.unique("planeCol");
  const row = ctx.unique("planeRow");
  asm.movem("l", 0x03f2, eaPre(7), true);

  asm.move("w", eaD(1), eaD(7));
  asm.ext("l", 7);
  asm.subq("l", 1, eaD(7));
  asm.lsl("l", 2, 7);

  asm.moveq(0, 6);
  asm.move("w", eaImm(PLANE_STRIPS - 1), eaD(4));
  asm.label(column);

  // The strip's own SCB1 window, and the port pointed at its first row.
  asm.move("w", eaD(6), eaD(0));
  asm.mulu(eaImm(SCB1_STRIDE), 0);
  asm.addi("w", SCB1 + PLANE_SPRITE0 * SCB1_STRIDE, eaD(0));
  asm.move("w", eaD(0), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaImm(1), eaAbs(LSPC.MODULO));

  // The source cell: `((originRow * width) + originCol + strip) * 4` bytes.
  asm.move("w", at(layout.words + W.mapRow * 2), eaD(0));
  asm.mulu(eaD(1), 0);
  asm.move("w", at(layout.words + W.mapCol * 2), eaD(2));
  asm.ext("l", 2);
  asm.add("l", eaD(2), 0);
  asm.move("w", eaD(6), eaD(2));
  asm.ext("l", 2);
  asm.add("l", eaD(2), 0);
  asm.lsl("l", 2, 0);
  asm.movea("l", eaA(0), 1);
  asm.adda("l", eaD(0), 1);

  asm.move("w", eaImm(PLANE_ROWS - 1), eaD(5));
  asm.label(row);
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));
  asm.adda("l", eaD(7), 1);
  asm.dbra(5, row);

  asm.addq("w", 1, eaD(6));
  asm.dbra(4, column);
  asm.movem("l", 0x03f2, eaPost(7), false);
  asm.rts();

  // Objects: three address writes an entry, because SCB3, SCB4 and SCB1 are
  // three regions. Strips the frame did not use have their height cleared, which
  // is the only way to hide a sprite on hardware with no link field.
  asm.label("UploadFrame");
  const upload = ctx.unique("stripLoop");
  const park = ctx.unique("parkRest");
  const parkLoop = ctx.unique("parkLoop2");
  const done = ctx.unique("uploadDone");
  asm.movem("l", 0x03f2, eaPre(7), true);
  asm.moveq(0, 6);
  asm.move("b", at(layout.oamCount), eaD(4));
  ctx.far("eq", park);
  asm.subq("w", 1, eaD(4));
  asm.lea(at(layout.memory.oamShadow), 1);

  asm.label(upload);
  asm.move("w", eaD(6), eaD(0));
  asm.addi("w", SCB3 + OBJECT_SPRITE0, eaD(0));
  asm.move("w", eaD(0), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaImm(1), eaAbs(LSPC.MODULO));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));

  asm.move("w", eaD(6), eaD(0));
  asm.addi("w", SCB4 + OBJECT_SPRITE0, eaD(0));
  asm.move("w", eaD(0), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));

  asm.move("w", eaD(6), eaD(0));
  asm.addi("w", OBJECT_SPRITE0, eaD(0));
  asm.mulu(eaImm(SCB1_STRIDE), 0);
  asm.addi("w", SCB1, eaD(0));
  asm.move("w", eaD(0), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));
  asm.move("w", eaPost(1), eaAbs(LSPC.DATA));

  asm.addq("w", 1, eaD(6));
  asm.dbra(4, upload);

  // Everything from here to the strip the last frame reached is parked.
  asm.label(park);
  asm.moveq(0, 0);
  asm.move("b", at(layout.oamPrev), eaD(0));
  asm.cmp("w", eaD(6), 0);
  ctx.far("le", done);
  asm.sub("w", eaD(6), 0);
  asm.subq("w", 1, eaD(0));
  asm.move("w", eaD(0), eaD(4));
  asm.move("w", eaD(6), eaD(0));
  asm.addi("w", SCB3 + OBJECT_SPRITE0, eaD(0));
  asm.move("w", eaD(0), eaAbs(LSPC.ADDRESS));
  asm.move("w", eaImm(1), eaAbs(LSPC.MODULO));
  asm.moveq(0, 2);
  asm.label(parkLoop);
  asm.move("w", eaD(2), eaAbs(LSPC.DATA));
  asm.dbra(4, parkLoop);
  asm.label(done);
  asm.move("b", at(layout.oamCount), at(layout.oamPrev));
  asm.movem("l", 0x03f2, eaPost(7), false);
  asm.rts();
}
