/**
 * Binding a program's art for the Game Boy Advance — and for the Nintendo DS,
 * which is the same 2D engine on a bigger screen.
 *
 * The counterpart of `art.ts`, `nes-art.ts`, `sms-art.ts`, `snes-art.ts` and
 * `md-art.ts`, and it calls the same engine. A second converter here is how the
 * browser and the CLI stop agreeing (doc 15 §The conversion path), so nothing
 * about a pixel is decided in this file. What is decided here is what the
 * *hardware* imposes, and on this console that is three things, all of which are
 * the opposite of a constraint.
 *
 *   - **Backgrounds and objects have separate banks and separate palettes.**
 *     48 KiB of background character memory and 32 KiB of object, with 256
 *     colours each. Every other console in the set divides one bank and one set
 *     of sub-palettes between the two and has to state the split; here there is
 *     nothing to divide, so a sprite's colours cost a backdrop nothing and a
 *     full-screen picture cannot starve the objects.
 *   - **A cell is not restricted to a sub-palette at all.** The fit asks for the
 *     console's 256-colour mode (`getConsole("gba").modes[0]`), where a screen
 *     entry carries no palette field — so a picture is one palette of 256 and
 *     `maxSubPalettes`, which every other backend here spends most of its
 *     reasoning on, does not apply.
 *   - **The reservation is therefore in colours, not in sub-palettes.** There is
 *     no palette to hold back for the font, so four of the 256 are held back
 *     instead — `maxColors`, which exists for this console — and a picture keeps
 *     the other 252. That is 1.6% against the quarter a Mega Drive gives up.
 *
 * Colour zero is still transparent on every background layer, which is what
 * makes it the shared backdrop the spec declares. The fourth reserved entry is
 * the font's *paper*, and it is the one thing here that no other console's
 * binding needs: a caption is drawn on a layer over the picture rather than into
 * a cell the picture gave up, so a transparent glyph would be read against
 * whatever the backdrop happened to put behind it.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  prep,
  withMode,
  type Executor,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import type { Program } from "../program.js";
import { builtinGba, GBA_BUILTIN_TILES, GBA_TILE_BYTES, objectBlockGba } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import {
  ART_COLORS,
  BANK_TILES,
  encodeColour,
  OBJ_TILES,
  PACK_W,
  PALETTE_COLORS,
  SYSTEM_INK,
  SYSTEM_PAPER,
  type GbaEmitOptions,
} from "./gba/emit.js";
import { GBA_MEMORY, NDS_MEMORY, type MemoryPlan } from "./layout.js";

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A full-screen backdrop here is 240×160 fitted into one 256-colour palette
 * while the web app rebuilds the game on every keystroke. The conversion is a
 * pure function of (bytes, box, console), so remembering its answer cannot
 * change one. A speed optimisation over a pure function, never one that changes
 * bytes.
 */
const CACHE_LIMIT = 12;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** Which of the console's selectable layouts a game is fitted into. */
const GAME_MODE = 0;

/**
 * The window a picture is fitted to, which is the *machine's* rather than the
 * family's.
 *
 * Both consoles declare the same 256-colour mode and both fit through the same
 * path; what differs is the screen, and a picture demade at the wrong one is a
 * picture cropped or letterboxed by exactly the difference. Read off the memory
 * plan so that the fit's box and the map the renderer walks are one number.
 */
function planFor(consoleId: string): MemoryPlan {
  return consoleId === "nds" ? NDS_MEMORY : GBA_MEMORY;
}

/** Tiles left for background art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - GBA_BUILTIN_TILES;

/** Tiles left for object art once the placeholder block has its one. */
export const OBJECT_ART_TILES = OBJ_TILES - 1;

