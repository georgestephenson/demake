/**
 * Binding a program's art for the Mega Drive.
 *
 * The counterpart of `art.ts`, `nes-art.ts` and `sms-art.ts`, and it calls the
 * same engine. A second converter here is how the browser and the CLI stop
 * agreeing (doc 15 §The conversion path), so nothing about a pixel is decided in
 * this file. What is decided here is what the *hardware* imposes, and on this
 * console that is three things:
 *
 *   - **One tile bank of 1408, shared, and eleven bits wide.** A name-table
 *     entry and a sprite attribute both carry an eleven-bit tile index, so
 *     unlike the Sega 8-bits there is no 256-tile ceiling on what an object may
 *     draw — the bank is simply as large as the VDP's memory allows once the
 *     planes, the scroll table and the sprite table have theirs. That is four
 *     times the room a Master System has and it is what makes a full-screen
 *     picture cheap here.
 *   - **Four sub-palettes, shared between the planes and the sprites.** Not a
 *     bank each, as on the Sega 8-bits: sprites and the background index the
 *     same sixty-four colour entries. So the split is a reservation — two
 *     sub-palettes for background art, one for objects, one for the font — and
 *     it is stated once, here.
 *   - **Colour zero is the shared backdrop, on every layer.** A background pixel
 *     of index 0 shows register 7's colour rather than its own palette's, which
 *     is the same shared-index-0 machinery the NES uses. The font's ink is
 *     therefore chosen against that backdrop, the way the NES backend chooses
 *     its caption ink, because a white glyph on a white sky is a caption nobody
 *     can read.
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
import { builtinMd, BUILTIN_TILES, MD_TILE_BYTES } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { MD_MEMORY } from "./layout.js";
import {
  ART_PALETTES,
  BANK_TILES,
  encodeColour,
  SPRITE_PALETTE,
  SYSTEM_INK,
  SYSTEM_PALETTE,
  type MdEmitOptions,
} from "./md/emit.js";
import { applyArtOverrides } from "../demakefile/overrides.js";
import type { ArtSettings } from "./settings.js";

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A full-screen backdrop here is a 320×224 fit into two sixteen-colour
 * sub-palettes — the largest picture in the project — while the web app rebuilds
 * the game on every keystroke. The conversion is a pure function of (bytes, box,
 * console), so remembering its answer cannot change one. A speed optimisation
 * over a pure function, never one that changes bytes.
 */
const CACHE_LIMIT = 12;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/** Cells the plane is wide, which a backdrop's rows are padded to. */
const MAP_W = 64;

