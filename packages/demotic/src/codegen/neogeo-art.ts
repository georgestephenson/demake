/**
 * Binding a program's art for the Neo Geo.
 *
 * The counterpart of `md-art.ts` and `pce-art.ts`, calling the same engine — a
 * second converter here is how the browser and the CLI stop agreeing (doc 15
 * §The conversion path), so nothing about a pixel is decided in this file. What
 * is decided here is what the *hardware* imposes, and on this console that is
 * four things, of which the first has no counterpart anywhere else in the set.
 *
 *   - **A playfield tile is 16×16 and a language cell is 8×8**, so one hardware
 *     tile covers a 2×2 block of cells (`neogeo/machine.ts` §CELLS_PER_TILE).
 *     The engine fits 8×8 tiles with a palette per 16×16 attribute cell — the
 *     NES's arrangement — and this file composes each 2×2 block into one
 *     hardware tile and dedups *those*. The PC Engine does the same for objects
 *     because it has no 8×8 sprite; what is new here is that the background has
 *     the same problem, which that console does not, because its BAT cells are
 *     8×8.
 *   - **The tile bank is decoded pixels, not a packed format.** `core`'s
 *     `packNeoCharacters` owns the C ROM's peculiar block order, so what this
 *     file produces is one byte a pixel and the cartridge wrapper encodes it.
 *     That keeps the format's right-half-before-left quirk in the one place it
 *     is pinned against hand-computed offsets.
 *   - **The fix layer is 8×8 and needs no composition at all.** It is the
 *     language's own cell grid, so the built-in font goes into the S ROM
 *     unchanged — the only art on this console that is not doubled.
 *   - **There are 256 sub-palettes**, against a Mega Drive's four. The
 *     reservation is one palette for the font rather than a quarter of the
 *     machine, and a picture can have as many as it asks for.
 */

