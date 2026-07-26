/**
 * Binding a program's art for the NES: where the game pipeline meets the image one.
 *
 * The counterpart of `art.ts`, and it calls the same engine — `buildSpriteBank` for
 * objects and level tiles, `prepSync` plus the `nes` image backend for a backdrop.
 * A second converter here is how the browser and the CLI stop agreeing (doc 15
 * §The conversion path), so nothing about a pixel is decided in this file. What is
 * decided here is what the *hardware* imposes, and on this console that is three
 * things the Game Boy does not impose:
 *
 *   - **Characters are ROM, in two tables.** The PPU addresses 256 background
 *     patterns at `$0000` and 256 object patterns at `$1000`, and a program cannot
 *     write either. So the bank is built at compile time and objects do not compete
 *     with backgrounds for room — which is why an NES build fits more art than a
 *     Game Boy one, not less. The built-in font, patterns and placeholder block go
 *     in *both* tables at the same indices, because the character bank is a fixed
 *     8 KiB either way and the copy is free.
 *   - **A background palette covers a 16×16 block.** Four map cells share it, so
 *     level tile art is fitted to *one* background palette: two adjacent legend
 *     entries that wanted different palettes could not both have them, and picking
 *     one per block at build time would make a level's colours depend on where its
 *     author happened to put a wall. A backdrop is a single picture, so the fitter
 *     can place palettes per block there and does.
 *   - **The palette is indices into the console's own 64 colours.** There is no
 *     RGB to write, which the image engine already models as `fixed-master`; what
 *     reaches the ROM is sixteen master-palette indices with the universal backdrop
 *     repeated at every fourth.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  prepSync,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import type { Program } from "../program.js";
import { builtinChr, BUILTIN_TILES, TILE_BYTES } from "../rom/graphics.js";

import { artRequests, TilePool, type AssetBytes } from "./art.js";
import { NES_MEMORY } from "./layout.js";
import { ART_PALETTES, SYSTEM_PALETTE, type NesEmitOptions } from "./nes/emit.js";

/** Patterns one table holds; the console has two, and they do not share. */
export const PATTERNS_PER_TABLE = 256;

/** Patterns left for art once the built-in bank has its share of a table. */
export const ART_PATTERNS = PATTERNS_PER_TABLE - BUILTIN_TILES;

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundNesArt {
  options: NesEmitOptions;
  /** The 8 KiB character bank, both tables, ready to pack into the cartridge. */
  chr: Uint8Array;
  /** Patterns the conversion added, over both tables. */
  tiles: number;
  /** Patterns it added to each table, which is what the hardware budget is. */
  backgroundPatterns: number;
  objectPatterns: number;
  /**
   * What each scene's picture was demade against, by scene name.
   *
   * Reported because it is the difference between a title screen and a smudge,
   * and because it is what makes the claim checkable: the cartridge's picture is
   * `prep`'s picture at *this* budget, and `nes-rom.test.ts` compares them cell
   * by cell rather than taking it on trust.
   */
  backdropFits: ReadonlyMap<string, { table: 0 | 1; budget: number }>;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/**
 * The font's own ramp, chosen against the backdrop it will be read on.
 *
 * The Game Boy Color reserves a palette for the font and fills it with a fixed
 * white-through-black ramp, because all four of its colours are free. Here colour
 * zero of *every* background palette is the one universal backdrop — the hardware
 * reads `$3F00` for all of them — so a font palette gets three colours and has to
 * live with the fourth. A glyph's unlit pixels are therefore the picture's
 * backdrop, whatever that is, and the only thing left to choose is the ink.
 *
 * So it is chosen: dark ink over a light backdrop and light ink over a dark one.
 * A fixed ramp would have been white ink, which is exactly invisible on the one
 * scene in the example library whose backdrop the fit made white.
 */
function systemRamp(backdrop: number): readonly number[] {
  const master = getConsole("nes").color;
  const colour = master.masterPalette?.[backdrop & 0x3f];
  // Rec. 601 luma, which is what "light or dark" means to an eye.
  const luma = colour ? 0.299 * colour.r + 0.587 * colour.g + 0.114 * colour.b : 0;
  return luma > 128 ? [backdrop, 0x10, 0x00, 0x0f] : [backdrop, 0x00, 0x10, 0x30];
}

/** Pack four palettes of four master indices into the sixteen bytes the PPU takes. */
function packPalette(
  palettes: readonly (readonly { codes: readonly number[] }[])[],
  backdrop: number,
): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let palette = 0; palette < 4; palette += 1) {
    // Every fourth entry is the universal backdrop: the hardware reads `$3F00` for
    // colour 0 of all four, so writing anything else there is writing the same
    // byte four times.
    bytes[palette * 4] = backdrop;
    if (palette === SYSTEM_PALETTE) {
      const ramp = systemRamp(backdrop);
      for (let colour = 1; colour < 4; colour += 1) {
        bytes[palette * 4 + colour] = ramp[colour] as number;
      }
      continue;
    }
    const colours = palettes[palette] ?? [];
    for (let colour = 1; colour < 4; colour += 1) {
      bytes[palette * 4 + colour] = colours[colour]?.codes[0] ?? backdrop;
    }
  }
  return bytes;
}