/** The flip bits of a name-table entry, which the fitter sets. */
const FLIP_X = 0x0800;
const FLIP_Y = 0x1000;

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundMdArt {
  options: MdEmitOptions;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/**
 * Colour RAM: four sub-palettes of sixteen big-endian `BGR333` words.
 *
 * The last of the four is always the font's, whatever the art chose — the
 * reservation, stated once, in the one place that writes the bytes. Its ink is
 * picked against the *backdrop*, because on this console a glyph's shade zero is
 * transparent and shows whatever register 7 points at: a fixed white-through-
 * black ramp would be invisible over a picture whose colour zero happened to be
 * white. That is the NES's rule for its universal backdrop, reached by different
 * hardware.
 */
function packPalette(
  background: readonly (readonly { codes: readonly number[] }[])[],
  sprites: readonly { codes: readonly number[] }[],
): Uint8Array {
  const bytes = new Uint8Array(64 * 2);
  const put = (palette: number, index: number, codes: readonly number[]): void => {
    const word = encodeColour(codes);
    const at = (palette * 16 + index) * 2;
    bytes[at] = (word >> 8) & 0xff;
    bytes[at + 1] = word & 0xff;
  };

  for (let palette = 0; palette < ART_PALETTES; palette += 1) {
    const colours = background[palette] ?? [];
    for (let index = 0; index < 16; index += 1) {
      put(palette, index, colours[index]?.codes ?? [0, 0, 0]);
    }
  }
  for (let index = 0; index < 16; index += 1) {
    put(SPRITE_PALETTE, index, sprites[index]?.codes ?? [0, 0, 0]);
  }
  for (const [index, codes] of systemRamp(background[0]?.[0]?.codes ?? [0, 0, 0]).entries()) {
    put(SYSTEM_PALETTE, index, codes);
  }
  return bytes;
}

/**
 * The font's four entries, as a ramp away from the backdrop.
 *
 * Entry zero is never rendered — it is the shared transparent index — so what
 * matters is that shade three, which is every glyph's ink, contrasts with the
 * colour showing through shade zero.
 */
function systemRamp(backdrop: readonly number[]): number[][] {
  const luminance = ((backdrop[0] ?? 0) * 2 + (backdrop[1] ?? 0) * 5 + (backdrop[2] ?? 0)) / 8;
  const dark = luminance < 3.5;
  return dark
    ? [
        [0, 0, 0],
        [3, 3, 3],
        [5, 5, 5],
        [7, 7, 7],
      ]
    : [
        [0, 0, 0],
        [4, 4, 4],
        [2, 2, 2],
        [0, 0, 0],
      ];
}

/**
 * Share a bank out among pictures that together want more of it than there is.
 *
 * Max-min fair, which is the honest reading of "no picture is squeezed while
 * another has slack" — the same allocator the Sega backend uses, and it is here
 * for the same reason rather than by copying: a build demakes every picture
 * against an even split first, reads off what each one *wanted*, and hands the
 * bank out on those demands.
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

/** One demade backdrop: the tiles it needs and the name table that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  palettes: readonly (readonly { codes: readonly number[] }[])[];
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
  const spec = getConsole("md");
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: "md",
        size: { w: MD_MEMORY.viewW * 8, h: MD_MEMORY.viewH * 8 },
        fit: "cover",
        // Two of the four sub-palettes: one is the objects' and one is the font's,
        // and a picture told it had all four would take colours a caption needs.
        maxSubPalettes: ART_PALETTES,
        maxTiles,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const backend = backendFor("md");
  if (!backend) throw new Error("the md image backend is missing");
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
 * reason doc 15 gives: an object's index 0 is transparency, so it has one fewer
 * colour and a choice of *which*, while a background tile has all sixteen and no
 * choice at all.
 */
export async function bindMdArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundMdArt> {
  const requests = artRequests(program);
  const missing: string[] = [];
  const sources: Record<"sprite" | "tile", SpriteSource[]> = { sprite: [], tile: [] };
  for (const request of requests) {
    const bytes = assets.get(request.name);
    if (!bytes) {
      // One line per *file*, not per box: a missing asset is a missing file.
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
    const key = `md:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: "md",
          // Two pixels a byte, left in the high nibble — this VDP reads tiles as
          // colour indices rather than as bitplanes.
          packing: "packed4",
          maxPalettes: 1,
          ...(kind === "sprite" ? {} : { opaque: true }),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: MdEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinMd(SYSTEM_INK)];
  let next = BUILTIN_TILES;
  let backgroundColours: readonly { codes: readonly number[] }[] = [];
  let spriteColours: readonly { codes: readonly number[] }[] = [];

  if (backgrounds) {
    const tiles = new Map<string, { tile: number }>();
    for (const [name, art] of backgrounds.art) tiles.set(name, { tile: next + art.tile });
    options.tiles = tiles;
    bankParts.push(backgrounds.tiles);
    next += backgrounds.uniqueTiles;
    backgroundColours = backgrounds.palettes[0] ?? [];
  }

  if (objects) {
    const sprites = new Map<string, { tile: number; width: number; height: number }>();
    for (const [name, art] of objects.art) {
      sprites.set(name, { tile: next + art.tile, width: art.width, height: art.height });
    }
    options.sprites = sprites;
    bankParts.push(objects.tiles);
    next += objects.uniqueTiles;
    spriteColours = objects.palettes[0] ?? [];
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
  const free = BANK_TILES - poolStart;
  const pictures = backdropScenes.map(
    (scene) => assets.get(scene.backdrop as string) as Uint8Array,
  );
  // The paths beside the bytes, so a conversion can find its own settings.
  const files = backdropScenes.map((scene) => scene.backdrop as string);
  const convert = (source: Uint8Array, cap: number, file: string): Promise<Backdrop> =>
    rememberAsync(
      backdropCache,
      `md:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a tile's number is where it
   * landed. The engine's map is one big-endian word a cell and as wide as the
   * picture; the plane is sixty-four cells wide, so each row is padded — and the
   * word's other bits have to survive the pool. This layout is flip-aware, so
   * the fitter stores one tile for up to four orientations and says which one a
   * cell wants; the palette select is the fit's too. Dropping either would draw
   * the right-hand end of every mirrored brick the wrong way round, or in the
   * wrong colours.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, MD_TILE_BYTES);
    const maps = arts.map((art) => {
      const map = new Uint8Array(MAP_W * MD_MEMORY.viewH * 2);
      for (let row = 0; row < MD_MEMORY.viewH; row += 1) {
        for (let column = 0; column < MD_MEMORY.viewW; column += 1) {
          const cell = row * MD_MEMORY.viewW + column;
          const word = ((art.map[cell * 2] as number) << 8) | (art.map[cell * 2 + 1] as number);
          const local = word & 0x07ff;
          const at = local * MD_TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + MD_TILE_BYTES));
          const out = (row * MAP_W + column) * 2;
          const entry = (tile & 0x07ff) | (word & (FLIP_X | FLIP_Y | 0x6000));
          map[out] = (entry >> 8) & 0xff;
          map[out + 1] = entry & 0xff;
        }
      }
      return map;
    });
    return { pool, maps };
  };

  // An even split first — not because it is the answer, but because it is a
  // budget every picture can be demade against at once, and a conversion reports
  // what it *wanted* as well as what it took. The bank is then shared out
  // max-min fair on those demands.
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
    scenePalettes.set(scene.name, packPalette(converted[index]!.palettes, spriteColours));
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }

  const bank = new Uint8Array(bankParts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of bankParts) {
    bank.set(part, at);
    at += part.length;
  }
  options.bank = bank;
  options.palette = packPalette([backgroundColours], spriteColours);

  return {
    options,
    tiles: bank.length / MD_TILE_BYTES - BUILTIN_TILES,
    missing,
  };
}
