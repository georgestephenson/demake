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
  type SpriteSource,
} from "@demake/core";

import type { InstanceDef, Program } from "../program.js";
import { BUILTIN_TILES, builtinTiles, TILE_BYTES } from "../rom/graphics.js";

import { artKey, type EmitOptions } from "./emit.js";
import { VIEW_H, VIEW_W } from "./layout.js";

/** Asset bytes by the name a `.dmt` or a `.dmtl` legend wrote. */
export type AssetBytes = ReadonlyMap<string, Uint8Array>;

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
 * Demake one scene's backdrop through the *image* pipeline.
 *
 * Not the sprite path, and the difference is the whole reason a backdrop is
 * worth having: a sprite is a small object with transparency and a contiguous
 * run of tiles, while a picture is a screenful of *deduplicated* tiles plus a
 * map that says where each one goes. That is exactly what `prep` and the `gb`
 * image backend already produce for a photograph, so a title screen is demade
 * by the same code, at the same size, with the same fitter.
 */
function convertBackdrop(bytes: Uint8Array): {
  tiles: Uint8Array;
  map: Uint8Array;
  bgp: number;
} {
  const consoleId = "dmg";
  const spec = getConsole(consoleId);
  // Exactly the window the renderer paints, in pixels. Letting `prep` choose
  // would fit the *source's* size, and a title screen has to be a screenful:
  // the map it produces and the loop that draws it are the same rectangle.
  const fitted = prepSync(bytes, {
    console: consoleId,
    size: { w: VIEW_W * 8, h: VIEW_H * 8 },
    fit: "cover",
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
    // The fitted ramp decides the background palette register; a mono fit that
    // came out in shade order leaves it as the identity the font expects.
    bgp: bgpFor(palette ? palette.colors : []),
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
 * that lands in the built-in font or in another game object's art.
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
 * Convert a program's art and return the emitter options that bind it.
 *
 * Objects and background tiles go through the image pipeline separately, for
 * the reason doc 15 gives: an object's index 0 is transparency, so it has three
 * colours and a choice of *which* three, while a background tile has four and
 * no choice at all. Running them together would cost the objects a colour.
 */
export function bindArt(program: Program, assets: AssetBytes): BoundArt {
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
    return { missing, tiles8: 0 };
  }

  // The image engine's mono path is the DMG's, whichever Game Boy is targeted:
  // this backend emits a DMG-compatible cartridge, so its art is DMG art.
  const consoleId = "dmg";
  const objects =
    sources.sprite.length > 0 ? buildSpriteBank(sources.sprite, { console: consoleId }) : null;
  const backgrounds =
    sources.tile.length > 0
      ? buildSpriteBank(sources.tile, { console: consoleId, opaque: true })
      : null;

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

  const sprites = new Map<string, { tile: number; width: number; height: number }>();
  for (const [name, art] of objects?.art ?? []) {
    sprites.set(name, { tile: objectBase + art.tile, width: art.width, height: art.height });
  }
  const tiles = new Map<string, number>();
  for (const [name, art] of backgrounds?.art ?? []) {
    tiles.set(name, backgroundBase + art.tile);
  }

  // Backdrops come last in the bank, and go in through a pool: a cell already
  // drawn by the built-in font, by an object's art or by an earlier picture is
  // pointed at rather than stored again. Two screenfuls of the same night sky
  // then cost one tile between them instead of two.
  const backdrops = new Map<string, { map: Uint8Array; bgp: number }>();
  const known = new Uint8Array(builtinTiles().length + extraTiles.length);
  known.set(builtinTiles(), 0);
  known.set(extraTiles, builtinTiles().length);
  const pool = new TilePool(known, BUILTIN_TILES + extraTiles.length / TILE_BYTES);
  for (const scene of backdropScenes) {
    const art = convertBackdrop(assets.get(scene.backdrop as string) as Uint8Array);
    const map = new Uint8Array(art.map.length);
    for (let cell = 0; cell < art.map.length; cell += 1) {
      const local = (art.map[cell] as number) * TILE_BYTES;
      map[cell] = pool.intern(art.tiles.subarray(local, local + TILE_BYTES));
    }
    backdrops.set(scene.name, { map, bgp: art.bgp });
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
  if (objects) bound.objectPalette = paletteRegister(objects.shades);
  return bound;
}