/** The palette a build with no demade art uses: the font's ramp, four times. */
function systemOnlyPalette(): Uint8Array {
  const bytes = new Uint8Array(16);
  const ramp = systemRamp(0x0f);
  for (let palette = 0; palette < 4; palette += 1) {
    for (let colour = 0; colour < 4; colour += 1) {
      bytes[palette * 4 + colour] = ramp[colour] as number;
    }
  }
  return bytes;
}

/** Assemble the character bank: the built-in tiles in both tables, then the art. */
function buildChr(background: Uint8Array, objects: Uint8Array): Uint8Array {
  const chr = new Uint8Array(0x2000);
  const builtin = builtinChr();
  // The same tiles in both tables, at the same indices. The bank is a fixed 8 KiB
  // whatever is in it, so this costs nothing and means a glyph can be drawn on
  // either layer without the runtime knowing which table it came from.
  chr.set(builtin, 0);
  chr.set(builtin, 0x1000);
  chr.set(background.subarray(0, 0x1000 - builtin.length), builtin.length);
  chr.set(objects.subarray(0, 0x1000 - builtin.length), 0x1000 + builtin.length);
  return chr;
}

/**
 * A pool over one pattern table: what is already in it, and what is left.
 *
 * `TilePool` interns against tiles it has been shown, so a picture's cell that
 * matches a glyph, a level tile or a sprite costs nothing. `free()` is what the
 * fit is told it may spend, and it is the honest number: the table's 256 minus
 * the built-in bank minus whatever else this table carries minus what earlier
 * pictures in it have already added.
 */
function newPool(builtin: Uint8Array, art: Uint8Array | undefined, next: number) {
  const known = new Uint8Array(builtin.length + (art?.length ?? 0));
  known.set(builtin, 0);
  if (art) known.set(art, builtin.length);
  const pool = new TilePool(known, next);
  return {
    intern: (tile: Uint8Array) => pool.intern(tile),
    tail: () => pool.tail(),
    free: () => PATTERNS_PER_TABLE - next - pool.tail().length / TILE_BYTES,
  };
}

/** One demade backdrop: a nametable, its attribute table, and its palette. */
interface Backdrop {
  chr: Uint8Array;
  map: Uint8Array;
  attr: Uint8Array;
  palette: Uint8Array;
}

/**
 * Demake one scene's backdrop through the image pipeline.
 *
 * Exactly the window the PPU displays, in pixels — 32×30 cells. Letting `prep`
 * choose would fit the *source's* size, and a title screen has to be a screenful:
 * the nametable it produces and the block copy that paints it are the same
 * rectangle.
 */
