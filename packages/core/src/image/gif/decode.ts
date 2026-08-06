/**
 * A GIF decoder (doc 02 §Image codecs).
 *
 * Ours for the reason every codec here is ours — identical bytes in Node and in
 * a browser — and cheap to make that promise about, because GIF's compression is
 * lossless and its colour is a table: what comes out is what an encoder put in,
 * with no transform to round differently anywhere.
 *
 * **The first frame is the image.** A GIF may hold an animation, and a demake
 * has one screen to put it on — so what is decoded is frame one composited over
 * the background, and the rest of the file is skipped rather than blended into
 * something no frame of the original ever looked like. That is a decision worth
 * knowing about rather than a limitation: picking a *later* frame is a thing a
 * caller might reasonably want and would have to ask for.
 *
 * Interlacing is handled (a four-pass row order that predates progressive JPEG
 * and exists for the same reason), and so is the transparent-colour index, which
 * is the only alpha this format has.
 */

import { DemakeError } from "../../errors.js";
import { makeRgba, type RgbaImage } from "../rgba.js";

/** Whether a byte string looks like a GIF. */
export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  );
}

function bad(message: string, hint?: string): never {
  throw new DemakeError("E_BAD_INPUT", `GIF: ${message}`, hint === undefined ? {} : { hint });
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

/** Read a colour table of `count` RGB triples. */
function colorTable(bytes: Uint8Array, at: number, count: number): Uint8Array {
  const table = new Uint8Array(count * 3);
  table.set(bytes.subarray(at, at + count * 3));
  return table;
}

/** The four passes an interlaced GIF stores its rows in. */
const INTERLACE: readonly { start: number; step: number }[] = [
  { start: 0, step: 8 },
  { start: 4, step: 8 },
  { start: 2, step: 4 },
  { start: 1, step: 2 },
];

/** Decode the first frame of a GIF into an 8-bit RGBA raster. */
export function decodeGif(bytes: Uint8Array): RgbaImage {
  if (!isGif(bytes)) bad("not a GIF (bad signature)");
  if (bytes.length < 13) bad("truncated before the end of the screen descriptor");

  const screenWidth = u16(bytes, 6);
  const screenHeight = u16(bytes, 8);
  const packed = bytes[10]!;
  let pos = 13;

  let globalTable: Uint8Array | null = null;
  if ((packed & 0x80) !== 0) {
    const count = 2 << (packed & 7);
    globalTable = colorTable(bytes, pos, count);
    pos += count * 3;
  }

  if (screenWidth <= 0 || screenHeight <= 0) bad(`empty image (${screenWidth}×${screenHeight})`);
  const image = makeRgba(screenWidth, screenHeight);

  // The transparent index belongs to the graphic control extension immediately
  // before an image, so it is carried forward rather than looked up later.
  let transparent = -1;

  while (pos < bytes.length) {
    const marker = bytes[pos]!;

    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = bytes[pos + 1]!;
      if (label === 0xf9 && bytes[pos + 2] === 4) {
        transparent = (bytes[pos + 3]! & 1) !== 0 ? bytes[pos + 6]! : -1;
      }
      pos = skipBlocks(bytes, pos + 2);
      continue;
    }

    if (marker !== 0x2c) bad(`unrecognised block 0x${marker.toString(16)}`);

    const left = u16(bytes, pos + 1);
    const top = u16(bytes, pos + 3);
    const frameWidth = u16(bytes, pos + 5);
    const frameHeight = u16(bytes, pos + 7);
    const flags = bytes[pos + 9]!;
    pos += 10;

    let table = globalTable;
    if ((flags & 0x80) !== 0) {
      const count = 2 << (flags & 7);
      table = colorTable(bytes, pos, count);
      pos += count * 3;
    }
    if (!table) bad("the frame has no colour table, global or local");

    const minimumCodeSize = bytes[pos]!;
    pos += 1;
    const { data: compressed, next } = gatherBlocks(bytes, pos);
    const indices = inflateLzw(compressed, minimumCodeSize, frameWidth * frameHeight);
    void next;

    paint(image, indices, table, {
      left,
      top,
      width: frameWidth,
      height: frameHeight,
      interlaced: (flags & 0x40) !== 0,
      transparent,
    });
    // One frame is the picture (§the module note above), so the walk stops the
    // moment it has one rather than compositing an animation into a smear.
    return image;
  }

  bad("no image block in the file");
}

/** Walk a chain of length-prefixed sub-blocks and return where it ends. */
function skipBlocks(bytes: Uint8Array, at: number): number {
  let pos = at;
  while (pos < bytes.length) {
    const length = bytes[pos]!;
    pos += 1 + length;
    if (length === 0) break;
  }
  return pos;
}