/** The flip bits of a screen entry, which the fitter sets. */
const FLIP_X = 0x0400;
const FLIP_Y = 0x0800;

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundGbaArt {
  options: GbaEmitOptions;
  /** Tiles the conversion added to the background bank. */
  tiles: number;
  /** Tiles it added to the object bank, which is a separate budget. */
  objectTiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/**
 * One palette: 256 little-endian RGB555 halfwords.
 *
 * The last four are always the runtime's, whatever the art chose — the
 * reservation, stated once, in the one place that writes the bytes. It is a
 * *fixed* black-paper-through-white ramp rather than one picked against the
 * picture, and that is the whole point of the paper: a caption here is a layer
 * over the backdrop rather than a cell the backdrop gave up, so there is no one
 * colour behind it to choose against. The Sega build reaches the same answer
 * because its background layer is opaque outright; the NES and Mega Drive pick
 * their ink against a shared backdrop because on those machines a caption really
 * does replace the cell.
 */
function packPalette(colours: readonly { codes: readonly number[] }[]): Uint8Array {
  const bytes = new Uint8Array(PALETTE_COLORS * 2);
  const put = (index: number, codes: readonly number[]): void => {
    const word = encodeColour(codes);
    bytes[index * 2] = word & 0xff;
    bytes[index * 2 + 1] = (word >> 8) & 0xff;
  };
  for (let index = 0; index < ART_COLORS; index += 1) {
    put(index, colours[index]?.codes ?? [0, 0, 0]);
  }
  for (const [index, codes] of SYSTEM_RAMP.entries()) put(SYSTEM_PAPER + index, codes);
  return bytes;
}

/** The runtime's four entries: paper, then the three shades a glyph is inked in. */
const SYSTEM_RAMP: readonly (readonly number[])[] = [
  [0, 0, 0],
  [12, 12, 12],
  [22, 22, 22],
  [31, 31, 31],
];

/**
 * Share a bank out among pictures that together want more of it than there is.
 *
 * Max-min fair, the same allocator the Sega and Mega Drive backends use and here
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

/** One demade backdrop: the tiles it needs and the map that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  colours: readonly { codes: readonly number[] }[];
  /** Tiles the picture would have taken with nothing in its way. */
  demand: number;
}

/** Demake one scene's backdrop through the image pipeline. */
async function demakeBackdrop(
  consoleId: string,
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
): Promise<Backdrop> {
  const plan = planFor(consoleId);
  const spec = withMode(getConsole(consoleId), GAME_MODE);
  const fitted = await prep(bytes, {
    console: consoleId,
    mode: GAME_MODE,
    size: { w: plan.viewW * 8, h: plan.viewH * 8 },
    fit: "cover",
    // Four of the 256 are the runtime's; there is no sub-palette to reserve on
    // this console, so the reservation is in colours (see the file header).
    maxColors: ART_COLORS,
    maxTiles,
    ...(executor === undefined ? {} : { executor }),
  });
  const backend = backendFor(consoleId);
  if (!backend) throw new Error(`the ${consoleId} image backend is missing`);
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
    colours: fitted.image.palettes[0]?.colors ?? [],
    demand: fitted.stats.uniqueTiles + fitted.stats.tileMerges,
  };
}

/**
 * Convert a program's art and return what the emitter needs.
 *
 * Objects and background tiles go through the image pipeline separately, for the
 * reason doc 15 gives: an object's index 0 is transparency, so it has one fewer
 * colour and a choice of *which*, while a background tile has all of them and no
 * choice at all. Here they also land in different memory and draw from different
 * palettes, so the separation is the hardware's as well as the pipeline's.
 */