function demakeBackdrop(bytes: Uint8Array, maxTiles: number): Backdrop {
  const spec = getConsole("nes");
  const fitted = prepSync(bytes, {
    console: "nes",
    size: { w: NES_MEMORY.viewW * 8, h: NES_MEMORY.viewH * 8 },
    fit: "cover",
    // One palette is the font's, so a picture gets the rest. Reserving it here
    // rather than taking it back afterwards keeps the fit honest: the tournament
    // optimises against the budget it will actually be shown with.
    maxSubPalettes: ART_PALETTES,
    // And the same for the bank. A screenful here is 960 cells against a Game
    // Boy's 360, and the pattern table is the same 256 either way, so a picture
    // that was not told what it could afford would always overrun.
    maxTiles,
  });
  const backend = backendFor("nes");
  if (!backend) throw new Error("the nes image backend is missing");
  const artifacts = backend.emitBin(fitted.image, spec, {
    symbol: "backdrop",
    header: [],
    mapBase: 0,
    tileBase: 0,
  });
  const find = (suffix: string): Uint8Array =>
    artifacts.find((artifact) => artifact.suffix === suffix)?.bytes ?? new Uint8Array(0);
  const backdrop = fitted.image.palettes[0]?.colors[0]?.codes[0] ?? 0x0f;
  return {
    chr: find(".chr.bin"),
    map: find(".nam.bin"),
    attr: find(".attr.bin"),
    palette: packPalette(
      fitted.image.palettes.map((palette) => palette.colors),
      backdrop,
    ),
  };
}

/**
 * Convert a program's art and return what the emitter and the cartridge need.
 *
 * Objects and background tiles go through the image pipeline separately, for the
 * reason doc 15 gives: an object's index 0 is transparency, so it has three colours
 * and a choice of *which* three, while a background tile has four and no choice at
 * all. On this console they do not even share a pattern table.
 */