/** Join a chain of sub-blocks into one buffer. */
function gatherBlocks(bytes: Uint8Array, at: number): { data: Uint8Array; next: number } {
  const parts: Uint8Array[] = [];
  let pos = at;
  let total = 0;
  while (pos < bytes.length) {
    const length = bytes[pos]!;
    pos += 1;
    if (length === 0) break;
    parts.push(bytes.subarray(pos, pos + length));
    total += length;
    pos += length;
  }
  const data = new Uint8Array(total);
  let out = 0;
  for (const part of parts) {
    data.set(part, out);
    out += part.length;
  }
  return { data, next: pos };
}

/**
 * GIF's LZW, which is not quite anybody else's.
 *
 * Codes are read least-significant-bit first, the width grows as the dictionary
 * fills, and two codes are reserved: clear (reset the dictionary) and end. The
 * detail that catches an implementation is the *deferred* clear — an encoder is
 * allowed to keep emitting at the maximum width after the dictionary is full
 * instead of sending a clear, so a decoder that grows past twelve bits or resets
 * on its own produces garbage from the middle of the image onward.
 */
function inflateLzw(data: Uint8Array, minimumCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minimumCodeSize;
  const end = clear + 1;
  const out = new Uint8Array(pixels);

  // The dictionary as two parallel arrays: every entry is a previous entry plus
  // one byte, so a string is walked backwards from its tail. That avoids
  // allocating an array per entry, which for a full dictionary is 4096 of them.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);

  let codeSize = minimumCodeSize + 1;
  let next = end + 1;
  let previous = -1;
  let bits = 0;
  let bitCount = 0;
  let at = 0;
  let written = 0;

  for (let i = 0; i < clear; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  while (written < pixels) {
    while (bitCount < codeSize) {
      if (at >= data.length) return out; // truncated: keep what was decoded
      bits |= data[at]! << bitCount;
      bitCount += 8;
      at += 1;
    }
    const code = bits & ((1 << codeSize) - 1);
    bits >>>= codeSize;
    bitCount -= codeSize;

    if (code === clear) {
      codeSize = minimumCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;

    let current = code;
    let top = 0;
    // The self-referential case: a code the dictionary does not have yet, which
    // an encoder emits when the string it names is the previous one plus its own
    // first byte. Every LZW has it and every first implementation misses it.
    if (code >= next) {
      if (previous < 0) break;
      stack[top] = firstByte(prefix, suffix, previous);
      top += 1;
      current = previous;
    }
    while (current >= clear) {
      stack[top] = suffix[current]!;
      top += 1;
      current = prefix[current]!;
    }
    stack[top] = suffix[current]!;
    top += 1;

    while (top > 0 && written < pixels) {
      top -= 1;
      out[written] = stack[top]!;
      written += 1;
    }

    if (previous >= 0 && next < 4096) {
      prefix[next] = previous;
      suffix[next] = firstByte(prefix, suffix, code >= next ? previous : code);
      next += 1;
      // Widen only up to twelve bits: past that the encoder is deferring its
      // clear and the width stays where it is.
      if ((next & (next - 1)) === 0 && next < 4096 && codeSize < 12) codeSize += 1;
    }
    previous = code;
  }
  return out;
}

/** The first byte of the string a dictionary code names. */
function firstByte(prefix: Int32Array, suffix: Uint8Array, code: number): number {
  let current = code;
  while (prefix[current]! >= 0) current = prefix[current]!;
  return suffix[current]!;
}

/** Put a decoded frame into the screen it belongs on. */
function paint(
  image: RgbaImage,
  indices: Uint8Array,
  table: Uint8Array,
  frame: {
    left: number;
    top: number;
    width: number;
    height: number;
    interlaced: boolean;
    transparent: number;
  },
): void {
  const { data, width: screenWidth, height: screenHeight } = image;
  const rows = frame.interlaced ? interlacedRows(frame.height) : null;

  for (let row = 0; row < frame.height; row += 1) {
    const y = frame.top + (rows ? rows[row]! : row);
    if (y < 0 || y >= screenHeight) continue;
    for (let column = 0; column < frame.width; column += 1) {
      const x = frame.left + column;
      if (x < 0 || x >= screenWidth) continue;
      const index = indices[row * frame.width + column]!;
      if (index === frame.transparent) continue;
      const out = (y * screenWidth + x) * 4;
      data[out] = table[index * 3] ?? 0;
      data[out + 1] = table[index * 3 + 1] ?? 0;
      data[out + 2] = table[index * 3 + 2] ?? 0;
      data[out + 3] = 255;
    }
  }
}

/** Which screen row each stored row belongs to, for an interlaced frame. */
function interlacedRows(height: number): Int32Array {
  const rows = new Int32Array(height);
  let at = 0;
  for (const pass of INTERLACE) {
    for (let y = pass.start; y < height; y += pass.step) {
      rows[at] = y;
      at += 1;
    }
  }
  return rows;
}
