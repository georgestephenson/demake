/**
 * Pure-TypeScript PNG encoder (doc 02, doc 04 §Stage 7).
 *
 * We write our own encoder to control palette ordering, to emit properly
 * indexed PNGs at the smallest bit depth that fits, and to guarantee
 * byte-determinism (no libpng version drift). Compression is stored-block
 * DEFLATE (see `deflate.ts`); filtering is fixed at "none" so the byte stream
 * is a pure function of the pixels — the encoder makes no heuristic choices.
 */

import { crc32 } from "./checksums.js";
import { deflateStored } from "./deflate.js";

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An indexed image ready to encode: palette + one byte-per-pixel indices. */
export interface IndexedImage {
  width: number;
  height: number;
  /** Palette entries as flat RGB (`palette.length === colorCount * 3`). */
  palette: Uint8Array;
  /** Optional per-entry alpha (`0..255`); shorter than the palette = opaque tail. */
  alpha?: Uint8Array;
  /** One palette index per pixel, row-major. */
  indices: Uint8Array;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  const crcAt = 8 + data.length;
  out[crcAt] = (crc >>> 24) & 0xff;
  out[crcAt + 1] = (crc >>> 16) & 0xff;
  out[crcAt + 2] = (crc >>> 8) & 0xff;
  out[crcAt + 3] = crc & 0xff;
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13);
  data[0] = (width >>> 24) & 0xff;
  data[1] = (width >>> 16) & 0xff;
  data[2] = (width >>> 8) & 0xff;
  data[3] = width & 0xff;
  data[4] = (height >>> 24) & 0xff;
  data[5] = (height >>> 16) & 0xff;
  data[6] = (height >>> 8) & 0xff;
  data[7] = height & 0xff;
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return data;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Smallest PNG index bit depth (1/2/4/8) that addresses `colorCount` entries. */
function indexBitDepth(colorCount: number): 1 | 2 | 4 | 8 {
  if (colorCount <= 2) return 1;
  if (colorCount <= 4) return 2;
  if (colorCount <= 16) return 4;
  return 8;
}

/** Pack one scanline of indices at `bitDepth`, MSB-first, with a leading filter byte. */
function packRow(
  indices: Uint8Array,
  y: number,
  width: number,
  bitDepth: number,
  rowBytes: number,
): Uint8Array {
  const row = new Uint8Array(1 + rowBytes); // filter byte 0 (none) + samples
  if (bitDepth === 8) {
    row.set(indices.subarray(y * width, y * width + width), 1);
    return row;
  }
  const perByte = 8 / bitDepth;
  for (let x = 0; x < width; x += 1) {
    const value = indices[y * width + x]!;
    const byteIndex = 1 + Math.floor(x / perByte);
    const shift = 8 - bitDepth * ((x % perByte) + 1);
    row[byteIndex]! |= (value & ((1 << bitDepth) - 1)) << shift;
  }
  return row;
}

/** Encode an {@link IndexedImage} to indexed PNG bytes (color type 3). */
export function encodeIndexedPng(image: IndexedImage): Uint8Array {
  const colorCount = Math.floor(image.palette.length / 3);
  const bitDepth = indexBitDepth(colorCount);
  const rowBytes = Math.ceil((image.width * bitDepth) / 8);

  const rows: Uint8Array[] = [];
  for (let y = 0; y < image.height; y += 1) {
    rows.push(packRow(image.indices, y, image.width, bitDepth, rowBytes));
  }
  const rawData = concat(rows);

  const chunks: Uint8Array[] = [
    SIGNATURE,
    chunk("IHDR", ihdr(image.width, image.height, bitDepth, 3)),
    chunk("PLTE", image.palette),
  ];
  if (image.alpha && image.alpha.length > 0) {
    chunks.push(chunk("tRNS", image.alpha));
  }
  chunks.push(chunk("IDAT", deflateStored(rawData)));
  chunks.push(chunk("IEND", new Uint8Array(0)));
  return concat(chunks);
}

/** Encode a raw 8-bit RGBA raster to truecolor-with-alpha PNG (color type 6). */
export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowBytes = width * 4;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(1 + rowBytes);
    row.set(rgba.subarray(y * rowBytes, y * rowBytes + rowBytes), 1);
    rows.push(row);
  }
  const rawData = concat(rows);

  return concat([
    SIGNATURE,
    chunk("IHDR", ihdr(width, height, 8, 6)),
    chunk("IDAT", deflateStored(rawData)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
