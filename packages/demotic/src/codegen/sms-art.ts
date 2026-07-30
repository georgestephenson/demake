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
  prep,
  type Executor,
  type PrepOptions,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import type { Program } from "../program.js";
import { builtinSega, BUILTIN_TILES, SEGA_TILE_BYTES } from "../rom/graphics.js";

import { artRequests, digest, remember, rememberAsync, TilePool, type AssetBytes } from "./art.js";
import { GG_MEMORY, SMS_MEMORY } from "./layout.js";
import { BANK_TILES, SPRITE_COLORS, SYSTEM_INK, type SmsEmitOptions } from "./sms/emit.js";
import { applyArtOverrides } from "../demakefile/overrides.js";
import type { ArtSettings } from "./settings.js";

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
 *
 * The helpers are `art.ts`'s — one memo, not a third copy of one — but the limit
 * is this console's own: an entry here is a sixteen-colour screenful, so fewer of
 * them fit in the same memory than the Game Boy's four-colour ones.
 */
const CACHE_LIMIT = 16;
const backdropCache = new Map<string, Promise<Backdrop>>();
const bankCache = new Map<string, SpriteBank>();

/** Tiles left for art once the built-in bank has its share. */
export const ART_TILES = BANK_TILES - BUILTIN_TILES;

/** Cells the name table is wide, which a backdrop's rows are padded to. */
const MAP_W = 32;

/** The flip bits of a name-table entry's second byte, which the fitter sets. */
const FLIP_X = 0x02;
const FLIP_Y = 0x04;

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
 *
 * So is the *first*, and for the opposite reason. Entry zero of the sprite bank
 * is what an object's transparency indexes, so no sprite ever renders it and the
 * fit has no opinion about it — but a background cell has no transparency at all
 * on this hardware, and the font, the level patterns, the placeholder block and
 * every blank cell draw in that bank. Its colour zero is therefore the paper a
 * caption is read on, and leaving it to whatever the object fit happened to
 * leave in the slot is how a score comes out white on white. Black, so the three
 * rising greys above it read.
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
  bytes.fill(0, 16 * width, 17 * width);
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

/**
 * Share a bank out among pictures that together want more of it than there is.
 *
 * Max-min fair, which is the honest reading of "no picture is squeezed while
 * another has slack": serve the cheapest first, give it what it asks for if that
 * is no more than an even split of what is left, and offer the remainder to the
 * rest. A picture that wants half a bank on its own gets half a bank; the one
 * beside it that wants ten tiles gets ten and not a hundred and twenty.
 *
 * Order comes from the demands, not from the scenes, so "whichever screen the
 * author wrote first" decides nothing — ties fall back to scene order only so
 * that the answer is one answer.
 */
