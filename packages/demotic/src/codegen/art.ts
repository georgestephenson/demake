/**
 * Binding a program's art: the point where the game pipeline meets the image
 * one (doc 15 §The conversion path).
 *
 * The whole tool exists to demake *assets*, so a `.dmt` that says
 * `sprite hero.svg` has to end up with the hero on screen, drawn by the same
 * engine that demakes a photograph — not by a placeholder block, and not by a
 * second converter written for games. This module is deliberately thin for that
 * reason: it works out *what* art the program needs and how big each piece has
 * to be, hands the bytes to `@demake/core`, and hands the result back to the
 * emitter. Every decision about pixels is made in the image engine.
 *
 * Sizes come from the game, not from the file. An object one cell wide and two
 * cells tall is drawn 8×16 whatever the source's aspect ratio, because its
 * *collision box* is the thing the player experiences and art that disagreed
 * with it would be a lie the trace oracle could not catch. That is also why one
 * asset can be requested more than once: a class whose instances override
 * `width` has one collision box per instance, so it needs one *set of tiles* per
 * box. Converting it once at the largest box and drawing every instance that
 * size is the one thing this module must not do — an eleven-cell floor and a
 * five-cell shelf drawn from the same run put six cells of solid-looking ledge
 * where nothing collides, and the player falls through it.
 *
 * **Which console the art is demade for is the build's, not the runtime's.**
 * A `gb` build takes the image engine's mono path, a `gbc` build takes its
 * RGB-lattice one, and everything downstream — how many colours an object has,
 * which sub-palette it names, how a backdrop's cells are attributed — is the
 * engine's answer rather than a second one written here.
 *
 * Art is optional at every step: a program with no assets, or an edge that
 * chose not to load them, builds exactly as before with the built-in block and
 * pattern tiles. That is what makes the browser and the CLI able to agree — the
 * inputs are the same or the feature is absent, never half-applied.
 */

import {
  backendFor,
  buildSpriteBank,
  getConsole,
  paletteRegister,
  prepSync,
  type PaletteColor,
  type SpriteBank,
  type SpriteSource,
} from "@demake/core";

import type { InstanceDef, Program } from "../program.js";
import { BUILTIN_TILES, builtinTiles, TILE_BYTES } from "../rom/graphics.js";

import { artKey, ART_PALETTES, PALETTE_BYTES, SYSTEM_PALETTE, type EmitOptions } from "./emit.js";
import { GB_MEMORY } from "./layout.js";

/** Asset bytes by the name a `.dmt` or a `.dmtl` legend wrote. */
export type AssetBytes = ReadonlyMap<string, Uint8Array>;

/**
 * Demaking is expensive, deterministic, and asked for over and over.
 *
 * A colour backdrop goes through the whole `prep` tournament — several
 * candidates, each a constrained fit with restarts — and takes a few seconds
 * where the monochrome path takes a fraction of one. Meanwhile the two callers
 * that matter rebuild constantly: the web app compiles the game again on every
 * keystroke, and the test suite builds the same fixture for both consoles.
 *
 * The conversion is a pure function of (bytes, box, console), so remembering
 * its answer cannot change one — the same inputs produce the same cartridge
 * whether it is the first build or the tenth, which is the parity contract
 * restated. The cache is small and evicts in insertion order; it is a speed
 * optimisation, never a correctness one.
 */
const CACHE_LIMIT = 24;

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

const backdropCache = new Map<string, Backdrop>();
const bankCache = new Map<string, SpriteBank>();

/** One asset the program needs, with the box the game says it fills. */
export interface AssetRequest {
  name: string;
  /** `name` and the box together — what the emitter looks the art up by. */
  key: string;
  /** Whether it is drawn as an object (transparent) or a background tile. */
  kind: "sprite" | "tile";
  cellsWide: number;
  cellsHigh: number;
}

/** Size of an instance in whole cells, which is what a sprite must fill. */
function cells(instance: InstanceDef, prop: string): number {
  return Math.max(1, Math.round((instance.numbers[prop] ?? 0) / 65536));
}

