/**
 * A BMP decoder (doc 02 §Image codecs).
 *
 * Ours rather than a host's, for the reason every codec here is ours: the bytes
 * that come out have to be identical in Node and in a browser, and a platform
 * decoder promises nothing of the sort. BMP is the easiest of the raster
 * formats to make that promise about, because there is no transform in it —
 * every pixel in the file is a pixel in the output, so "deterministic" is just
 * "reads the header correctly".
 *
 * Which is where the format's reputation comes from. There are four different
 * DIB headers in the wild, the rows run bottom-up unless the height is negative,
 * a scanline is padded to four bytes, the channel order is BGR, and 16- and
 * 32-bit images carry their channel layout in *masks* that may or may not be
 * present depending on which header and which compression code. All four
 * headers, both row orders and both run-length encodings are handled here;
 * embedded JPEG and PNG payloads (`BI_JPEG`, `BI_PNG`, which are a BMP wrapper
 * around another file entirely) are refused by name.
 */

import { DemakeError } from "../../errors.js";
import { makeRgba, type RgbaImage } from "../rgba.js";

/** Whether a byte string looks like a BMP. */
export function isBmp(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
}

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_JPEG = 4;
const BI_PNG = 5;
const BI_ALPHABITFIELDS = 6;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

function i32(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) | 0;
}

function bad(message: string, hint?: string): never {
  throw new DemakeError("E_BAD_INPUT", `BMP: ${message}`, hint === undefined ? {} : { hint });
}

/**
 * A channel mask reduced to a shift and a scale.
 *
 * A mask is any run of set bits, so a 5-bit channel has to be widened to 8 —
 * and widening it by a shift alone leaves white at 248 rather than 255. The
 * scale below maps the channel's full range onto 0–255 exactly, so a 5-bit
 * `11111` is 255 and a 1-bit mask is 0 or 255, which is what the format means.
 */
interface Channel {
  shift: number;
  mask: number;
  max: number;
}

function channelOf(mask: number): Channel | null {
  if (mask === 0) return null;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  const width = mask >>> shift;
  return { shift, mask: width, max: width };
}

function scaled(value: number, channel: Channel): number {
  // Integer round-half-up of `value * 255 / max`, so the arithmetic is exact and
  // the same everywhere rather than a float division rounded by the host.
  return Math.floor((value * 255 + (channel.max >> 1)) / channel.max);
}

