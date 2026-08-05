/**
 * The raster decoders — BMP, GIF and baseline JPEG — against a second
 * implementation.
 *
 * These are ours for the reason every codec here is ours: the pipeline's output
 * bytes have to be identical in Node and in a browser, and a host decoder
 * promises nothing of the sort. That makes the oracle problem real, because a
 * decoder tested only against an encoder written beside it agrees with itself
 * and with nothing else — the same argument `arm-gnu.test.ts` makes about an
 * instruction encoder.
 *
 * So the fixtures in `fixtures/` are a *pair*: the file, and the RGBA Chromium
 * produced from those exact bytes. The BMPs and GIFs were written from the spec
 * and the JPEGs came out of Chromium's own encoder, so at no point does one of
 * our own functions stand in for the format's definition.
 *
 * What each is held to differs, and it differs for a reason. BMP and GIF are
 * **lossless**, so the comparison is exact: a single byte out is a bug. JPEG is
 * not — the standard specifies the inverse transform only to a tolerance, and
 * two correct decoders genuinely disagree in the low bits — so the comparison is
 * a bound. It is a *tight* bound (±2 of Chromium, on every channel of every
 * pixel) precisely because a loose one would pass a decoder that had the chroma
 * upsampling wrong, which is what a first attempt here did: replicating the
 * chroma sample instead of interpolating it was up to 110 levels out and still
 * looked like a photograph.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DemakeError } from "../src/errors.js";
import { decodeImage, detectFormat } from "../src/image/decode.js";
import { decodeBmp } from "../src/image/bmp/decode.js";
import { decodeGif } from "../src/image/gif/decode.js";
import { decodeJpeg } from "../src/image/jpeg/decode.js";

const here = fileURLToPath(new URL("./fixtures/", import.meta.url));
const load = (name: string): Uint8Array => new Uint8Array(readFileSync(here + name));

/** The fixture, and what Chromium made of it. */
function pair(name: string): { bytes: Uint8Array; reference: Uint8Array } {
  return { bytes: load(name), reference: load(`${name}.rgba`) };
}

/** The largest per-channel disagreement with the reference, alpha included. */
function worstDelta(mine: Uint8Array, reference: Uint8Array): number {
  let worst = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const delta = Math.abs((mine[i] ?? 0) - (reference[i] ?? 0));
    if (delta > worst) worst = delta;
  }
  return worst;
}

const WIDTH = 24;
const HEIGHT = 16;

