/**
 * Stage 7 — render & encode (doc 04 §Stage 7).
 *
 * A {@link CompliantImage} stores hardware indices; here it becomes displayable
 * pixels. The default output is **DAC-decoded** sRGB (looks right everywhere);
 * `useRaw` selects the naive-expansion colors (`--raw-colors`). The PNG is a
 * deterministic indexed image at the smallest bit depth that fits — and it is
 * self-sufficient: `gen` can re-derive full compliance from the pixels alone.
 */

import type { RGB8 } from "../consoles/types.js";
import { encodeIndexedPng } from "../image/png/encode.js";
import type { RgbaImage } from "../image/rgba.js";

import type { CompliantImage } from "./types.js";

/** The displayed (or raw) color of a pixel via its cell's palette. */
function pixelColor(image: CompliantImage, x: number, y: number, useRaw: boolean): RGB8 {
  const cell =
    Math.floor(y / image.grid.attributeH) * image.grid.cellsX +
    Math.floor(x / image.grid.attributeW);
  const palette = image.palettes[image.cellPalette[cell]!]!;
  const color = palette.colors[image.pixelIndex[y * image.width + x]!];
  if (!color) return { r: 0, g: 0, b: 0 };
  return useRaw ? color.raw : color.display;
}

/** Render a compliant image to a full-resolution RGBA raster. */
export function renderCompliant(image: CompliantImage, useRaw = false): RgbaImage {
  const data = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const c = pixelColor(image, x, y, useRaw);
      const o = (y * image.width + x) * 4;
      data[o] = c.r;
      data[o + 1] = c.g;
      data[o + 2] = c.b;
      data[o + 3] = 255;
    }
  }
  return { width: image.width, height: image.height, data };
}

/** Encode a compliant image to a deterministic indexed PNG. */
export function encodeCompliantPng(image: CompliantImage, useRaw = false): Uint8Array {
  // Build a deduplicated flat palette of displayed colors, ordered by luminance
  // then RGB for stable, readable diffs.
  const keyToColor = new Map<number, RGB8>();
  const pixelKeys = new Uint32Array(image.width * image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const c = pixelColor(image, x, y, useRaw);
      const key = (c.r << 16) | (c.g << 8) | c.b;
      if (!keyToColor.has(key)) keyToColor.set(key, c);
      pixelKeys[y * image.width + x] = key;
    }
  }

  const colors = [...keyToColor.values()].sort((a, b) => {
    const la = a.r * 299 + a.g * 587 + a.b * 114;
    const lb = b.r * 299 + b.g * 587 + b.b * 114;
    return la - lb || a.r - b.r || a.g - b.g || a.b - b.b;
  });
  const keyToIndex = new Map<number, number>();
  const palette = new Uint8Array(colors.length * 3);
  colors.forEach((c, i) => {
    palette[i * 3] = c.r;
    palette[i * 3 + 1] = c.g;
    palette[i * 3 + 2] = c.b;
    keyToIndex.set((c.r << 16) | (c.g << 8) | c.b, i);
  });

  const indices = new Uint8Array(image.width * image.height);
  for (let i = 0; i < indices.length; i += 1) {
    indices[i] = keyToIndex.get(pixelKeys[i]!)!;
  }

  return encodeIndexedPng({ width: image.width, height: image.height, palette, indices });
}
