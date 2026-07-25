/**
 * UTF-8 → string, because `TextDecoder` is a platform API and core has none.
 *
 * This is the smallest thing that could possibly be needed: SVG is the one
 * *text* format the pipeline decodes, and reading it must work identically in
 * Node, in a worker and in a bundler's test environment. Thirty lines of
 * arithmetic beats a lib reference that would also drag `window` into scope and
 * defeat the platform-purity lint (doc 02).
 */

/** Decode UTF-8 bytes, skipping a byte-order mark and replacing bad sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  let at = 0;
  // A BOM is legal at the head of an XML document and is not content.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;

  const parts: string[] = [];
  const chunk: number[] = [];
  while (at < bytes.length) {
    const first = bytes[at] as number;
    let code: number;
    let length: number;
    if (first < 0x80) {
      code = first;
      length = 1;
    } else if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      length = 2;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      length = 3;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      length = 4;
    } else {
      code = 0xfffd;
      length = 1;
    }
    if (length > 1) {
      if (at + length > bytes.length) {
        code = 0xfffd;
        length = 1;
      } else {
        for (let index = 1; index < length; index += 1) {
          const next = bytes[at + index] as number;
          if ((next & 0xc0) !== 0x80) {
            code = 0xfffd;
            length = 1;
            break;
          }
          code = (code << 6) | (next & 0x3f);
        }
      }
    }
    at += length;

    if (code > 0xffff) {
      const offset = code - 0x10000;
      chunk.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      chunk.push(code);
    }
    // `fromCharCode` takes arguments, so the chunk cannot grow without bound.
    if (chunk.length >= 4096) {
      parts.push(String.fromCharCode(...chunk));
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) parts.push(String.fromCharCode(...chunk));
  return parts.join("");
}
