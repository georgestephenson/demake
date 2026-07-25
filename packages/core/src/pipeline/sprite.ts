/**
 * The sprite path (doc 15 §The conversion path, steps 3–4).
 *
 * A sprite is not a small background. Index 0 is *transparency*, not a colour,
 * so a Game Boy object has three shades where a tile has four — and which three
 * is decided by what an object is drawn *over*, not by what its source happens
 * to look like. Colour 0 shows the background through, and this runtime's
 * background is the lightest shade, so an object painted in that shade is an
 * object nobody can see. The three darkest shades are therefore the object
 * palette, and the art is stretched across them by auto-contrast rather than
 * matched to them by absolute lightness. That is doc 04 §The objective restated
 * at eight pixels across: under this much palette pressure, keeping a shape
 * legible beats minimising its error.
 *
 * The rest is the existing pipeline's shape, restated with alpha carried
 * through. Downscaling averages in linear light over *premultiplied* alpha,
 * because averaging colour across a transparent pixel is how a sprite grows a
 * dark halo — the classic edge artifact, and one that shows up brutally at
 * 8 pixels wide.
 *
 * Deduplication is across the whole build rather than per asset (step 4): two
 * assets that share a blank corner share the tile, which on a machine with 256
 * object tiles is not a micro-optimisation.
 */

import { linearToOklab } from "../color/oklab.js";
import { srgbToLinear } from "../color/srgb.js";
import { DemakeError } from "../errors.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";
import { getConsole } from "../consoles/registry.js";
import type { TileLayout } from "../consoles/types.js";

/** Bytes per 8×8 2bpp tile — the only sprite format this path emits today. */
const TILE_BYTES = 16;

/** One converted asset: where its tiles start, and how big it is in cells. */
export interface SpriteArt {
  /** Index of the asset's first tile within the returned bank. */
  tile: number;
  /** Size in whole cells. Tiles are row-major within that box. */
  width: number;
  height: number;
}

/** An asset to convert: its name, its bytes, and the box it must fill. */
export interface SpriteSource {
  /** The name a `.dmt` or a `.dmtl` legend wrote. */
  name: string;
  bytes: Uint8Array;
  /** Footprint in whole cells. */
  cellsWide: number;
  cellsHigh: number;
}

/** What {@link buildSpriteBank} produced. */
export interface SpriteBank {
  /** Packed tile bytes, ready to append to a tile bank. */
  tiles: Uint8Array;
  /** Per-asset placement, keyed by the name that was passed in. */
  art: Map<string, SpriteArt>;
  /**
   * Hardware shade per usable colour index, in index order.
   *
   * For objects that is indices 1–3, index 0 being transparent, and it becomes
   * the object palette register `demake build` writes to OBP0.
   */
  shades: number[];
  /** Distinct tiles the bank holds, after deduplication. */
  uniqueTiles: number;
  /** Tiles the assets would have needed without it. */
  totalTiles: number;
}

/** Options for the sprite path. */
export interface SpriteOptions {
  /** Console id; decides the shade count and the tile format. */
  console: string;
  /** Alpha at or above which a pixel is opaque. Below it, it is index 0. */
  alphaCutoff?: number;
  /**
   * Convert as background tiles rather than objects.
   *
   * Background tiles have no transparency, so every shade is available and
   * index 0 is the lightest one rather than "not drawn". The mapping is the
   * identity — the background palette register is shared with the built-in
   * font and level patterns, and a build that re-chose it would change how
   * those look to suit a tile the player barely notices.
   */
  opaque?: boolean;
}

/** A downscaled sprite in linear light, with straight alpha kept separate. */
interface Sampled {
  width: number;
  height: number;
  /** Linear r,g,b per pixel. Meaningless where alpha is zero. */
  color: Float32Array;
  /** Coverage 0–1 per pixel. */
  alpha: Float32Array;
}

