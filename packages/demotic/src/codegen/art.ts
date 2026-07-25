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

import { buildSpriteBank, paletteRegister, type SpriteSource } from "@demake/core";

import type { InstanceDef, Program } from "../program.js";
import { BUILTIN_TILES } from "../rom/graphics.js";

import { artKey, type EmitOptions } from "./emit.js";

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
  if (sources.sprite.length === 0 && sources.tile.length === 0) {
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

  const bound: BoundArt = {
    sprites,
    tiles,
    extraTiles,
    missing,
    tiles8: (objects?.uniqueTiles ?? 0) + (backgrounds?.uniqueTiles ?? 0),
  };
  if (objects) bound.objectPalette = paletteRegister(objects.shades);
  return bound;
}
