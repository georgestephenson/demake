/**
 * Mono-ramp path (doc 04 §Special cases → Mono ramps).
 *
 * For shade-only consoles (DMG, and later Virtual Boy / WonderSwan / Pokémon
 * Mini) luminance mapping replaces the RGB-lattice quantizer: auto-contrast
 * (percentile stretch), a gamma-correct N-level split, and optional dither, all
 * on the Oklab L channel. The result is rendered through the platform tint
 * (green LCD, red LED) by the DAC model for preview. Output is a
 * {@link CompliantImage} with a single sub-palette of shades.
 */

import { linearToOklab } from "../color/oklab.js";
import { dacDecodeShade } from "../image/dac.js";
import type { ConsoleSpec, RGB8, TileLayout } from "../consoles/types.js";

import type { CompliantImage, DitherAlg, Palette } from "./types.js";
import type { LinImage } from "./types.js";

/** Build the single mono sub-palette (shade index → display + raw colors). */
function monoPalette(spec: ConsoleSpec, shades: number): Palette {
  const colors = [];
  for (let s = 0; s < shades; s += 1) {
    const display: RGB8 = dacDecodeShade(spec.color.dac, s);
    // Raw = a neutral grayscale ramp (what `--raw-colors` shows), lightest first.
    const level = shades === 1 ? 255 : Math.round(255 * (1 - s / (shades - 1)));
    const raw: RGB8 = { r: level, g: level, b: level };
    colors.push({ codes: [s], display, raw });
  }
  return { colors };
}

/** The Oklab L of each pixel and the stretch percentiles. */
function luminance(img: LinImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const o = i * 3;
    out[i] = linearToOklab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!).L;
  }
  return out;
}

/** Percentile value of a copy-sorted array (p in [0,1]). */
function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/** Convert a post-geometry image to a compliant mono image. */
export function fitMono(
  img: LinImage,
  spec: ConsoleSpec,
  dither: DitherAlg,
  strength: number,
): CompliantImage {
  const shades = spec.color.shades ?? 4;
  const layout = spec.layout as TileLayout;
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const cellsX = Math.floor(img.width / cellW);
  const cellsY = Math.floor(img.height / cellH);

  const L = luminance(img);
  const lo = percentile(L, 0.02);
  const hi = percentile(L, 0.98);
  const span = hi - lo > 1e-6 ? hi - lo : 1;

  const stretched = new Float32Array(L.length);
  for (let i = 0; i < L.length; i += 1) {
    stretched[i] = clamp01((L[i]! - lo) / span);
  }

  const pixelIndex = new Uint8Array(img.width * img.height);
  const maxShade = shades - 1;
  const amp = strength / 100;

  if (dither === "floyd-steinberg" || dither === "atkinson" || dither === "riemersma") {
    const work = Float32Array.from(stretched);
    for (let y = 0; y < img.height; y += 1) {
      const ltr = y % 2 === 0;
      const xs = ltr ? 0 : img.width - 1;
      const xe = ltr ? img.width : -1;
      const step = ltr ? 1 : -1;
      for (let x = xs; x !== xe; x += step) {
        const i = y * img.width + x;
        const level = clamp01(work[i]!);
        const shade = Math.round((1 - level) * maxShade);
        pixelIndex[i] = shade;
        const quantLevel = 1 - shade / maxShade;
        const err = (level - quantLevel) * amp;
        diffuse1(work, img.width, img.height, x, y, step, err);
      }
    }
  } else if (dither === "bayer2" || dither === "bayer4" || dither === "bayer8") {
    const size = dither === "bayer2" ? 2 : dither === "bayer4" ? 4 : 8;
    const matrix = bayerMatrix(size);
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        const i = y * img.width + x;
        const threshold = (matrix[(y % size) * size + (x % size)]! + 0.5) / (size * size) - 0.5;
        const level = clamp01(stretched[i]! + threshold * amp * 0.4);
        pixelIndex[i] = Math.round((1 - level) * maxShade);
      }
    }
  } else {
    for (let i = 0; i < stretched.length; i += 1) {
      pixelIndex[i] = Math.round((1 - stretched[i]!) * maxShade);
    }
  }

  const palette = monoPalette(spec, shades);
  const cellPalette = new Uint16Array(cellsX * cellsY); // all zero: single palette
  return {
    consoleId: spec.id,
    width: img.width,
    height: img.height,
    grid: { cellsX, cellsY, attributeW: cellW, attributeH: cellH },
    palettes: [palette],
    cellPalette,
    pixelIndex,
  };
}

function diffuse1(
  work: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  step: number,
  err: number,
): void {
  const add = (nx: number, ny: number, w: number): void => {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    work[ny * width + nx] = work[ny * width + nx]! + err * w;
  };
  add(x + step, y, 7 / 16);
  add(x - step, y + 1, 3 / 16);
  add(x, y + 1, 5 / 16);
  add(x + step, y + 1, 1 / 16);
}

function bayerMatrix(size: 2 | 4 | 8): number[] {
  if (size === 2) return [0, 2, 3, 1];
  const b4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  if (size === 4) return b4;
  const out = new Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const q = b4[(y % 4) * 4 + (x % 4)]!;
      const sub = ((y >> 2) << 1) | (x >> 2);
      out[y * 8 + x] = q * 4 + sub;
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
