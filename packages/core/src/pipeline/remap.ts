/**
 * Stage 5 — dithering & remap (doc 04 §Stage 5).
 *
 * Remaps each pixel to the nearest color in *its cell's* sub-palette (Oklab
 * distance on DAC-decoded colors), optionally dithering. Error diffusion is
 * **cell-aware**: error never crosses into a neighbor cell whose palette can't
 * represent it, which prevents the classic smearing artifact at attribute
 * edges. Produces the {@link CompliantImage} index arrays.
 */

import { deltaESq, type Oklab } from "../color/oklab.js";
import type { TileLayout } from "../consoles/types.js";
import type { ConsoleSpec } from "../consoles/types.js";

import type { HwColor } from "./hwcolor.js";
import type { TiledFit } from "./fit-tiled.js";
import type { CompliantImage, DitherAlg, Palette } from "./types.js";

/** Ordered (Bayer) threshold matrices, values in [0, size²). */
const BAYER2 = [0, 2, 3, 1];
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER8 = buildBayer8();

function buildBayer8(): number[] {
  // Recursively expand the 4×4 into 8×8.
  const out = new Array(64).fill(0);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const q = BAYER4[(y % 4) * 4 + (x % 4)]!;
      const sub = ((y >> 2) << 1) | (x >> 2);
      out[y * 8 + x] = q * 4 + sub;
    }
  }
  return out;
}

function nearestIndex(lab: Oklab, palette: HwColor[], lWeight: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const d = deltaESq(lab, palette[i]!.lab, lWeight);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Convert fitted hardware palettes into the serializable {@link Palette} form. */
function toPalettes(hw: HwColor[][]): Palette[] {
  return hw.map((colors) => ({
    colors: colors.map((c) => ({ codes: c.codes, display: c.display, raw: c.raw })),
  }));
}

/** Remap + dither a fit into a compliant indexed image. */
export function remap(
  fit: TiledFit,
  spec: ConsoleSpec,
  width: number,
  height: number,
  dither: DitherAlg,
  strength: number,
  lWeight: number,
): CompliantImage {
  const layout = spec.layout as TileLayout;
  const cellW = layout.attribute.w;
  const cellH = layout.attribute.h;
  const pixelIndex = new Uint8Array(width * height);
  const amp = strength / 100;

  const cellOf = (x: number, y: number): number =>
    Math.floor(y / cellH) * fit.cellsX + Math.floor(x / cellW);

  const paletteAt = (x: number, y: number): HwColor[] =>
    fit.palettes[fit.cellPalette[cellOf(x, y)]!]!;

  if (dither === "floyd-steinberg" || dither === "atkinson" || dither === "riemersma") {
    diffuse(fit, pixelIndex, width, height, cellOf, paletteAt, dither, amp, lWeight);
  } else if (dither === "bayer2" || dither === "bayer4" || dither === "bayer8") {
    ordered(fit, pixelIndex, width, height, paletteAt, dither, amp, lWeight);
  } else {
    // none / ramp (ramp falls back to hard remap in this build).
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        const o = i * 3;
        const lab: Oklab = {
          L: fit.pixelLab[o]!,
          a: fit.pixelLab[o + 1]!,
          b: fit.pixelLab[o + 2]!,
        };
        pixelIndex[i] = nearestIndex(lab, paletteAt(x, y), lWeight);
      }
    }
  }

  return {
    consoleId: spec.id,
    width,
    height,
    grid: { cellsX: fit.cellsX, cellsY: fit.cellsY, attributeW: cellW, attributeH: cellH },
    palettes: toPalettes(fit.palettes),
    cellPalette: fit.cellPalette,
    pixelIndex,
  };
}

function ordered(
  fit: TiledFit,
  pixelIndex: Uint8Array,
  width: number,
  height: number,
  paletteAt: (x: number, y: number) => HwColor[],
  dither: "bayer2" | "bayer4" | "bayer8",
  amp: number,
  lWeight: number,
): void {
  const matrix = dither === "bayer2" ? BAYER2 : dither === "bayer4" ? BAYER4 : BAYER8;
  const size = dither === "bayer2" ? 2 : dither === "bayer4" ? 4 : 8;
  const denom = size * size;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const o = i * 3;
      const threshold = (matrix[(y % size) * size + (x % size)]! + 0.5) / denom - 0.5;
      // Perturb luminance/chroma by the ordered threshold before nearest-match.
      const lab: Oklab = {
        L: fit.pixelLab[o]! + threshold * amp * 0.25,
        a: fit.pixelLab[o + 1]! + threshold * amp * 0.15,
        b: fit.pixelLab[o + 2]! + threshold * amp * 0.15,
      };
      pixelIndex[i] = nearestIndex(lab, paletteAt(x, y), lWeight);
    }
  }
}

function diffuse(
  fit: TiledFit,
  pixelIndex: Uint8Array,
  width: number,
  height: number,
  cellOf: (x: number, y: number) => number,
  paletteAt: (x: number, y: number) => HwColor[],
  dither: "floyd-steinberg" | "atkinson" | "riemersma",
  amp: number,
  lWeight: number,
): void {
  // Working buffer we perturb with diffused error (Oklab).
  const work = Float32Array.from(fit.pixelLab);
  // Diffusion kernels: [dx, dy, weight]. Atkinson spreads 1/8 to 6 neighbors.
  const fs: Array<[number, number, number]> = [
    [1, 0, 7 / 16],
    [-1, 1, 3 / 16],
    [0, 1, 5 / 16],
    [1, 1, 1 / 16],
  ];
  const atk: Array<[number, number, number]> = [
    [1, 0, 1 / 8],
    [2, 0, 1 / 8],
    [-1, 1, 1 / 8],
    [0, 1, 1 / 8],
    [1, 1, 1 / 8],
    [0, 2, 1 / 8],
  ];
  const kernel = dither === "atkinson" ? atk : fs;

  for (let y = 0; y < height; y += 1) {
    const leftToRight = y % 2 === 0;
    const xStart = leftToRight ? 0 : width - 1;
    const xEnd = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += step) {
      const i = y * width + x;
      const o = i * 3;
      const lab: Oklab = { L: work[o]!, a: work[o + 1]!, b: work[o + 2]! };
      const palette = paletteAt(x, y);
      const idx = nearestIndex(lab, palette, lWeight);
      pixelIndex[i] = idx;
      const chosen = palette[idx]!.lab;
      const eL = (lab.L - chosen.L) * amp;
      const ea = (lab.a - chosen.a) * amp;
      const eb = (lab.b - chosen.b) * amp;
      const cell = cellOf(x, y);
      for (const [dx, dy, w] of kernel) {
        const nx = x + dx * step;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        // Cell-aware: don't diffuse into a different attribute cell.
        if (cellOf(nx, ny) !== cell) continue;
        const no = (ny * width + nx) * 3;
        work[no] = work[no]! + eL * w;
        work[no + 1] = work[no + 1]! + ea * w;
        work[no + 2] = work[no + 2]! + eb * w;
      }
    }
  }
}
