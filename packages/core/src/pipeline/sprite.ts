/**
 * The sprite path (doc 15 §The conversion path, steps 3–4).
 *
 * A sprite is not a small background. Index 0 is *transparency*, not a colour,
 * so a Game Boy object has three colours where a tile has four — and which
 * three is decided by what an object is drawn *over*, not by what its source
 * happens to look like.
 *
 * On a **mono** console that plays out as a shade choice: colour 0 shows the
 * background through, and this runtime's background is the lightest shade, so an
 * object painted in that shade is an object nobody can see. The three darkest
 * shades are therefore the object palette, and the art is stretched across them
 * by auto-contrast rather than matched to them by absolute lightness. That is
 * doc 04 §The objective restated at eight pixels across: under this much palette
 * pressure, keeping a shape legible beats minimising its error.
 *
 * On a **colour** console the same pressure buys something else. The hardware
 * has several small sub-palettes and an object names one of them, so the choice
 * is no longer "which shades" but "which objects share a palette" — the
 * constrained assignment problem `fit-tiled.ts` solves for an image's attribute
 * cells, with an *asset* in place of a cell. It is solved here rather than
 * there because the unit differs: a cell is eight pixels square and an asset is
 * whatever box the game gave it, and an asset must end up under one palette
 * however many cells it spans.
 *
 * The rest is the existing pipeline's shape, restated with alpha carried
 * through. Downscaling averages in linear light over *premultiplied* alpha,
 * because averaging colour across a transparent pixel is how a sprite grows a
 * dark halo — the classic edge artifact, and one that shows up brutally at
 * 8 pixels wide.
 *
 * Deduplication is across the whole build rather than per asset (step 4): two
 * assets that share a blank corner share the tile, which on a machine with 256
 * object tiles is not a micro-optimisation. It stays valid in colour, and gets
 * better: two assets drawn with the same *shape* under different palettes are
 * one tile and two attribute bytes.
 */

import { deltaESq, linearToOklab, type Oklab } from "../color/oklab.js";
import { srgbToLinear } from "../color/srgb.js";
import { DemakeError } from "../errors.js";
import { decodeImage } from "../image/decode.js";
import type { RgbaImage } from "../image/rgba.js";
import { makePrng, type Prng } from "../math/prng.js";
import { getConsole, withMode } from "../consoles/registry.js";
import type { ConsoleSpec, TileLayout } from "../consoles/types.js";

import { makeColorSpace, type HwColor, type HwColorSpace } from "./hwcolor.js";
import { latticeKmeans, type Points } from "./kmeans.js";
import { isMonoTiled } from "./portfolio.js";
import type { PaletteColor } from "./types.js";

/** Default seed for the colour fit, matching `prep`'s. */
const DEFAULT_SEED = 0x9e3779b9;