export function bindNesArt(program: Program, assets: AssetBytes): BoundNesArt {
  const requests = artRequests(program);
  const missing: string[] = [];
  const sources: Record<"sprite" | "tile", SpriteSource[]> = { sprite: [], tile: [] };
  for (const request of requests) {
    const bytes = assets.get(request.name);
    if (!bytes) {
      // One line per *file*, not per box: a missing asset is a missing file, and
      // naming it twice would just read as two problems.
      if (!missing.includes(request.name)) missing.push(request.name);
      continue;
    }
    sources[request.kind].push({
      name: request.key,
      bytes,
      cellsWide: request.cellsWide,
      cellsHigh: request.cellsHigh,
    });
  }
  // Backdrops the edge actually supplied bytes for. A *declared* backdrop is not
  // enough: a build with no assets has to come out exactly as it would without art.
  const backdropScenes = program.scenes.filter(
    (scene) => scene.backdrop !== undefined && assets.has(scene.backdrop),
  );
  for (const scene of program.scenes) {
    const file = scene.backdrop;
    if (file !== undefined && !assets.has(file) && !missing.includes(file)) missing.push(file);
  }

  const demakeBank = (kind: "sprite" | "tile"): SpriteBank | null => {
    const list = sources[kind];
    if (list.length === 0) return null;
    return buildSpriteBank(list, {
      console: "nes",
      packing: "grouped",
      // Level tile art is fitted to one background palette, because a 16×16
      // attribute cell covers four map cells: two adjacent legend entries cannot
      // have different palettes, whatever the fit would prefer.
      maxPalettes: kind === "tile" ? 1 : ART_PALETTES,
      ...(kind === "tile" ? { opaque: true } : {}),
    });
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: NesEmitOptions = {};
  const backgroundArt: Uint8Array[] = [];
  let backgroundNext = BUILTIN_TILES;
  let levelBackdrop = 0x0f;

  if (backgrounds) {
    const tiles = new Map<string, { tile: number }>();
    for (const [name, art] of backgrounds.art) {
      tiles.set(name, { tile: backgroundNext + art.tile });
    }
    options.tiles = tiles;
    backgroundArt.push(backgrounds.tiles);
    backgroundNext += backgrounds.uniqueTiles;
    levelBackdrop = backgrounds.palettes[0]?.[0]?.codes[0] ?? 0x0f;
    options.levelPalette = packPalette(backgrounds.palettes, levelBackdrop);
  }

  if (objects) {
    const sprites = new Map<
      string,
      { tile: number; width: number; height: number; palette: number }
    >();
    for (const [name, art] of objects.art) {
      sprites.set(name, {
        tile: BUILTIN_TILES + art.tile,
        width: art.width,
        height: art.height,
        palette: art.palette,
      });
    }
    options.sprites = sprites;
    // An object's colour 0 is never displayed, so the shared entry is the
    // background's business — but the font ramp still has to be chosen against
    // something, and what a HUD sprite is read *over* is the level's backdrop.
    options.objectPalette = packPalette(objects.palettes, levelBackdrop);
  }

  // Backdrops go through a pool — a cell already drawn by the built-in font, by a
  // level tile, by a sprite or by an earlier picture is pointed at rather than
  // stored again — and each picture is given a *whole pattern table*.
  //
  // That is the console's own answer to "a screenful is 960 cells and a table is
  // 256 patterns": there are two tables, and `PPUCTRL` bit 4 chooses which one the
  // background reads. Sharing one between every picture in the game halved what
  // each got and the fitter spent the difference merging cells — 216 of the
  // shooter's 960 at a 97-pattern share, against 57 at a full one. So a picture is
  // assigned to whichever table has the most room left when its turn comes, and
  // the two-backdrop games in the library end up with one each.
  //
  // Room is what the *other* contents leave: level art shares table 0 and object
  // art shares table 1, because those are the tables the background and the
  // objects are read from.
  const backdrops = new Map<
    string,
    { map: Uint8Array; attr: Uint8Array; palette: Uint8Array; table: 0 | 1 }
  >();
  const builtin = builtinChr();
  const objectArt = objects?.tiles ?? new Uint8Array(0);
  const pools = [
    newPool(builtin, backgrounds?.tiles, backgroundNext),
    newPool(builtin, objectArt, BUILTIN_TILES + objectArt.length / TILE_BYTES),
  ] as const;
  const backdropFits = new Map<string, { table: 0 | 1; budget: number }>();
  for (const scene of backdropScenes) {
    // The table with the most room, and the room it has. A picture is never given
    // less than one pattern, because a build that produced no picture at all would
    // be a worse answer than a coarse one.
    const table = pools[0].free() >= pools[1].free() ? 0 : 1;
    const pool = pools[table];
    const budget = Math.max(1, pool.free());
    backdropFits.set(scene.name, { table, budget });
    const art = demakeBackdrop(assets.get(scene.backdrop as string) as Uint8Array, budget);
    const map = new Uint8Array(art.map.length);
    for (let cell = 0; cell < art.map.length; cell += 1) {
      const local = (art.map[cell] as number) * TILE_BYTES;
      map[cell] = pool.intern(art.chr.subarray(local, local + TILE_BYTES)) & 0xff;
    }
    backdrops.set(scene.name, { map, attr: art.attr, palette: art.palette, table });
  }
  const pooled = pools[0].tail();
  if (pooled.length > 0) backgroundArt.push(pooled);
  if (backdrops.size > 0) options.backdrops = backdrops;
  if (options.levelPalette === undefined) options.levelPalette = systemOnlyPalette();
  if (options.objectPalette === undefined) options.objectPalette = systemOnlyPalette();

  const background = concat(backgroundArt);
  // Table 1 is the objects' own, and it carries the pictures assigned to it —
  // which the background layer reads by pointing `PPUCTRL` at it for that scene.
  const objectTiles = concat([objectArt, pools[1].tail()]);

  return {
    options,
    chr: buildChr(background, objectTiles),
    tiles: background.length / TILE_BYTES + objectTiles.length / TILE_BYTES,
    backgroundPatterns: background.length / TILE_BYTES,
    objectPatterns: objectTiles.length / TILE_BYTES,
    backdropFits,
    missing,
  };
}

/** Join blobs of tile bytes, in order. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