/** A one-row 32-bit BMP with a V4 header, written here so the bytes are visible. */
function bmp32(pixels: readonly (readonly number[])[], alphaMask: boolean): Uint8Array {
  const dib = 108;
  const bytes = new Uint8Array(14 + dib + pixels.length * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(10, 14 + dib, true);
  view.setUint32(14, dib, true);
  view.setInt32(18, pixels.length, true);
  view.setInt32(22, -1, true); // one row, top-down
  view.setUint16(26, 1, true);
  view.setUint16(28, 32, true);
  view.setUint32(30, 3, true); // BI_BITFIELDS
  view.setUint32(14 + 40, 0x00ff0000, true);
  view.setUint32(14 + 44, 0x0000ff00, true);
  view.setUint32(14 + 48, 0x000000ff, true);
  view.setUint32(14 + 52, alphaMask ? 0xff000000 : 0, true);
  pixels.forEach((pixel, at) => bytes.set(pixel, 14 + dib + at * 4));
  return bytes;
}

/** A one-row 16-bit BMP in 5:6:5, which needs BI_BITFIELDS to say so. */
function bmp16(pixels: readonly number[]): Uint8Array {
  const dib = 40;
  const stride = (pixels.length * 2 + 3) & ~3;
  const bytes = new Uint8Array(14 + dib + 12 + stride);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(10, 14 + dib + 12, true);
  view.setUint32(14, dib, true);
  view.setInt32(18, pixels.length, true);
  view.setInt32(22, -1, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 16, true);
  view.setUint32(30, 3, true);
  // On a 40-byte header the masks sit where the colour table would.
  view.setUint32(14 + dib, 0xf800, true);
  view.setUint32(14 + dib + 4, 0x07e0, true);
  view.setUint32(14 + dib + 8, 0x001f, true);
  pixels.forEach((pixel, at) => view.setUint16(14 + dib + 12 + at * 2, pixel, true));
  return bytes;
}

/** A palettised BMP, rows given top-down and stored the way the format wants. */
function indexedBmp(
  bpp: number,
  width: number,
  height: number,
  palette: readonly (readonly number[])[],
  rows: readonly (readonly number[])[],
): Uint8Array {
  const dib = 40;
  const stride = (((width * bpp + 7) >> 3) + 3) & ~3;
  const bytes = new Uint8Array(14 + dib + palette.length * 4 + stride * height);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  const start = 14 + dib + palette.length * 4;
  view.setUint32(10, start, true);
  view.setUint32(14, dib, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive: bottom-up
  view.setUint16(26, 1, true);
  view.setUint16(28, bpp, true);
  view.setUint32(46, palette.length, true);
  palette.forEach(([r, g, b], at) => {
    bytes[14 + dib + at * 4] = b!;
    bytes[14 + dib + at * 4 + 1] = g!;
    bytes[14 + dib + at * 4 + 2] = r!;
  });
  rows.forEach((row, y) => bytes.set(row, start + (height - 1 - y) * stride));
  return bytes;
}

/** An 8-bit run-length BMP over a literal command stream. */
function rleBmp(
  width: number,
  height: number,
  palette: readonly (readonly number[])[],
  stream: readonly number[],
): Uint8Array {
  const dib = 40;
  const bytes = new Uint8Array(14 + dib + palette.length * 4 + stream.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  const start = 14 + dib + palette.length * 4;
  view.setUint32(10, start, true);
  view.setUint32(14, dib, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 8, true);
  view.setUint32(30, 1, true); // BI_RLE8
  view.setUint32(46, palette.length, true);
  palette.forEach(([r, g, b], at) => {
    bytes[14 + dib + at * 4] = b!;
    bytes[14 + dib + at * 4 + 1] = g!;
    bytes[14 + dib + at * 4 + 2] = r!;
  });
  bytes.set(stream, start);
  return bytes;
}

/**
 * One row as palette indices, with `-1` for a pixel nothing wrote.
 *
 * The palettes above are distinct enough to invert, which keeps the assertions
 * readable: an index says what a run laid down, where four RGBA bytes say only
 * that something did.
 */
function rowOf(image: { width: number; data: Uint8Array }, y: number): number[] {
  const table = ["0,0,0", "255,255,255", "255,0,0", "0,255,0"];
  const out: number[] = [];
  for (let x = 0; x < image.width; x += 1) {
    const at = (y * image.width + x) * 4;
    if (image.data[at + 3] === 0) {
      out.push(-1);
      continue;
    }
    out.push(table.indexOf(`${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`));
  }
  return out;
}

describe("BMP", () => {
  // Three files, three of the format's genuinely different shapes: 24-bit
  // bottom-up, 8-bit through a colour table, and a top-down 32-bit V4 header
  // whose channel layout is in its masks rather than implied by its depth.
  for (const name of ["pattern-24.bmp", "pattern-8.bmp", "pattern-32.bmp"]) {
    it(`decodes ${name} exactly as Chromium does`, () => {
      const { bytes, reference } = pair(name);
      expect(detectFormat(bytes)).toBe("bmp");
      const image = decodeBmp(bytes);
      expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
      expect([...image.data]).toEqual([...reference]);
    });
  }

  // Translucency is checked by hand rather than against Chromium, because the
  // reference comes out of a canvas and a canvas stores premultiplied alpha:
  // reading a half-transparent pixel back is a level or two off whatever wrote
  // it, so the *oracle's* rounding would present as our error.
  it("reads a 32-bit alpha channel, or leaves the pixel opaque when there is none", () => {
    const pixels = [
      [0x10, 0x20, 0x30, 0x40],
      [0x40, 0x30, 0x20, 0xff],
    ];
    // A 32-bit BMP with no alpha mask has a fourth byte per pixel that means
    // nothing at all, and reading it as alpha is how a photograph comes out
    // invisible. So: the same bytes, twice, differing only in whether the header
    // claims an alpha channel.
    const withMask = bmp32(pixels, true);
    const without = bmp32(pixels, false);

    expect([...decodeBmp(withMask).data]).toEqual([0x30, 0x20, 0x10, 0x40, 0x20, 0x30, 0x40, 0xff]);
    expect([...decodeBmp(without).data]).toEqual([0x30, 0x20, 0x10, 0xff, 0x20, 0x30, 0x40, 0xff]);
  });

  it("widens a narrow channel to white rather than to almost-white", () => {
    // 5:6:5 through BI_BITFIELDS. All bits set has to come out 255 on every
    // channel; a plain shift leaves it at 248, which is a picture whose whites
    // are grey and whose palette fit then spends a slot saying so.
    const bytes = bmp16([0xffff, 0x0000, 0xf800, 0x07e0]);
    expect([...decodeBmp(bytes).data]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255,
    ]);
  });

  it("unpacks the sub-byte depths, padding each row to four bytes", () => {
    // The padding is the thing that catches every first implementation: five
    // 4-bit pixels are three bytes of data in a four-byte row, so a decoder that
    // walked the data densely would shear the picture by a pixel a line.
    const palette = [
      [0, 0, 0],
      [0xff, 0xff, 0xff],
      [0xff, 0, 0],
      [0, 0xff, 0],
    ];
    // Five 1-bit pixels: one byte of data in a four-byte row, most significant
    // bit first. The rows go in top-down here and come out of the file
    // bottom-up, which is `indexedBmp`'s doing rather than the decoder's.
    const mono = indexedBmp(1, 5, 2, palette, [[0b01010000], [0b10101000]]);
    expect(rowOf(decodeBmp(mono), 0)).toEqual([0, 1, 0, 1, 0]);
    expect(rowOf(decodeBmp(mono), 1)).toEqual([1, 0, 1, 0, 1]);

    const nibbles = indexedBmp(4, 5, 1, palette, [[0x01, 0x23, 0x10]]);
    expect(rowOf(decodeBmp(nibbles), 0)).toEqual([0, 1, 2, 3, 1]);
  });

  it("decodes a run-length BMP, escapes and all", () => {
    // Runs, a literal run padded to a word, a delta that skips, and the
    // end-of-image escape. Skipped pixels stay transparent, which is what the
    // format means by them — a run-length BMP is the one place it has a hole.
    const palette = [
      [0, 0, 0],
      [0xff, 0xff, 0xff],
      [0xff, 0, 0],
      [0, 0xff, 0],
    ];
    // The rows arrive bottom-up, so the first thing this stream draws is the
    // *last* row of the picture.
    const image = decodeBmp(
      rleBmp(4, 2, palette, [
        0x02,
        0x01, // a run: two of index 1
        0x00,
        0x02,
        0x01,
        0x00, // a delta: one across, none down — x=2 is skipped
        0x01,
        0x03, // a run: one of index 3
        0x00,
        0x00, // end of line
        0x00,
        0x03,
        0x02,
        0x03,
        0x00,
        0x00, // a literal 2,3,0 — three bytes, padded to four
        0x00,
        0x01, // end of image
      ]),
    );
    expect(rowOf(image, 1)).toEqual([1, 1, -1, 3]);
    expect(rowOf(image, 0)).toEqual([2, 3, 0, -1]);
  });

  it("refuses a BMP whose pixels are somebody else's file", () => {
    // BI_JPEG: legal, and a wrapper around a different format entirely. Saying
    // so beats decoding the wrapper's zeroes into a black rectangle.
    const bytes = load("pattern-24.bmp").slice();
    new DataView(bytes.buffer).setUint32(30, 4, true);
    expect(() => decodeBmp(bytes)).toThrow(DemakeError);
    expect(() => decodeBmp(bytes)).toThrow(/embedded JPEG/);
  });
});

describe("GIF", () => {
  it("decodes the LZW stream exactly as Chromium does", () => {
    const { bytes, reference } = pair("pattern.gif");
    expect(detectFormat(bytes)).toBe("gif");
    const image = decodeGif(bytes);
    expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
    expect([...image.data]).toEqual([...reference]);
  });

  it("puts an interlaced frame's rows back where they belong", () => {
    // Four passes in a fixed order, and getting it wrong is a picture that is
    // *complete* and shuffled — which no size or checksum can catch.
    const { bytes, reference } = pair("pattern-interlaced.gif");
    expect([...decodeGif(bytes).data]).toEqual([...reference]);
    // And it is the same picture as the progressive one, which is the claim
    // interlacing actually makes.
    expect([...decodeGif(bytes).data]).toEqual([...decodeGif(load("pattern.gif")).data]);
  });

  it("honours the transparent colour index, which is this format's only alpha", () => {
    const { bytes, reference } = pair("pattern-transparent.gif");
    const image = decodeGif(bytes);
    expect([...image.data]).toEqual([...reference]);
    expect(image.data[3]).toBe(0);
    // Outside the hole the picture is opaque, so an all-transparent decode
    // cannot pass this by accident.
    expect(image.data[(HEIGHT - 1) * WIDTH * 4 + 3]).toBe(255);
  });
});

describe("baseline JPEG", () => {
  for (const name of ["pattern-q90.jpg", "pattern-q50.jpg"]) {
    it(`decodes ${name} to within a level or two of Chromium`, () => {
      const { bytes, reference } = pair(name);
      expect(detectFormat(bytes)).toBe("jpeg");
      const image = decodeJpeg(bytes);
      expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
      // Two, and not more: the fixtures are 4:2:0, so a decoder that replicated
      // the chroma rather than interpolating it would be tens of levels out
      // here while still producing a plausible-looking picture.
      expect(worstDelta(image.data, reference)).toBeLessThanOrEqual(2);
    });
  }

  it("decodes an image whose last MCU hangs off both edges", () => {
    // 21×19 against a 16×16 macroblock: the last block of every row and of every
    // column is coded in full and mostly outside the picture. The blocks are
    // allocated per MCU for that reason, and a decoder sized to the image
    // instead writes past the end of every row it decodes.
    const { bytes, reference } = pair("overhang.jpg");
    const image = decodeJpeg(bytes);
    expect([image.width, image.height]).toEqual([21, 19]);
    expect(worstDelta(image.data, reference)).toBeLessThanOrEqual(2);
  });

  it("is bit-identical run twice, which is the whole reason it is ours", () => {
    const bytes = load("pattern-q50.jpg");
    expect([...decodeJpeg(bytes).data]).toEqual([...decodeJpeg(bytes).data]);
  });

  it("names progressive rather than half-decoding it", () => {
    // SOF0 → SOF2. A progressive file codes the picture as a stack of partial
    // scans; a baseline decoder let loose on one produces something that looks
    // like a bad demake rather than like a decoder error.
    const bytes = load("pattern-q90.jpg").slice();
    for (let at = 0; at + 1 < bytes.length; at += 1) {
      if (bytes[at] === 0xff && bytes[at + 1] === 0xc0) {
        bytes[at + 1] = 0xc2;
        break;
      }
    }
    expect(() => decodeJpeg(bytes)).toThrow(/progressive/);
  });
});

describe("the dispatcher", () => {
  it("routes every format it claims to support", () => {
    for (const name of [
      "pattern-24.bmp",
      "pattern-8.bmp",
      "pattern-32.bmp",
      "pattern.gif",
      "pattern-interlaced.gif",
      "pattern-transparent.gif",
      "pattern-q90.jpg",
      "pattern-q50.jpg",
    ]) {
      const image = decodeImage(load(name));
      expect([image.width, image.height]).toEqual([WIDTH, HEIGHT]);
    }
    expect(decodeImage(load("overhang.jpg")).width).toBe(21);
  });

  it("still says so, by name, for the one format that has no decoder", () => {
    // A RIFF/WEBP header over nothing. WebP is VP8 — a video codec's intra path
    // — and an error naming it beats a guess (doc 02).
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectFormat(webp)).toBe("webp");
    expect(() => decodeImage(webp)).toThrow(/WEBP decoding is not available/);
  });
});