/** One converted asset: where its tiles start, and how big it is in cells. */
export interface SpriteArt {
  /** Index of the asset's first tile within the returned bank. */
  tile: number;
  /** Size in whole cells. Tiles are row-major within that box. */
  width: number;
  height: number;
  /**
   * Sub-palette this asset was fitted into.
   *
   * Always 0 on a mono console, where there is only one. On a colour console it
   * is the palette number the hardware attribute has to name — for a Game Boy
   * Color object, the low three bits of its OAM attribute byte.
   */
  palette: number;
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
   * the object palette register `demake build` writes to OBP0. Empty on a
   * colour console, where {@link palettes} carries the answer instead.
   */
  shades: number[];
  /**
   * Fitted sub-palettes, on a colour console.
   *
   * One entry per palette the fit used, each holding exactly the console's
   * sub-palette size in index order — so `palettes[art.palette][index]` is the
   * colour a pixel of value `index` shows. Index 0 of an object palette is
   * never displayed, and is emitted as a black placeholder so the array can be
   * written to the hardware verbatim. Empty on a mono console.
   */
  palettes: PaletteColor[][];
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
   * Background tiles have no transparency, so every colour is available and
   * index 0 is a colour rather than "not drawn". On a mono console the mapping
   * is then the identity — the background palette register is shared with the
   * built-in font and level patterns, and a build that re-chose it would change
   * how those look to suit a tile the player barely notices.
   */
  opaque?: boolean;
  /**
   * Sub-palettes this bank may use, when the console has more than one.
   *
   * Defaults to all of them. A caller reserves the rest: `demake build` keeps
   * one back for the font and the HUD, which must stay legible over art whose
   * own palette was chosen for the art.
   */
  maxPalettes?: number;
  /** Seed for the deterministic colour fit. */
  seed?: number;
  /**
   * How the two bitplanes of a tile are arranged.
   *
   * `interleaved` puts them byte by byte down the rows, which is what the Game
   * Boy addresses; `grouped` stores the whole low plane then the whole high
   * plane, which is what the NES does; `planar` writes every plane of a row
   * before the next row, which is the Sega VDP's layout and the only one that
   * generalises past two bits; `pairs` interleaves plane 0 with plane 1 down the
   * rows and then plane 2 with plane 3, which is how the S-PPU reads a 4bpp tile
   * — two 2bpp tiles stacked. It is the hardware's business and not the art's —
   * the same picture, packed three ways — so it is a flag here rather than a
   * second conversion, and each family's image backend packs its own data the
   * same way.
   */
  packing?: Packing;
  /**
   * Which of the console's selectable layouts to fit, by index into
   * `ConsoleSpec.modes`.
   *
   * Omitted, the primary layout is used — which is what `prep` fits and what the
   * display-ROM harnesses were built against. A caller passes this when the
   * hardware has a mode the *primary* one is not: `demake build` asks the ARM
   * consoles for their 256-colour tiled mode, because a game's sprites are better
   * served by one palette of 256 than by sixteen of sixteen, and the still-image
   * path's goldens should not move because of it.
   */
  mode?: number;
  /**
   * Colours one palette may use, rather than the console's whole palette.
   *
   * The same reservation `maxPalettes` makes, for a machine that has no spare
   * palette to reserve. A Sega VDP has exactly two sixteen-colour banks and the
   * sprites must have one of them, so `demake build` keeps three entries at the
   * top back for the font and says so here — the fit then chooses thirteen
   * colours it can really have instead of sixteen it cannot.
   */
  maxColors?: number;
}

/**
 * How a tile's bitplanes are arranged in memory.
 *
 * `linear8` is the one that is not a bitplane arrangement at all: a 256-colour
 * tile is one byte per pixel in reading order, which is what the ARM consoles'
 * 2D engines take. It is here rather than being a separate path because
 * everything above it — the fit, the dedup, the asset run — is identical, and
 * "which byte layout does this hardware read" is the only question that differs.
 */
export type Packing =
  "interleaved" | "grouped" | "planar" | "packed4" | "packed2" | "pairs" | "linear8";

/** A downscaled sprite in linear light, with straight alpha kept separate. */
interface Sampled {
  width: number;
  height: number;
  /** Linear r,g,b per pixel. Meaningless where alpha is zero. */
  color: Float32Array;
  /** Coverage 0–1 per pixel. */
  alpha: Float32Array;
}

