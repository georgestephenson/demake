/**
 * Binding a program's art for the Super Nintendo.
 *
 * The counterpart of `art.ts`, `nes-art.ts` and `sms-art.ts`, and it calls the
 * same engine. A second converter here is how the browser and the CLI stop
 * agreeing (doc 15 §The conversion path), so nothing about a pixel is decided in
 * this file. What is decided here is what the *hardware* imposes, and on this
 * console that is three things:
 *
 *   - **One tile bank, shared, and it is large.** Five hundred and twelve tiles,
 *     background and objects together, because an object's tile number is eight
 *     bits *plus* the ninth bit its attribute byte carries and the name-select
 *     field puts the second half exactly where the first half runs out. The bank
 *     lives in the cartridge's second bank and reaches video RAM by transfer, so
 *     sixteen kilobytes of art costs the program nothing.
 *   - **There are eight sub-palettes of sixteen for each layer**, so one of each
 *     is kept back for the font, the level patterns and the placeholder block —
 *     the Game Boy Color's arrangement rather than the Sega VDP's, because here
 *     there really is a palette to spare. The fitters are given the other seven.
 *   - **Colour zero is transparent on both layers.** A background cell of index
 *     zero shows the fixed backdrop — CGRAM entry zero — rather than its own
 *     palette's first colour, which the Sega VDP would have drawn. So the
 *     backdrop is chosen once for the whole screen, and the font's ink is chosen
 *     against it: light over a dark backdrop and dark over a light one, exactly
 *     as the NES path chooses one against its universal backdrop.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  prep,
  type Executor,
  type PrepOptions,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import type { Program } from "../program.js";
import { builtinSnes, BUILTIN_TILES, SNES_TILE_BYTES } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { SNES_MEMORY } from "./layout.js";
import {
  ART_PALETTES,
  BANK_TILES,
  SYSTEM_INK,
  SYSTEM_PALETTE,
  type SnesEmitOptions,
} from "./snes/emit.js";
import { applyArtOverrides } from "../demakefile/overrides.js";
import type { ArtSettings } from "./settings.js";

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A full-screen backdrop here is a sixteen-colour fit over 256×224 pixels while
 * the web app rebuilds the game on every keystroke. The conversion is a pure
 * function of (bytes, box, console), so remembering its answer cannot change one:
 * the same inputs produce the same cartridge whether it is the first build or the
 * tenth, which is the parity contract restated. A speed optimisation over a pure
 * function, never one that changes bytes.
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/** The flip bits of a tilemap entry, which the fitter sets. */
const FLIP_X = 0x4000;
const FLIP_Y = 0x8000;

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundSnesArt {
  options: SnesEmitOptions;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/** One CGRAM entry: `0BBBBBGG GGGRRRRR`, little-endian. */
function colourWord(codes: readonly number[]): number {
  const r = (codes[0] ?? 0) & 31;
  const g = (codes[1] ?? 0) & 31;
  const b = (codes[2] ?? 0) & 31;
  return (b << 10) | (g << 5) | r;
}

/** Rec. 601 luma of a fitted colour, which is what "light or dark" means. */
function luma(codes: readonly number[]): number {
  const expand = (channel: number): number => ((channel & 31) << 3) | ((channel & 31) >> 2);
  return (
    0.299 * expand(codes[0] ?? 0) + 0.587 * expand(codes[1] ?? 0) + 0.114 * expand(codes[2] ?? 0)
  );
}

/**
 * The font's own ramp, chosen against the backdrop it will be read on.
 *
 * The three reserved entries at the top of the system sub-palette. Shade zero is
 * transparency on this chip, so a glyph's unlit pixels are the picture's own
 * backdrop whatever that is — and the only thing left to choose is the ink. A
 * fixed white ramp is exactly invisible over a picture whose fit made the
 * backdrop white, which is the same trap the NES path names.
 */
function systemRamp(backdrop: readonly number[]): readonly (readonly number[])[] {
  return luma(backdrop) > 128
    ? [
        [20, 20, 20],
        [10, 10, 10],
        [0, 0, 0],
      ]
    : [
        [10, 10, 10],
        [20, 20, 20],
        [31, 31, 31],
      ];
}

/**
 * Pack colour RAM: eight background sub-palettes, then eight for the objects.
 *
 * Entry zero is the fixed backdrop every transparent pixel shows, on both layers
 * and in every sub-palette, so it is written once and taken from whatever the
 * background fit chose. The last sub-palette of each half is the system's,
 * whatever the art chose — which is the reservation, stated once, in the one
 * place that writes the bytes.
 */
function packPalette(
  background: readonly (readonly { codes: readonly number[] }[])[],
  objects: readonly (readonly { codes: readonly number[] }[])[],
): Uint8Array {
  const bytes = new Uint8Array(512);
  const write = (entry: number, word: number): void => {
    bytes[entry * 2] = word & 0xff;
    bytes[entry * 2 + 1] = (word >> 8) & 0xff;
  };
  const backdrop = background[0]?.[0]?.codes ?? [0, 0, 0];
  const ramp = systemRamp(backdrop);

  for (let palette = 0; palette < 8; palette += 1) {
    for (const [half, source] of [background, objects].entries()) {
      const base = half * 128 + palette * 16;
      const colours = source[palette] ?? [];
      for (let index = 0; index < 16; index += 1) {
        write(base + index, colourWord(colours[index]?.codes ?? backdrop));
      }
      if (palette !== SYSTEM_PALETTE) continue;
      for (const [offset, codes] of ramp.entries()) {
        write(base + SYSTEM_INK - 2 + offset, colourWord(codes));
      }
    }
  }
  // The fixed backdrop, which is what index zero of anything shows.
  write(0, colourWord(backdrop));
  return bytes;
}

/** The colour RAM a build with no demade art uses: the font's ramp, everywhere. */
function systemOnlyPalette(): Uint8Array {
  return packPalette([], []);
}

/**
 * Share the bank out among pictures that together want more of it than there is.
 *
 * Max-min fair, which is the honest reading of "no picture is squeezed while
 * another has slack": serve the cheapest first, give it what it asks for if that
 * is no more than an even split of what is left, and offer the remainder to the
 * rest. The `sms-art.ts` original, unchanged, because the problem is unchanged.
 */
function fairShares(demands: readonly number[], capacity: number): number[] {
  const order = demands.map((_, index) => index).sort((a, b) => demands[a]! - demands[b]! || a - b);
  const shares = demands.map(() => 0);
  let left = capacity;
  let waiting = demands.length;
  for (const index of order) {
    const even = Math.floor(left / waiting);
    shares[index] = Math.max(1, Math.min(demands[index]!, even));
    left -= shares[index]!;
    waiting -= 1;
  }
  return shares;
}

/** One demade backdrop: the tiles it needs and the tilemap that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  palettes: readonly (readonly { codes: readonly number[] }[])[];
  /**
   * Tiles the picture would have taken with nothing in its way.
   *
   * The whole reason a budget can be shared out sensibly without demaking
   * anything twice: `maxTiles` reaches the pipeline *after* the fit, so a
   * conversion always reports how many tiles it wanted as well as how many it was
   * allowed.
   */
  demand: number;
}

