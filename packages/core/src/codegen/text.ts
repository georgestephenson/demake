/**
 * Tiny ASCII text helpers for codegen (doc 02 §Dependency rules).
 *
 * All generated source (`asm`/`c`) and their provenance headers are ASCII, so
 * core encodes them byte-by-byte rather than reaching for `TextEncoder` — which
 * is a platform global the core is deliberately not allowed to see (the DOM/Node
 * libs are excluded so the platform-purity lint can catch stray I/O). This keeps
 * codegen output byte-deterministic across every JS engine.
 */

/**
 * Encode a string to bytes as clean, deterministic ASCII: printable ASCII and
 * newline/tab pass through; anything else (a non-ASCII char in a filename that
 * reached a header, say) becomes `?`. Generated source thus never carries stray
 * control bytes, whatever the inputs.
 */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    out[i] = code === 10 || code === 9 || (code >= 32 && code <= 126) ? code : 63;
  }
  return out;
}

/** Lowercase hex of an unsigned byte, zero-padded to two digits. */
export function hex2(value: number): string {
  return (value & 0xff).toString(16).padStart(2, "0");
}

/** Lowercase `0x`-prefixed hex of a byte, e.g. `0x0f`. */
export function hexByte(value: number): string {
  return `$${hex2(value)}`;
}

/** Lowercase hex of an unsigned 32-bit value, zero-padded to eight digits. */
export function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