/** One asset, decoded and measured, before any palette decision. */
interface Decoded {
  source: SpriteSource;
  sampled: Sampled;
  /** Perceptual lightness per pixel; only meaningful where opaque. */
  light: Float32Array;
  /** Oklab per opaque pixel, 3 per pixel; zero elsewhere. */
  lab: Float32Array;
  /** Importance weight per pixel. */
  weight: Float32Array;
  opaque: Uint8Array;
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

/**
 * Oklab, lightness, opacity and importance for one sampled asset.
 *
 * The weight is the tiled fitter's, narrowed to what an eight-pixel sprite can
 * show: one plus local contrast, so a two-pixel eye highlight is not averaged
 * into the face around it. Transparent neighbours contribute no contrast, or
 * every silhouette edge would out-weigh everything inside it.
 */
function measure(sampled: Sampled, cutoff: number): Omit<Decoded, "source" | "sampled"> {
  const count = sampled.width * sampled.height;
  const light = new Float32Array(count);
  const lab = new Float32Array(count * 3);
  const weight = new Float32Array(count).fill(1);
  const opaque = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    if ((sampled.alpha[index] as number) < cutoff) continue;
    opaque[index] = 1;
    const at = index * 3;
    const color = linearToOklab(
      sampled.color[at] as number,
      sampled.color[at + 1] as number,
      sampled.color[at + 2] as number,
    );
    light[index] = color.L;
    lab[at] = color.L;
    lab[at + 1] = color.a;
    lab[at + 2] = color.b;
  }
  for (let y = 0; y < sampled.height; y += 1) {
    for (let x = 0; x < sampled.width; x += 1) {
      const index = y * sampled.width + x;
      if (opaque[index] === 0) continue;
      let contrast = 0;
      let neighbours = 0;
      const consider = (other: number): void => {
        if (opaque[other] === 0) return;
        const a = index * 3;
        const b = other * 3;
        const dL = (lab[a] as number) - (lab[b] as number);
        const da = (lab[a + 1] as number) - (lab[b + 1] as number);
        const db = (lab[a + 2] as number) - (lab[b + 2] as number);
        contrast += dL * dL + da * da + db * db;
        neighbours += 1;
      };
      if (x > 0) consider(index - 1);
      if (x < sampled.width - 1) consider(index + 1);
      if (y > 0) consider(index - sampled.width);
      if (y < sampled.height - 1) consider(index + sampled.width);
      weight[index] = 1 + 8 * (neighbours > 0 ? contrast / neighbours : 0);
    }
  }
  return { light, lab, weight, opaque };
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

/**
 * Pack one 8×8 block of colour indices, in the console's own bitplane layout.
 *
 * One picture, several layouts. `interleaved` puts the two planes byte by byte
 * down the rows, which is what the Game Boy addresses; `grouped` stores the
 * whole low plane then the whole high plane, which is the NES's character
 * format; `planar` writes every plane of a row before moving on, which is what
 * the Sega VDP reads. `packed4` is not a bitplane layout at all — it is two
 * pixels a byte, left pixel in the high nibble, which is what the Mega Drive's
 * VDP and the ARM consoles' 2D engines read — and `packed2` is that idea two
 * bits wide with a row as a little-endian halfword, which is the Neo Geo
 * Pocket's. Which one a console wants is the hardware's business and not the
 * art's.
 */
function packTile(
  indices: Uint8Array,
  width: number,
  originX: number,
  originY: number,
  packing: Packing,
  bpp: number,
): Uint8Array {
  const bytes = new Uint8Array(8 * bpp);
  if (packing === "linear8") {
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        bytes[row * 8 + column] = indices[(originY + row) * width + originX + column] as number;
      }
    }
    return bytes;
  }
  if (packing === "packed4") {
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 2) {
        const high = indices[(originY + row) * width + originX + column] as number;
        const low = indices[(originY + row) * width + originX + column + 1] as number;
        bytes[row * 4 + (column >> 1)] = ((high & 0x0f) << 4) | (low & 0x0f);
      }
    }
    return bytes;
  }
  // `packed2` is the same idea two bits wide, but a row is a little-endian
  // *halfword* rather than a run of bytes — so the leftmost pixel is in the
  // highest bits of a value whose low byte is stored first, and the byte a pixel
  // lands in counts down from the right-hand end of the row.
  if (packing === "packed2") {
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const value = indices[(originY + row) * width + originX + column] as number;
        const at = row * 2 + (1 - (column >> 2));
        bytes[at] = (bytes[at] as number) | ((value & 3) << (6 - (column & 3) * 2));
      }
    }
    return bytes;
  }
  for (let row = 0; row < 8; row += 1) {
    const planes = new Uint8Array(bpp);
    for (let column = 0; column < 8; column += 1) {
      const value = indices[(originY + row) * width + originX + column] as number;
      for (let plane = 0; plane < bpp; plane += 1) {
        if ((value >> plane) & 1) planes[plane] = (planes[plane] as number) | (0x80 >> column);
      }
    }
    for (let plane = 0; plane < bpp; plane += 1) {
      const byte = planes[plane] as number;
      if (packing === "grouped") bytes[plane * 8 + row] = byte;
      // Plane *pairs*: the S-PPU reads a 4bpp tile as two 2bpp tiles stacked, so
      // planes 0 and 1 interleave down the rows for sixteen bytes and then planes
      // 2 and 3 do the same. It is `planar` for two bits and something else
      // entirely for four, which is why it is a fourth name rather than a flag on
      // one of the others.
      else if (packing === "pairs") bytes[(plane >> 1) * 16 + row * 2 + (plane & 1)] = byte;
      else bytes[row * bpp + plane] = byte;
    }
  }
  return bytes;
}

