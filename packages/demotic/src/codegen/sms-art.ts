/**
 * Binding a program's art for the Sega 8-bits.
 *
 * The counterpart of `art.ts` and `nes-art.ts`, and it calls the same engine. A
 * second converter here is how the browser and the CLI stop agreeing (doc 15
 * §The conversion path), so nothing about a pixel is decided in this file. What
 * is decided here is what the *hardware* imposes, and on this console that is
 * three things:
 *
 *   - **One tile bank, shared, and capped at 256.** Video RAM would hold 448
 *     tiles, but a sprite's tile number in the attribute table is a single byte
 *     — so anything an object can draw has to be below 256, and having the
 *     background reach higher would mean two budgets to explain and a
 *     nine-bit index in the name table's second byte. The built-in font, the
 *     level patterns and the placeholder block take the first sixty; art gets
 *     the rest, and objects and backgrounds share them.
 *   - **There are two colour banks and no third to reserve.** The Game Boy
 *     Color keeps one sub-palette of eight back for the font and the NES one of
 *     four; here there are exactly two, one of which the sprites must have. So
 *     the reservation is three *entries* at the top of the sprite bank instead,
 *     and the sprite fit is told it has that many fewer colours. Background art
 *     gets its bank whole.
 *   - **A backdrop is a screenful, padded to the name table's width.** The VDP's
 *     name table is thirty-two columns on both machines and a Game Gear's window
 *     is twenty, so a Game Gear picture is written into the left of each row and
 *     the copy that paints it stays one contiguous run.
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
import { builtinSega, BUILTIN_TILES, SEGA_TILE_BYTES } from "../rom/graphics.js";

import { artRequests, TilePool, type AssetBytes } from "./art.js";
import { GG_MEMORY, SMS_MEMORY } from "./layout.js";
import { BANK_TILES, SPRITE_COLORS, SYSTEM_INK, type SmsEmitOptions } from "./sms/emit.js";

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A full-screen backdrop here is a sixteen-colour fit over 256×192 pixels and
 * takes about twenty seconds — half again what the NES costs and three times the
 * Game Boy Color — while the web app rebuilds the game on every keystroke. The
 * conversion is a pure function of (bytes, box, console), so remembering its
 * answer cannot change one: the same inputs produce the same cartridge whether
 * it is the first build or the tenth, which is the parity contract restated.
 * A speed optimisation over a pure function, never one that changes bytes.
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Backdrop>();
const bankCache = new Map<string, SpriteBank>();

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

/** FNV-1a over a byte string — a cache key, never a checksum anyone relies on. */
function digest(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${bytes.length}`;
}

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/** Cells the name table is wide, which a backdrop's rows are padded to. */
const MAP_W = 32;

/** What the art binding produced, beyond the emitter's own options. */
export interface BoundSmsArt {
  options: SmsEmitOptions;
  /** Tiles the conversion added to the built-in bank. */
  tiles: number;
  /** Files the program names that no bytes were supplied for. */
  missing: readonly string[];
}

/** The console a build targets, and the window it draws into. */
function plan(consoleId: string): typeof SMS_MEMORY {
  return consoleId === "gg" ? GG_MEMORY : SMS_MEMORY;
}

/**
 * The colour bytes one palette's worth of fitted colours comes to.
 *
 * A Master System entry is one byte of `--BBGGRR` and a Game Gear entry is two
 * of `----BBBBGGGGRRRR`, and the image engine has already reduced the colours to
 * this console's lattice — so this is a re-encoding of codes the fitter chose
 * and not a colour decision.
 */
function encodeColours(
  colours: readonly { codes: readonly number[] }[],
  gameGear: boolean,
  count: number,
): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const codes = colours[index]?.codes ?? [0, 0, 0];
    const r = codes[0] ?? 0;
    const g = codes[1] ?? 0;
    const b = codes[2] ?? 0;
    if (gameGear) bytes.push((g << 4) | r, b);
    else bytes.push(((b & 3) << 4) | ((g & 3) << 2) | (r & 3));
  }
  return bytes;
}

/**
 * The three reserved entries, as this console encodes them.
 *
 * A rising grey ramp, which is what a caption drawn over anything needs: the
 * font's shade zero is the bank's own colour zero, so only the ink is chosen
 * here and it is chosen to be the brightest thing on the screen.
 */
function systemRamp(gameGear: boolean): number[] {
  const greys: [number, number, number][] = gameGear
    ? [
        [5, 5, 5],
        [10, 10, 10],
        [15, 15, 15],
      ]
    : [
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ];
  return encodeColours(
    greys.map((codes) => ({ codes })),
    gameGear,
    3,
  );
}

/** Bytes one colour takes in this console's colour RAM. */
function colourBytes(gameGear: boolean): number {
  return gameGear ? 2 : 1;
}

/**
 * Both banks, as colour RAM: sixteen background entries, then sixteen sprite.
 *
 * The last three of the sprite bank are always the font's, whatever the art
 * chose — which is the reservation, stated once, in the one place that writes
 * the bytes.
 */
function packPalette(
  background: readonly { codes: readonly number[] }[],
  sprites: readonly { codes: readonly number[] }[],
  gameGear: boolean,
): Uint8Array {
  const width = colourBytes(gameGear);
  const bytes = new Uint8Array(32 * width);
  bytes.set(encodeColours(background, gameGear, 16), 0);
  bytes.set(encodeColours(sprites, gameGear, 16 - 3), 16 * width);
  bytes.set(systemRamp(gameGear), (16 + SYSTEM_INK - 2) * width);
  return bytes;
}

/** The colour RAM a build with no demade art uses: the font's ramp, twice over. */
function systemOnlyPalette(gameGear: boolean): Uint8Array {
  const width = colourBytes(gameGear);
  const bytes = new Uint8Array(32 * width);
  const ramp = systemRamp(gameGear);
  bytes.set(ramp, (SYSTEM_INK - 2) * width);
  bytes.set(ramp, (16 + SYSTEM_INK - 2) * width);
  return bytes;
}

/** One demade backdrop: the tiles it needs and the name table that places them. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  palette: readonly { codes: readonly number[] }[];
}

/**
 * Demake one scene's backdrop through the image pipeline.
 *
 * Exactly the window the console displays, in pixels. Letting `prep` choose
 * would fit the *source's* size, and a title screen has to be a screenful: the
 * name table it produces and the block copy that paints it are the same
 * rectangle.
 */
function demakeBackdrop(bytes: Uint8Array, consoleId: string, maxTiles: number): Backdrop {
  const memory = plan(consoleId);
  const spec = getConsole(consoleId);
  const fitted = prepSync(bytes, {
    console: consoleId,
    size: { w: memory.viewW * 8, h: memory.viewH * 8 },
    fit: "cover",
    // A picture here is up to 768 cells against a Game Boy's 360 and the bank is
    // shared with every object in the game, so a picture that was not told what
    // it could afford would always overrun.
    maxTiles,
  });
  const backend = backendFor("sms");
  if (!backend) throw new Error("the sms image backend is missing");
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
    palette: fitted.image.palettes[0]?.colors ?? [],
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
export function bindSmsArt(program: Program, assets: AssetBytes, consoleId: string): BoundSmsArt {
  const gameGear = consoleId === "gg";
  const memory = plan(consoleId);
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
    const key = `${consoleId}:${kind}:${list.map((source) => `${source.name}:${digest(source.bytes)}`).join("|")}`;
    return remember(bankCache, key, () =>
      buildSpriteBank(list, {
        console: consoleId,
        packing: "planar",
        maxPalettes: 1,
        // The font's three entries come off the top of the sprite bank, so the
        // fit is told what it really has rather than being trimmed afterwards.
        ...(kind === "sprite" ? { maxColors: SPRITE_COLORS } : { opaque: true }),
      }),
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  const options: SmsEmitOptions = {};
  const bankParts: Uint8Array[] = [builtinSega(SYSTEM_INK)];
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
  // rather than stored again. Two title screens that share a night sky then cost
  // one tile between them.
  //
  // The budget is divided evenly among the pictures rather than given to the
  // first one, because "whichever screen the author wrote first gets to look
  // better" is not a decision a build should be making.
  const backdrops = new Map<string, { map: Uint8Array }>();
  const scenePalettes = new Map<string, Uint8Array>();
  const known = new Uint8Array(bankParts.reduce((total, part) => total + part.length, 0));
  let cursor = 0;
  for (const part of bankParts) {
    known.set(part, cursor);
    cursor += part.length;
  }
  const poolStart = next;
  const pool = new TilePool(known, poolStart, SEGA_TILE_BYTES);
  for (const [index, scene] of backdropScenes.entries()) {
    const left = BANK_TILES - next;
    const share = Math.max(1, Math.floor(left / (backdropScenes.length - index)));
    const source = assets.get(scene.backdrop as string) as Uint8Array;
    // The share is part of the key: the same picture fitted into a different
    // number of tiles is a different conversion, and two scenes sharing a bank
    // get different shares.
    const art = remember(backdropCache, `${consoleId}:${share}:${digest(source)}`, () =>
      demakeBackdrop(source, consoleId, share),
    );
    // The engine's map is two bytes a cell and as wide as the picture; the name
    // table is thirty-two cells wide on both machines, so each row is padded.
    const map = new Uint8Array(MAP_W * memory.viewH * 2);
    for (let row = 0; row < memory.viewH; row += 1) {
      for (let column = 0; column < memory.viewW; column += 1) {
        const cell = row * memory.viewW + column;
        const local =
          (art.map[cell * 2] as number) | (((art.map[cell * 2 + 1] as number) & 1) << 8);
        const at = local * SEGA_TILE_BYTES;
        const tile = pool.intern(art.tiles.subarray(at, at + SEGA_TILE_BYTES));
        const out = (row * MAP_W + column) * 2;
        map[out] = tile & 0xff;
        map[out + 1] = (tile >> 8) & 1;
      }
    }
    next = poolStart + pool.tail().length / SEGA_TILE_BYTES;
    backdrops.set(scene.name, { map });
    scenePalettes.set(scene.name, packPalette(art.palette, spriteColours, gameGear));
  }
  const pooled = pool.tail();
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
  options.palette =
    backgroundColours.length > 0 || spriteColours.length > 0
      ? packPalette(backgroundColours, spriteColours, gameGear)
      : systemOnlyPalette(gameGear);

  return {
    options,
    tiles: bank.length / SEGA_TILE_BYTES - BUILTIN_TILES,
    missing,
  };
}