/**
 * Every piece of art the program refers to, deduplicated by *file and box*.
 *
 * An asset used by two objects of different sizes is converted twice, once per
 * box, because the box is the collision box: art that covered more cells than
 * the box would be scenery the player can walk through, and art that covered
 * fewer would be a hole they cannot. Two conversions is not two banks —
 * `buildSpriteBank` deduplicates tiles across the whole build, so the cells the
 * two sizes happen to share cost nothing.
 */
export function artRequests(program: Program): AssetRequest[] {
  const requests = new Map<string, AssetRequest>();
  const want = (name: string, kind: "sprite" | "tile", wide: number, high: number): void => {
    const key = artKey(name, wide, high);
    if (!requests.has(key)) {
      requests.set(key, { name, key, kind, cellsWide: wide, cellsHigh: high });
    }
  };

  for (const instance of program.instances) {
    const asset = instance.strings["sprite"];
    if (asset !== undefined)
      want(asset, "sprite", cells(instance, "width"), cells(instance, "height"));
  }
  for (const scene of program.scenes) {
    for (const tile of scene.level?.tiles ?? []) {
      if (tile.art !== undefined) want(tile.art, "tile", 1, 1);
    }
  }
  return [...requests.values()];
}

/** Art bound to a program, in the form the emitter consumes. */
export interface BoundArt extends EmitOptions {
  /** Assets that were requested but whose bytes were not supplied. */
  missing: string[];
  /** Distinct tiles the conversion produced. */
  tiles8: number;
}

/**
 * The system ramp: what the built-in font, the level patterns and the HUD are
 * drawn with on a colour build.
 *
 * One background palette and one object palette are reserved for it, and that
 * reservation is the whole reason a score stays readable. Everything else on
 * screen is demade art whose palettes were chosen *for that art* — a title
 * screen's fit is free to spend all four of a palette's colours on sky — and a
 * caption borrowing one of them would come out sky-on-sky. Plain white through
 * black is also what the monochrome build shows, so the two look like the same
 * game.
 */
const SYSTEM_RAMP: readonly (readonly [number, number, number])[] = [
  [31, 31, 31],
  [21, 21, 21],
  [10, 10, 10],
  [0, 0, 0],
];

/** BGR555, five bits a channel, blue high — the CGB's palette-RAM word order. */
function bgr555(codes: readonly number[]): number {
  return ((codes[0] ?? 0) & 31) | (((codes[1] ?? 0) & 31) << 5) | (((codes[2] ?? 0) & 31) << 10);
}

/**
 * Pack fitted sub-palettes into the byte block the hardware is written from.
 *
 * Always `count` palettes long, padded with black: the upload is then a
 * constant-size copy, and a palette nothing names cannot be seen whatever is in
 * it. Anything past `count` is dropped rather than silently wrapping onto a
 * palette that belongs to something else.
 */
function packPalettes(palettes: readonly (readonly PaletteColor[])[], count: number): Uint8Array {
  const bytes = new Uint8Array(count * PALETTE_BYTES);
  for (let index = 0; index < Math.min(count, palettes.length); index += 1) {
    const palette = palettes[index] as readonly PaletteColor[];
    for (let color = 0; color < 4; color += 1) {
      const word = bgr555(palette[color]?.codes ?? [0, 0, 0]);
      bytes[index * PALETTE_BYTES + color * 2] = word & 0xff;
      bytes[index * PALETTE_BYTES + color * 2 + 1] = (word >> 8) & 0xff;
    }
  }
  return bytes;
}

/** The system ramp as a palette block, with index 0 forced transparent or not. */
function systemPalette(transparent: boolean): Uint8Array {
  const bytes = new Uint8Array(PALETTE_BYTES);
  for (let color = 0; color < 4; color += 1) {
    // An object's colour 0 is never displayed; black there keeps the block the
    // shape the hardware is written from without implying a colour.
    const word = bgr555(transparent && color === 0 ? [0, 0, 0] : (SYSTEM_RAMP[color] ?? [0, 0, 0]));
    bytes[color * 2] = word & 0xff;
    bytes[color * 2 + 1] = (word >> 8) & 0xff;
  }
  return bytes;
}

