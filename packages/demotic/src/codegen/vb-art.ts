/**
 * Binding a program's art for the Virtual Boy.
 *
 * The counterpart of `art.ts`, `nes-art.ts`, `sms-art.ts`, `pce-art.ts` and
 * `wsc-art.ts`, and it calls the same engine — a second converter here is how
 * the browser and the CLI stop agreeing (doc 15 §The conversion path), so
 * nothing about a pixel is decided in this file. What is decided here is what
 * the *hardware* imposes, and on this console that is four things.
 *
 *   - **A palette is four colours and there are four of them per layer**, which
 *     is the narrowest budget in the set. So the reservation for the font is a
 *     whole palette rather than a corner of one — the Neo Geo Pocket's answer —
 *     and art takes `GPLT0`/`JPLT0` while the font, the level patterns and the
 *     placeholder block take `GPLT1`/`JPLT1`.
 *   - **Colour zero is transparent on both layers**, so a picture's lightest
 *     shade only ever reaches the screen through `BKCOL`. That is why a scene's
 *     palette block is nine bytes rather than eight: the backdrop is not a
 *     caller's decision, it is the fit's own colour zero.
 *   - **Shade zero is the LEDs being off**, which is the opposite end of the ramp
 *     from where every mono console in this project puts index 0. {@link vbShade}
 *     is the one place that reversal happens and this file is one of its three
 *     readers; a copy of the arithmetic here would be a cartridge whose picture
 *     is a photographic negative against the other two.
 *   - **A character row is a little-endian halfword with its leftmost pixel in
 *     the lowest bits**, which is the Neo Geo Pocket's layout read the other way
 *     round — so `packed2le` is a packing of its own rather than a flag, and the
 *     built-in bank is {@link builtinVb} rather than {@link builtinNgp}.
 *
 * And one thing the hardware does *not* impose, worth saying because every other
 * console in the set pays it: the character bank holds two thousand and
 * forty-eight cells, which is more than any demade screen can want. What is
 * scarce here is the palette, not the bank.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  prep,
  vbShade,
  type CompliantImage,
  type Executor,
  type PrepOptions,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import { applyArtOverrides } from "../demakefile/overrides.js";
import type { Program } from "../program.js";
import { builtinVb, BUILTIN_TILES } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { VB_MEMORY } from "./layout.js";
import { packCellPairs } from "./pack.js";
import type { ArtSettings } from "./settings.js";
import { artKey, instanceCells } from "./shape.js";
import {
  ART_PALETTES,
  BANK_TILES,
  mapWord,
  OBJECT_PALETTES,
  PALETTE_BYTES,
  systemPaletteByte,
  TILE_BYTES,
  VB_MAP_W,
  type VbEmitOptions,
} from "./vb/emit.js";

/** The console this file demakes for. */
const CONSOLE = "vb";

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * The conversion is a pure function of (bytes, box, budget), so remembering its
 * answer cannot change one — a speed optimisation over a pure function, never one
 * that changes bytes. The budget is in the key because what a picture may spend
 * is what the pictures before it left (AGENTS.md §And every art module memoises).
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundVbArt {
  options: VbEmitOptions;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/**
 * One palette register: three shades in bits 2–7, and colour zero left alone.
 *
 * The fit's indices are reversed on the way in, because this display's shade 0
 * is the LEDs off and a fit's index 0 is its lightest colour. Colour zero has no
 * bits in the register at all — the hardware never shows it — which is why the
 * backdrop travels separately.
 */
function paletteByte(shades: readonly number[]): number {
  return (
    ((vbShade(shades[0] ?? 1) & 3) << 2) |
    ((vbShade(shades[1] ?? 2) & 3) << 4) |
    ((vbShade(shades[2] ?? 3) & 3) << 6)
  );
}

/**
 * A whole scene's palette block: four background registers, four object
 * registers, and the backdrop.
 *
 * The reservation happens here and nowhere else: `GPLT0` and `JPLT0` are the
 * art's, and the three above each are the font's ramp — chosen against the
 * backdrop, so a caption is dark over a bright picture and bright over a dark
 * one, exactly as the NES's and the PC Engine's caption ink is.
 */
function packPaletteBlock(
  background: readonly number[],
  objects: readonly number[],
  backdrop: number,
  behind = backdrop,
): Uint8Array {
  const art = paletteByte(background);
  const object = paletteByte(objects);
  const system = systemPaletteByte(behind);
  return Uint8Array.from([art, system, system, system, object, system, system, system, backdrop]);
}

/** One demade backdrop: the characters it needs and the map that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  /** The picture's own four shade indices, in fit order. */
  shades: readonly number[];
  /**
   * The hardware shade this picture mostly *shows*, which is what a caption over
   * it has to be legible against.
   *
   * Not the backdrop, and the difference is the whole point: the caption plane
   * draws in front of the picture, so a glyph's transparent paper shows the
   * picture rather than the backdrop register. A title screen that is three
   * quarters dark with a bright colour zero would otherwise be given dark ink
   * (`vb/emit.ts` §systemPaletteByte).
   */
  behind: number;
  /** Tiles the picture would have taken with nothing in its way. */
  demand: number;
}

/** The shade a fit's palette entry names, in the fit's own convention. */
function shadesOf(image: CompliantImage): readonly number[] {
  return (image.palettes[0]?.colors ?? []).map((colour) => colour.codes[0] ?? 0);
}

