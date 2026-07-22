/**
 * CRC-32 (PNG chunks) and Adler-32 (zlib) checksums.
 *
 * Both are pure integer arithmetic, so they are deterministic by construction.
 * The CRC table is built once at module load from the standard polynomial.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a byte range, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32 of a byte range, as an unsigned 32-bit integer. */
export function adler32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  for (let i = start; i < end; i += 1) {
    a = (a + bytes[i]!) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}