/** What one demade backdrop contributed. */
interface Backdrop {
  tiles: Uint8Array;
  map: Uint8Array;
  /** CGB attribute per cell — palette and flip bits. Empty on a mono build. */
  attr: Uint8Array;
  /** The DMG background palette register the fit chose. */
  bgp: number;
  /** CGB sub-palettes the fit chose, as BCPD bytes. Empty on a mono build. */
  palettes: Uint8Array;
}

/**
 * Demake one scene's backdrop through the *image* pipeline.
 *
 * Not the sprite path, and the difference is the whole reason a backdrop is
 * worth having: a sprite is a small object with transparency and a contiguous
 * run of tiles, while a picture is a screenful of *deduplicated* tiles plus a
 * map that says where each one goes. That is exactly what `prep` and the `gb`
 * image backend already produce for a photograph, so a title screen is demade
 * by the same code, at the same size, with the same fitter — and on a colour
 * build the same call also produces the per-cell attributes and the palettes,
 * because that is what the backend emits for the `gbc` spec.
 */
function convertBackdrop(bytes: Uint8Array, consoleId: string): Backdrop {
  return remember(backdropCache, `${consoleId}:${digest(bytes)}`, () =>
    demakeBackdrop(bytes, consoleId),
  );
}

function demakeBackdrop(bytes: Uint8Array, consoleId: string): Backdrop {
  const spec = getConsole(consoleId);
  const color = spec.color.model === "rgb";
  // Exactly the window the renderer paints, in pixels. Letting `prep` choose
  // would fit the *source's* size, and a title screen has to be a screenful:
  // the map it produces and the loop that draws it are the same rectangle.
  const fitted = prepSync(bytes, {
    console: consoleId,
    size: { w: GB_MEMORY.viewW * 8, h: GB_MEMORY.viewH * 8 },
    fit: "cover",
    // One palette is the font's, so a picture gets the rest. Reserving it here
    // rather than taking it back afterwards is what keeps the fit honest: the
    // tournament optimises against the budget it will actually be shown with.
    ...(color ? { maxSubPalettes: ART_PALETTES } : {}),
  });
  const palette = fitted.image.palettes[0];
  const backend = backendFor("gb");
  if (!backend) throw new Error("the gb image backend is missing");
  // Indices local to this picture, remapped by the caller once it knows which
  // of them are already in the bank.
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
    attr: find(".attr.bin"),
    // The fitted ramp decides the background palette register; a mono fit that
    // came out in shade order leaves it as the identity the font expects.
    bgp: bgpFor(palette ? palette.colors : []),
    palettes: color
      ? packPalettes(
          fitted.image.palettes.map((palette) => palette.colors),
          ART_PALETTES,
        )
      : new Uint8Array(0),
  };
}

/**
 * A tile bank that will not store the same eight-by-eight twice.
 *
 * The image backend already deduplicates *within* one picture, which is what
 * makes a screenful of sky cost one tile. Across pictures it cannot: each
 * conversion is its own call and knows nothing of the bank it is joining. So a
 * title screen and a play background that share a brick, and two title screens
 * that share black, each paid twice — and a Game Boy has 256 tiles for
 * everything, backgrounds and objects together.
 *
 * Only backdrops can be pooled this way. A sprite's tiles have to stay in one
 * contiguous run because OAM addresses them by offset from the first, but a
 * backdrop is reached only through its map, so any index will do — including one
 * that lands in the built-in font or in another game object's art. On a colour
 * build it is *more* effective, not less: two cells with the same shape under
 * different palettes are one tile and two attribute bytes.
 */
class TilePool {
  private readonly byBytes = new Map<string, number>();
  private readonly added: Uint8Array[] = [];

  /** `existing` is everything already in the bank, in bank order. */
  constructor(
    existing: Uint8Array,
    private readonly base: number,
  ) {
    for (let at = 0; at + TILE_BYTES <= existing.length; at += TILE_BYTES) {
      const key = TilePool.key(existing.subarray(at, at + TILE_BYTES));
      if (!this.byBytes.has(key)) this.byBytes.set(key, at / TILE_BYTES);
    }
  }

  private static key(tile: Uint8Array): string {
    return String.fromCharCode(...tile);
  }