/** Demake one scene's backdrop through the image pipeline. */
async function demakeBackdrop(
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  const spec = getConsole(CONSOLE);
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: CONSOLE,
        size: { w: VB_MEMORY.viewW * 8, h: VB_MEMORY.viewH * 8 },
        fit: "cover",
        maxTiles,
        maxSubPalettes: ART_PALETTES,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const backend = backendFor(CONSOLE);
  if (!backend) throw new Error(`the ${CONSOLE} image backend is missing`);
  const artifacts = backend.emitBin(fitted.image, spec, {
    symbol: "backdrop",
    header: [],
    mapBase: 0,
    tileBase: 0,
  });
  const find = (suffix: string): Uint8Array =>
    artifacts.find((artifact) => artifact.suffix === suffix)?.bytes ?? new Uint8Array(0);
  const chars = find(".chr.bin");
  const map = find(".map.bin");
  const shades = shadesOf(fitted.image);
  return {
    tiles: chars,
    map,
    shades,
    behind: meanShade(chars, map, shades),
    demand: fitted.stats.uniqueTiles + fitted.stats.tileMerges,
  };
}

/**
 * The hardware shade a demade picture shows on average, over the visible screen.
 *
 * Counted off the characters and the map rather than off the source image,
 * because what a caption is read against is what the *display* draws: the fit's
 * four colours, reversed for this panel, in the proportions the map actually
 * places them. Colour zero counts as the backdrop, which is where it goes.
 */
function meanShade(chars: Uint8Array, map: Uint8Array, shades: readonly number[]): number {
  const counts = [0, 0, 0, 0];
  const cells = Math.min(map.length >> 1, VB_MEMORY.viewW * VB_MEMORY.viewH);
  for (let cell = 0; cell < cells; cell += 1) {
    const word = (map[cell * 2] as number) | ((map[cell * 2 + 1] as number) << 8);
    const at = (word & 0x07ff) * TILE_BYTES;
    for (let byte = 0; byte < TILE_BYTES; byte += 1) {
      const packed = chars[at + byte] ?? 0;
      for (let pixel = 0; pixel < 4; pixel += 1) {
        counts[(packed >> (pixel * 2)) & 3] = (counts[(packed >> (pixel * 2)) & 3] as number) + 1;
      }
    }
  }
  let total = 0;
  let weight = 0;
  for (const [index, count] of counts.entries()) {
    total += vbShade(shades[index] ?? index) * count;
    weight += count;
  }
  return weight === 0 ? 0 : Math.round(total / weight);
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
export async function bindVbArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundVbArt> {
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
    const key = `${CONSOLE}:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: CONSOLE,
          packing: "packed2le",
          maxPalettes: kind === "sprite" ? OBJECT_PALETTES : ART_PALETTES,
          ...(kind === "tile" ? { opaque: true } : {}),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: VbEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinVb()];
  let next = BUILTIN_TILES;

  if (backgrounds) {
    const tiles = new Map<string, { tile: number; palette: number }>();
    for (const [name] of backgrounds.art) {
      const art = backgrounds.art.get(name);
      if (art) tiles.set(name, { tile: next + art.tile, palette: 0 });
    }
    options.tiles = tiles;
    bankParts.push(backgrounds.tiles);
    next += backgrounds.uniqueTiles;
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
        palette: 0,
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
      `${CONSOLE}:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a character's number is where it
   * landed. The map goes out padded to the *hardware's* row of sixty-four rather
   * than the picture's forty-eight, because that is what makes painting it one
   * walk from the first cell — the Super Nintendo's stride hazard, four consoles
   * along.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, TILE_BYTES);
    const maps = arts.map((art) => {
      const cells = new Uint8Array(VB_MAP_W * VB_MEMORY.viewH * 2);
      for (let row = 0; row < VB_MEMORY.viewH; row += 1) {
        for (let column = 0; column < VB_MEMORY.viewW; column += 1) {
          const cell = row * VB_MEMORY.viewW + column;
          const word = (art.map[cell * 2] as number) | ((art.map[cell * 2 + 1] as number) << 8);
          const local = word & 0x07ff;
          // The flip bits are the fitter's and they cost nothing: one character
          // stands for up to four orientations and the cell says which.
          const flips = word & 0x3000;
          const at = local * TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + TILE_BYTES));
          const entry = mapWord(tile, 0) | flips;
          const out = (row * VB_MAP_W + column) * 2;
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
    // A picture's own colour zero *is* the backdrop register, so its palette
    // block carries it and the font's ramp is chosen against it.
    const backdrop = vbShade(art.shades[0] ?? 0);
    scenePalettes.set(
      scene.name,
      packPaletteBlock(art.shades.slice(1), objects?.shades ?? [], backdrop, art.behind),
    );
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }

  // The build's own palette block, which every scene without a picture brings:
  // the level tiles' shades, the objects', and a backdrop that is the level art's
  // own colour zero — or the LEDs off, for a build with no level art at all,
  // which is the one thing a scene with nothing in it should look like here.
  const levelShades = backgrounds?.shades ?? [];
  options.palette = packPaletteBlock(
    levelShades.slice(1),
    objects?.shades ?? [],
    levelShades.length > 0 ? vbShade(levelShades[0] ?? 0) : 0,
  );
  options.levelPalette = 0;

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

/** How long a palette block is, for a caller that stores one. */
export { PALETTE_BYTES };

/** What one object instance's art is keyed by, for a backend that asks. */
export { artKey, instanceCells };
