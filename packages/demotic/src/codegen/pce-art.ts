/**
 * Binding a program's art for the PC Engine.
 *
 * The counterpart of `art.ts`, `nes-art.ts` and `sms-art.ts`, and it calls the
 * same engine — a second converter here is how the browser and the CLI stop
 * agreeing (doc 15 §The conversion path), so nothing about a pixel is decided in
 * this file. What is decided here is what the *hardware* imposes, and on this
 * console that is four things:
 *
 *   - **A cell carries its own sub-palette, and there are sixteen of them.** No
 *     16×16 attribute block as on the NES and no two-bank arrangement as on the
 *     Sega 8-bits: a BAT entry names one of sixteen sixteen-colour palettes
 *     directly, so the fitter is handed fifteen (the sixteenth is the font's) and
 *     a picture keeps whatever it uses.
 *   - **Colour zero is shared by every background palette.** The chip reads one
 *     entry for it, which is the same `sharedIndex0` machinery the Mega Drive and
 *     the Super Nintendo use — so the font's *paper* is whatever the picture chose
 *     and only its ink is decided here. It is chosen against that backdrop, dark
 *     over light and light over dark, exactly as the NES's is.
 *   - **Characters are program bytes, not a second ROM.** Thirty-two bytes each,
 *     uploaded at boot out of the same forty-eight kilobytes the code lives in —
 *     which is the trade this console makes against an NES, whose character ROM
 *     is free. {@link ART_TILES} is what is left of {@link BANK_TILES} once the
 *     built-in bank has its share.
 *   - **There is no 8×8 sprite.** An object is 16×16 at its smallest, so the
 *     8×8 tiles the sprite engine returns are *composed* here into 16×16 patterns
 *     — four tiles to a pattern, missing corners transparent. An object `w` cells
 *     wide is `ceil(w/2)` patterns and costs `ceil(w/2)` hardware entries, which
 *     is a quarter of what it costs anywhere else.
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

import type { Program } from "../program.js";
import { selectBank, type SelectedBank } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { applyArtOverrides } from "../demakefile/overrides.js";
import { PCE_MEMORY } from "./layout.js";
import { packCellPairs } from "./pack.js";
import {
  ART_PALETTES,
  BANK_TILES,
  CHAR_BASE,
  MAP_W,
  PALETTE_SIZE,
  PATTERN_BYTES,
  SPRITE_PATTERNS,
  SYSTEM_PALETTE,
  type PceEmitOptions,
} from "./pce/emit.js";
import type { ArtSettings } from "./settings.js";
import { artKey, instanceCells } from "./shape.js";

/** Bytes one character is: sixteen words of two bitplanes each. */
export const CHAR_BYTES = 32;

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A full-screen backdrop here is a sixteen-colour fit over 256×224 pixels, which
 * is the Super Nintendo's screen and therefore the Super Nintendo's cost. The
 * conversion is a pure function of (bytes, box, console), so remembering its
 * answer cannot change one — a speed optimisation over a pure function, never one
 * that changes bytes.
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** Characters left for art once the built-in bank has its share. */
export function artTiles(bank: SelectedBank): number {
  return BANK_TILES - bank.count;
}

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundPceArt {
  options: PceEmitOptions;
  /** The bank the emitter will hand to the context, for its glyph indices. */
  bank: SelectedBank;
  /** Characters the conversion added to the built-in bank. */
  tiles: number;
  /** Sprite patterns the object art contributed, which glyphs are numbered after. */
  patterns: number;
  /** Which sub-palette a level's tile art was fitted into. */
  levelPalette: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/** One VCE colour word: `0000000G GGRRRBBB`, little-endian. */
function colourBytes(codes: readonly number[]): [number, number] {
  const r = (codes[0] ?? 0) & 7;
  const g = (codes[1] ?? 0) & 7;
  const b = (codes[2] ?? 0) & 7;
  const word = (g << 6) | (r << 3) | b;
  return [word & 0xff, (word >> 8) & 0xff];
}

/** Rec. 601 luma of a VCE code, which is what "light or dark" means. */
function luma(codes: readonly number[]): number {
  const to8 = (value: number): number =>
    ((value & 7) << 5) | ((value & 7) << 2) | ((value & 7) >> 1);
  return 0.299 * to8(codes[0] ?? 0) + 0.587 * to8(codes[1] ?? 0) + 0.114 * to8(codes[2] ?? 0);
}

/**
 * The font's sub-palette, chosen against the backdrop it will be read on.
 *
 * Colour zero of every background palette is the one shared backdrop on this
 * chip, so a glyph's unlit pixels are the picture's own and the only thing left
 * to choose is the ink: dark over a light backdrop, light over a dark one. A
 * fixed white ramp is exactly invisible over a pale sky, which is the mistake the
 * NES backend already made once.
 */
function fontPalette(backdrop: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(PALETTE_SIZE * 2);
  const dark = luma(backdrop) > 128;
  const ramp: readonly (readonly number[])[] = dark
    ? [
        [5, 5, 5],
        [2, 2, 2],
        [0, 0, 0],
      ]
    : [
        [2, 2, 2],
        [5, 5, 5],
        [7, 7, 7],
      ];
  for (const [offset, codes] of ramp.entries()) {
    const [low, high] = colourBytes(codes);
    bytes[(13 + offset) * 2] = low;
    bytes[(13 + offset) * 2 + 1] = high;
  }
  return bytes;
}

/** A run of sub-palettes as the colour table takes them. */
function packPalettes(palettes: readonly (readonly PaletteColor[])[]): Uint8Array {
  const bytes = new Uint8Array(Math.max(1, palettes.length) * PALETTE_SIZE * 2);
  for (const [index, colours] of palettes.entries()) {
    for (let entry = 0; entry < PALETTE_SIZE; entry += 1) {
      const [low, high] = colourBytes(colours[entry]?.codes ?? [0, 0, 0]);
      bytes[(index * PALETTE_SIZE + entry) * 2] = low;
      bytes[(index * PALETTE_SIZE + entry) * 2 + 1] = high;
    }
  }
  return bytes;
}

/** The built-in bank in this console's character format, selected cells only. */
export function builtinChars(bank: SelectedBank): Uint8Array {
  const bytes = new Uint8Array(bank.cells.length * CHAR_BYTES);
  // The font's three shades land at the top of its sub-palette, matching the ramp
  // {@link fontPalette} writes.
  const map = [0, 13, 14, 15];
  let at = 0;
  for (const cell of bank.cells) {
    for (let y = 0; y < 8; y += 1) {
      const row = cell[y] ?? "";
      for (let x = 0; x < 8; x += 1) {
        const shade = Number.parseInt(row[x] ?? "0", 10) || 0;
        const colour = map[shade] as number;
        for (let plane = 0; plane < 4; plane += 1) {
          if (((colour >> plane) & 1) === 0) continue;
          // Word `(plane >> 1) * 8 + y`, low byte the lower-numbered plane — which
          // is `packPceChar`'s layout in `core/src/codegen/pce.ts`, and it is not
          // the sprite pattern's.
          const index = at + (plane >> 1) * 16 + y * 2 + (plane & 1);
          bytes[index] = (bytes[index] as number) | (0x80 >> x);
        }
      }
    }
    at += CHAR_BYTES;
  }
  return bytes;
}

/**
 * Compose 8×8 tiles into one 16×16 sprite pattern.
 *
 * Sixteen words of plane 0, then sixteen each of planes 1, 2 and 3 — so a row of
 * one plane is a whole word and its leftmost pixel is bit fifteen. The four
 * corners are the tiles at (0,0), (1,0), (0,1) and (1,1) of the object's own
 * grid; a corner the object does not reach is left transparent, which is what
 * makes a one-cell object legal at all on hardware with no small sprite.
 */
function composePattern(
  tiles: Uint8Array,
  index: (column: number, row: number) => number | null,
  originX: number,
  originY: number,
): Uint8Array {
  const bytes = new Uint8Array(PATTERN_BYTES);
  for (let half = 0; half < 2; half += 1) {
    for (let quarter = 0; quarter < 2; quarter += 1) {
      const tile = index(originX + quarter, originY + half);
      if (tile === null) continue;
      const at = tile * CHAR_BYTES;
      for (let y = 0; y < 8; y += 1) {
        for (let plane = 0; plane < 4; plane += 1) {
          // The source is a character: planes 0/1 in word `y`, planes 2/3 in
          // word `8 + y`, low byte the lower-numbered plane.
          const source = at + (plane >> 1) * 16 + y * 2 + (plane & 1);
          const byte = tiles[source] ?? 0;
          if (byte === 0) continue;
          // The destination is a pattern: word `plane * 16 + row`, and the left
          // eight pixels are its high byte.
          const word = (plane * 16 + half * 8 + y) * 2;
          const to = word + (quarter === 0 ? 1 : 0);
          bytes[to] = (bytes[to] as number) | byte;
        }
      }
    }
  }
  return bytes;
}

/** One demade backdrop: the characters it needs and the map that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  palettes: readonly (readonly PaletteColor[])[];
  /** Characters the picture would have taken with nothing in its way. */
  demand: number;
}

