/**
 * Shared extensive image battery + framebuffer utilities for the pixel-perfect
 * emulator E2Es (doc 10). Every console family is exercised with the *same*
 * deliberately-extreme cases the GB family established — flat fill, a full-screen
 * smooth gradient and full-screen noise (which stress the tile budget and any
 * second VRAM bank), mirror symmetry (flip dedup), per-cell palettes, and the
 * 8×8 minimum — scaled to each console's full screen. Keeping the battery in one
 * place means "run the same tests where appropriate" is literally true: NES, SMS,
 * GG (and beyond) all march through the identical case set, differing only in the
 * per-family harness that boots the ROM.
 */

import { encodeRgbaPng } from "@demake/core";

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Deterministic image builder (RGBA PNG). */
export function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(w, h, d);
}

/** A deterministic LCG for the noise case (no Math.random → reproducible). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * The extensive case battery scaled to a console's full screen (`fullW`×`fullH`).
 * The "full" gradient and noise cases fill the whole display, so they exercise
 * the tile budget and, on tiled consoles, every name-table entry; the smaller
 * cases pin down flip dedup, per-cell palettes, and the minimum tile.
 */
export function makeBattery(fullW: number, fullH: number): Record<string, Uint8Array> {
  return {
    flat: image(64, 64, () => [80, 140, 200]),
    "gradient-full": image(fullW, fullH, (x, y) => [
      clamp((x * 255) / (fullW - 1)),
      clamp((y * 255) / (fullH - 1)),
      128,
    ]),
    "noise-full": (() => {
      const r = lcg(7);
      return image(fullW, fullH, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
    })(),
    hmirror: image(64, 64, (x, y) => [(x < 32 ? x : 63 - x) * 8, y * 4, 100]),
    manycolors: image(64, 64, (x, y) => [
      ((x >> 3) * 40) % 256,
      ((y >> 3) * 40) % 256,
      (((x >> 3) + (y >> 3)) * 30) % 256,
    ]),
    tiny: image(8, 8, (x, y) => [x * 32, y * 32, 0]),
  };
}

/** Parse a binary PPM (P6). Returns the width and the pixel bytes (RGB). */
export function readPpm(bytes: Uint8Array): { w: number; h: number; data: Uint8Array } {
  const tokens: string[] = [];
  let pos = 0;
  const ws = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
  while (tokens.length < 4) {
    while (ws(bytes[pos]!)) pos += 1;
    let s = "";
    while (pos < bytes.length && !ws(bytes[pos]!)) s += String.fromCharCode(bytes[pos++]!);
    tokens.push(s);
  }
  pos += 1;
  return { w: Number(tokens[1]), h: Number(tokens[2]), data: bytes.subarray(pos) };
}

/** Reduce an 8-bit RGB triple to the RGB565 the 16-bit cores natively render. */
export const to565 = (r: number, g: number, b: number): number =>
  ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/**
 * Reduce an 8-bit RGB triple to RGB555 — the comparison space for cores whose
 * framebuffer is 16-bit but whose console is a 15-bit machine, and which widen
 * green by a plain shift rather than bit replication (mGBA, DeSmuME: the 565
 * green field is always `g5 << 1`, so its sixth bit carries no information).
 * Reducing both sides to 555 compares exactly the bits the hardware has.
 */
export const to555 = (r: number, g: number, b: number): number =>
  ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/**
 * Count pixels where the emulator frame's top-left region disagrees with the
 * DAC reference. `map` maps an RGB triple to the comparison space (identity for
 * exact 8-bit cores; {@link to565} for the 16-bit cores).
 */
export function countMismatches(
  frame: { w: number; data: Uint8Array },
  ref: { width: number; height: number; data: Uint8Array },
  map: (r: number, g: number, b: number) => number = (r, g, b) => (r << 16) | (g << 8) | b,
): number {
  let mismatches = 0;
  for (let y = 0; y < ref.height; y += 1) {
    for (let x = 0; x < ref.width; x += 1) {
      const p = (y * frame.w + x) * 3;
      const r = (y * ref.width + x) * 4;
      const emu = map(frame.data[p]!, frame.data[p + 1]!, frame.data[p + 2]!);
      const want = map(ref.data[r]!, ref.data[r + 1]!, ref.data[r + 2]!);
      if (emu !== want) mismatches += 1;
    }
  }
  return mismatches;
}
