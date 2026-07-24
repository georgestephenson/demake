/**
 * TMS9918 Graphics II ("row-pair") path — the SG-1000 and other TMS-VDP consoles
 * (doc 04 §Special cases). Unlike a sub-palette tiled fitter, the constraint here
 * is per **8×1 row segment**: each such segment may show at most *two* of the 16
 * fixed TMS colors (a foreground and a background), stored in the VDP color table
 * one byte per tile row. So each row segment is an independent two-color
 * quantization against a fixed master — expressed as a {@link CompliantImage}
 * with 8×1 attribute cells, each carrying its own ≤2-color palette. Color index 0
 * (transparent) is avoided; the master's two blacks make that free.
 *
 * The result plugs into the same `renderCompliant` + codegen machinery every
 * other console uses; only the fit is bespoke.
 */

import { srgb8ToLinear } from "../color/srgb.js";
import { linearToOklab, deltaESq, type Oklab } from "../color/oklab.js";
import type { ConsoleSpec, RGB8 } from "../consoles/types.js";

import type { CompliantImage, DitherAlg, Palette, PaletteColor } from "./types.js";
import type { LinImage } from "./types.js";

interface Entry {
  index: number; // master-palette index (1..15; 0 is transparent, skipped)
  color: RGB8;
  lin: [number, number, number];
  lab: Oklab;
}

/** Build the opaque master entries (skip index 0, the transparent slot). */
function opaqueEntries(master: readonly RGB8[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 1; i < master.length; i += 1) {
    const c = master[i]!;
    const lin: [number, number, number] = [
      srgb8ToLinear(c.r),
      srgb8ToLinear(c.g),
      srgb8ToLinear(c.b),
    ];
    out.push({ index: i, color: c, lin, lab: linearToOklab(lin[0], lin[1], lin[2]) });
  }
  return out;
}

function paletteColor(e: Entry): PaletteColor {
  return { codes: [e.index], display: { ...e.color }, raw: { ...e.color } };
}

/** Convert a post-geometry linear image to a compliant TMS Graphics II image. */
export function fitTms(
  img: LinImage,
  spec: ConsoleSpec,
  dither: DitherAlg,
  strength: number,
): CompliantImage {
  const master = spec.color.masterPalette;
  if (!master) throw new Error(`fitTms requires a fixed-master console (got ${spec.id})`);
  const entries = opaqueEntries(master);
  const { width, height } = img;
  const cellsX = Math.floor(width / 8);
  const cellsY = height; // 8×1 cells: one per pixel row per tile column

  // Per-pixel Oklab (for palette choice) and a mutable linear copy (for dither).
  const lab = new Array<Oklab>(width * height);
  const work = new Float32Array(img.data); // linear RGB, diffused in place
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 3;
    lab[i] = linearToOklab(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
  }

  const palettes: Palette[] = [];
  const palIndexByKey = new Map<string, number>();
  const cellPalette = new Uint16Array(cellsX * cellsY);
  const cellEntries: [Entry, Entry][] = []; // the two chosen entries per cell
  const pixelIndex = new Uint8Array(width * height);

  // ---- choose the best two master colors for every 8×1 cell ----------------
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const x0 = cx * 8;
      // Distance from each of the 8 pixels to each opaque entry.
      const d: number[][] = [];
      for (let px = 0; px < 8; px += 1) {
        const pl = lab[cy * width + x0 + px]!;
        const row: number[] = [];
        for (const e of entries) row.push(deltaESq(pl, e.lab, 1));
        d.push(row);
      }
      // Best pair (i ≤ j), cost = Σ min(d_i, d_j); ties break to the lower pair.
      let bestI = 0;
      let bestJ = 0;
      let bestCost = Infinity;
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i; j < entries.length; j += 1) {
          let cost = 0;
          for (let px = 0; px < 8; px += 1) cost += Math.min(d[px]![i]!, d[px]![j]!);
          if (cost < bestCost) {
            bestCost = cost;
            bestI = i;
            bestJ = j;
          }
        }
      }
      const a = entries[bestI]!;
      const b = entries[bestJ]!;
      cellEntries[cy * cellsX + cx] = [a, b];

      const key = `${a.index},${b.index}`;
      let pi = palIndexByKey.get(key);
      if (pi === undefined) {
        pi = palettes.length;
        palettes.push({
          colors: a.index === b.index ? [paletteColor(a)] : [paletteColor(a), paletteColor(b)],
        });
        palIndexByKey.set(key, pi);
      }
      cellPalette[cy * cellsX + cx] = pi;
    }
  }

  // ---- assign each pixel to color 0 (a) or 1 (b), optionally dithering ------
  const amp = strength / 100;
  const useFs = dither === "floyd-steinberg" || dither === "atkinson" || dither === "riemersma";
  const bayer = dither === "bayer2" ? 2 : dither === "bayer4" ? 4 : dither === "bayer8" ? 8 : 0;
  const matrix = bayer ? bayerMatrix(bayer) : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const [a, b] = cellEntries[Math.floor(y) * cellsX + Math.floor(x / 8)]!;
      if (a.index === b.index) {
        pixelIndex[i] = 0;
        continue;
      }
      const o = i * 3;
      const pl = useFs ? linearToOklab(work[o]!, work[o + 1]!, work[o + 2]!) : lab[i]!;
      let da = deltaESq(pl, a.lab, 1);
      let db = deltaESq(pl, b.lab, 1);
      if (matrix) {
        // Ordered dither: bias the choice by the pixel's threshold position.
        const t = (matrix[(y % bayer) * bayer + (x % bayer)]! + 0.5) / (bayer * bayer) - 0.5;
        const bias = t * amp * (da + db) * 0.5;
        da += bias;
        db -= bias;
      }
      const pick = da <= db ? 0 : 1;
      pixelIndex[i] = pick;
      if (useFs) {
        const chosen = pick === 0 ? a : b;
        diffuseLinear(work, width, height, x, y, [
          (work[o]! - chosen.lin[0]) * amp,
          (work[o + 1]! - chosen.lin[1]) * amp,
          (work[o + 2]! - chosen.lin[2]) * amp,
        ]);
      }
    }
  }

  return {
    consoleId: spec.id,
    width,
    height,
    grid: { cellsX, cellsY, attributeW: 8, attributeH: 1 },
    palettes,
    cellPalette,
    pixelIndex,
  };
}

/** Floyd–Steinberg error diffusion of a linear-RGB residual (left-to-right). */
function diffuseLinear(
  work: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  err: [number, number, number],
): void {
  const add = (nx: number, ny: number, w: number): void => {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    const o = (ny * width + nx) * 3;
    work[o] = work[o]! + err[0] * w;
    work[o + 1] = work[o + 1]! + err[1] * w;
    work[o + 2] = work[o + 2]! + err[2] * w;
  };
  add(x + 1, y, 7 / 16);
  add(x - 1, y + 1, 3 / 16);
  add(x, y + 1, 5 / 16);
  add(x + 1, y + 1, 1 / 16);
}

function bayerMatrix(size: number): number[] {
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
