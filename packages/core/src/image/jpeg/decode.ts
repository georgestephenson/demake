/**
 * A baseline JPEG decoder (doc 02 §Image codecs).
 *
 * Ours rather than a host's, and here that is not a preference — it is the only
 * way the promise can be kept at all. JPEG is a *lossy* format, so "decode it"
 * has no single right answer: the standard specifies the inverse transform only
 * to a tolerance, and two libraries genuinely disagree in the low bit of an edge
 * pixel. A demake fitted from a browser's decode and one fitted from Node's
 * would differ, and the difference would show up as a mystery two layers down
 * in a palette fit. So the arithmetic below is fixed, integer, and ours: the
 * scaled-integer inverse DCT with the constants written out, no float anywhere
 * in the transform, and no `Math.*` (doc 02 §Determinism).
 *
 * **Baseline sequential, and progressive by name.** A progressive JPEG (`SOF2`)
 * codes the same picture as a stack of partial scans and is a substantially
 * different decoder; it is refused with a message that says so rather than
 * half-decoded into something that looks like a bad demake. Arithmetic coding
 * (`SOF9`/`SOF10`, essentially extinct) and hierarchical mode go the same way.
 *
 * What *is* handled is what a camera, a phone and every export dialogue produce:
 * Huffman-coded baseline, one to four components, any subsampling the standard
 * allows, restart intervals, multiple scans of a sequential image, and both the
 * JFIF and Adobe colour conventions — including the inverted CMYK an Adobe
 * four-component file uses, which is the one case where guessing wrongly turns a
 * photograph into its own negative.
 */

import { DemakeError } from "../../errors.js";
import { makeRgba, type RgbaImage } from "../rgba.js";

/** Whether a byte string looks like a JPEG. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function bad(message: string, hint?: string): never {
  throw new DemakeError("E_BAD_INPUT", `JPEG: ${message}`, hint === undefined ? {} : { hint });
}

/** The zig-zag order a quantised block is stored in. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** One Huffman table, as the fast lookup a decoder actually wants. */
interface HuffTable {
  /** The smallest code of each length, and where its values start. */
  readonly minCode: Int32Array;
  readonly maxCode: Int32Array;
  readonly valuePointer: Int32Array;
  readonly values: Uint8Array;
}

function buildHuffTable(counts: Uint8Array, values: Uint8Array): HuffTable {
  const minCode = new Int32Array(17);
  const maxCode = new Int32Array(17).fill(-1);
  const valuePointer = new Int32Array(17);
  let code = 0;
  let at = 0;
  for (let length = 1; length <= 16; length += 1) {
    valuePointer[length] = at;
    minCode[length] = code;
    code += counts[length - 1]!;
    at += counts[length - 1]!;
    maxCode[length] = counts[length - 1]! > 0 ? code - 1 : -1;
    code <<= 1;
  }
  return { minCode, maxCode, valuePointer, values };
}

/** One image component: which tables it uses, and its sampling factors. */
interface Component {
  id: number;
  h: number;
  v: number;
  quantTable: number;
  dcTable: number;
  acTable: number;
  /** Blocks across and down for this component, over the whole image. */
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Decoded samples, one byte each, `blocksPerLine * 8` to a row. */
  pixels: Uint8Array;
  prediction: number;
}

/**
 * The entropy-coded bit reader.
 *
 * Two things here are the format's rather than a reader's: a `0xFF` byte in the
 * stream is followed by a stuffed `0x00` that is not data, and a marker ends the
 * scan wherever it appears. Reading past the end returns zero bits rather than
 * throwing, because a truncated JPEG should give back the picture it does have.
 */