import {
  buildSpriteBank,
  getConsole,
  prep,
  type CompliantImage,
  type Executor,
  type PrepOptions,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import { collectLevels } from "./shape.js";
import type { Program } from "../program.js";
import { builtinMd, BUILTIN_TILES } from "../rom/graphics.js";

import { applyArtOverrides } from "../demakefile/overrides.js";
import { artKey } from "./shape.js";
import { artRequests, digest, remember, rememberAsync, type AssetBytes } from "./art.js";
import {
  ART_PALETTE0,
  ART_PALETTES,
  CELLS_PER_TILE,
  SYSTEM_PALETTE,
  TILE_PIXELS,
  VIEW_TILES_H,
  VIEW_TILES_W,
} from "./neogeo/machine.js";
import type { ArtSettings } from "./settings.js";

/** Bytes one decoded hardware tile occupies: 16×16, one byte a pixel. */
export const TILE_BYTES = TILE_PIXELS * TILE_PIXELS;

/** Bytes one decoded fix tile occupies: 8×8, one byte a pixel. */
export const FIX_TILE_BYTES = 64;

/**
 * Tiles a build may use.
 *
 * Not a bank the way every other console has one — these are read from the
 * cartridge's C ROM by the video hardware and nothing is ever uploaded, so the
 * ceiling is the sixteen-bit tile field in SCB1's even word rather than a region
 * of video memory. A picture is 280 tiles, so this is not a budget any demade
 * game approaches.
 */
export const ART_TILES = 0x10000 - 1;

const CACHE_LIMIT = 12;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundNeogeoArt {
  options: NeogeoArtOptions;
  tiles: number;
  missing: readonly string[];
}

/** One object's art, as the emitter needs to place it. */
export interface ObjectArt {
  /** The first hardware tile of the object's own grid of them. */
  tile: number;
  /** Hardware tiles across and down: `ceil(cells / 2)` on each axis. */
  tilesWide: number;
  tilesHigh: number;
  /** The sub-palette the object fit chose. */
  palette: number;
}

/** Everything the art path hands the emitter. */
export interface NeogeoArtOptions {
  /** Object art, keyed by the asset name and box a `.dmt` wrote. */
  sprites?: ReadonlyMap<string, ObjectArt>;
  /** A scene's demade backdrop, as the plane words that place it. */
  backdrops?: ReadonlyMap<string, { map: Uint16Array; palette: Uint16Array }>;
  /** Decoded 16×16 sprite tiles: the C ROM, before `packNeoCharacters`. */
  bank?: Uint8Array;
  /** Decoded 8×8 fix tiles: the S ROM, before `packNeoFix`. */
  fix?: Uint8Array;
  /** Palette RAM as the art chose it, one word an entry. */
  palette?: Uint16Array;
  /**
   * Each level's grid, already composed into hardware tiles.
   *
   * Keyed by the level's index in `collectLevels` order. A plane cell covers a
   * 2x2 block of language cells, so the runtime cannot look a tile up per cell
   * the way every other backend does — the composition is build-time, which is
   * legal exactly because a Demotic tile layer cannot change (doc 13 §D6).
   * Two words a block: the tile number, and the attribute carrying its palette.
   */
  levelPlanes?: ReadonlyMap<number, { words: Uint16Array; wide: number; high: number }>;
}

/**
 * Pack a colour into this console's word.
 *
 * Bit 15 is the dark bit, bits 14–12 are each channel's least significant bit,
 * and bits 11–0 are their four high bits — so a five-bit channel is split across
 * two fields. The engine hands three five-bit codes, matching the console spec's
 * declared lattice.
 */
export function encodeColour(codes: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = codes;
  const high = ((r >> 1) << 8) | ((g >> 1) << 4) | (b >> 1);
  const low = ((r & 1) << 14) | ((g & 1) << 13) | ((b & 1) << 12);
  return (high | low) & 0xffff;
}

/**
 * Palette RAM: 256 palettes of sixteen words.
 *
 * Two entries are the hardware's rather than the art's. `$400000` must be pure
 * black, because the video output uses it as its reference; and the last word of
 * the bank is the backdrop, the colour behind everything. Palette
 * {@link SYSTEM_PALETTE} is the font's, and it has to be among the first sixteen
 * because that is all the fix layer can reach.
 */
function packPalette(
  art: readonly (readonly (readonly { codes: readonly number[] }[])[])[],
  sprites: readonly { codes: readonly number[] }[],
): Uint16Array {
  const words = new Uint16Array(256 * 16);
  // The reference colour, which the hardware requires to be black.
  words[0] = 0x8000;
  for (const [index, codes] of systemRamp().entries()) {
    words[SYSTEM_PALETTE * 16 + index] = encodeColour(codes);
  }
  let next = ART_PALETTE0;
  for (const group of art) {
    for (const colours of group) {
      if (next >= 256) break;
      for (let index = 0; index < 16; index += 1) {
        words[next * 16 + index] = encodeColour(colours[index]?.codes ?? [0, 0, 0]);
      }
      next += 1;
    }
  }
  if (next < 256 && sprites.length > 0) {
    for (let index = 0; index < 16; index += 1) {
      words[next * 16 + index] = encodeColour(sprites[index]?.codes ?? [0, 0, 0]);
    }
  }
  return words;
}

/**
 * The font's palette: a ramp with index 0 transparent.
 *
 * Fixed rather than chosen against a backdrop, which is the opposite of what the
 * Mega Drive and the NES do — and it is right here for a hardware reason. On
 * those consoles colour zero of every background palette *is* the one shared
 * backdrop, so a glyph's paper is whatever the picture chose. Here index 0 is
 * transparent on the fix layer and what shows through is the sprite plane, which
 * a caption is drawn over rather than into: the ink has to read against a
 * picture, and a mid grey with a dark surround does that everywhere.
 */
function systemRamp(): number[][] {
  return [
    [0, 0, 0],
    [4, 4, 4],
    [20, 20, 20],
    [31, 31, 31],
  ];
}

/** Unpack a `packed4` 8×8 tile into one byte a pixel. */
function unpack4(tiles: Uint8Array, tile: number): Uint8Array {
  const out = new Uint8Array(64);
  const at = tile * 32;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 2) {
      const byte = tiles[at + row * 4 + (column >> 1)] ?? 0;
      out[row * 8 + column] = byte >> 4;
      out[row * 8 + column + 1] = byte & 0x0f;
    }
  }
  return out;
}

/**
 * Compose four 8×8 tiles into one decoded 16×16 hardware tile.
 *
 * `quadrant` answers with the 8×8 tile's pixels for each corner, or `null` where
 * the source does not reach — which is what makes a one-cell object legal on
 * hardware whose smallest sprite is sixteen pixels square.
 */
function compose(quadrant: (column: number, row: number) => Uint8Array | null): Uint8Array {
  const out = new Uint8Array(TILE_BYTES);
  for (let row = 0; row < CELLS_PER_TILE; row += 1) {
    for (let column = 0; column < CELLS_PER_TILE; column += 1) {
      const pixels = quadrant(column, row);
      if (!pixels) continue;
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          out[(row * 8 + y) * TILE_PIXELS + column * 8 + x] = pixels[y * 8 + x] as number;
        }
      }
    }
  }
  return out;
}

/** A pool of decoded hardware tiles, deduplicated by content. */
class TileBank {
  private readonly seen = new Map<string, number>();
  private readonly parts: Uint8Array[] = [];

