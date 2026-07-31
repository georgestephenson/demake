/**
 * Drawing a project's art on a canvas — one definition, two callers.
 *
 * The game section's preview draws a scene's tiles; the level editor draws the
 * grid you are painting (doc 19 §The level editor). Those have to look the same,
 * and the way to make that true rather than aspirational is for there to be one
 * function that decides it: a tile with art draws its art, a tile without draws a
 * flat block whose shade says whether it is solid, and nothing else is a tile.
 *
 * This is the *preview's* renderer, not the cartridge's. It uses the browser's
 * own image decoding at whatever size the page has, because it only has to look
 * right; the cartridge gets the same file through `@demake/core`'s fitter and
 * comes out demade (doc 07 §parity). What must never differ is the bytes, and the
 * bytes come from core on both sides.
 */

import type { TileSpec } from "@demake/demotic";

import { fileUrl, type Project } from "./project.js";

/** An `<img>` for one of the project's files, and whether it can be drawn yet. */
export interface Loaded {
  image: HTMLImageElement;
  ready: boolean;
}

/**
 * Start loading one asset into a cache, if it is not there already.
 *
 * `onReady` is for a caller that paints on demand rather than every frame: the
 * level editor draws once per edit, so an image arriving afterwards has to say
 * so or the cell it belongs in stays a flat block until the next keystroke.
 */
export function loadAsset(
  cache: Map<string, Loaded>,
  project: Project,
  name: string,
  onReady?: () => void,
): void {
  if (cache.has(name)) return;
  const url = fileUrl(project, name);
  if (!url) return;
  const image = new Image();
  const entry: Loaded = { image, ready: false };
  image.addEventListener("load", () => {
    entry.ready = true;
    onReady?.();
  });
  image.src = url;
  cache.set(name, entry);
}

/**
 * Draw one cell of a level.
 *
 * A tile with no art draws as a flat block. That is deliberate: a legend entry
 * exists to give a *name* to rules, and a game may well want a named tile that is
 * never seen.
 */
export function drawTileCell(
  target: CanvasRenderingContext2D,
  tile: TileSpec,
  assets: Map<string, Loaded>,
  x: number,
  y: number,
  unit: number,
): void {
  const art = tile.art ? assets.get(tile.art) : undefined;
  if (art?.ready) {
    target.drawImage(art.image, x, y, unit, unit);
  } else {
    target.fillStyle = tile.solid ? "#3a4459" : "#232b3b";
    target.fillRect(x, y, unit, unit);
  }
}
