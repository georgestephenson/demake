/**
 * A pure-TypeScript DEFLATE / zlib inflater (RFC 1950 / 1951).
 *
 * `core` may not touch `node:zlib` (platform-purity rule), and the browser's
 * `DecompressionStream` is async and not universally available, so PNG decoding
 * needs its own inflater. This handles all three block types — stored, fixed
 * Huffman, and dynamic Huffman — so it reads PNGs written by any encoder.
 */

/** Thrown when the compressed stream is malformed. */
export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman decode table (counts + sorted symbols). */
interface Huffman {
  counts: Uint16Array; // number of codes of each length
  symbols: Uint16Array; // symbols sorted by (length, value)
  maxLen: number;
}

function buildHuffman(lengths: Uint8Array, n: number): Huffman {
  let maxLen = 0;
  for (let i = 0; i < n; i += 1) {
    if (lengths[i]! > maxLen) maxLen = lengths[i]!;
  }
  const counts = new Uint16Array(maxLen + 1);
  for (let i = 0; i < n; i += 1) {
    counts[lengths[i]!]! += 1;
  }
  counts[0] = 0;
  const offsets = new Uint16Array(maxLen + 2);
  for (let len = 1; len <= maxLen; len += 1) {
    offsets[len + 1] = offsets[len]! + counts[len]!;
  }
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) {
    const len = lengths[i]!;
    if (len !== 0) {
      symbols[offsets[len]!] = i;
      offsets[len]! += 1;
    }
  }
  return { counts, symbols, maxLen };
}

/** Streaming bit reader (LSB-first, as DEFLATE requires). */
class BitReader {
  private pos: number;
  private bitBuf = 0;
  private bitCnt = 0;
  constructor(
    private readonly data: Uint8Array,
    start: number,
  ) {
    this.pos = start;
  }

  bits(count: number): number {
    while (this.bitCnt < count) {
      if (this.pos >= this.data.length) {
        throw new InflateError("unexpected end of DEFLATE stream");
      }
      this.bitBuf |= this.data[this.pos]! << this.bitCnt;
      this.pos += 1;
      this.bitCnt += 8;
    }
    const value = this.bitBuf & ((1 << count) - 1);
    this.bitBuf >>>= count;
    this.bitCnt -= count;
    return value;
  }

  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  readBytes(count: number): Uint8Array {
    if (this.pos + count > this.data.length) {
      throw new InflateError("unexpected end of stored block");
    }
    const out = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }

  decode(table: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= table.maxLen; len += 1) {
      code |= this.bits(1);
      const count = table.counts[len]!;
      if (code - first < count) {
        return table.symbols[index + (code - first)]!;
      }
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("invalid Huffman code");
  }
}