  /** Tile 0 is left blank: the hardware's padding sprite must draw nothing. */
  constructor() {
    this.intern(new Uint8Array(TILE_BYTES));
  }

  intern(pixels: Uint8Array): number {
    const key = String.fromCharCode(...pixels);
    const found = this.seen.get(key);
    if (found !== undefined) return found;
    const index = this.parts.length;
    this.seen.set(key, index);
    this.parts.push(pixels);
    return index;
  }

  get count(): number {
    return this.parts.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.length * TILE_BYTES);
    for (const [index, part] of this.parts.entries()) out.set(part, index * TILE_BYTES);
    return out;
  }
}

/** One demade backdrop, already composed into hardware tiles. */
interface Backdrop {
  /** Decoded 16×16 tiles, in the order the map refers to them. */
  tiles: Uint8Array[];
  /** One entry a plane cell: the local tile index and its sub-palette. */
  cells: { tile: number; palette: number }[];
  palettes: readonly (readonly { codes: readonly number[] }[])[];
  demand: number;
}

/**
 * Demake one scene's backdrop and compose it into hardware tiles.
 *
 * The fit is at the screen's own size with an attribute cell of 16×16, so a
 * sub-palette already belongs to exactly the block this composes — which is why
 * the console spec declares that attribute size rather than 8×8, and why nothing
 * here has to decide which of four palettes a composed tile should take.
 */
async function demakeBackdrop(
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  void getConsole("neogeo");
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: "neogeo",
        size: { w: VIEW_TILES_W * TILE_PIXELS, h: VIEW_TILES_H * TILE_PIXELS },
        fit: "cover",
        // Every palette but the font's. This console has 256, so a picture is
        // never the thing that runs out.
        maxSubPalettes: ART_PALETTES,
        maxTiles,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const image = fitted.image;
  const tiles: Uint8Array[] = [];
  const seen = new Map<string, number>();
  const cells: { tile: number; palette: number }[] = [];
  for (let row = 0; row < VIEW_TILES_H; row += 1) {
    for (let column = 0; column < VIEW_TILES_W; column += 1) {
      const pixels = blockPixels(image, column * TILE_PIXELS, row * TILE_PIXELS);
      const key = String.fromCharCode(...pixels);
      let index = seen.get(key);
      if (index === undefined) {
        index = tiles.length;
        seen.set(key, index);
        tiles.push(pixels);
      }
      cells.push({ tile: index, palette: paletteOfBlock(image, column, row) });
    }
  }
  return {
    tiles,
    cells,
    palettes: image.palettes.map((palette) => palette.colors),
    demand: fitted.stats.uniqueTiles + fitted.stats.tileMerges,
  };
}

/** Read one 16×16 block of a fitted picture as decoded pixels. */
function blockPixels(image: CompliantImage, originX: number, originY: number): Uint8Array {
  const out = new Uint8Array(TILE_BYTES);
  for (let y = 0; y < TILE_PIXELS; y += 1) {
    for (let x = 0; x < TILE_PIXELS; x += 1) {
      out[y * TILE_PIXELS + x] = image.pixelIndex[(originY + y) * image.width + originX + x] ?? 0;
    }
  }
  return out;
}

/** Which sub-palette a 16×16 block was fitted into. */
function paletteOfBlock(image: CompliantImage, column: number, row: number): number {
  const wide = Math.ceil(image.width / TILE_PIXELS);
  return image.cellPalette[row * wide + column] ?? 0;
}

/**
 * Convert a program's art and return what the emitter needs.
 *
 * Objects and level tiles go through the image pipeline separately, for the
 * reason doc 15 gives: an object's index 0 is transparency, so it has one fewer
 * colour and a choice of which, while a level tile has all sixteen.
 */