/**
 * The layout a caller asked for: the primary one, or one of the selectable modes.
 *
 * A mode index that names nothing is an error rather than a silent fall back to
 * the primary layout — a caller asking for 256 colours and quietly getting
 * sixteen would produce art that is *valid* and half the picture it asked for,
 * which is the hardest kind of wrong to notice.
 */

/** The point set one asset contributes to a palette fit. */
function pointsFor(entry: Decoded): Points {
  const members: number[] = [];
  for (let index = 0; index < entry.opaque.length; index += 1) {
    if (entry.opaque[index] === 1) members.push(index);
  }
  const lab = new Float32Array(members.length * 3);
  const weight = new Float32Array(members.length);
  members.forEach((pixel, at) => {
    lab[at * 3] = entry.lab[pixel * 3] as number;
    lab[at * 3 + 1] = entry.lab[pixel * 3 + 1] as number;
    lab[at * 3 + 2] = entry.lab[pixel * 3 + 2] as number;
    weight[at] = entry.weight[pixel] as number;
  });
  return { lab, weight, count: members.length };
}

/** Concatenate several point sets into one. */
function mergePoints(sets: readonly Points[]): Points {
  const count = sets.reduce((total, set) => total + set.count, 0);
  const lab = new Float32Array(count * 3);
  const weight = new Float32Array(count);
  let at = 0;
  for (const set of sets) {
    lab.set(set.lab.subarray(0, set.count * 3), at * 3);
    weight.set(set.weight.subarray(0, set.count), at);
    at += set.count;
  }
  return { lab, weight, count };
}

/** Weighted error of fitting one asset's pixels to one palette. */
function fitError(points: Points, palette: readonly HwColor[]): number {
  if (palette.length === 0) return Infinity;
  let total = 0;
  for (let index = 0; index < points.count; index += 1) {
    const lab: Oklab = {
      L: points.lab[index * 3] as number,
      a: points.lab[index * 3 + 1] as number,
      b: points.lab[index * 3 + 2] as number,
    };
    let best = Infinity;
    for (const color of palette) {
      const distance = deltaESq(lab, color.lab, 1);
      if (distance < best) best = distance;
    }
    total += best * (points.weight[index] as number);
  }
  return total;
}

/**
 * Choose which assets share a sub-palette, and what is in each one.
 *
 * The alternating refinement `fit-tiled.ts` runs over attribute cells, with an
 * asset as the unit: seed the groups from the assets' mean colours, then repeat
 * { assign each asset to its cheapest palette; refit each palette over the
 * pixels of the assets that chose it }. An asset is indivisible because the
 * hardware names one palette per object, so a sprite whose halves want different
 * colours pays for it here rather than being quietly split.
 */
