/**
 * Pure-TypeScript PNG decoder (doc 02 §Image codecs and determinism).
 *
 * PNG is lossless, so any correct decoder is bit-identical — but we ship our own
 * to control ancillary-chunk and bit-depth handling and to stay platform-pure.
 * Supports the full baseline color-type/bit-depth matrix (grayscale, truecolor,
 * palette, and their alpha variants) with `tRNS` transparency, producing 8-bit
 * RGBA. Interlaced (Adam7) PNGs are rejected with a clear error — the encoder
 * never writes them and sources are rarely interlaced.
 */

import type { RgbaImage } from "../rgba.js";

import { crc32 } from "./checksums.js";
import { inflateZlib } from "./inflate.js";

/** Thrown when the input is not a valid/supported PNG. */
export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

/** Is this byte stream a PNG (signature check only)? */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== SIGNATURE[i]) return false;
  }
  return true;
}

function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // truecolor
    case 3:
      return 1; // palette index
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // truecolor + alpha
    default:
      throw new PngDecodeError(`unsupported PNG color type ${colorType}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverse the per-scanline PNG filters in place, returning packed samples. */
function unfilter(
  raw: Uint8Array,
  header: Header,
  bytesPerPixel: number,
  rowBytes: number,
): Uint8Array {
  const out = new Uint8Array(header.height * rowBytes);
  let inPos = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[inPos]!;
    inPos += 1;
    const rowStart = y * rowBytes;
    const prevStart = rowStart - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const rawByte = raw[inPos]!;
      inPos += 1;
      const a = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel]! : 0;
      const b = y > 0 ? out[prevStart + x]! : 0;
      const c = y > 0 && x >= bytesPerPixel ? out[prevStart + x - bytesPerPixel]! : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new PngDecodeError(`unknown PNG filter type ${filter}`);
      }
      out[rowStart + x] = value & 0xff;
    }
  }
  return out;
}

/** Read one sample of `bitDepth` bits from a scanline's bit-packed samples. */
function sampleReader(row: Uint8Array, bitDepth: number): (index: number) => number {
  if (bitDepth === 8) {
    return (index) => row[index]!;
  }
  if (bitDepth === 16) {
    return (index) => row[index * 2]!; // high byte; we downconvert 16→8
  }
  // 1/2/4-bit packed, MSB first.
  const mask = (1 << bitDepth) - 1;
  const perByte = 8 / bitDepth;
  return (index) => {
    const byte = row[Math.floor(index / perByte)]!;
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    return (byte >> shift) & mask;
  };
}

function scaleSample(value: number, bitDepth: number): number {
  if (bitDepth === 8 || bitDepth === 16) return value;
  const maxIn = (1 << bitDepth) - 1;
  return Math.round((value / maxIn) * 255);
}

/** Decode a PNG byte stream into an 8-bit {@link RgbaImage}. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) {
    throw new PngDecodeError("not a PNG (bad signature)");
  }
  let pos = 8;
  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  while (pos + 8 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = String.fromCharCode(
      bytes[pos + 4]!,
      bytes[pos + 5]!,
      bytes[pos + 6]!,
      bytes[pos + 7]!,
    );
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new PngDecodeError(`truncated chunk '${type}'`);
    }
    const expectedCrc = readU32(bytes, dataEnd);
    const actualCrc = crc32(bytes, pos + 4, dataEnd);
    if (expectedCrc !== actualCrc) {
      throw new PngDecodeError(`CRC mismatch in chunk '${type}'`);
    }
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      header = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8]!,
        colorType: data[9]!,
        interlace: data[12]!,
      };
      if (header.interlace !== 0) {
        throw new PngDecodeError("interlaced PNGs are not supported");
      }
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "tRNS") {
      trns = data.slice();
    } else if (type === "IDAT") {
      idat.push(data.slice());
    } else if (type === "IEND") {
      break;
    }
    pos = dataEnd + 4;
  }

  if (!header) {
    throw new PngDecodeError("missing IHDR");
  }
  if (header.width <= 0 || header.height <= 0) {
    throw new PngDecodeError("invalid image dimensions");
  }

  let idatLen = 0;
  for (const part of idat) idatLen += part.length;
  const compressed = new Uint8Array(idatLen);
  let o = 0;
  for (const part of idat) {
    compressed.set(part, o);
    o += part.length;
  }

  const channels = channelsForColorType(header.colorType);
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((channels * header.bitDepth) / 8));

  const raw = inflateZlib(compressed, (rowBytes + 1) * header.height);
  const packed = unfilter(raw, header, bytesPerPixel, rowBytes);

  const out = new Uint8Array(header.width * header.height * 4);

  for (let y = 0; y < header.height; y += 1) {
    const row = packed.subarray(y * rowBytes, (y + 1) * rowBytes);
    const sample = sampleReader(row, header.bitDepth);
    for (let x = 0; x < header.width; x += 1) {
      const oi = (y * header.width + x) * 4;
      writePixel(out, oi, header, sample, x, channels, palette, trns);
    }
  }

  return { width: header.width, height: header.height, data: out };
}

function writePixel(
  out: Uint8Array,
  oi: number,
  header: Header,
  sample: (index: number) => number,
  x: number,
  channels: number,
  palette: Uint8Array | undefined,
  trns: Uint8Array | undefined,
): void {
  const base = x * channels;
  const bd = header.bitDepth;
  switch (header.colorType) {
    case 0: {
      const g = scaleSample(sample(base), bd);
      out[oi] = g;
      out[oi + 1] = g;
      out[oi + 2] = g;
      out[oi + 3] = grayTransparent(trns, sample(base)) ? 0 : 255;
      break;
    }
    case 2: {
      const r = scaleSample(sample(base), bd);
      const g = scaleSample(sample(base + 1), bd);
      const b = scaleSample(sample(base + 2), bd);
      out[oi] = r;
      out[oi + 1] = g;
      out[oi + 2] = b;
      out[oi + 3] = rgbTransparent(trns, sample(base), sample(base + 1), sample(base + 2))
        ? 0
        : 255;
      break;
    }
    case 3: {
      const index = sample(base);
      if (!palette) throw new PngDecodeError("indexed PNG without PLTE");
      out[oi] = palette[index * 3] ?? 0;
      out[oi + 1] = palette[index * 3 + 1] ?? 0;
      out[oi + 2] = palette[index * 3 + 2] ?? 0;
      out[oi + 3] = trns && index < trns.length ? trns[index]! : 255;
      break;
    }
    case 4: {
      const g = scaleSample(sample(base), bd);
      out[oi] = g;
      out[oi + 1] = g;
      out[oi + 2] = g;
      out[oi + 3] = scaleSample(sample(base + 1), bd);
      break;
    }
    case 6: {
      out[oi] = scaleSample(sample(base), bd);
      out[oi + 1] = scaleSample(sample(base + 1), bd);
      out[oi + 2] = scaleSample(sample(base + 2), bd);
      out[oi + 3] = scaleSample(sample(base + 3), bd);
      break;
    }
    default:
      throw new PngDecodeError(`unsupported color type ${header.colorType}`);
  }
}

function grayTransparent(trns: Uint8Array | undefined, value: number): boolean {
  if (!trns || trns.length < 2) return false;
  // The transparent gray is stored as a 2-byte sample; for bit depths ≤ 8 the
  // meaningful value sits in the low bits and equals our raw (unscaled) sample.
  const key = (trns[0]! << 8) | trns[1]!;
  return key === value;
}

function rgbTransparent(trns: Uint8Array | undefined, r: number, g: number, b: number): boolean {
  if (!trns || trns.length < 6) return false;
  const kr = (trns[0]! << 8) | trns[1]!;
  const kg = (trns[2]! << 8) | trns[3]!;
  const kb = (trns[4]! << 8) | trns[5]!;
  return kr === r && kg === g && kb === b;
}