export async function bindNeogeoArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundNeogeoArt> {
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
    const key = `neogeo:${kind}:${list
      .map((source) => `${source.name}:${digest(source.bytes)}`)
      .join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: "neogeo",
          packing: "packed4",
          maxPalettes: 1,
          ...(kind === "sprite" ? {} : { opaque: true }),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const levelTiles = demakeBank("tile");

  const bank = new TileBank();
  const options: NeogeoArtOptions = {};
  let spriteColours: readonly { codes: readonly number[] }[] = [];
  const artPalettes: (readonly (readonly { codes: readonly number[] }[])[])[] = [];

  // Objects: 8×8 tiles from the engine, composed into the 16×16 the hardware
  // draws — `pce-art.ts`'s arrangement, with a decoded destination.
  if (objects) {
    const sprites = new Map<string, ObjectArt>();
    for (const [name, art] of objects.art) {
      const tilesWide = Math.ceil(art.width / CELLS_PER_TILE);
      const tilesHigh = Math.ceil(art.height / CELLS_PER_TILE);
      const first = bank.count;
      for (let row = 0; row < tilesHigh; row += 1) {
        for (let column = 0; column < tilesWide; column += 1) {
          bank.intern(
            compose((qx, qy) => {
              const cellX = column * CELLS_PER_TILE + qx;
              const cellY = row * CELLS_PER_TILE + qy;
              if (cellX >= art.width || cellY >= art.height) return null;
              return unpack4(objects.tiles, art.tile + cellY * art.width + cellX);
            }),
          );
        }
      }
      sprites.set(name, { tile: first, tilesWide, tilesHigh, palette: ART_PALETTE0 });
    }
    options.sprites = sprites;
    spriteColours = objects.palettes[0] ?? [];
  }
  if (levelTiles) artPalettes.push([levelTiles.palettes[0] ?? []]);

  // Backdrops, composed and interned into the same bank.
  const backdrops = new Map<string, { map: Uint16Array; palette: Uint16Array }>();
  const pictures = backdropScenes.map(
    (scene) => assets.get(scene.backdrop as string) as Uint8Array,
  );
  const files = backdropScenes.map((scene) => scene.backdrop as string);
  const converted = await Promise.all(
    pictures.map((source, index) =>
      rememberAsync(
        backdropCache,
        `neogeo:${digest(source)}:${JSON.stringify(settings?.[files[index]!] ?? {})}`,
        () => demakeBackdrop(source, ART_TILES, executor, settings?.[files[index]!]),
        CACHE_LIMIT,
      ),
    ),
  );
  for (const [index, scene] of backdropScenes.entries()) {
    const art = converted[index]!;
    const local = art.tiles.map((pixels) => bank.intern(pixels));
    const map = new Uint16Array(VIEW_TILES_W * VIEW_TILES_H * 2);
    for (const [cell, entry] of art.cells.entries()) {
      map[cell * 2] = local[entry.tile] ?? 0;
      map[cell * 2 + 1] = ((ART_PALETTE0 + entry.palette) & 0xff) << 8;
    }
    backdrops.set(scene.name, {
      map,
      palette: packPalette([art.palettes], spriteColours),
    });
  }
  if (backdrops.size > 0) options.backdrops = backdrops;

  // The fix layer takes the built-in 8×8 tiles unchanged: the only art on this
  // console that is not doubled, because that layer's cells *are* language cells.
  const builtin = builtinMd(3);
  const fix = new Uint8Array(BUILTIN_TILES * FIX_TILE_BYTES);
  for (let tile = 0; tile < BUILTIN_TILES; tile += 1) {
    fix.set(unpack4(builtin, tile), tile * FIX_TILE_BYTES);
  }
  options.fix = fix;

  // Levels: each 2x2 block of the grid becomes one hardware tile. Done here
  // rather than in the emitter because it grows the bank, and the bank is this
  // file's; done at build time rather than at run time because a plane cell has
  // no single legend entry behind it and a tile layer cannot change.
  const levelPlanes = new Map<number, { words: Uint16Array; wide: number; high: number }>();
  for (const level of collectLevels(program.scenes)) {
    const file = level.file;
    const wide = Math.ceil(file.width / CELLS_PER_TILE);
    const high = Math.ceil(file.height / CELLS_PER_TILE);
    const words = new Uint16Array(wide * high * 2);
    for (let row = 0; row < high; row += 1) {
      for (let column = 0; column < wide; column += 1) {
        const tile = bank.intern(
          compose((qx, qy) => {
            const cellX = column * CELLS_PER_TILE + qx;
            const cellY = row * CELLS_PER_TILE + qy;
            if (cellX >= file.width || cellY >= file.height) return null;
            const character = file.rows[cellY]?.[cellX] ?? " ";
            const legend = file.tiles.findIndex((entry) => entry.char === character);
            if (legend < 0) return null;
            const art = file.tiles[legend]?.art;
            const bound = art ? levelTiles?.art.get(artKey(art, 1, 1)) : undefined;
            if (!bound || !levelTiles) return null;
            return unpack4(levelTiles.tiles, bound.tile);
          }),
        );
        const at = (row * wide + column) * 2;
        words[at] = tile;
        words[at + 1] = (ART_PALETTE0 & 0xff) << 8;
      }
    }
    levelPlanes.set(level.index, { words, wide, high });
  }
  if (levelPlanes.size > 0) options.levelPlanes = levelPlanes;

  options.bank = bank.bytes();
  options.palette = packPalette(artPalettes, spriteColours);

  return { options, tiles: bank.count, missing };
}