function assignPalettes(
  decoded: readonly Decoded[],
  perAsset: readonly Points[],
  count: number,
  size: number,
  space: HwColorSpace,
  prng: Prng,
): { palettes: HwColor[][]; choice: number[] } {
  const assets = decoded.length;
  const groups = Math.max(1, Math.min(count, assets));
  const choice = new Array<number>(assets).fill(0);

  // Seed: order the assets by mean lightness and deal them round-robin, which
  // puts unlike art in unlike groups without a second clustering pass. The
  // refinement below is what actually decides; this only has to be a spread.
  const order = decoded
    .map((entry, index) => ({ index, mean: meanLightness(entry) }))
    .sort((a, b) => a.mean - b.mean || a.index - b.index);
  order.forEach((entry, rank) => {
    choice[entry.index] = rank % groups;
  });

  let palettes = refit(perAsset, choice, groups, size, space, prng);
  for (let round = 0; round < 8; round += 1) {
    let moved = false;
    for (let asset = 0; asset < assets; asset += 1) {
      let best = choice[asset] as number;
      let bestError = Infinity;
      for (let palette = 0; palette < groups; palette += 1) {
        const error = fitError(perAsset[asset] as Points, palettes[palette] as HwColor[]);
        if (error < bestError) {
          bestError = error;
          best = palette;
        }
      }
      if (choice[asset] !== best) moved = true;
      choice[asset] = best;
    }
    palettes = refit(perAsset, choice, groups, size, space, prng);
    if (!moved) break;
  }
  return { palettes, choice };
}