  /** Bank index for one tile, appending it only if it is new. */
  intern(tile: Uint8Array): number {
    const key = TilePool.key(tile);
    const found = this.byBytes.get(key);
    if (found !== undefined) return found;
    const index = this.base + this.added.length;
    this.byBytes.set(key, index);
    this.added.push(tile);
    return index;
  }

  /** Tiles this pool appended, in bank order. */
  tail(): Uint8Array {
    const out = new Uint8Array(this.added.length * TILE_BYTES);
    this.added.forEach((tile, index) => out.set(tile, index * TILE_BYTES));
    return out;
  }
}

/** BGP packs a shade per 2bpp index, two bits each, index 0 lowest. */
function bgpFor(colors: readonly { codes: readonly number[] }[]): number {
  let register = 0;
  let last = 0;
  for (let index = 0; index < 4; index += 1) {
    const shade = colors[index]?.codes[0] ?? last;
    last = shade;
    register |= (shade & 3) << (2 * index);
  }
  return register & 0xff;
}

/**
 * The attribute byte a background cell needs: its palette, its flips, its bank.
 *
 * The palette and the flips are the picture's own — the image backend chose
 * them — but the VRAM bank is not, because pooling moved the tile. Recomputing
 * it from the pooled index rather than trusting the one the backend emitted is
 * the difference between a cell drawing its own art and drawing whatever sits at
 * the same index in the other bank.
 */
function cellAttribute(source: number, tile: number): number {
  return (source & 0x67) | (tile > 0xff ? 0x08 : 0);
}

/**
 * Convert a program's art and return the emitter options that bind it.
 *
 * Objects and background tiles go through the image pipeline separately, for
 * the reason doc 15 gives: an object's index 0 is transparency, so it has three
 * colours and a choice of *which* three, while a background tile has four and
 * no choice at all. Running them together would cost the objects a colour — and
 * on a colour build they do not even share palette hardware, since the CGB has
 * eight background palettes and eight object ones.
 */
