/**
 * The pipeline's decoded-image buffer.
 *
 * `RgbaImage` is 8-bit non-premultiplied sRGB RGBA, row-major — the common
 * currency between the codecs (which produce it) and Stage 0 (which normalizes
 * it into linear-light working buffers). Kept as flat typed arrays, never
 * per-pixel objects, per the performance rules (doc 04 §Performance).
 */

/** An 8-bit RGBA raster: `data.length === width * height * 4`. */
export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA bytes, row-major, non-premultiplied. */
  data: Uint8Array;
}

/** Allocate a blank (transparent) RGBA image. */
export function makeRgba(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Byte offset of pixel (x, y) in an {@link RgbaImage}. */
export function pixelOffset(image: RgbaImage, x: number, y: number): number {
  return (y * image.width + x) * 4;
}