/** Decode a BMP into an 8-bit RGBA raster. */
export function decodeBmp(bytes: Uint8Array): RgbaImage {
  if (!isBmp(bytes)) bad("not a BMP (bad signature)");
  if (bytes.length < 26) bad("truncated before the end of the header");

  const pixelOffset = u32(bytes, 10);
  const dibSize = u32(bytes, 14);

  // The 12-byte OS/2 header ("BITMAPCOREHEADER") stores its dimensions as 16-bit
  // and has no compression field at all; everything since Windows 3 is 40 bytes
  // or a superset of it. Nothing in between exists.
  const core = dibSize === 12;
  if (!core && dibSize < 40) bad(`unrecognised DIB header of ${dibSize} bytes`);

  // The two headers do not agree about where anything after the size lives: an
  // OS/2 header's dimensions are 16-bit and adjacent, a Windows one's are 32-bit
  // and therefore two bytes further apart.
  const width = core ? u16(bytes, 18) : i32(bytes, 18);
  const rawHeight = core ? u16(bytes, 20) : i32(bytes, 22);
  // A negative height means the rows are stored top-down. It is the only place
  // the format says which way up it is.
  const topDown = rawHeight < 0;
  const height = topDown ? -rawHeight : rawHeight;
  const bpp = core ? u16(bytes, 24) : u16(bytes, 28);
  const compression = core ? BI_RGB : u32(bytes, 30);

  if (width <= 0 || height <= 0) bad(`empty image (${width}×${rawHeight})`);
  if (compression === BI_JPEG || compression === BI_PNG) {
    bad(
      `the pixels are an embedded ${compression === BI_JPEG ? "JPEG" : "PNG"}`,
      "this is a BMP wrapper around another file — extract it and convert that instead",
    );
  }

  const paletteEntry = core ? 3 : 4;
  let paletteStart = 14 + dibSize;
  let masks: { r: number; g: number; b: number; a: number } | null = null;

  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    // On a 40-byte header the masks follow it, where the palette would go; on a
    // V4 header (108 bytes) and later they are *inside* it, at a fixed offset.
    if (dibSize >= 52) {
      masks = {
        r: u32(bytes, 14 + 40),
        g: u32(bytes, 14 + 44),
        b: u32(bytes, 14 + 48),
        a: dibSize >= 56 ? u32(bytes, 14 + 52) : 0,
      };
    } else {
      const extra = compression === BI_ALPHABITFIELDS ? 4 : 3;
      masks = {
        r: u32(bytes, paletteStart),
        g: u32(bytes, paletteStart + 4),
        b: u32(bytes, paletteStart + 8),
        a: extra === 4 ? u32(bytes, paletteStart + 12) : 0,
      };
      paletteStart += extra * 4;
    }
  } else if (dibSize >= 56 && (bpp === 16 || bpp === 32)) {
    // A V4/V5 header carries masks whether or not the compression code asks for
    // them; an all-zero set means "the default layout for this depth".
    const r = u32(bytes, 14 + 40);
    const g = u32(bytes, 14 + 44);
    const b = u32(bytes, 14 + 48);
    if ((r | g | b) !== 0) masks = { r, g, b, a: u32(bytes, 14 + 52) };
  }

  const image = makeRgba(width, height);
  const rowOf = (y: number): number => (topDown ? y : height - 1 - y) * width * 4;

  if (bpp <= 8) {
    const declared = core ? 0 : u32(bytes, 46);
    const count = declared > 0 ? declared : 1 << bpp;
    const palette = readPalette(bytes, paletteStart, count, paletteEntry);
    if (compression === BI_RLE8 || compression === BI_RLE4) {
      decodeRle(bytes, pixelOffset, image, palette, compression === BI_RLE4, topDown);
      return image;
    }
    unpackIndexed(bytes, pixelOffset, image, palette, bpp, rowOf);
    return image;
  }

  unpackDirect(bytes, pixelOffset, image, bpp, masks, rowOf);
  return image;
}

/** The colour table, as RGB triples. BMP stores it BGR(A), like everything else. */
function readPalette(bytes: Uint8Array, at: number, count: number, stride: number): Uint8Array {
  const palette = new Uint8Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const p = at + i * stride;
    palette[i * 3] = bytes[p + 2] ?? 0;
    palette[i * 3 + 1] = bytes[p + 1] ?? 0;
    palette[i * 3 + 2] = bytes[p] ?? 0;
  }
  return palette;
}

/** 1, 4 and 8 bits per pixel, straight out of the colour table. */
function unpackIndexed(
  bytes: Uint8Array,
  at: number,
  image: RgbaImage,
  palette: Uint8Array,
  bpp: number,
  rowOf: (y: number) => number,
): void {
  const { width, height, data } = image;
  // A scanline is padded to a four-byte boundary — the one thing about this
  // format that catches every first implementation.
  const stride = (((width * bpp + 7) >> 3) + 3) & ~3;
  const perByte = 8 / bpp;
  const mask = (1 << bpp) - 1;
  for (let y = 0; y < height; y += 1) {
    const row = at + y * stride;
    let out = rowOf(y);
    for (let x = 0; x < width; x += 1) {
      const byte = bytes[row + Math.floor(x / perByte)] ?? 0;
      const shift = 8 - bpp - (x % perByte) * bpp;
      const index = (byte >> shift) & mask;
      data[out] = palette[index * 3] ?? 0;
      data[out + 1] = palette[index * 3 + 1] ?? 0;
      data[out + 2] = palette[index * 3 + 2] ?? 0;
      data[out + 3] = 255;
      out += 4;
    }
  }
}