function fairShares(demands: readonly number[], capacity: number): number[] {
  const order = demands.map((_, index) => index).sort((a, b) => demands[a]! - demands[b]! || a - b);
  const shares = demands.map(() => 0);
  let left = capacity;
  let waiting = demands.length;
  for (const index of order) {
    const even = Math.floor(left / waiting);
    // At least one tile each: a picture demade into nothing at all would be a
    // blank screen, which reads as a broken build rather than a tight one.
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
  palette: readonly { codes: readonly number[] }[];
  /**
   * Tiles the picture would have taken with nothing in its way.
   *
   * The whole reason a budget can be shared out sensibly without demaking
   * anything twice. `maxTiles` reaches the pipeline *after* the fit — it is the
   * merge stage and nothing else — so a conversion always reports how many tiles
   * it wanted as well as how many it was allowed, and a fit that merged nothing
   * is byte-for-byte what any larger budget would have produced.
   */
  demand: number;
}

/**
 * Demake one scene's backdrop through the image pipeline.
 *
 * Exactly the window the console displays, in pixels. Letting `prep` choose
 * would fit the *source's* size, and a title screen has to be a screenful: the
 * name table it produces and the block copy that paints it are the same
 * rectangle.
 */
async function demakeBackdrop(
  bytes: Uint8Array,
  consoleId: string,
  maxTiles: number,
  executor: Executor | undefined,
  overrides?: Partial<PrepOptions>,
): Promise<Backdrop> {
  const memory = plan(consoleId);
  const spec = getConsole(consoleId);
  const fitted = await prep(
    bytes,
    applyArtOverrides(
      {
        console: consoleId,
        size: { w: memory.viewW * 8, h: memory.viewH * 8 },
        fit: "cover",
        // A picture here is up to 768 cells against a Game Boy's 360 and the bank is
        // shared with every object in the game, so a picture that was not told what
        // it could afford would always overrun.
        maxTiles,
        ...(executor === undefined ? {} : { executor }),
      },
      overrides,
    ),
  );
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
export async function bindSmsArt(
  program: Program,
  assets: AssetBytes,
  consoleId: string,
  executor?: Executor,
  settings?: ArtSettings,
): Promise<BoundSmsArt> {
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
    return remember(
      bankCache,
      key,
      () =>
        buildSpriteBank(list, {
          console: consoleId,
          packing: "planar",
          maxPalettes: 1,
          // The font's three entries come off the top of the sprite bank, so the
          // fit is told what it really has rather than being trimmed afterwards.
          ...(kind === "sprite" ? { maxColors: SPRITE_COLORS } : { opaque: true }),
        }),
      CACHE_LIMIT,
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
  // The budget is part of the key: the same picture fitted into a different
  // number of tiles is a different conversion.
  const convert = (source: Uint8Array, cap: number, file: string): Promise<Backdrop> =>
    rememberAsync(
      backdropCache,
      `${consoleId}:${cap}:${digest(source)}:${JSON.stringify(settings?.[file] ?? {})}`,
      () => demakeBackdrop(source, consoleId, cap, executor, settings?.[file]),
      CACHE_LIMIT,
    );

  /**
   * Intern a set of conversions into a fresh pool, in scene order.
   *
   * Scene order and not arrival order, because a tile's number is where it
   * landed — the Game Boy's arrangement, and the reason its backdrops may be
   * demade concurrently. The pool is fresh each time because interning is what
   * decides the numbers, so a second attempt has to start from the same place
   * the first one did.
   *
   * The engine's map is two bytes a cell and as wide as the picture; the name
   * table is thirty-two cells wide on both machines, so each row is padded. And
   * the second byte carries more than the tile's ninth bit: this layout is
   * flip-aware (`ConsoleSpec.tiles.flip`), so the fitter stores one tile for up
   * to four orientations and says which one a cell wants in bits 1 and 2. Those
   * bits have to survive the pool, or every mirrored cell is drawn the wrong way
   * round — it is the same tile either way, so nothing here changes what the bank
   * costs; what changes is that the right-hand end of a brick, a ledge or a
   * letter is the shape the picture was fitted with.
   */
  const internAll = (arts: readonly Backdrop[]): { pool: TilePool; maps: Uint8Array[] } => {
    const pool = new TilePool(known, poolStart, SEGA_TILE_BYTES);
    const maps = arts.map((art) => {
      const map = new Uint8Array(MAP_W * memory.viewH * 2);
      for (let row = 0; row < memory.viewH; row += 1) {
        for (let column = 0; column < memory.viewW; column += 1) {
          const cell = row * memory.viewW + column;
          const high = art.map[cell * 2 + 1] as number;
          const local = (art.map[cell * 2] as number) | ((high & 1) << 8);
          const at = local * SEGA_TILE_BYTES;
          const tile = pool.intern(art.tiles.subarray(at, at + SEGA_TILE_BYTES));
          const out = (row * MAP_W + column) * 2;
          map[out] = tile & 0xff;
          map[out + 1] = ((tile >> 8) & 1) | (high & (FLIP_X | FLIP_Y));
        }
      }
      return map;
    });
    return { pool, maps };
  };

  // An even split first — not because it is the answer, but because it is a
  // budget every picture can be demade against at once, and a conversion reports
  // what it *wanted* as well as what it took. The bank is then shared out max-min
  // fair on those demands: the cheapest picture is served first and what it does
  // not want is offered to the rest.
  //
  // The even split alone was the bug. Breakout's Master System title screen wants
  // 229 tiles and its court wants 21, against a bank with 183 free — so half each
  // starved the title of sixty-eight tiles to reserve seventy the court never
  // asked for, and merged the letters of the word BREAKOUT into each other to pay
  // for it. That is the "an under-fed fit looks like a bad fit" rule with the fit
  // under-fed by arithmetic rather than by hardware.
  //
  // A picture is demade a second time only where the share it ends up with would
  // change its fit, which is why this costs nothing on a game whose pictures all
  // want more than their share (they keep it) and nothing on a game with one
  // picture (it had the whole bank already).
  const share = Math.max(1, Math.floor(free / backdropScenes.length));
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
    scenePalettes.set(scene.name, packPalette(converted[index]!.palette, spriteColours, gameGear));
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