/**
 * Box-downsample an RGBA raster to an exact target size, in linear light.
 *
 * Area averaging rather than a windowed kernel: sprites go from a few dozen
 * pixels to eight, a ratio at which lanczos rings visibly and a box filter is
 * simply what the eye expects. Upscaling repeats the nearest sample, because
 * inventing detail for art that has none is worse than showing it as it is.
 */
function sample(image: RgbaImage, width: number, height: number): Sampled {
  const color = new Float32Array(width * height * 3);
  const alpha = new Float32Array(width * height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * image.width + sx) * 4;
          const pixelAlpha = (image.data[at + 3] as number) / 255;
          // Premultiplied: a transparent pixel contributes no colour at all.
          r += srgbToLinear((image.data[at] as number) / 255) * pixelAlpha;
          g += srgbToLinear((image.data[at + 1] as number) / 255) * pixelAlpha;
          b += srgbToLinear((image.data[at + 2] as number) / 255) * pixelAlpha;
          a += pixelAlpha;
          count += 1;
        }
      }
      const index = y * width + x;
      const scale = count === 0 ? 0 : 1 / count;
      const coverage = a * scale;
      alpha[index] = coverage;
      const unpremultiply = coverage <= 0 ? 0 : scale / coverage;
      color[index * 3] = r * unpremultiply;
      color[index * 3 + 1] = g * unpremultiply;
      color[index * 3 + 2] = b * unpremultiply;
    }
  }
  return { width, height, color, alpha };
}

/** Perceptual lightness of every opaque pixel, and the pixels' opacity. */
function lightness(sampled: Sampled, cutoff: number): { light: Float32Array; opaque: Uint8Array } {
  const count = sampled.width * sampled.height;
  const light = new Float32Array(count);
  const opaque = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    if ((sampled.alpha[index] as number) < cutoff) continue;
    opaque[index] = 1;
    const at = index * 3;
    light[index] = linearToOklab(
      sampled.color[at] as number,
      sampled.color[at + 1] as number,
      sampled.color[at + 2] as number,
    ).L;
  }
  return { light, opaque };
}

/** Percentile of a copy-sorted array, `p` in 0–1. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index] as number;
}

/**
 * Stretch a lightness across the usable shades, darkest art to darkest shade.
 *
 * The 2nd and 98th percentiles rather than the extremes, exactly as the mono
 * path does (doc 04 §Mono ramps): one stray highlight pixel should not spend a
 * third of a three-colour palette on itself. The stretch is computed over every
 * asset at once, so two sprites that were drawn to sit together still do.
 */
function stretch(light: number, lo: number, span: number, steps: number): number {
  const level = (light - lo) / span;
  const clamped = level < 0 ? 0 : level > 1 ? 1 : level;
  return Math.round((1 - clamped) * (steps - 1));
}

/** Pack one 8×8 block of colour indices into planar 2bpp, low plane first. */
function packTile(
  indices: Uint8Array,
  width: number,
  originX: number,
  originY: number,
): Uint8Array {
  const bytes = new Uint8Array(TILE_BYTES);
  for (let row = 0; row < 8; row += 1) {
    let low = 0;
    let high = 0;
    for (let column = 0; column < 8; column += 1) {
      const value = indices[(originY + row) * width + originX + column] as number;
      if (value & 1) low |= 0x80 >> column;
      if (value & 2) high |= 0x80 >> column;
    }
    bytes[row * 2] = low;
    bytes[row * 2 + 1] = high;
  }
  return bytes;
}

/**
 * Convert every asset in a build into one deduplicated tile bank.
 *
 * The whole build at once is the point: the shade choice and the tile dedup are
 * both global decisions, and doing them per asset would give a different — and
 * worse — answer for reasons that have nothing to do with the asset.
 */
