/**
 * A minimal zlib compressor that emits **stored** (uncompressed) DEFLATE blocks.
 *
 * The design docs require the PNG encoder to be byte-deterministic and free of
 * libpng/zlib drift (doc 04 §Gotchas). Stored blocks trivially satisfy that:
 * the output is a pure function of the input with no Huffman-tree or match
 * choices to vary. The cost is size — outputs are larger than a compressing
 * encoder's — but demake's images are tiny (≤ 512×512 indexed), so the bytes
 * are cheap, and a compressing back end can be swapped in later behind this same
 * interface (an output-affecting minor release when it lands).
 */

import { adler32 } from "./checksums.js";

const MAX_BLOCK = 0xffff;

/** Compress `data` into a zlib stream using stored blocks only. */
export function deflateStored(data: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.length / MAX_BLOCK));
  // zlib header (2) + per block [1 flag + 2 len + 2 nlen] + data + adler (4).
  const total = 2 + blockCount * 5 + data.length + 4;
  const out = new Uint8Array(total);
  let p = 0;

  // zlib header: CM=8/CINFO=7 (0x78), FLEVEL=0 with a valid FCHECK (0x01).
  out[p++] = 0x78;
  out[p++] = 0x01;

  let offset = 0;
  for (let b = 0; b < blockCount; b += 1) {
    const size = Math.min(MAX_BLOCK, data.length - offset);
    const isFinal = b === blockCount - 1 ? 1 : 0;
    out[p++] = isFinal; // BFINAL bit, BTYPE=00 (stored)
    out[p++] = size & 0xff;
    out[p++] = (size >> 8) & 0xff;
    out[p++] = ~size & 0xff;
    out[p++] = (~size >> 8) & 0xff;
    out.set(data.subarray(offset, offset + size), p);
    p += size;
    offset += size;
  }

  const checksum = adler32(data);
  out[p] = (checksum >>> 24) & 0xff;
  out[p + 1] = (checksum >>> 16) & 0xff;
  out[p + 2] = (checksum >>> 8) & 0xff;
  out[p + 3] = checksum & 0xff;

  return out;
}