/** Demake one scene's backdrop through the image pipeline. */
async function demakeBackdrop(
  bytes: Uint8Array,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  const spec = getConsole("pce");
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: "pce",
        size: { w: PCE_MEMORY.viewW * 8, h: PCE_MEMORY.viewH * 8 },
        fit: "cover",
        maxTiles,
        // The font keeps the sixteenth sub-palette, which is the one reservation
        // this console's picture has to live with — and it is a fifteenth of the
        // colour rather than the quarter an NES gives up.
        maxSubPalettes: ART_PALETTES,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
  const backend = backendFor("pce");
  if (!backend) throw new Error("the pce image backend is missing");
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
export async function bindPceArt(
  program: Program,
  assets: AssetBytes,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundPceArt> {
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

  const bank = selectBank({
    characters: captions(program),
    patterns: program.scenes.some((scene) => scene.level !== undefined),
    objectBlock: true,
  });

  const demakeBank = (kind: "sprite" | "tile"): SpriteBank | null => {
    const list = sources[kind];
    if (list.length === 0) return null;
    const key = `pce:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: "pce",
          // The character format is the Super Nintendo's exactly: planes 0 and 1
          // interleaved down eight rows, then planes 2 and 3.
          packing: "pairs",
          maxPalettes: ART_PALETTES,
          ...(kind === "tile" ? { opaque: true } : {}),
        }),
      CACHE_LIMIT,
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: PceEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinChars(bank)];
  let next = bank.count;
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
    options.levelPalette = packPalettes(backgrounds.palettes);
  }

  // Objects, composed into 16×16 patterns. The tiles the sprite engine returns
  // are 8×8 and go nowhere near the character bank on this console — they exist
  // only to be assembled into patterns here.
  const patternBlobs: Uint8Array[] = [];
  if (objects) {
    const sprites = new Map<
      string,
      { pattern: number; wide: number; tall: number; palette: number }
    >();
    for (const [name, art] of objects.art) {
      const wide = Math.ceil(art.width / 2);
      const tall = Math.ceil(art.height / 2);
      const first = patternBlobs.length;
      for (let row = 0; row < tall; row += 1) {
        for (let column = 0; column < wide; column += 1) {
          patternBlobs.push(
            composePattern(
              objects.tiles,
              (x, y) => (x < art.width && y < art.height ? art.tile + y * art.width + x : null),
              column * 2,
              row * 2,
            ),
          );
        }
      }
      sprites.set(name, { pattern: first, wide, tall, palette: art.palette });
    }
    options.sprites = sprites;
    options.spritePalette = packPalettes(objects.palettes);
  }

  // Backdrops go last, and through a pool: a cell already drawn by the built-in
  // font, by a level tile or by an earlier picture is pointed at rather than
  // stored again.
  const backdrops = new Map<string, { map: Uint8Array; palettes: number }>();
  const scenePalettes = new Map<string, { art: Uint8Array; font: Uint8Array }>();
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
      `pce:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a character's number is where it
   * landed. The map goes out padded to the *hardware's* row of sixty-four rather
   * than the picture's thirty-two, because that is what makes painting it one
   * walk from the first cell: the map's rows are contiguous at sixty-four words
   * each, and "the left half of a row" is not a thing the chip has.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, CHAR_BYTES);
    const maps = arts.map((art) => {
      const cells = new Uint8Array(MAP_W * PCE_MEMORY.viewH * 2);
      // Everything the picture does not cover is the blank character in palette
      // zero, which is what the boot code filled the map with.
      for (let index = 0; index < MAP_W * PCE_MEMORY.viewH; index += 1) {
        cells[index * 2] = CHAR_BASE & 0xff;
        cells[index * 2 + 1] = (CHAR_BASE >> 8) & 0x0f;
      }
      for (let row = 0; row < PCE_MEMORY.viewH; row += 1) {
        for (let column = 0; column < PCE_MEMORY.viewW; column += 1) {
          const cell = row * PCE_MEMORY.viewW + column;
          const word = (art.map[cell * 2] as number) | ((art.map[cell * 2 + 1] as number) << 8);
          const local = word & 0x0fff;
          const palette = (word >> 12) & 0x0f;
          const at = local * CHAR_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + CHAR_BYTES));
          const entry = ((CHAR_BASE + tile) & 0x0fff) | (palette << 12);
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
    backdrops.set(scene.name, {
      map: interned.maps[index] as Uint8Array,
      palettes: art.palettes.length,
    });
    scenePalettes.set(scene.name, {
      art: packPalettes(art.palettes),
      font: fontPalette(art.palettes[0]?.[0]?.codes ?? [0, 0, 0]),
    });
  }
  const pooled = interned.pool.tail();
  if (pooled.length > 0) bankParts.push(pooled);
  if (backdrops.size > 0) {
    options.backdrops = backdrops;
    options.scenePalettes = scenePalettes;
  }
  // Every scene needs a font palette, picture or no picture: a scene with a level
  // reads its captions over the level's own colours.
  options.fontPalette = fontPalette(backgrounds?.palettes[levelPalette]?.[0]?.codes ?? [0, 0, 0]);
  options.levelSubPalette = levelPalette;

  const chars = new Uint8Array(bankParts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of bankParts) {
    chars.set(part, at);
    at += part.length;
  }
  options.bank = chars;

  const patterns = new Uint8Array(patternBlobs.length * PATTERN_BYTES);
  for (const [index, blob] of patternBlobs.entries()) patterns.set(blob, index * PATTERN_BYTES);
  options.patterns = patterns;

  return {
    options,
    bank,
    tiles: chars.length / CHAR_BYTES - bank.count,
    patterns: patternBlobs.length,
    levelPalette,
    missing,
  };
}

/** Every character a program's captions and counters can draw. */
function captions(program: Program): string {
  let characters = "0123456789-";
  for (const instance of program.instances) {
    if (instance.className === "text") characters += instance.strings["text"] ?? "";
  }
  return characters;
}

/** Sprite patterns a build may have, art and pulled glyphs together. */
export { SPRITE_PATTERNS, SYSTEM_PALETTE };

/** What one object instance's art is keyed by, for a backend that asks. */
export { artKey, instanceCells };