class BitReader {
  private at: number;
  private bits = 0;
  private count = 0;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
  ) {
    this.at = start;
  }

  /** Where the reader has got to, for finding the next marker. */
  position(): number {
    return this.at;
  }

  /** Drop any partial byte — what a restart marker means. */
  align(): void {
    this.bits = 0;
    this.count = 0;
  }

  bit(): number {
    if (this.count === 0) {
      if (this.at >= this.bytes.length) return 0;
      const byte = this.bytes[this.at]!;
      this.at += 1;
      if (byte === 0xff) {
        const next = this.bytes[this.at];
        if (next === 0x00) {
          this.at += 1;
        } else {
          // A marker. Back off it and feed zeroes: the scan is over, and the
          // caller finds the marker by asking where the reader stopped.
          this.at -= 1;
          this.bits = 0;
          this.count = 8;
          return 0;
        }
      }
      this.bits = byte;
      this.count = 8;
    }
    this.count -= 1;
    return (this.bits >> this.count) & 1;
  }

  bitsOf(length: number): number {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = (value << 1) | this.bit();
    return value;
  }

  decode(table: HuffTable): number {
    let code = this.bit();
    let length = 1;
    while (length <= 16) {
      if (table.maxCode[length]! >= 0 && code <= table.maxCode[length]!) {
        const index = table.valuePointer[length]! + code - table.minCode[length]!;
        return table.values[index] ?? 0;
      }
      code = (code << 1) | this.bit();
      length += 1;
    }
    return 0;
  }
}

