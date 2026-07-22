/**
 * Format-dispatching image decoder (doc 02 §Image codecs, doc 04 §Stage 0).
 *
 * The public entry point turns arbitrary input bytes into an {@link RgbaImage}.
 * PNG is decoded by our own pure-TS codec. JPEG/WebP/GIF/BMP are slated for
 * pinned, bit-deterministic WASM codecs (the jSquash/Squoosh builds, doc 02);
 * until those land, an unsupported format fails with a typed, actionable error
 * rather than a wrong guess — honesty over a silent bad decode.
 */

import { DemakeError } from "../errors.js";

import { decodePng, isPng } from "./png/decode.js";
import type { RgbaImage } from "./rgba.js";

/** A detectable input image format. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "unknown";

/** Sniff the container format from magic bytes. */
export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (isPng(bytes)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "bmp";
  }
  return "unknown";
}

/** Decode input bytes (any supported format) into an 8-bit RGBA raster. */
export function decodeImage(bytes: Uint8Array): RgbaImage {
  const format = detectFormat(bytes);
  if (format === "png") {
    return decodePng(bytes);
  }
  if (format === "unknown") {
    throw new DemakeError("E_BAD_INPUT", "input is not a recognized image format", {
      hint: "supported input in this build: PNG. JPEG/WebP/GIF/BMP support (WASM codecs) is planned.",
    });
  }
  throw new DemakeError(
    "E_UNSUPPORTED_FORMAT",
    `${format.toUpperCase()} decoding is not available in this build`,
    {
      hint: "convert the source to PNG first; pinned WASM codecs for JPEG/WebP/GIF/BMP arrive in a later release.",
      docs: "docs/02-architecture.md",
    },
  );
}