/** Mean lightness over an asset's opaque pixels; 0 when it has none. */
function meanLightness(entry: Decoded): number {
  let total = 0;
  let count = 0;
  for (let index = 0; index < entry.opaque.length; index += 1) {
    if (entry.opaque[index] === 0) continue;
    total += entry.light[index] as number;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

/** Refit every sub-palette over the pixels of the assets assigned to it. */
function refit(
  perAsset: readonly Points[],
  choice: readonly number[],
  groups: number,
  size: number,
  space: HwColorSpace,
  prng: Prng,
): HwColor[][] {
  const palettes: HwColor[][] = [];
  for (let palette = 0; palette < groups; palette += 1) {
    const members = perAsset.filter(
      (points, asset) => choice[asset] === palette && points.count > 0,
    );
    if (members.length === 0) {
      palettes.push([]);
      continue;
    }
    palettes.push(latticeKmeans(mergePoints(members), size, space, prng, 12, 1, false));
  }
  return palettes;
}

/**
 * Order a fitted palette lightest first, and pad it to the hardware's size.
 *
 * Lightest first because that is the order every other Game Boy palette in this
 * repository is in — the DMG's shade ramp, the built-in font's, the mono fit's —
 * so an index means the same thing whichever machine is being built for. Ties
 * break on the raw codes so the order is a function of the colours alone.
 */
function orderPalette(fitted: readonly HwColor[], size: number): HwColor[] {
  const sorted = [...fitted].sort(
    (a, b) => b.lab.L - a.lab.L || a.codes.join(",").localeCompare(b.codes.join(",")),
  );
  while (sorted.length > 0 && sorted.length < size)
    sorted.push(sorted[sorted.length - 1] as HwColor);
  return sorted.slice(0, size);
}

/** Index of the nearest colour in a palette, in Oklab. */
function nearest(palette: readonly HwColor[], lab: Oklab): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index += 1) {
    const distance = deltaESq(lab, (palette[index] as HwColor).lab, 1);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * Convert every asset in a build into one deduplicated tile bank.
 *
 * The whole build at once is the point: the palette choice and the tile dedup
 * are both global decisions, and doing them per asset would give a different —
 * and worse — answer for reasons that have nothing to do with the asset.
 */
export function buildSpriteBank(
  sources: readonly SpriteSource[],
  options: SpriteOptions,
): SpriteBank {
  const spec = getConsole(options.console);
  const layout = withMode(spec, options.mode).layout;
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
  const bpp = (layout as TileLayout).bpp;
  if (bpp !== 2 && bpp !== 4 && bpp !== 8) {
    throw new DemakeError(
      "E_UNSUPPORTED_FAMILY",
      `the sprite path emits 2bpp, 4bpp and 8bpp tiles and ${spec.name} uses ${bpp}bpp`,
    );
  }
  // Eight bits a pixel is a byte a pixel, and no bitplane arrangement of one
  // byte is meaningful — so a caller that asks for a plane packing on a
  // 256-colour console has confused two consoles rather than chosen a layout.
  if (bpp === 8 && options.packing !== undefined && options.packing !== "linear8") {
    throw new DemakeError(
      "E_UNSUPPORTED_FAMILY",
      `a 256-colour tile is one byte per pixel; '${options.packing}' is a bitplane layout`,
    );
  }

  const cutoff = options.alphaCutoff ?? 0.5;
  const opaque = options.opaque === true;
  const tiles = layout as TileLayout;
  // On a tiled-mono console the two numbers come apart, and taking the wrong one
  // packs indices a tile cannot hold: `color.shades` is the *pool* — eight, on
  // the one console that has one — while a palette holds `subPalettes.size` of
  // them, which is what a pixel index selects between. The ramp is then spread
  // across the pool rather than being consecutive, because those are the shades
  // the palette entries may name (see {@link SpriteBank.shades}).
  const spread = spec.color.shades ?? tiles.subPalettes.size;
  const declared = isMonoTiled(spec) ? tiles.subPalettes.size : spread;
  // A caller that does not own the whole palette says so, exactly as it does for
  // sub-palettes and for tiles; the fit is then honest about what it has rather
  // than being trimmed after the fact.
  const total = Math.max(2, Math.min(declared, options.maxColors ?? declared));
  // Index 0 is transparency, so an object has one fewer colour than a tile.
  const usable = Math.max(1, opaque ? total : total - 1);

  const decoded: Decoded[] = sources.map((source) => {
    // The object's box in pixels is exactly what a drawing should be drawn at:
    // a 16×16 `.svg` used for a four-cell-wide object was rasterised at 16 and
    // then sampled up to 32, which is a blur the file never had in it. Raster
    // sources are unaffected — their pixels are the file (`decodeImage`).
    const box = { width: source.cellsWide * 8, height: source.cellsHigh * 8 };
    const image = decodeImage(source.bytes, { atLeast: box });
    const sampled = sample(image, box.width, box.height);
    return { source, sampled, ...measure(sampled, cutoff) };
  });

  const color = spec.color.model !== "mono";
  const fit = color
    ? colorIndices(decoded, spec, tiles, usable, opaque, options)
    : monoIndices(decoded, total, usable, opaque, spread);

  const packing = options.packing ?? (bpp === 8 ? "linear8" : "interleaved");
  const bank: Uint8Array[] = [];
  const seen = new Map<string, number>();
  const art = new Map<string, SpriteArt>();
  let totalTiles = 0;

  decoded.forEach((entry, asset) => {
    const { source, sampled } = entry;
    const width = sampled.width;
    const indices = fit.indices[asset] as Uint8Array;

    const placements: number[] = [];
    for (let row = 0; row < source.cellsHigh; row += 1) {
      for (let column = 0; column < source.cellsWide; column += 1) {
        const packed = packTile(indices, width, column * 8, row * 8, packing, bpp);
        // A hex key rather than an object identity: two identical tiles from
        // different assets must collapse, which is the whole point of step 4.
        let key = "";
        for (const byte of packed) key += byte.toString(16).padStart(2, "0");
        totalTiles += 1;
        let at = seen.get(key);
        if (at === undefined) {
          at = bank.length;
          bank.push(packed);
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
      base = bank.length;
      for (const at of placements) bank.push(bank[at] as Uint8Array);
    }
    art.set(source.name, {
      tile: base,
      width: source.cellsWide,
      height: source.cellsHigh,
      palette: fit.palette[asset] ?? 0,
    });
  });

  const stride = 8 * bpp;
  const bytes = new Uint8Array(bank.length * stride);
  bank.forEach((tile, index) => bytes.set(tile, index * stride));
  return {
    tiles: bytes,
    art,
    shades: fit.shades,
    palettes: fit.palettes,
    uniqueTiles: bank.length,
    totalTiles,
  };
}

/** What either fitter hands back: per-asset pixel indices and palette choice. */
interface Fitted {
  indices: Uint8Array[];
  palette: number[];
  shades: number[];
  palettes: PaletteColor[][];
}

/**
 * The mono fit: one auto-contrast ramp across every asset in the build.
 *
 * `spread` is how many hardware shades the ramp may reach — the same number as
 * `total` on every console whose palette *is* the shade set, and larger on the
 * one whose palette entries index a wider pool. Spreading rather than counting
 * up is what keeps an object's contrast when four entries choose among eight
 * shades; taking `first`, `first + 1`, `first + 2` there would draw every sprite
 * in three adjacent greys.
 */
function monoIndices(
  decoded: readonly Decoded[],
  total: number,
  usable: number,
  opaque: boolean,
  spread: number,
): Fitted {
  // Objects take the darkest shades; a background tile has the whole ramp.
  const first = total - usable;
  const last = Math.max(first, spread - 1);
  const shades = Array.from({ length: usable }, (_, index) =>
    usable === 1 ? last : first + Math.round((index * (last - first)) / (usable - 1)),
  );

  const values: number[] = [];
  for (const entry of decoded) {
    for (let index = 0; index < entry.opaque.length; index += 1) {
      if (entry.opaque[index] === 1) values.push(entry.light[index] as number);
    }
  }
  const lo = percentile(values, 0.02);
  const hi = percentile(values, 0.98);
  const span = hi - lo > 1e-6 ? hi - lo : 1;

  const indices = decoded.map((entry) => {
    const out = new Uint8Array(entry.opaque.length);
    for (let index = 0; index < out.length; index += 1) {
      // A transparent pixel is index 0 either way: "not drawn" for an object,
      // the lightest shade for a tile, which is what a hole in a tile means.
      if (entry.opaque[index] === 0) continue;
      const level = stretch(entry.light[index] as number, lo, span, usable);
      out[index] = opaque ? level : level + 1;
    }
    return out;
  });
  return { indices, palette: decoded.map(() => 0), shades, palettes: [] };
}

/** The colour fit: sub-palettes shared between assets, one palette per asset. */
function colorIndices(
  decoded: readonly Decoded[],
  spec: ConsoleSpec,
  tiles: TileLayout,
  usable: number,
  opaque: boolean,
  options: SpriteOptions,
): Fitted {
  const space = makeColorSpace(spec);
  const prng = makePrng((options.seed ?? DEFAULT_SEED) >>> 0);
  const count = Math.max(1, Math.min(tiles.subPalettes.count, options.maxPalettes ?? Infinity));
  const perAsset = decoded.map(pointsFor);
  const { palettes, choice } = assignPalettes(decoded, perAsset, count, usable, space, prng);

  // Index 0 of an object palette is never displayed, so it is emitted as black:
  // a placeholder keeps the array the shape the hardware is written from, and a
  // fitted colour there would only be a colour the machine cannot show.
  const transparent = space.fromCodes([0, 0, 0]);
  const ordered = palettes.map((palette) => {
    const fitted = orderPalette(palette.length > 0 ? palette : [transparent], usable);
    return opaque ? fitted : [transparent, ...fitted];
  });

  const indices = decoded.map((entry, asset) => {
    const palette = ordered[choice[asset] as number] as HwColor[];
    // Objects match against the colours the hardware will really show, which
    // starts one past the transparent slot.
    const candidates = opaque ? palette : palette.slice(1);
    const out = new Uint8Array(entry.opaque.length);
    for (let index = 0; index < out.length; index += 1) {
      if (entry.opaque[index] === 0) continue;
      const at = index * 3;
      const lab: Oklab = {
        L: entry.lab[at] as number,
        a: entry.lab[at + 1] as number,
        b: entry.lab[at + 2] as number,
      };
      out[index] = nearest(candidates, lab) + (opaque ? 0 : 1);
    }
    return out;
  });

  return {
    indices,
    palette: choice,
    shades: [],
    palettes: ordered.map((palette) =>
      palette.map((entry) => ({ codes: entry.codes, display: entry.display, raw: entry.raw })),
    ),
  };
}

/** Pack chosen shades into a Game Boy palette register, index 0 first. */
export function paletteRegister(shades: readonly number[], transparentShade = 0): number {
  let value = transparentShade & 3;
  for (let index = 0; index < 3; index += 1) {
    value |= ((shades[index] ?? index + 1) & 3) << ((index + 1) * 2);
  }
  return value & 0xff;
}
