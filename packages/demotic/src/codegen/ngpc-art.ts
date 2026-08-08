/**
 * Binding a program's art for the Neo Geo Pocket Color.
 *
 * The counterpart of `art.ts`, `nes-art.ts`, `sms-art.ts`, `pce-art.ts` and
 * `wsc-art.ts`, and it calls the same engine — a second converter here is how
 * the browser and the CLI stop agreeing (doc 15 §The conversion path), so
 * nothing about a pixel is decided in this file. What is decided here is what
 * the *hardware* imposes, and on this console that is three things:
 *
 *   - **A palette is four colours and there are sixteen of them per layer.**
 *     Not sixteen shared between the layers, which is every other tiled console
 *     in the set: the display controller keeps three blocks of sixteen — one for
 *     the objects, one for each scroll plane — so a picture and its sprites can
 *     never compete for a palette and there is no split to force. Fifteen apiece
 *     for art and the sixteenth for the font, on both.
 *   - **Four colours is the narrowest palette here, and the tile bank is the
 *     widest lever.** Five hundred and twelve characters against a Master
 *     System's four hundred and forty-eight, shared between the planes and the
 *     objects because there is no second bank — so what a fit spends on this
 *     console is *tiles*, and `maxSubPalettes` at fifteen is what lets it.
 *   - **Colour zero is transparent on every layer**, so a caption's unlit pixels
 *     show the picture underneath and the only thing to decide is the ink: dark
 *     over a light backdrop, light over a dark one. A fixed white ramp is
 *     exactly invisible over a pale sky, which is the mistake the NES backend
 *     already made once.
 *
 * The tile format is nobody else's: two-bit pixels in a little-endian halfword a
 * row, leftmost pixel in the highest bits, sixteen bytes a character. That is
 * `packed2`, and {@link builtinNgp} is the built-in bank in it.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  prep,
  type Executor,
  type PaletteColor,
  type PrepOptions,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import { applyArtOverrides } from "../demakefile/overrides.js";
import type { Program } from "../program.js";
import { builtinNgp, BUILTIN_TILES, TILE_BYTES } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { NGPC_MEMORY } from "./layout.js";
import {
  ART_PALETTES,
  BANK_TILES,
  mapWord,
  MAP_W,
  PALETTE_BLOCKS,
  PALETTE_PLANE1,
  PALETTE_PLANE2,
  PALETTE_SPRITES,
  SYSTEM_PALETTE,
  type NgpcEmitOptions,
} from "./ngpc/emit.js";
import { packCellPairs } from "./pack.js";
import type { ArtSettings } from "./settings.js";
import { artKey, instanceCells } from "./shape.js";

/** Palettes one layer's block holds, and colours in each. */
const PALETTES = 16;
const PALETTE_SIZE = 4;

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * The conversion is a pure function of (bytes, box, console), so remembering its
 * answer cannot change one — a speed optimisation over a pure function, never
 * one that changes bytes.
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundNgpcArt {
  options: NgpcEmitOptions;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/**
 * One palette word: `0000BBBB GGGGRRRR`, little-endian byte pair.
 *
 * **Blue first**, which is this console's and nobody else's in the set — red is
 * the low nibble and blue the high one. `core/src/codegen/ngpc.ts` says why that
 * is worth a paragraph: an encoder and a renderer that agreed with each other
 * about it would draw every picture in the wrong colours and pass every byte
 * comparison there is.
 */
function colourBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 0xf;
  const g = (codes[1] ?? 0) & 0xf;
  const b = (codes[2] ?? 0) & 0xf;
  return [(g << 4) | r, b];
}

/** Rec. 601 luma of an RGB444 code, which is what "light or dark" means. */
function luma(codes: readonly number[]): number {
  const to8 = (value: number): number => (value & 0xf) * 0x11;
  return 0.299 * to8(codes[0] ?? 0) + 0.587 * to8(codes[1] ?? 0) + 0.114 * to8(codes[2] ?? 0);
}

/**
 * The whole palette block: three sets of sixteen four-colour palettes.
 *
 * The objects' block, then plane one's, then plane two's — the order the
 * hardware keeps them in and therefore the order the boot's single `ldir`
 * copies. Plane two draws nothing in a demade cartridge, so its block is the
 * font's ramp repeated: a build that left it as whatever powered up would be a
 * build whose only visible bug is on hardware nothing here writes.
 *
 * This one function is where the reservation actually happens. Art fills palette
 * 0 upward on each layer and the font takes the sixteenth of each, so there is
 * nowhere else for a picture's colours to land.
 */