export function buildSpriteBank(
  sources: readonly SpriteSource[],
  options: SpriteOptions,
): SpriteBank {
  const spec = getConsole(options.console);
  const layout = spec.layout;
  if (
    layout.kind !== "tiles" ||
    (layout as TileLayout).tileW !== 8 ||
    (layout as TileLayout).tileH !== 8
  ) {
    throw new DemakeError(
      "E_UNSUPPORTED_FAMILY",
      `the sprite path emits 8×8 tiles and ${spec.name} does not use them`,
    );
  }
  if ((layout as TileLayout).bpp !== 2) {
    throw new DemakeError(
      "E_UNSUPPORTED_FAMILY",
      `the sprite path emits 2bpp tiles and ${spec.name} uses ${(layout as TileLayout).bpp}bpp`,
    );
  }

  const cutoff = options.alphaCutoff ?? 0.5;
  const opaque = options.opaque === true;
  const total = spec.color.shades ?? (layout as TileLayout).subPalettes.size;
  // Index 0 is transparency, so an object has one fewer colour than a tile.
  const usable = Math.max(1, opaque ? total : total - 1);

  const decoded = sources.map((source) => {
    const image = decodeImage(source.bytes);
    const sampled = sample(image, source.cellsWide * 8, source.cellsHigh * 8);
    return { source, sampled, ...lightness(sampled, cutoff) };
  });

  // Objects take the darkest shades; a background tile has the whole ramp.
  const first = total - usable;
  const shades = Array.from({ length: usable }, (_, index) => first + index);

  const values: number[] = [];
  for (const entry of decoded) {
    for (let index = 0; index < entry.opaque.length; index += 1) {
      if (entry.opaque[index] === 1) values.push(entry.light[index] as number);
    }
  }
  const lo = percentile(values, 0.02);
  const hi = percentile(values, 0.98);
  const span = hi - lo > 1e-6 ? hi - lo : 1;

  const tiles: Uint8Array[] = [];
  const seen = new Map<string, number>();
  const art = new Map<string, SpriteArt>();
  let totalTiles = 0;

  for (const entry of decoded) {
    const { source, sampled } = entry;
    const width = sampled.width;
    const indices = new Uint8Array(width * sampled.height);
    for (let index = 0; index < indices.length; index += 1) {
      // A transparent pixel is index 0 either way: "not drawn" for an object,
      // the lightest shade for a tile, which is what a hole in a tile means.
      if (entry.opaque[index] === 0) continue;
      const level = stretch(entry.light[index] as number, lo, span, usable);
      indices[index] = opaque ? level : level + 1;
    }

    const placements: number[] = [];
    for (let row = 0; row < source.cellsHigh; row += 1) {
      for (let column = 0; column < source.cellsWide; column += 1) {
        const packed = packTile(indices, width, column * 8, row * 8);
        // A hex key rather than an object identity: two identical tiles from
        // different assets must collapse, which is the whole point of step 4.
        let key = "";
        for (const byte of packed) key += byte.toString(16).padStart(2, "0");
        totalTiles += 1;
        let at = seen.get(key);
        if (at === undefined) {
          at = tiles.length;
          tiles.push(packed);
          seen.set(key, at);
        }
        placements.push(at);
      }
    }
    // The runtime addresses an asset's tiles as one contiguous run, so an asset
    // whose tiles deduplicated out of order needs its own copies. Emitting them
    // only when the run is not already contiguous keeps the common case free.
    const contiguous = placements.every(
      (value, index) => value === (placements[0] as number) + index,
    );
    let base = placements[0] ?? 0;
    if (!contiguous) {
      base = tiles.length;
      for (const at of placements) tiles.push(tiles[at] as Uint8Array);
    }
    art.set(source.name, {
      tile: base,
      width: source.cellsWide,
      height: source.cellsHigh,
    });
  }

  const bank = new Uint8Array(tiles.length * TILE_BYTES);
  tiles.forEach((tile, index) => bank.set(tile, index * TILE_BYTES));
  return { tiles: bank, art, shades, uniqueTiles: tiles.length, totalTiles };
}

/** Pack chosen shades into a Game Boy palette register, index 0 first. */
export function paletteRegister(shades: readonly number[], transparentShade = 0): number {
  let value = transparentShade & 3;
  for (let index = 0; index < 3; index += 1) {
    value |= ((shades[index] ?? index + 1) & 3) << ((index + 1) * 2);
  }
  return value & 0xff;
}
