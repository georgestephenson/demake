/**
 * Format-dispatching image decoder (doc 02 §Image codecs, doc 04 §Stage 0).
 *
 * The public entry point turns arbitrary input bytes into an {@link RgbaImage}.
 * Every codec behind it is ours — PNG, SVG, JPEG, GIF and BMP — for one reason:
 * the bytes that come out have to be identical in Node and in a browser, and a
 * host decoder makes no such promise. That matters most for the one lossy
 * format in the list, because the standard specifies JPEG's inverse transform
 * only to a *tolerance*: two libraries genuinely disagree in the low bit of an
 * edge pixel, so a demake fitted from the page's decode and one fitted from the
 * CLI's would differ, and the difference would surface two layers down as a
 * palette that could not be explained.
 *
 * WebP is the one that is still absent, and it is absent loudly: it is VP8, a
 * whole video codec's intra path, and a typed error naming it is a better answer
 * than a guess (doc 02).
 */

import { DemakeError } from "../errors.js";

import { decodeBmp, isBmp } from "./bmp/decode.js";
import { decodeGif, isGif } from "./gif/decode.js";
import { decodeJpeg, isJpeg } from "./jpeg/decode.js";
import { decodePng, isPng } from "./png/decode.js";
import { isSvg, rasterizeSvg, svgIntrinsicSize } from "./svg/index.js";
import { decodeUtf8 } from "./svg/utf8.js";
import type { RgbaImage } from "./rgba.js";

/** A detectable input image format. */
export type ImageFormat = "png" | "svg" | "jpeg" | "gif" | "webp" | "bmp" | "unknown";

/**
 * Sniff the container format from magic bytes.
 *
 * The sniff each codec already owns, called rather than restated: a second copy
 * of "what a GIF looks like" is a second answer, and the one that decides which
 * decoder runs must be the one the decoder itself agrees with.
 */
export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (isPng(bytes)) return "png";
  if (isSvg(bytes)) return "svg";
  if (isJpeg(bytes)) return "jpeg";
  if (isGif(bytes)) return "gif";
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
  if (isBmp(bytes)) return "bmp";
  return "unknown";
}

/** How a caller wants the bytes turned into pixels. */
export interface DecodeOptions {
  /**
   * The raster a **vector** source should at least cover.
   *
   * A drawing has no pixels of its own, so rasterising it at whatever size its
   * author happened to declare and then scaling *that* up to the demake's target
   * throws away detail that was never lost — a 64×64 `<svg>` asked for at
   * 160×144 came out as a 64×64 raster stretched, when the same file could have
   * been drawn at 160×144 exactly. Passing the target here rasterises it once,
   * at a size that covers the target, **keeping the document's own aspect
   * ratio** so every framing decision downstream (`--fit`, the auto size, the
   * sprite box) means precisely what it meant before.
   *
   * Ignored for every other format, where the pixels are the file: asking a
   * 64×64 PNG for more of them is an upscale whichever layer performs it, and
   * the pipeline's own scale kernels are the ones the strategy chose.
   */
  atLeast?: { width: number; height: number };
}

/** Decode input bytes (any supported format) into an 8-bit RGBA raster. */
export function decodeImage(bytes: Uint8Array, options: DecodeOptions = {}): RgbaImage {
  const format = detectFormat(bytes);
  if (format === "png") {
    return decodePng(bytes);
  }
  if (format === "svg") {
    const text = decodeUtf8(bytes);
    return rasterizeSvg(text, vectorRaster(text, options.atLeast));
  }
  if (format === "jpeg") {
    return decodeJpeg(bytes);
  }
  if (format === "gif") {
    return decodeGif(bytes);
  }
  if (format === "bmp") {
    return decodeBmp(bytes);
  }
  if (format === "unknown") {
    throw new DemakeError("E_BAD_INPUT", "input is not a recognized image format", {
      hint: "supported input: PNG, SVG, JPEG, GIF and BMP.",
    });
  }
  throw new DemakeError(
    "E_UNSUPPORTED_FORMAT",
    `${format.toUpperCase()} decoding is not available in this build`,
    {
      hint: "convert the source to PNG first — WebP is VP8, a video codec's intra path, and decoding it deterministically is a later release.",
      docs: "docs/02-architecture.md",
    },
  );
}

/**
 * How big to draw a vector source, given what the caller is going to need.
 *
 * `{}` — the rasteriser's own default, which is the document's declared size —
 * whenever that already covers the target, so every conversion that was
 * downscaling a drawing (which is all of them, until somebody asks for an output
 * bigger than the file says it is) produces exactly the bytes it always did. The
 * scale is taken on the *longer* shortfall and applied to both axes, so the
 * document's framing is untouched and only its resolution moves.
 */
function vectorRaster(
  text: string,
  atLeast: { width: number; height: number } | undefined,
): { width?: number; height?: number } {
  if (!atLeast || atLeast.width <= 0 || atLeast.height <= 0) return {};
  const own = svgIntrinsicSize(text);
  const scale = Math.max(atLeast.width / own.width, atLeast.height / own.height);
  if (scale <= 1) return {};
  return {
    width: Math.max(1, Math.round(own.width * scale)),
    height: Math.max(1, Math.round(own.height * scale)),
  };
}