function packPaletteBlock(
  background: readonly (readonly PaletteColor[])[],
  objects: readonly (readonly PaletteColor[])[],
  fontInk: readonly (readonly number[])[],
): Uint8Array {
  const bytes = new Uint8Array(PALETTE_BLOCKS * PALETTES * PALETTE_SIZE * 2);
  const put = (block: number, palette: number, entry: number, codes: readonly number[]): void => {
    const at = ((block * PALETTES + palette) * PALETTE_SIZE + entry) * 2;
    const [low, high] = colourBytes(codes);
    bytes[at] = low;
    bytes[at + 1] = high;
  };
  const fill = (block: number, palettes: readonly (readonly PaletteColor[])[]): void => {
    for (const [index, colours] of palettes.slice(0, ART_PALETTES).entries()) {
      for (let entry = 0; entry < PALETTE_SIZE; entry += 1) {
        put(block, index, entry, colours[entry]?.codes ?? [0, 0, 0]);
      }
    }
  };
  fill(PALETTE_SPRITES, objects);
  fill(PALETTE_PLANE1, background);
  // The font's ramp, in every layer's reserved palette: a caption on a plane, a
  // glyph drawn as a sprite by a scrolling scene's HUD, and the placeholder
  // block an object draws before its art is bound are the same three pictures on
  // three different layers.
  for (const block of [PALETTE_SPRITES, PALETTE_PLANE1, PALETTE_PLANE2]) {
    for (const [offset, codes] of fontInk.entries()) {
      put(block, SYSTEM_PALETTE, offset + 1, codes);
    }
  }
  return bytes;
}

/**
 * The font's three shades, chosen against what will be behind them.
 *
 * Colour zero is transparent on every layer here, so a glyph's unlit pixels show
 * whatever is underneath and the only thing to decide is the ink: dark over a
 * light backdrop, light over a dark one.
 */
function fontRamp(backdrop: readonly number[]): readonly (readonly number[])[] {
  return luma(backdrop) > 128
    ? [
        [0xa, 0xa, 0xa],
        [0x5, 0x5, 0x5],
        [0x0, 0x0, 0x0],
      ]
    : [
        [0x5, 0x5, 0x5],
        [0xa, 0xa, 0xa],
        [0xf, 0xf, 0xf],
      ];
}

/** One demade backdrop: the tiles it needs and the map that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  palettes: readonly (readonly PaletteColor[])[];
  /** Tiles the picture would have taken with nothing in its way. */
  demand: number;
}