export function bindArt(program: Program, assets: AssetBytes): BoundArt {
  // The image engine's path is chosen by the console the *build* targets: a
  // `gb` cartridge is DMG art whichever Game Boy plays it, and a `gbc` one is
  // fitted to the colour hardware it will really run on.
  const color = program.profile.id === "gbc";
  const consoleId = color ? "gbc" : "dmg";

  const requests = artRequests(program);
  const missing: string[] = [];
  const sources: Record<"sprite" | "tile", SpriteSource[]> = { sprite: [], tile: [] };
  for (const request of requests) {
    const bytes = assets.get(request.name);
    if (!bytes) {
      // One line per *file*, not per box: a missing asset is a missing file,
      // and naming it twice would just read as two problems.
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
  // enough: a build with no assets at all has to come out exactly as it did
  // before art existed — built-in tiles, blank background — rather than an empty
  // bank that merely looks like one.
  const backdropScenes = program.scenes.filter(
    (scene) => scene.backdrop !== undefined && assets.has(scene.backdrop),
  );
  for (const scene of program.scenes) {
    const file = scene.backdrop;
    if (file !== undefined && !assets.has(file) && !missing.includes(file)) missing.push(file);
  }
  if (sources.sprite.length === 0 && sources.tile.length === 0 && backdropScenes.length === 0) {
    // Nothing was demade, but a colour build still needs the ramp its font and
    // its placeholder blocks are drawn with — otherwise every palette is black.
    return color ? { ...systemPalettes(), missing, tiles8: 0 } : { missing, tiles8: 0 };
  }

  const demakeBank = (kind: "sprite" | "tile"): SpriteBank | null => {
    const list = sources[kind];
    if (list.length === 0) return null;
    const key = list
      .map(
        (source) =>
          `${source.name}@${source.cellsWide}x${source.cellsHigh}:${digest(source.bytes)}`,
      )
      .join("|");
    return remember(bankCache, `${consoleId}:${kind}:${key}`, () =>
      buildSpriteBank(list, {
        console: consoleId,
        maxPalettes: ART_PALETTES,
        ...(kind === "tile" ? { opaque: true } : {}),
      }),
    );
  };
  const objects = demakeBank("sprite");
  const backgrounds = demakeBank("tile");

  // The bank is the built-in tiles, then the objects, then the level tiles;
  // both halves are addressed from the same base, so their offsets differ only
  // by where they sit in it.
  const objectBase = BUILTIN_TILES;
  const backgroundBase = objectBase + (objects?.uniqueTiles ?? 0);
  const extraTiles = new Uint8Array(
    (objects?.tiles.length ?? 0) + (backgrounds?.tiles.length ?? 0),
  );
  if (objects) extraTiles.set(objects.tiles, 0);
  if (backgrounds) extraTiles.set(backgrounds.tiles, objects?.tiles.length ?? 0);

  const sprites = new Map<
    string,
    { tile: number; width: number; height: number; palette: number }
  >();
  for (const [name, art] of objects?.art ?? []) {
    sprites.set(name, {
      tile: objectBase + art.tile,
      width: art.width,
      height: art.height,
      palette: art.palette,
    });
  }
  const tiles = new Map<string, { tile: number; palette: number }>();
  for (const [name, art] of backgrounds?.art ?? []) {
    tiles.set(name, { tile: backgroundBase + art.tile, palette: art.palette });
  }

  // Backdrops come last in the bank, and go in through a pool: a cell already
  // drawn by the built-in font, by an object's art or by an earlier picture is
  // pointed at rather than stored again. Two screenfuls of the same night sky
  // then cost one tile between them instead of two.
  const backdrops = new Map<
    string,
    { map: Uint8Array; bgp: number; attr?: Uint8Array; palettes?: Uint8Array }
  >();
  const known = new Uint8Array(builtinTiles().length + extraTiles.length);
  known.set(builtinTiles(), 0);
  known.set(extraTiles, builtinTiles().length);
  const pool = new TilePool(known, BUILTIN_TILES + extraTiles.length / TILE_BYTES);
  for (const scene of backdropScenes) {
    const art = convertBackdrop(assets.get(scene.backdrop as string) as Uint8Array, consoleId);
    const map = new Uint8Array(art.map.length);
    const attr = new Uint8Array(color ? art.map.length : 0);
    for (let cell = 0; cell < art.map.length; cell += 1) {
      const local = (art.map[cell] as number) * TILE_BYTES;
      const tile = pool.intern(art.tiles.subarray(local, local + TILE_BYTES));
      map[cell] = tile & 0xff;
      if (color) attr[cell] = cellAttribute(art.attr[cell] ?? 0, tile);
    }
    backdrops.set(
      scene.name,
      color ? { map, bgp: art.bgp, attr, palettes: art.palettes } : { map, bgp: art.bgp },
    );
  }

  const tail = pool.tail();
  const bank = new Uint8Array(extraTiles.length + tail.length);
  bank.set(extraTiles, 0);
  bank.set(tail, extraTiles.length);

  const bound: BoundArt = {
    sprites,
    tiles,
    extraTiles: bank,
    missing,
    tiles8: bank.length / TILE_BYTES,
  };
  if (backdrops.size > 0) bound.backdrops = backdrops;
  if (color) {
    Object.assign(bound, systemPalettes());
    // Objects take palettes 0–6 of the object hardware; the font's HUD sprites
    // take the seventh, which is why the fit was capped rather than trimmed.
    const objectBlock = new Uint8Array(8 * PALETTE_BYTES);
    objectBlock.set(packPalettes(objects?.palettes ?? [], ART_PALETTES), 0);
    objectBlock.set(systemPalette(true), SYSTEM_PALETTE * PALETTE_BYTES);
    bound.objectPalettes = objectBlock;
    if (backgrounds) bound.tilePalettes = packPalettes(backgrounds.palettes, ART_PALETTES);
  } else if (objects) {
    bound.objectPalette = paletteRegister(objects.shades);
  }
  return bound;
}

/** The reserved background palette, for a build that has colour hardware. */
function systemPalettes(): Pick<EmitOptions, "systemPalette" | "objectPalettes"> {
  const objectBlock = new Uint8Array(8 * PALETTE_BYTES);
  objectBlock.set(systemPalette(true), SYSTEM_PALETTE * PALETTE_BYTES);
  return { systemPalette: systemPalette(false), objectPalettes: objectBlock };
}