/** 16, 24 and 32 bits per pixel, through the channel masks when there are any. */
function unpackDirect(
  bytes: Uint8Array,
  at: number,
  image: RgbaImage,
  bpp: number,
  masks: { r: number; g: number; b: number; a: number } | null,
  rowOf: (y: number) => number,
): void {
  const { width, height, data } = image;
  const bytesPerPixel = bpp >> 3;
  const stride = (width * bytesPerPixel + 3) & ~3;

  // The defaults are the format's own: 5:5:5 at 16 bits (not 5:6:5 — that needs
  // BI_BITFIELDS to say so) and BGR(x) at 24 and 32.
  const fallback =
    bpp === 16
      ? { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0 }
      : { r: 0xff0000, g: 0x00ff00, b: 0x0000ff, a: 0 };
  const use = masks ?? fallback;
  const red = channelOf(use.r);
  const green = channelOf(use.g);
  const blue = channelOf(use.b);
  const alpha = channelOf(use.a);
  if (!red || !green || !blue) bad("a channel mask is empty");

  for (let y = 0; y < height; y += 1) {
    const row = at + y * stride;
    let out = rowOf(y);
    for (let x = 0; x < width; x += 1) {
      const p = row + x * bytesPerPixel;
      let value = 0;
      for (let byte = 0; byte < bytesPerPixel; byte += 1) {
        value |= (bytes[p + byte] ?? 0) << (byte * 8);
      }
      value >>>= 0;
      data[out] = scaled((value >>> red.shift) & red.mask, red);
      data[out + 1] = scaled((value >>> green.shift) & green.mask, green);
      data[out + 2] = scaled((value >>> blue.shift) & blue.mask, blue);
      // A 32-bit BMP with no alpha mask has a byte per pixel that means nothing,
      // and treating it as alpha is how a photograph comes out fully
      // transparent. Opaque unless the header actually claimed an alpha channel.
      data[out + 3] = alpha ? scaled((value >>> alpha.shift) & alpha.mask, alpha) : 255;
      out += 4;
    }
  }
}

/**
 * The two run-length encodings, which share a shape.
 *
 * A pair of bytes is either a run (count, colour) or, with a zero count, an
 * escape: 0 ends the line, 1 ends the image, 2 is a delta that *skips* pixels,
 * and anything else is a literal run padded to a word boundary. Skipped pixels
 * are left transparent, which is what the format means by them — a run-length
 * BMP is the one place this format has a hole in it.
 */
function decodeRle(
  bytes: Uint8Array,
  at: number,
  image: RgbaImage,
  palette: Uint8Array,
  half: boolean,
  topDown: boolean,
): void {
  const { width, height, data } = image;
  let x = 0;
  let y = 0;
  let pos = at;

  const plot = (index: number): void => {
    if (x >= width || y >= height) return;
    const out = ((topDown ? y : height - 1 - y) * width + x) * 4;
    data[out] = palette[index * 3] ?? 0;
    data[out + 1] = palette[index * 3 + 1] ?? 0;
    data[out + 2] = palette[index * 3 + 2] ?? 0;
    data[out + 3] = 255;
    x += 1;
  };

  while (pos + 1 < bytes.length) {
    const count = bytes[pos]!;
    const value = bytes[pos + 1]!;
    pos += 2;
    if (count > 0) {
      for (let i = 0; i < count; i += 1) {
        plot(half ? (i % 2 === 0 ? value >> 4 : value & 15) : value);
      }
      continue;
    }
    if (value === 0) {
      x = 0;
      y += 1;
      continue;
    }
    if (value === 1) return;
    if (value === 2) {
      x += bytes[pos] ?? 0;
      y += bytes[pos + 1] ?? 0;
      pos += 2;
      continue;
    }
    // A literal run. Four-bit runs pack two to a byte, and either way the run is
    // padded to an even number of bytes.
    const bytesUsed = half ? (value + 1) >> 1 : value;
    for (let i = 0; i < value; i += 1) {
      const byte = bytes[pos + (half ? i >> 1 : i)] ?? 0;
      plot(half ? (i % 2 === 0 ? byte >> 4 : byte & 15) : byte);
    }
    pos += bytesUsed + (bytesUsed & 1);
  }
}
