import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { adler32, crc32 } from "../src/image/png/checksums.js";
import { decodePng } from "../src/image/png/decode.js";
import { encodeIndexedPng, encodeRgbaPng } from "../src/image/png/encode.js";
import { inflateZlib } from "../src/image/png/inflate.js";
import { decodeImage, detectFormat } from "../src/image/decode.js";

/** Build a minimal truecolor+alpha PNG using Node's zlib (real DEFLATE). */
function makeCompressedRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const rowBytes = width * 4;
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0; // filter none
    raw.set(rgba.subarray(y * rowBytes, y * rowBytes + rowBytes), y * (rowBytes + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw), { level: 9 }));

  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: Uint8Array): number[] => {
    const body = new Uint8Array(4 + data.length);
    body[0] = type.charCodeAt(0);
    body[1] = type.charCodeAt(1);
    body[2] = type.charCodeAt(2);
    body[3] = type.charCodeAt(3);
    body.set(data, 4);
    const crc = crc32(body);
    const len = data.length;
    return [
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...body,
      (crc >>> 24) & 0xff,
      (crc >>> 16) & 0xff,
      (crc >>> 8) & 0xff,
      crc & 0xff,
    ];
  };
  const ihdr = new Uint8Array([
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    6,
    0,
    0,
    0,
  ]);
  return new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("checksums", () => {
  it("crc32 matches known value for 'IEND'", () => {
    expect(crc32(new Uint8Array([0x49, 0x45, 0x4e, 0x44]))).toBe(0xae426082);
  });
  it("adler32 of empty is 1", () => {
    expect(adler32(new Uint8Array(0))).toBe(1);
  });
});

describe("inflate", () => {
  it("reads a real zlib (dynamic Huffman) stream", () => {
    const original = new Uint8Array(2048);
    for (let i = 0; i < original.length; i += 1) {
      original[i] = (i * 7 + (i >> 3)) & 0xff;
    }
    const compressed = new Uint8Array(deflateSync(Buffer.from(original), { level: 9 }));
    const out = inflateZlib(compressed);
    expect(out.length).toBe(original.length);
    expect(Array.from(out)).toEqual(Array.from(original));
  });
});

describe("PNG round-trip", () => {
  it("encodes and decodes an indexed image", () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const indices = new Uint8Array([0, 1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 1]);
    const png = encodeIndexedPng({ width: 4, height: 3, palette, indices });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    // pixel (0,0) is palette[0] = red, opaque
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    // pixel (3,0) is palette[3] = white
    expect(Array.from(decoded.data.subarray(12, 16))).toEqual([255, 255, 255, 255]);
  });

  it("indexed encode chooses a sub-8-bit depth for small palettes", () => {
    const palette = new Uint8Array([0, 0, 0, 255, 255, 255]); // 2 colors → 1bpp
    const indices = new Uint8Array([0, 1, 1, 0]);
    const png = encodeIndexedPng({ width: 2, height: 2, palette, indices });
    const decoded = decodePng(png);
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    expect(Array.from(decoded.data.subarray(4, 8))).toEqual([255, 255, 255, 255]);
  });

  it("carries palette alpha via tRNS", () => {
    const palette = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const alpha = new Uint8Array([0]); // index 0 fully transparent
    const indices = new Uint8Array([0, 1]);
    const png = encodeIndexedPng({ width: 2, height: 1, palette, alpha, indices });
    const decoded = decodePng(png);
    expect(decoded.data[3]).toBe(0);
    expect(decoded.data[7]).toBe(255);
  });

  it("round-trips a raw RGBA image", () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 4, 5, 6, 128]);
    const png = encodeRgbaPng(2, 1, rgba);
    const decoded = decodePng(png);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });

  it("decodes a real zlib-compressed truecolor PNG", () => {
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i += 1) {
      rgba[i * 4] = i * 16;
      rgba[i * 4 + 1] = 255 - i * 16;
      rgba[i * 4 + 2] = (i * 32) & 0xff;
      rgba[i * 4 + 3] = 255;
    }
    const png = makeCompressedRgbaPng(4, 4, rgba);
    const decoded = decodeImage(png);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
  });
});

describe("format detection", () => {
  it("detects PNG and reports unsupported formats", () => {
    const png = encodeRgbaPng(1, 1, new Uint8Array([0, 0, 0, 255]));
    expect(detectFormat(png)).toBe("png");
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("jpeg");
    expect(() => decodeImage(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toThrow(/JPEG/);
  });
});