/**
 * Demake one scene's backdrop through the image pipeline.
 *
 * Exactly the window the console displays, in pixels. Letting `prep` choose would
 * fit the *source's* size, and a title screen has to be a screenful: the tilemap
 * it produces and the block copy that paints it are the same rectangle.
 */
async function demakeBackdrop(
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  const spec = getConsole("snes");
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: "snes",
        size: { w: SNES_MEMORY.viewW * 8, h: SNES_MEMORY.viewH * 8 },
        fit: "cover",
        // Seven of the eight; the eighth is the font's (see {@link packPalette}).
        maxSubPalettes: ART_PALETTES,
        maxTiles,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const backend = backendFor("snes");
  if (!backend) throw new Error("the snes image backend is missing");
  const artifacts = backend.emitBin(fitted.image, spec, {
    symbol: "backdrop",
    header: [],
    mapBase: 0,
    tileBase: 0,
  });
  const find = (suffix: string): Uint8Array =>
    artifacts.find((artifact) => artifact.suffix === suffix)?.bytes ?? new Uint8Array(0);
  return {
    tiles: find(".tiles.bin"),
    map: find(".map.bin"),
    palettes: fitted.image.palettes.map((palette) => palette.colors),
    demand: fitted.stats.uniqueTiles + fitted.stats.tileMerges,
  };
}

/**
 * Convert a program's art and return what the emitter needs.
 *
 * Objects and background tiles go through the image pipeline separately, for the
 * reason doc 15 gives: an object's index 0 is transparency, so it has fifteen
 * colours and a choice of *which*, while a background tile has sixteen — except
 * that on this chip index 0 is transparent there too, which is why the background
 * bank is not asked to be opaque and its own colour zero is the one backdrop.
 */