/** Sign-extend a `length`-bit magnitude the way the standard's `EXTEND` does. */
function extend(value: number, length: number): number {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

// --- the inverse transform ---------------------------------------------------

/*
 * A scaled-integer inverse DCT: the row-column AAN-style butterfly with its
 * constants written out as integers rather than derived from a cosine, which is
 * what makes it reproducible to the bit. The scaling is 13 fractional bits
 * through the rows and 13 more through the columns, with the descaling folded
 * into the final shift — the arrangement libjpeg uses, and pinned here rather
 * than recomputed so that nothing about the host's floating point can reach the
 * pixels.
 */
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

const CONST_BITS = 13;
const PASS1_BITS = 2;

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Inverse-transform one block of quantised coefficients into eight-bit samples.
 *
 * `block` is in natural (de-zig-zagged) order and already multiplied by the
 * quantisation table. The output is written into `out` at `stride`-byte rows,
 * level-shifted by 128 and clamped, which is what the standard calls for.
 */
function idctBlock(block: Int32Array, out: Uint8Array, offset: number, stride: number): void {
  const workspace = new Int32Array(64);

  // Pass 1: columns.
  for (let column = 0; column < 8; column += 1) {
    // A column with nothing but a DC term is most of a photograph's blocks and
    // all of a flat area's, so it is worth the branch: the whole column is one
    // value and the eight-point transform is a shift.
    if (
      block[column + 8] === 0 &&
      block[column + 16] === 0 &&
      block[column + 24] === 0 &&
      block[column + 32] === 0 &&
      block[column + 40] === 0 &&
      block[column + 48] === 0 &&
      block[column + 56] === 0
    ) {
      const dc = block[column]! << PASS1_BITS;
      for (let row = 0; row < 8; row += 1) workspace[column + row * 8] = dc;
      continue;
    }

    let z2 = block[column + 16]!;
    let z3 = block[column + 48]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    const tmp2 = z1 + z3 * -FIX_1_847759065;
    const tmp3 = z1 + z2 * FIX_0_765366865;

    z2 = block[column]!;
    z3 = block[column + 32]!;
    const tmp0 = (z2 + z3) << CONST_BITS;
    const tmp1 = (z2 - z3) << CONST_BITS;

    const t10 = tmp0 + tmp3;
    const t13 = tmp0 - tmp3;
    const t11 = tmp1 + tmp2;
    const t12 = tmp1 - tmp2;

    let t0 = block[column + 56]!;
    let t1 = block[column + 40]!;
    let t2 = block[column + 24]!;
    let t3 = block[column + 8]!;

    z1 = t0 + t3;
    z2 = t1 + t2;
    z3 = t0 + t2;
    let z4 = t1 + t3;
    const z5 = (z3 + z4) * FIX_1_175875602;

    t0 *= FIX_0_298631336;
    t1 *= FIX_2_053119869;
    t2 *= FIX_3_072711026;
    t3 *= FIX_1_501321110;
    z1 *= -FIX_0_899976223;
    z2 *= -FIX_2_562915447;
    z3 *= -FIX_1_961570560;
    z4 *= -FIX_0_390180644;

    z3 += z5;
    z4 += z5;

    t0 += z1 + z3;
    t1 += z2 + z4;
    t2 += z2 + z3;
    t3 += z1 + z4;

    const half = 1 << (CONST_BITS - PASS1_BITS - 1);
    workspace[column] = (t10 + t3 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 56] = (t10 - t3 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 8] = (t11 + t2 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 48] = (t11 - t2 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 16] = (t12 + t1 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 40] = (t12 - t1 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 24] = (t13 + t0 + half) >> (CONST_BITS - PASS1_BITS);
    workspace[column + 32] = (t13 - t0 + half) >> (CONST_BITS - PASS1_BITS);
  }

  // Pass 2: rows, with the level shift and the clamp on the way out.
  for (let row = 0; row < 8; row += 1) {
    const at = row * 8;
    const target = offset + row * stride;

    let z2 = workspace[at + 2]!;
    let z3 = workspace[at + 6]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    const tmp2 = z1 + z3 * -FIX_1_847759065;
    const tmp3 = z1 + z2 * FIX_0_765366865;

    const tmp0 = (workspace[at]! + workspace[at + 4]!) << CONST_BITS;
    const tmp1 = (workspace[at]! - workspace[at + 4]!) << CONST_BITS;

    const t10 = tmp0 + tmp3;
    const t13 = tmp0 - tmp3;
    const t11 = tmp1 + tmp2;
    const t12 = tmp1 - tmp2;

    let t0 = workspace[at + 7]!;
    let t1 = workspace[at + 5]!;
    let t2 = workspace[at + 3]!;
    let t3 = workspace[at + 1]!;

    z1 = t0 + t3;
    z2 = t1 + t2;
    z3 = t0 + t2;
    let z4 = t1 + t3;
    const z5 = (z3 + z4) * FIX_1_175875602;

    t0 *= FIX_0_298631336;
    t1 *= FIX_2_053119869;
    t2 *= FIX_3_072711026;
    t3 *= FIX_1_501321110;
    z1 *= -FIX_0_899976223;
    z2 *= -FIX_2_562915447;
    z3 *= -FIX_1_961570560;
    z4 *= -FIX_0_390180644;

    z3 += z5;
    z4 += z5;

    t0 += z1 + z3;
    t1 += z2 + z4;
    t2 += z2 + z3;
    t3 += z1 + z4;

    const shift = CONST_BITS + PASS1_BITS + 3;
    const half = 1 << (shift - 1);
    out[target] = clampByte(((t10 + t3 + half) >> shift) + 128);
    out[target + 7] = clampByte(((t10 - t3 + half) >> shift) + 128);
    out[target + 1] = clampByte(((t11 + t2 + half) >> shift) + 128);
    out[target + 6] = clampByte(((t11 - t2 + half) >> shift) + 128);
    out[target + 2] = clampByte(((t12 + t1 + half) >> shift) + 128);
    out[target + 5] = clampByte(((t12 - t1 + half) >> shift) + 128);
    out[target + 3] = clampByte(((t13 + t0 + half) >> shift) + 128);
    out[target + 4] = clampByte(((t13 - t0 + half) >> shift) + 128);
  }
}

// --- the file ----------------------------------------------------------------

interface Frame {
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
}

/** Decode a baseline JPEG into an 8-bit RGBA raster. */
export function decodeJpeg(bytes: Uint8Array): RgbaImage {
  if (!isJpeg(bytes)) bad("not a JPEG (bad signature)");

  const quantTables: (Int32Array | undefined)[] = new Array(4).fill(undefined);
  const dcTables: (HuffTable | undefined)[] = new Array(4).fill(undefined);
  const acTables: (HuffTable | undefined)[] = new Array(4).fill(undefined);
  let frame: Frame | undefined;
  let restartInterval = 0;
  /** Adobe's APP14 transform byte, which is the only thing that can distinguish
   * a three-component RGB JPEG from a YCbCr one, and CMYK from YCCK. */
  let adobeTransform = -1;
  let sawAdobe = false;

  let pos = 2;
  while (pos < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = bytes[pos + 1]!;
    pos += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (pos + 2 > bytes.length) break;
    const length = (bytes[pos]! << 8) | bytes[pos + 1]!;
    const segment = pos + 2;
    const segmentEnd = pos + length;

    switch (marker) {
      case 0xdb: {
        // Quantisation tables, de-zig-zagged as they are read so that nothing
        // downstream has to remember the order.
        let at = segment;
        while (at < segmentEnd) {
          const spec = bytes[at]!;
          at += 1;
          const table = new Int32Array(64);
          const wide = spec >> 4 !== 0;
          for (let i = 0; i < 64; i += 1) {
            table[ZIGZAG[i]!] = wide
              ? (bytes[at + i * 2]! << 8) | bytes[at + i * 2 + 1]!
              : bytes[at + i]!;
          }
          at += wide ? 128 : 64;
          quantTables[spec & 15] = table;
        }
        break;
      }
      case 0xc4: {
        let at = segment;
        while (at < segmentEnd) {
          const spec = bytes[at]!;
          at += 1;
          const counts = bytes.subarray(at, at + 16);
          at += 16;
          let total = 0;
          for (const count of counts) total += count;
          const values = bytes.slice(at, at + total);
          at += total;
          const table = buildHuffTable(counts, values);
          if (spec >> 4 === 0) dcTables[spec & 15] = table;
          else acTables[spec & 15] = table;
        }
        break;
      }
      case 0xdd:
        restartInterval = (bytes[segment]! << 8) | bytes[segment + 1]!;
        break;
      case 0xee:
        // "Adobe\0"
        if (
          length >= 13 &&
          bytes[segment] === 0x41 &&
          bytes[segment + 1] === 0x64 &&
          bytes[segment + 2] === 0x6f
        ) {
          sawAdobe = true;
          adobeTransform = bytes[segment + 11]!;
        }
        break;
      case 0xc0:
      case 0xc1:
        frame = readFrame(bytes, segment);
        break;
      // Every other start-of-frame. Named rather than attempted: a baseline
      // decoder let loose on one of these produces something that looks like a
      // bad demake rather than like an error, and progressive is much the most
      // common of them, so it gets a message of its own.
      case 0xc2:
      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        if (marker === 0xc2) {
          bad(
            "this is a progressive JPEG",
            "re-save it as a baseline JPEG, or as a PNG — a progressive file codes the picture as a stack of partial scans and needs a different decoder",
          );
        }
        bad(
          `unsupported coding mode (SOF${marker - 0xc0})`,
          "lossless, hierarchical and arithmetic-coded JPEGs are outside baseline; re-save as a baseline JPEG or a PNG",
        );
      // eslint-disable-next-line no-fallthrough -- `bad` returns `never`
      case 0xda: {
        if (!frame) bad("a scan arrived before the frame header");
        pos = decodeScan(bytes, segment, frame, quantTables, dcTables, acTables, restartInterval);
        continue;
      }
      default:
        break;
    }
    pos = segmentEnd;
  }

  if (!frame) bad("no frame header (SOF0/SOF1) in the file");
  return toRgba(frame, sawAdobe, adobeTransform);
}

function readFrame(bytes: Uint8Array, at: number): Frame {
  const precision = bytes[at]!;
  if (precision !== 8) {
    bad(
      `${precision}-bit samples`,
      "only 8-bit baseline JPEG is supported; re-save at 8 bits, or as a PNG",
    );
  }
  const height = (bytes[at + 1]! << 8) | bytes[at + 2]!;
  const width = (bytes[at + 3]! << 8) | bytes[at + 4]!;
  const count = bytes[at + 5]!;
  if (width <= 0 || height <= 0) bad(`empty image (${width}×${height})`);
  if (count < 1 || count > 4) bad(`${count} colour components`);

  const components: Component[] = [];
  let maxH = 1;
  let maxV = 1;
  for (let i = 0; i < count; i += 1) {
    const p = at + 6 + i * 3;
    const h = bytes[p + 1]! >> 4;
    const v = bytes[p + 1]! & 15;
    if (h < 1 || v < 1) bad("a component has a zero sampling factor");
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    components.push({
      id: bytes[p]!,
      h,
      v,
      quantTable: bytes[p + 2]!,
      dcTable: 0,
      acTable: 0,
      blocksPerLine: 0,
      blocksPerColumn: 0,
      pixels: new Uint8Array(0),
      prediction: 0,
    });
  }

  const mcusPerLine = Math.ceil(width / (maxH * 8));
  const mcusPerColumn = Math.ceil(height / (maxV * 8));
  for (const component of components) {
    // Allocated per *MCU* rather than per pixel: the last MCU of a row runs past
    // the picture's edge and its blocks are still coded, so a buffer sized to
    // the image would be written past the end of every row.
    component.blocksPerLine = mcusPerLine * component.h;
    component.blocksPerColumn = mcusPerColumn * component.v;
    component.pixels = new Uint8Array(component.blocksPerLine * 8 * component.blocksPerColumn * 8);
  }
  return { width, height, maxH, maxV, mcusPerLine, mcusPerColumn, components };
}

/**
 * Decode one scan, returning where the entropy-coded data ended.
 *
 * Two shapes, and both occur in ordinary files: a scan naming one component
 * walks that component's own blocks, and a scan naming several walks
 * interleaved MCUs. The unit of the walk differs; nothing else does.
 */
function decodeScan(
  bytes: Uint8Array,
  at: number,
  frame: Frame,
  quantTables: (Int32Array | undefined)[],
  dcTables: (HuffTable | undefined)[],
  acTables: (HuffTable | undefined)[],
  restartInterval: number,
): number {
  const count = bytes[at]!;
  const scan: Component[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = bytes[at + 1 + i * 2]!;
    const tables = bytes[at + 2 + i * 2]!;
    const component = frame.components.find((c) => c.id === id);
    if (!component) bad(`the scan names component ${id}, which the frame does not have`);
    component.dcTable = tables >> 4;
    component.acTable = tables & 15;
    component.prediction = 0;
    scan.push(component);
  }

  const single = scan.length === 1;
  const component0 = scan[0]!;
  const perLine = single
    ? Math.ceil(frame.width / (8 * (frame.maxH / component0.h)))
    : frame.mcusPerLine;
  const units = single
    ? perLine * Math.ceil(frame.height / (8 * (frame.maxV / component0.v)))
    : frame.mcusPerLine * frame.mcusPerColumn;

  const block = new Int32Array(64);
  let reader = new BitReader(bytes, at + 1 + count * 2 + 3);
  let sinceRestart = 0;

  for (let unit = 0; unit < units; unit += 1) {
    if (restartInterval > 0 && sinceRestart === restartInterval) {
      // A restart is a fresh entropy stream on a byte boundary, so the reader is
      // replaced rather than realigned — carrying its part-consumed byte across
      // the boundary would decode the rest of the picture as noise. Every
      // prediction restarts with it too, which is what the marker is *for*:
      // skipping that makes the image drift in brightness from here onward.
      const marker = findRestart(bytes, reader.position());
      if (marker < 0) break;
      reader = new BitReader(bytes, marker);
      for (const component of scan) component.prediction = 0;
      sinceRestart = 0;
    }
    sinceRestart += 1;

    if (single) {
      decodeBlockInto(
        reader,
        component0,
        block,
        quantTables,
        dcTables,
        acTables,
        unit % perLine,
        Math.floor(unit / perLine),
      );
      continue;
    }
    const mcuColumn = unit % frame.mcusPerLine;
    const mcuRow = Math.floor(unit / frame.mcusPerLine);
    for (const component of scan) {
      for (let v = 0; v < component.v; v += 1) {
        for (let h = 0; h < component.h; h += 1) {
          decodeBlockInto(
            reader,
            component,
            block,
            quantTables,
            dcTables,
            acTables,
            mcuColumn * component.h + h,
            mcuRow * component.v + v,
          );
        }
      }
    }
  }

  return nextMarker(bytes, reader.position());
}

/** Read one block's coefficients and transform them into the component. */
function decodeBlockInto(
  reader: BitReader,
  component: Component,
  block: Int32Array,
  quantTables: (Int32Array | undefined)[],
  dcTables: (HuffTable | undefined)[],
  acTables: (HuffTable | undefined)[],
  blockColumn: number,
  blockRow: number,
): void {
  const quant = quantTables[component.quantTable];
  const dc = dcTables[component.dcTable];
  const ac = acTables[component.acTable];
  if (!quant || !dc || !ac) bad("the scan uses a table the file never defined");

  block.fill(0);

  const dcLength = reader.decode(dc);
  const diff = dcLength === 0 ? 0 : extend(reader.bitsOf(dcLength), dcLength);
  component.prediction += diff;
  block[0] = component.prediction * quant[0]!;

  let k = 1;
  while (k < 64) {
    const symbol = reader.decode(ac);
    const size = symbol & 15;
    const run = symbol >> 4;
    if (size === 0) {
      if (run !== 15) break; // end of block
      k += 16;
      continue;
    }
    k += run;
    if (k > 63) break;
    const natural = ZIGZAG[k]!;
    block[natural] = extend(reader.bitsOf(size), size) * quant[natural]!;
    k += 1;
  }

  if (blockColumn >= component.blocksPerLine || blockRow >= component.blocksPerColumn) return;
  const stride = component.blocksPerLine * 8;
  idctBlock(block, component.pixels, blockRow * 8 * stride + blockColumn * 8, stride);
}

/** The offset just past the next `RSTn` marker, or -1. */
function findRestart(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    if (bytes[at] !== 0xff) continue;
    const marker = bytes[at + 1]!;
    if (marker >= 0xd0 && marker <= 0xd7) return at + 2;
    if (marker !== 0x00 && marker !== 0xff) return -1;
  }
  return -1;
}

