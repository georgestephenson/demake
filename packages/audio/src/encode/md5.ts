/**
 * MD5, for the one thing in this project that needs it.
 *
 * A FLAC stream carries an MD5 of its unencoded audio, and writing a real one
 * rather than the zeroes the format also permits is what lets `flac -t` verify
 * our encoder end to end instead of merely parsing it (doc 16 §Artifacts).
 *
 * **Not a security primitive and never to be used as one.** It is here because
 * a file format asks for it by name. Integer throughout, so the digest is the
 * same on every engine — which is the whole reason the codecs in this project
 * are its own (doc 02 §Determinism).
 *
 * Source: RFC 1321.
 */

/** Per-round left-rotation amounts. */
const SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * The per-round constants, `floor(abs(sin(i + 1)) * 2^32)`.
 *
 * Written out rather than computed, and that is the determinism rule rather
 * than a preference: `Math.sin` is not specified to the last bit and these are
 * *exact* integers in the standard. A table cannot drift.
 */
const K: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** The 128-bit digest of `input`, little-endian as MD5 defines it. */
export function md5(input: Uint8Array): Uint8Array {
  // The padded length: the message, a `0x80`, zeroes, and a 64-bit bit count.
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input, 0);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  // The length is 64 bits and a JavaScript bitwise operation reaches 32, so the
  // halves go separately — a shift would lose everything past half a gigabyte.
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const block = new Int32Array(16);
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i += 1) block[i] = view.getInt32(at + i * 4, true);
    let [aa, bb, cc, dd] = [a, b, c, d];
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) % 16;
      }
      const rotated = add(add(aa, f), add(K[i] as number, block[g] as number));
      const shift = SHIFTS[i] as number;
      aa = dd;
      dd = cc;
      cc = bb;
      bb = add(bb, (rotated << shift) | (rotated >>> (32 - shift)));
    }
    a = add(a, aa);
    b = add(b, bb);
    c = add(c, cc);
    d = add(d, dd);
  }

  const out = new Uint8Array(16);
  const digest = new DataView(out.buffer);
  digest.setInt32(0, a, true);
  digest.setInt32(4, b, true);
  digest.setInt32(8, c, true);
  digest.setInt32(12, d, true);
  return out;
}

/** Addition that stays inside 32 bits, which is what MD5 is defined over. */
function add(x: number, y: number): number {
  return (x + y) | 0;
}