/** Growable output buffer for the inflated bytes (LZ77 back-references). */
class OutBuffer {
  private buf: Uint8Array;
  length = 0;
  constructor(hint: number) {
    this.buf = new Uint8Array(Math.max(hint, 1024));
  }
  private ensure(extra: number): void {
    if (this.length + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  push(byte: number): void {
    this.ensure(1);
    this.buf[this.length] = byte;
    this.length += 1;
  }
  copyMatch(distance: number, len: number): void {
    if (distance > this.length) {
      throw new InflateError("back-reference before start of output");
    }
    this.ensure(len);
    let src = this.length - distance;
    for (let i = 0; i < len; i += 1) {
      this.buf[this.length] = this.buf[src]!;
      this.length += 1;
      src += 1;
    }
  }
  append(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }
  finish(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

const FIXED_LIT = (() => {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  return buildHuffman(lengths, 288);
})();
const FIXED_DIST = (() => {
  const lengths = new Uint8Array(30).fill(5);
  return buildHuffman(lengths, 30);
})();

function inflateBlockData(reader: BitReader, out: OutBuffer, lit: Huffman, dist: Huffman): void {
  for (;;) {
    const sym = reader.decode(lit);
    if (sym === 256) {
      return;
    }
    if (sym < 256) {
      out.push(sym);
      continue;
    }
    const li = sym - 257;
    if (li >= LENGTH_BASE.length) {
      throw new InflateError("invalid length symbol");
    }
    const length = LENGTH_BASE[li]! + reader.bits(LENGTH_EXTRA[li]!);
    const dsym = reader.decode(dist);
    if (dsym >= DIST_BASE.length) {
      throw new InflateError("invalid distance symbol");
    }
    const distance = DIST_BASE[dsym]! + reader.bits(DIST_EXTRA[dsym]!);
    out.copyMatch(distance, length);
  }
}

function readDynamicTables(reader: BitReader): { lit: Huffman; dist: Huffman } {
  const hlit = reader.bits(5) + 257;
  const hdist = reader.bits(5) + 1;
  const hclen = reader.bits(4) + 4;

  const clLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i += 1) {
    clLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3);
  }
  const clTable = buildHuffman(clLengths, 19);

  const all = new Uint8Array(hlit + hdist);
  let i = 0;
  while (i < all.length) {
    const sym = reader.decode(clTable);
    if (sym < 16) {
      all[i] = sym;
      i += 1;
    } else if (sym === 16) {
      if (i === 0) throw new InflateError("repeat with no previous length");
      const prev = all[i - 1]!;
      let repeat = 3 + reader.bits(2);
      while (repeat > 0 && i < all.length) {
        all[i] = prev;
        i += 1;
        repeat -= 1;
      }
    } else if (sym === 17) {
      let repeat = 3 + reader.bits(3);
      while (repeat > 0 && i < all.length) {
        all[i] = 0;
        i += 1;
        repeat -= 1;
      }
    } else {
      let repeat = 11 + reader.bits(7);
      while (repeat > 0 && i < all.length) {
        all[i] = 0;
        i += 1;
        repeat -= 1;
      }
    }
  }

  const lit = buildHuffman(all.subarray(0, hlit), hlit);
  const dist = buildHuffman(all.subarray(hlit), hdist);
  return { lit, dist };
}

/** Inflate a raw DEFLATE stream (no zlib header). */
export function inflateRaw(data: Uint8Array, start = 0, sizeHint = data.length * 4): Uint8Array {
  const reader = new BitReader(data, start);
  const out = new OutBuffer(sizeHint);
  let final = false;
  while (!final) {
    final = reader.bits(1) === 1;
    const type = reader.bits(2);
    if (type === 0) {
      reader.alignToByte();
      const len = reader.readBytes(2);
      const nlen = reader.readBytes(2);
      const size = len[0]! | (len[1]! << 8);
      const nsize = nlen[0]! | (nlen[1]! << 8);
      if ((size ^ 0xffff) !== nsize) {
        throw new InflateError("stored block length check failed");
      }
      out.append(reader.readBytes(size));
    } else if (type === 1) {
      inflateBlockData(reader, out, FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const { lit, dist } = readDynamicTables(reader);
      inflateBlockData(reader, out, lit, dist);
    } else {
      throw new InflateError("reserved DEFLATE block type");
    }
  }
  return out.finish();
}

/** Inflate a zlib stream (2-byte header + DEFLATE body + Adler-32 trailer). */
export function inflateZlib(data: Uint8Array, sizeHint?: number): Uint8Array {
  if (data.length < 2) {
    throw new InflateError("zlib stream too short");
  }
  const cmf = data[0]!;
  const flg = data[1]!;
  if ((cmf & 0x0f) !== 8) {
    throw new InflateError("unsupported zlib compression method");
  }
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw new InflateError("zlib header check failed");
  }
  if ((flg & 0x20) !== 0) {
    throw new InflateError("preset dictionaries are not supported");
  }
  return inflateRaw(data, 2, sizeHint ?? data.length * 4);
}