/** Where the next non-restart marker starts, so the outer walk can resume. */
function nextMarker(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    if (bytes[at] !== 0xff) continue;
    const marker = bytes[at + 1]!;
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) continue;
    return at;
  }
  return bytes.length;
}

/**
 * Bring one component up to the full picture's resolution.
 *
 * A halved axis is interpolated with the triangle filter — three parts of the
 * nearer sample to one of the further, which is the "fancy" upsampling libjpeg
 * has done by default since 1994 and therefore what essentially every decoder in
 * the world produces. Replicating the sample instead is legal and much worse:
 * measured against Chromium on a 4:2:0 gradient it was up to 110 levels out,
 * which on a demake is a *palette* fitted to colours the photograph does not
 * have. The arithmetic is integer with an explicit round, so it is exactly
 * reproducible; only the edge samples are clamped rather than extrapolated.
 *
 * Any other ratio — a 3:1 or 4:1 axis, which the standard allows and nothing
 * emits — replicates, because a filter nobody can test is worse than an honest
 * blocky one.
 */
function upsample(component: Component, frame: Frame): Uint8Array {
  const { width, height, maxH, maxV } = frame;
  const stride = component.blocksPerLine * 8;
  const scaleH = maxH / component.h;
  const scaleV = maxV / component.v;
  // How much of the stored plane is picture rather than the padding the last
  // MCU of a row and column always carries.
  const sourceWidth = Math.ceil((width * component.h) / maxH);
  const sourceHeight = Math.ceil((height * component.v) / maxV);

  const at = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= sourceWidth ? sourceWidth - 1 : x;
    const cy = y < 0 ? 0 : y >= sourceHeight ? sourceHeight - 1 : y;
    return component.pixels[cy * stride + cx] ?? 0;
  };

  const out = new Uint8Array(width * height);
  const fancyH = scaleH === 2;
  const fancyV = scaleV === 2;

  for (let y = 0; y < height; y += 1) {
    // The vertical half of the triangle, done into a one-row scratch so the
    // horizontal half reads a row that already exists — separable, as the filter
    // is, rather than four taps per output pixel.
    const nearY = fancyV ? y >> 1 : Math.floor(y / scaleV);
    const farY = nearY + ((y & 1) === 0 ? -1 : 1);
    for (let x = 0; x < width; x += 1) {
      const nearX = fancyH ? x >> 1 : Math.floor(x / scaleH);
      const farX = nearX + ((x & 1) === 0 ? -1 : 1);
      let value: number;
      if (fancyV) {
        const near = fancyH ? (3 * at(nearX, nearY) + at(farX, nearY) + 2) >> 2 : at(nearX, nearY);
        const far = fancyH ? (3 * at(nearX, farY) + at(farX, farY) + 2) >> 2 : at(nearX, farY);
        value = (3 * near + far + 2) >> 2;
      } else {
        value = fancyH ? (3 * at(nearX, nearY) + at(farX, nearY) + 2) >> 2 : at(nearX, nearY);
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

/** Upsample the components and convert to RGBA. */
function toRgba(frame: Frame, sawAdobe: boolean, adobeTransform: number): RgbaImage {
  const { width, height, components } = frame;
  const image = makeRgba(width, height);
  const data = image.data;

  const planes = components.map((component) => upsample(component, frame));
  const sample = (index: number, x: number, y: number): number => planes[index]![y * width + x]!;

  // Which colour space the components are in. One component is grey; three are
  // YCbCr unless Adobe says 0 (RGB); four are YCCK when Adobe says 2 and CMYK
  // otherwise — and an Adobe four-component file stores its inks *inverted*,
  // which is the difference between a photograph and its negative.
  const count = components.length;
  const ycc = count === 3 ? !(sawAdobe && adobeTransform === 0) : adobeTransform === 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (count === 1) {
        const grey = sample(0, x, y);
        data[out] = grey;
        data[out + 1] = grey;
        data[out + 2] = grey;
        data[out + 3] = 255;
        continue;
      }

      let r: number;
      let g: number;
      let b: number;
      if (count === 3) {
        const c0 = sample(0, x, y);
        const c1 = sample(1, x, y);
        const c2 = sample(2, x, y);
        if (ycc) {
          [r, g, b] = fromYcc(c0, c1, c2);
        } else {
          r = c0;
          g = c1;
          b = c2;
        }
      } else {
        let c = sample(0, x, y);
        let m = sample(1, x, y);
        let yellow = sample(2, x, y);
        const k = sample(3, x, y);
        if (ycc) [c, m, yellow] = fromYcc(c, m, yellow);
        // Adobe writes CMYK inverted, and every four-component JPEG in practice
        // is Adobe's.
        r = clampByte((c * k) / 255);
        g = clampByte((m * k) / 255);
        b = clampByte((yellow * k) / 255);
      }
      data[out] = clampByte(r);
      data[out + 1] = clampByte(g);
      data[out + 2] = clampByte(b);
      data[out + 3] = 255;
    }
  }
  return image;
}

/**
 * YCbCr to RGB, in the fixed-point form the standard specifies.
 *
 * Sixteen fractional bits with a rounding half added in, so the result is an
 * integer function of the inputs — the same on every engine, which a float
 * expression rounded by the host is not guaranteed to be at the boundary.
 */
function fromYcc(y: number, cb: number, cr: number): [number, number, number] {
  const half = 1 << 15;
  const b0 = cb - 128;
  const r0 = cr - 128;
  return [
    clampByte((y * 65536 + 91881 * r0 + half) >> 16),
    clampByte((y * 65536 - 22554 * b0 - 46802 * r0 + half) >> 16),
    clampByte((y * 65536 + 116130 * b0 + half) >> 16),
  ];
}
