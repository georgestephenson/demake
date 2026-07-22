/**
 * Tile extraction + flip-aware deduplication (doc 06 §Tile handling).
 *
 * A {@link CompliantImage} stores per-pixel palette indices; hardware wants a
 * *tileset* (unique 8×8 index grids) plus a *map* that references them. Where the
 * console's map supports H/V flip (`spec.layout.flip`), a tile that is the mirror
 * of one already emitted is not stored twice — the map entry records the flip
 * instead. `gen-portraits.py` skipped this; we do it, faithfully (doc 06).
 *
 * Palette selection is per *attribute cell*, which need not equal the tile grid
 * (NES cells are 16×16). Each tile records the sub-palette of the cell it lives
 * in, so tile *pixel data* stays palette-independent and identical index grids
 * under different palettes share one tile — exactly how the hardware attribute
 * plane works.
 */

import type { TileLayout } from "../consoles/types.js";
import type { CompliantImage } from "../pipeline/types.js";

/** One map entry: which tile, and the flip needed to reproduce the original. */
export interface TileRef {
  tile: number;
  xflip: boolean;
  yflip: boolean;
}

/** Deduplicated tileset + map + per-tile palette (doc 06 §Tile handling). */
export interface TiledData {
  tileW: number;
  tileH: number;
  bpp: number;
  tilesX: number;
  tilesY: number;
  /** Unique tiles; each is a `tileW*tileH` row-major index grid. */
  tiles: Uint8Array[];
  /** One entry per tile position, row-major. */
  map: TileRef[];
  /** Sub-palette index per tile position, row-major. */
  cellPalette: number[];
}

/** Apply a horizontal/vertical flip to a `w*h` index grid. */
function applyFlip(grid: Uint8Array, w: number, h: number, xf: boolean, yf: boolean): Uint8Array {
  if (!xf && !yf) return grid;
  const out = new Uint8Array(grid.length);
  for (let y = 0; y < h; y += 1) {
    const sy = yf ? h - 1 - y : y;
    for (let x = 0; x < w; x += 1) {
      const sx = xf ? w - 1 - x : x;
      out[y * w + x] = grid[sy * w + sx]!;
    }
  }
  return out;
}

/** A stable string key for an index grid. */
function keyOf(grid: Uint8Array): string {
  let s = "";
  for (let i = 0; i < grid.length; i += 1) s += String.fromCharCode(grid[i]! + 48);
  return s;
}

/**
 * The four flip orientations, tried in a fixed order so dedup is deterministic:
 * identity first, then H, then V, then H+V.
 */
const ORIENTATIONS: readonly [boolean, boolean][] = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];

/** Extract the deduplicated tileset + map from a compliant image. */
export function extractTiles(img: CompliantImage, layout: TileLayout): TiledData {
  const tw = layout.tileW;
  const th = layout.tileH;
  const tilesX = Math.floor(img.width / tw);
  const tilesY = Math.floor(img.height / th);
  const flip = layout.flip === true;

  const tiles: Uint8Array[] = [];
  const map: TileRef[] = [];
  const cellPalette: number[] = [];
  // Canonical grid key → stored tile index. Only the identity orientation of a
  // stored tile is registered; any later mirror un-flips to it via the loop.
  const seen = new Map<string, number>();

  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      const grid = new Uint8Array(tw * th);
      for (let y = 0; y < th; y += 1) {
        for (let x = 0; x < tw; x += 1) {
          const px = tx * tw + x;
          const py = ty * th + y;
          grid[y * tw + x] = img.pixelIndex[py * img.width + px]!;
        }
      }

      let ref: TileRef | null = null;
      for (const [xf, yf] of flip ? ORIENTATIONS : ORIENTATIONS.slice(0, 1)) {
        const idx = seen.get(keyOf(applyFlip(grid, tw, th, xf, yf)));
        if (idx !== undefined) {
          ref = { tile: idx, xflip: xf, yflip: yf };
          break;
        }
      }
      if (!ref) {
        const idx = tiles.length;
        tiles.push(grid);
        seen.set(keyOf(grid), idx);
        ref = { tile: idx, xflip: false, yflip: false };
      }
      map.push(ref);

      // Palette of the attribute cell this tile falls in.
      const cx = Math.floor((tx * tw) / img.grid.attributeW);
      const cy = Math.floor((ty * th) / img.grid.attributeH);
      cellPalette.push(img.cellPalette[cy * img.grid.cellsX + cx]!);
    }
  }

  return { tileW: tw, tileH: th, bpp: layout.bpp, tilesX, tilesY, tiles, map, cellPalette };
}

/**
 * Pack one `tileW*tileH` index grid into planar bitplanes, MSB-first per row —
 * the layout shared by the GB (2bpp), NES CHR, and other planar consoles. For
 * `bpp` planes, byte `row*bpp + plane` holds bit `plane` of each of the 8 pixels
 * in that row (bit 7 = leftmost pixel).
 */
export function packPlanar(
  grid: Uint8Array,
  tileW: number,
  tileH: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(tileH * bpp);
  for (let y = 0; y < tileH; y += 1) {
    for (let plane = 0; plane < bpp; plane += 1) {
      let byte = 0;
      for (let x = 0; x < tileW; x += 1) {
        const bit = (grid[y * tileW + x]! >> plane) & 1;
        byte |= bit << (tileW - 1 - x);
      }
      out[y * bpp + plane] = byte;
    }
  }
  return out;
}
