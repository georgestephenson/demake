/**
 * Scene geometry, the camera, and tile collision.
 *
 * Three rules decide how a scene behaves, and they follow from one another:
 *
 *   1. **A scene's bounds are its level's, or the screen's if it has none.**
 *      That is what keeps every existing game working unchanged — with no level,
 *      the playfield is exactly the screen it always was.
 *   2. **`screenleft` and friends mean the bounds, not the viewport.** A player
 *      running right in a scrolling level must stop at the end of the *level*,
 *      not at an invisible wall a screen-width in. The names keep their reading
 *      ("the edge of the playfield"); what the playfield is has grown.
 *   3. **Object positions are level coordinates.** The camera decides what is on
 *      screen, so no rule ever has to know where the view is — which is the only
 *      reason scrolling does not infect every rule in the game.
 *
 * Tiles behave like objects, deliberately: a rule fires for any *named* tile,
 * and separation happens only for `solid` ones. That is the same split
 * `visible` makes for objects — take part in the rule, or also push back — so
 * there is one model to learn rather than two.
 */

import { type Fixed, floorToInt, fromInt } from "../fixed.js";
import type { ConsoleProfile } from "../profiles.js";

import { type LevelFile, tileAt } from "./parse.js";

/** A scene's playfield, in cells. */
export interface Bounds {
  width: number;
  height: number;
}

/** Where the viewport sits within the bounds, in cells. */
export interface Camera {
  x: Fixed;
  y: Fixed;
}

/** The bounds of a scene: its level's size, or the screen's when it has none. */
export function boundsOf(level: LevelFile | undefined, profile: ConsoleProfile): Bounds {
  if (!level) return { width: profile.screenWidth, height: profile.screenHeight };
  return { width: level.width, height: level.height };
}

/**
 * Centre the viewport on a point, then hold it inside the bounds.
 *
 * The clamp is what stops the view running off the end of the level and showing
 * nothing; it also means a level no bigger than the screen never scrolls at all,
 * which is why a non-scrolling game needs no special case.
 */
export function follow(
  targetCenterX: Fixed,
  targetCenterY: Fixed,
  bounds: Bounds,
  profile: ConsoleProfile,
): Camera {
  const halfWidth = fromInt(profile.screenWidth) / 2;
  const halfHeight = fromInt(profile.screenHeight) / 2;
  const maxX = fromInt(Math.max(0, bounds.width - profile.screenWidth));
  const maxY = fromInt(Math.max(0, bounds.height - profile.screenHeight));
  return {
    x: clampTo(targetCenterX - halfWidth, maxX),
    y: clampTo(targetCenterY - halfHeight, maxY),
  };
}

function clampTo(value: Fixed, max: Fixed): Fixed {
  if (value < 0) return 0;
  return value > max ? max : value;
}

/** One cell an object overlaps, and the tile in it. */
export interface TileHit {
  column: number;
  row: number;
  name: string;
  solid: boolean;
}

/**
 * Every named tile an object's box overlaps.
 *
 * The box is half-open — an object whose right edge lands exactly on a cell
 * boundary is not in that cell — which matches how object-versus-object overlap
 * already works, so an object resting against a wall is touching it and not
 * inside it.
 */
export function tilesUnder(
  level: LevelFile,
  x: Fixed,
  y: Fixed,
  width: Fixed,
  height: Fixed,
): TileHit[] {
  const hits: TileHit[] = [];
  const firstColumn = floorToInt(x);
  const lastColumn = ceilOpen(x + width);
  const firstRow = floorToInt(y);
  const lastRow = ceilOpen(y + height);

  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const tile = tileAt(level, column, row);
      if (tile) hits.push({ column, row, name: tile.name, solid: tile.solid });
    }
  }
  return hits;
}

/** The last cell a half-open span touches. */
function ceilOpen(edge: Fixed): number {
  const cell = floorToInt(edge);
  // An edge exactly on a boundary belongs to the cell before it.
  return edge === fromInt(cell) ? cell - 1 : cell;
}

/**
 * Push an object out of a solid cell along its shallower axis.
 *
 * Same rule as object separation, and for the same reason: resolving the deeper
 * axis would teleport a walking object over a wall it merely brushed.
 */
export function separateFromTile(
  hit: TileHit,
  x: Fixed,
  y: Fixed,
  width: Fixed,
  height: Fixed,
): { x: Fixed; y: Fixed } {
  const left = x + width - fromInt(hit.column);
  const right = fromInt(hit.column + 1) - x;
  const top = y + height - fromInt(hit.row);
  const bottom = fromInt(hit.row + 1) - y;

  const pushX = left < right ? -left : right;
  const pushY = top < bottom ? -top : bottom;

  return Math.abs(pushX) < Math.abs(pushY) ? { x: x + pushX, y } : { x, y: y + pushY };
}
