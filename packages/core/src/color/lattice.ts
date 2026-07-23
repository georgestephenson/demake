/**
 * Hardware color-lattice snapping (doc 04 §Stage 3).
 *
 * RGB-lattice consoles can only display colors on a coarse grid — RGB555 on the
 * GBC/SNES, RGB333 on the Mega Drive, RGB222 on the Master System, and so on.
 * Quantization snaps cluster centers to this lattice *inside* the k-means loop
 * (not after), which is why the snap functions live here and take per-channel
 * bit depths from the {@link ConsoleSpec}.
 */

/** Per-channel bit depths, e.g. `[5,5,5]` for RGB555, `[3,3,3]` for RGB333. */
export type ChannelBits = readonly [r: number, g: number, b: number];

/** An 8-bit-per-channel sRGB color. */
export interface Rgb8 {
  r: number;
  g: number;
  b: number;
}

/**
 * Quantize one 8-bit channel value (0–255) to `bits` of precision and expand it
 * back to 8-bit by bit-replication — the canonical "left-align then copy the
 * high bits down" expansion hardware and every reference tool use, so a snapped
 * value round-trips to the exact byte an emulator would show for that raw code.
 */
export function snapChannel(value: number, bits: number): number {
  if (bits >= 8) {
    return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  }
  const levels = (1 << bits) - 1;
  const v = value < 0 ? 0 : value > 255 ? 255 : value;
  const code = Math.round((v / 255) * levels);
  return expandChannel(code, bits);
}

/**
 * Expand a raw `bits`-wide channel code (0…2^bits−1) to an 8-bit value by **full
 * bit-replication** — repeat the code across all 8 bits, the expansion real
 * hardware and accuracy emulators use. For `bits ≥ 4` this is a single
 * replication (e.g. 5-bit `abcde → abcdeabc`); for 2-bit it is `xy → xyxyxyxy`
 * (so code 1 → 0x55 = 85, not the partial 0x50). Matters for RGB222/RGB333
 * consoles, where a partial expansion would miss the emulator by a few LSBs.
 */
export function expandChannel(code: number, bits: number): number {
  if (bits >= 8) {
    return code & 0xff;
  }
  let value = 0;
  let filled = 0;
  while (filled < 8) {
    value = (value << bits) | (code & ((1 << bits) - 1));
    filled += bits;
  }
  return (value >> (filled - 8)) & 0xff;
}

/** The raw `bits`-wide code for an 8-bit channel value (no re-expansion). */
export function channelCode(value: number, bits: number): number {
  if (bits >= 8) {
    return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
  }
  const levels = (1 << bits) - 1;
  const v = value < 0 ? 0 : value > 255 ? 255 : value;
  return Math.round((v / 255) * levels);
}

/** Snap an 8-bit color to the given channel lattice. */
export function snapRgb(color: Rgb8, bits: ChannelBits): Rgb8 {
  return {
    r: snapChannel(color.r, bits[0]),
    g: snapChannel(color.g, bits[1]),
    b: snapChannel(color.b, bits[2]),
  };
}

/** The raw per-channel codes for a color on the given lattice. */
export function rgbCodes(color: Rgb8, bits: ChannelBits): [number, number, number] {
  return [
    channelCode(color.r, bits[0]),
    channelCode(color.g, bits[1]),
    channelCode(color.b, bits[2]),
  ];
}