export async function bindSnesArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundSnesArt> {
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
    const key = `snes:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: "snes",
          // Plane pairs: this chip reads a 4bpp tile as two 2bpp tiles stacked,
          // which is neither the Sega VDP's layout nor the NES's.
          packing: "pairs",
          maxPalettes: ART_PALETTES,
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: SnesEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinSnes(SYSTEM_INK)];
  let next = BUILTIN_TILES;
  let backgroundPalettes: readonly (readonly { codes: readonly number[] }[])[] = [];
  let objectPalettes: readonly (readonly { codes: readonly number[] }[])[] = [];

  if (backgrounds) {
    const tiles = new Map<string, { tile: number; palette: number }>();
    for (const [name, art] of backgrounds.art) {
      tiles.set(name, { tile: next + art.tile, palette: art.palette });
    }
    options.tiles = tiles;
    bankParts.push(backgrounds.tiles);
    next += backgrounds.uniqueTiles;
    backgroundPalettes = backgrounds.palettes;
  }

  if (objects) {
    const sprites = new Map<
      string,
      { tile: number; width: number; height: number; palette: number }
    >();
    for (const [name, art] of objects.art) {
      sprites.set(name, {
        tile: next + art.tile,
        width: art.width,
        height: art.height,
        palette: art.palette,
      });
    }
    options.sprites = sprites;
    bankParts.push(objects.tiles);
    next += objects.uniqueTiles;
    objectPalettes = objects.palettes;
  }

  // Backdrops go last, and through a pool: a cell already drawn by the built-in
  // font, by a level tile, by an object or by an earlier picture is pointed at
  // rather than stored again. Two title screens that share a night sky then cost
  // one tile between them.
  const backdrops = new Map<string, { map: Uint16Array }>();
  const scenePalettes = new Map<string, Uint8Array>();
  const known = concat(bankParts);
  const poolStart = next;
  const free = Math.max(1, BANK_TILES - poolStart);
  const pictures = backdropScenes.map(
    (scene) => assets.get(scene.backdrop as string) as Uint8Array,
  );
  // The paths beside the bytes, so a conversion can find its own settings.
  const files = backdropScenes.map((scene) => scene.backdrop as string);
  // The budget is part of the key: the same picture fitted into a different
  // number of tiles is a different conversion.
  const convert = (source: Uint8Array, cap: number, file: string): Promise<Backdrop> =>
    rememberAsync(
      backdropCache,
      `snes:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a tile's number is where it
   * landed — the Game Boy's arrangement, and the reason these backdrops may be
   * demade concurrently. The pool is fresh each time because interning is what
   * decides the numbers, so a second attempt has to start from the same place the
   * first one did.
   *
   * The engine's map is two bytes a cell and as wide as the picture; the tilemap
   * is sixty-four cells wide, so each row is padded. The entry carries more than
   * the tile number: this layout is flip-aware (`ConsoleSpec.tiles.flip`), so the
   * fitter stores one tile for up to four orientations and says which one a cell
   * wants — and those bits have to survive the pool, or every mirrored cell is
   * drawn the wrong way round at no saving in tiles at all.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint16Array[] } => {
    const pool = new TilePool(known, poolStart, SNES_TILE_BYTES);
    const maps = arts.map((art) => {
      // A screen's worth of cells, **thirty-two to a row and not sixty-four**.
      // The tilemap is 64 columns wide and the picture fills the left 32 of them,
      // but those two facts do not compose the way an array does: a 64x32 tilemap
      // is two 32x32 *screens* a kilobyte apart, so screen zero's rows are
      // contiguous at 32 words each and column 32 is nowhere near column 31. A
      // row of 64 with the right half blank streams into video RAM as a picture
      // stretched to double height with every other row empty — which is exactly
      // what it did (§Gotchas).
      const map = new Uint16Array(SNES_MEMORY.viewW * SNES_MEMORY.viewH);
      for (let row = 0; row < SNES_MEMORY.viewH; row += 1) {
        for (let column = 0; column < SNES_MEMORY.viewW; column += 1) {
          const cell = row * SNES_MEMORY.viewW + column;
          const word = (art.map[cell * 2] as number) | ((art.map[cell * 2 + 1] as number) << 8);
          const local = word & 0x3ff;
          const at = local * SNES_TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + SNES_TILE_BYTES));
          map[cell] = (tile & 0x3ff) | (word & (0x1c00 | FLIP_X | FLIP_Y));
        }
      }
      return map;
    });
    return { pool, maps };
  };

  // An even split first — not because it is the answer, but because it is a
  // budget every picture can be demade against at once, and a conversion reports
  // what it *wanted* as well as what it took. The bank is then shared out max-min
  // fair on those demands, so a cheap picture does not reserve tiles an expensive
  // one is starving for.
  const share = Math.max(1, Math.floor(free / Math.max(1, backdropScenes.length)));
  let converted = await Promise.all(
    pictures.map((source, index) => convert(source, share, files[index]!)),
  );
  const demands = converted.map((art) => art.demand);
  const shares = fairShares(demands, free);
  // What a fit produces is `min(budget, demand)` tiles, and below the demand the
  // budget does not reach the fit at all — so a conversion is already the one the
  // final share would have produced whenever those two numbers agree.
  converted = await Promise.all(
    converted.map((art, index) =>
      Math.min(shares[index]!, demands[index]!) === Math.min(share, demands[index]!)
        ? Promise.resolve(art)
        : convert(pictures[index]!, shares[index]!, files[index]!),
    ),
  );
  const interned = internAll(converted);

  for (const [index, scene] of backdropScenes.entries()) {
    backdrops.set(scene.name, { map: interned.maps[index]! });
    scenePalettes.set(scene.name, packPalette(converted[index]!.palettes, objectPalettes));
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }

  const bank = concat(bankParts);
  options.bank = bank;
  options.palette =
    backgroundPalettes.length > 0 || objectPalettes.length > 0
      ? packPalette(backgroundPalettes, objectPalettes)
      : systemOnlyPalette();

  return {
    options,
    tiles: bank.length / SNES_TILE_BYTES - BUILTIN_TILES,
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
