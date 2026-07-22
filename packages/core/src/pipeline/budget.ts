/**
 * Stage 6 — tile-budget enforcement (doc 04 §Stage 6).
 *
 * Counts unique 8×8 tile patterns (flip-aware where the hardware supports H/V
 * flip) and, if over the console's VRAM budget, iteratively merges the closest
 * tile pair — perceptual distance on decoded tiles — repointing one onto the
 * other until within budget. Under `strict` the overflow is an error instead.
 * At full-screen resolution the Phase-1 consoles stay well under budget, so the
 * merge loop is normally a no-op; it exists for smaller budgets and crops.
 */

import { DemakeError } from "../errors.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import type { CompliantImage } from "./types.js";

/** Result of the budget stage. */
export interface BudgetResult {
  image: CompliantImage;
  uniqueTiles: number;
  budget: number | null;
  merges: number;
}

const TILE = 8;

/** Canonical flip-aware key for one 8×8 tile of pixel indices. */
function tileKey(image: CompliantImage, tx: number, ty: number, flip: boolean): string {
  const w = image.width;
  const base: number[] = [];
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      base.push(image.pixelIndex[(ty * TILE + y) * w + (tx * TILE + x)]!);
    }
  }
  if (!flip) return base.join(",");
  const variants = [base, flipH(base), flipV(base), flipV(flipH(base))];
  let min = variants[0]!.join(",");
  for (let i = 1; i < variants.length; i += 1) {
    const s = variants[i]!.join(",");
    if (s < min) min = s;
  }
  return min;
}

function flipH(tile: number[]): number[] {
  const out = new Array(64);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      out[y * TILE + x] = tile[y * TILE + (TILE - 1 - x)];
    }
  }
  return out;
}

function flipV(tile: number[]): number[] {
  const out = new Array(64);
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      out[y * TILE + x] = tile[(TILE - 1 - y) * TILE + x];
    }
  }
  return out;
}

/** Count unique tiles in the image (flip-aware per the layout). */
export function countUniqueTiles(image: CompliantImage, flip: boolean): number {
  const txCount = Math.floor(image.width / TILE);
  const tyCount = Math.floor(image.height / TILE);
  const keys = new Set<string>();
  for (let ty = 0; ty < tyCount; ty += 1) {
    for (let tx = 0; tx < txCount; tx += 1) {
      keys.add(tileKey(image, tx, ty, flip));
    }
  }
  return keys.size;
}

/** Displayed sRGB of a pixel (via its cell's palette). */
function displayAt(
  image: CompliantImage,
  x: number,
  y: number,
): { r: number; g: number; b: number } {
  const cell =
    Math.floor(y / image.grid.attributeH) * image.grid.cellsX +
    Math.floor(x / image.grid.attributeW);
  const palette = image.palettes[image.cellPalette[cell]!]!;
  const idx = image.pixelIndex[y * image.width + x]!;
  return palette.colors[idx]?.display ?? { r: 0, g: 0, b: 0 };
}

/** Perceptual distance between two tiles (sum of squared sRGB display diffs). */
function tileDistance(
  image: CompliantImage,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  let sum = 0;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const a = displayAt(image, ax * TILE + x, ay * TILE + y);
      const b = displayAt(image, bx * TILE + x, by * TILE + y);
      sum += (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
    }
  }
  return sum;
}

/** Enforce the tile budget, merging closest tiles if necessary. */
export function enforceBudget(
  image: CompliantImage,
  spec: ConsoleSpec,
  strict: boolean,
): BudgetResult {
  const layout = spec.layout as TileLayout;
  const budget = layout.tileBudget ?? null;
  const flip = layout.flip === true;
  let unique = countUniqueTiles(image, flip);
  if (budget === null || unique <= budget) {
    return { image, uniqueTiles: unique, budget, merges: 0 };
  }
  if (strict) {
    throw new DemakeError(
      "E_TILE_BUDGET_EXCEEDED",
      `image needs ${unique} unique tiles but ${spec.id} allows ${budget}`,
      { hint: "reduce --size, allow merging (drop --strict), or pick a console with more VRAM." },
    );
  }

  const txCount = Math.floor(image.width / TILE);
  const tyCount = Math.floor(image.height / TILE);
  const before = unique;

  // Keep the `budget` most-used tile patterns (frequency desc, first-occurrence
  // tiebreak) and remap every position whose pattern is not kept onto its nearest
  // kept representative. One pass → guaranteed within budget, deterministic, and
  // O(positions × budget) rather than the O(n³) of iterated nearest-pair merging.
  interface Group {
    rep: [number, number];
    key: string;
    count: number;
    order: number;
  }
  const groups = new Map<string, Group>();
  let order = 0;
  for (let ty = 0; ty < tyCount; ty += 1) {
    for (let tx = 0; tx < txCount; tx += 1) {
      const key = tileKey(image, tx, ty, flip);
      const g = groups.get(key);
      if (g) g.count += 1;
      else groups.set(key, { rep: [tx, ty], key, count: 1, order: (order += 1) });
    }
  }
  const kept = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, budget);
  const keptKeys = new Set(kept.map((g) => g.key));

  for (let ty = 0; ty < tyCount; ty += 1) {
    for (let tx = 0; tx < txCount; tx += 1) {
      if (keptKeys.has(tileKey(image, tx, ty, flip))) continue;
      let bestDist = Infinity;
      let bestRep: [number, number] = kept[0]!.rep;
      for (const g of kept) {
        const d = tileDistance(image, g.rep[0], g.rep[1], tx, ty);
        if (d < bestDist) {
          bestDist = d;
          bestRep = g.rep;
        }
      }
      copyTilePattern(image, bestRep[0], bestRep[1], tx, ty);
    }
  }

  unique = countUniqueTiles(image, flip);
  return { image, uniqueTiles: unique, budget, merges: before - unique };
}

/** Copy tile (sx,sy)'s index pattern over every tile position matching (dx,dy). */
function copyTilePattern(
  image: CompliantImage,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
): void {
  const w = image.width;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const src = image.pixelIndex[(sy * TILE + y) * w + (sx * TILE + x)]!;
      image.pixelIndex[(dy * TILE + y) * w + (dx * TILE + x)] = src;
    }
  }
}