export async function bindGbaArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
): Promise<BoundGbaArt> {
  const consoleId = program.profile.id;
  const plan = planFor(consoleId);
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
  // enough: a build with no assets has to come out exactly as it would without
  // art.
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
    const key = `${consoleId}:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: consoleId,
          mode: GAME_MODE,
          // One byte a pixel: a 256-colour tile is not a bitplane arrangement at
          // all, and it is the only packing this mode has.
          packing: "linear8",
          maxPalettes: 1,
          maxColors: ART_COLORS,
          ...(kind === "sprite" ? {} : { opaque: true }),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: GbaEmitOptions = {};

  // --- the object bank, which nothing else shares ----------------------------
  const objectParts: Uint8Array[] = [objectBlockGba(SYSTEM_INK)];
  let objectColours: readonly { codes: readonly number[] }[] = [];
  if (objects) {
    const sprites = new Map<string, { tile: number; width: number; height: number }>();
    for (const [name, art] of objects.art) {
      sprites.set(name, { tile: 1 + art.tile, width: art.width, height: art.height });
    }
    options.sprites = sprites;
    objectParts.push(objects.tiles);
    objectColours = objects.palettes[0] ?? [];
  }
  options.objectBank = concat(objectParts);
  options.objectPalette = packPalette(objectColours);

  // --- the background bank: built-ins, level tiles, then the pictures ---------
  const bankParts: Uint8Array[] = [builtinGba(SYSTEM_INK, SYSTEM_PAPER)];
  let next = GBA_BUILTIN_TILES;
  let backgroundColours: readonly { codes: readonly number[] }[] = [];

  if (backgrounds) {
    const tiles = new Map<string, { tile: number }>();
    for (const [name, art] of backgrounds.art) tiles.set(name, { tile: next + art.tile });
    options.tiles = tiles;
    bankParts.push(backgrounds.tiles);
    next += backgrounds.uniqueTiles;
    backgroundColours = backgrounds.palettes[0] ?? [];
  }

  // Backdrops go last, and through a pool: a cell already drawn by the built-in
  // font, by a level tile or by an earlier picture is pointed at rather than
  // stored again.
  const backdrops = new Map<string, { map: Uint8Array }>();
  const scenePalettes = new Map<string, Uint8Array>();
  const known = concat(bankParts);
  const poolStart = next;
  const free = BANK_TILES - poolStart;
  const pictures = backdropScenes.map(
    (scene) => assets.get(scene.backdrop as string) as Uint8Array,
  );
  const convert = (source: Uint8Array, cap: number): Promise<Backdrop> =>
    rememberAsync(
      backdropCache,
      `${consoleId}:${cap}:${digest(source)}`,
      () => demakeBackdrop(consoleId, source, cap, executor),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a tile's number is where it
   * landed. The engine's map is one little-endian halfword a cell and as wide as
   * the picture; a packed backdrop is streamed into one 32-cell-wide screen
   * block, so each row is padded to that — *not* to the 64-cell map, which is
   * four blocks a kilobyte apart rather than a rectangle. The flip bits are the
   * fit's and have to survive the pool: this layout is flip-aware, so one tile
   * stands for up to four orientations and the cell says which.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, GBA_TILE_BYTES);
    const maps = arts.map((art) => {
      const map = new Uint8Array(PACK_W * plan.viewH * 2);
      for (let row = 0; row < plan.viewH; row += 1) {
        for (let column = 0; column < plan.viewW; column += 1) {
          const cell = row * plan.viewW + column;
          const word = (art.map[cell * 2] as number) | ((art.map[cell * 2 + 1] as number) << 8);
          const local = word & 0x03ff;
          const at = local * GBA_TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + GBA_TILE_BYTES));
          const out = (row * PACK_W + column) * 2;
          const entry = (tile & 0x03ff) | (word & (FLIP_X | FLIP_Y));
          map[out] = entry & 0xff;
          map[out + 1] = (entry >> 8) & 0xff;
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
  let converted = await Promise.all(pictures.map((source) => convert(source, share)));
  const demands = converted.map((art) => art.demand);
  const shares = fairShares(demands, free);
  // What a fit produces is `min(budget, demand)` tiles, and below the demand the
  // budget does not reach the fit at all — so a conversion is already the one the
  // final share would have produced whenever those two numbers agree.
  converted = await Promise.all(
    converted.map((art, index) =>
      Math.min(shares[index]!, demands[index]!) === Math.min(share, demands[index]!)
        ? Promise.resolve(art)
        : convert(pictures[index]!, shares[index]!),
    ),
  );
  const interned = internAll(converted);

  for (const [index, scene] of backdropScenes.entries()) {
    backdrops.set(scene.name, { map: interned.maps[index]! });
    scenePalettes.set(scene.name, packPalette(converted[index]!.colours));
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }

  const bank = concat(bankParts);
  options.bank = bank;
  options.palette = packPalette(backgroundColours);

  return {
    options,
    tiles: bank.length / GBA_TILE_BYTES - GBA_BUILTIN_TILES,
    objectTiles: (options.objectBank?.length ?? 0) / GBA_TILE_BYTES - 1,
    missing,
  };
}

/** Join the parts of a bank, in bank order. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