/** Demake one scene's backdrop through the image pipeline. */
async function demakeBackdrop(
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  const spec = getConsole("ngpc");
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: "ngpc",
        size: { w: NGPC_MEMORY.viewW * 8, h: NGPC_MEMORY.viewH * 8 },
        fit: "cover",
        maxTiles,
        // Fifteen of the plane's sixteen; the sixteenth is the font's. The
        // objects' fifteen are a different block entirely, so there is nothing
        // to share and no split to force.
        maxSubPalettes: ART_PALETTES,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const backend = backendFor("ngpc");
  if (!backend) throw new Error("the ngpc image backend is missing");
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
 * Share a bank out among pictures that together want more of it than there is.
 *
 * Max-min fair, which is the honest reading of "no picture is squeezed while
 * another has slack" — `sms-art.ts` §fairShares has the whole argument and the
 * bug that produced it.
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

/** Convert a program's art and return what the emitter needs. */
export async function bindNgpcArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundNgpcArt> {
  const requests = artRequests(program);
  const missing: string[] = [];
  const sources: Record<"sprite" | "tile", SpriteSource[]> = { sprite: [], tile: [] };
  for (const request of requests) {
    const bytes = assets.get(request.name);
    if (!bytes) {
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
    const key = `ngpc:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: "ngpc",
          // Two-bit pixels in a little-endian halfword a row, which is this
          // chip's and nobody else's.
          packing: "packed2",
          maxPalettes: ART_PALETTES,
          ...(kind === "tile" ? { opaque: true } : {}),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: NgpcEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinNgp()];
  let next = BUILTIN_TILES;
  let levelPalette = 0;

  if (backgrounds) {
    const tiles = new Map<string, { tile: number; palette: number }>();
    for (const [name, art] of backgrounds.art) {
      tiles.set(name, { tile: next + art.tile, palette: art.palette });
    }
    options.tiles = tiles;
    bankParts.push(backgrounds.tiles);
    next += backgrounds.uniqueTiles;
    levelPalette = backgrounds.art.values().next().value?.palette ?? 0;
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
  }

  // Backdrops go last, and through a pool: a cell already drawn by the built-in
  // font, by a level tile, by an object or by an earlier picture is pointed at
  // rather than stored again.
  const backdrops = new Map<string, { map: Uint8Array }>();
  const scenePalettes = new Map<string, Uint8Array>();
  const known = new Uint8Array(bankParts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of bankParts) {
    known.set(part, cursor);
    cursor += part.length;
  }
  const poolStart = next;
  const free = Math.max(1, BANK_TILES - poolStart);
  const pictures = backdropScenes.map(
    (scene) => assets.get(scene.backdrop as string) as Uint8Array,
  );
  const files = backdropScenes.map((scene) => scene.backdrop as string);
  const convert = (source: Uint8Array, cap: number, file: string): Promise<Backdrop> =>
    rememberAsync(
      backdropCache,
      `ngpc:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a tile's number is where it
   * landed. The map goes out padded to the *hardware's* row of thirty-two rather
   * than the picture's twenty, because that is what makes painting it one walk
   * from the first cell — the Super Nintendo's stride hazard, which every
   * console with a map wider than its window has to answer.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, TILE_BYTES);
    const maps = arts.map((art) => {
      const cells = new Uint8Array(MAP_W * NGPC_MEMORY.viewH * 2);
      for (let row = 0; row < NGPC_MEMORY.viewH; row += 1) {
        for (let column = 0; column < NGPC_MEMORY.viewW; column += 1) {
          const cell = row * NGPC_MEMORY.viewW + column;
          const word = (art.map[cell * 2] as number) | ((art.map[cell * 2 + 1] as number) << 8);
          const local = word & 0x1ff;
          const palette = (word >> 9) & 0x0f;
          // The flip bits are the fitter's and they cost nothing: one tile
          // stands for up to four orientations and the cell says which. They are
          // the other way round from the WonderSwan's — vertical at bit 14 and
          // horizontal at bit 15 — which is why they are carried as a mask off
          // the word the image backend already wrote rather than rebuilt.
          const flips = word & 0xc000;
          const at = local * TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + TILE_BYTES));
          const entry = mapWord(tile, palette) | flips;
          const out = (row * MAP_W + column) * 2;
          cells[out] = entry & 0xff;
          cells[out + 1] = (entry >> 8) & 0xff;
        }
      }
      return packCellPairs(cells);
    });
    return { pool, maps };
  };

  const share = Math.max(1, Math.floor(free / Math.max(1, backdropScenes.length)));
  let converted = await Promise.all(
    pictures.map((source, index) => convert(source, share, files[index]!)),
  );
  const demands = converted.map((art) => art.demand);
  const shares = fairShares(demands, free);
  converted = await Promise.all(
    converted.map((art, index) =>
      Math.min(shares[index]!, demands[index]!) === Math.min(share, demands[index]!)
        ? Promise.resolve(art)
        : convert(pictures[index]!, shares[index]!, files[index]!),
    ),
  );
  const interned = internAll(converted);

  for (const [index, scene] of backdropScenes.entries()) {
    const art = converted[index] as Backdrop;
    backdrops.set(scene.name, { map: interned.maps[index] as Uint8Array });
    scenePalettes.set(
      scene.name,
      packPaletteBlock(
        art.palettes,
        objects?.palettes ?? [],
        fontRamp(art.palettes[0]?.[0]?.codes ?? [0, 0, 0]),
      ),
    );
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }

  // The build's own palette block, which every scene without a picture of its
  // own brings: the level tiles' colours, the objects', and a font ramp chosen
  // against whatever the level fit put behind it.
  options.palette = packPaletteBlock(
    backgrounds?.palettes ?? [],
    objects?.palettes ?? [],
    fontRamp(backgrounds?.palettes[levelPalette]?.[0]?.codes ?? [0, 0, 0]),
  );

  const bank = new Uint8Array(bankParts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of bankParts) {
    bank.set(part, at);
    at += part.length;
  }
  options.bank = bank;

  return {
    options,
    tiles: bank.length / TILE_BYTES - BUILTIN_TILES,
    missing,
  };
}

/** What one object instance's art is keyed by, for a backend that asks. */
export { artKey, instanceCells };
