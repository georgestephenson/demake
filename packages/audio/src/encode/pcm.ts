/**
 * Float PCM to integer samples — the one quantizer (doc 16 §Artifacts).
 *
 * Both lossless artifacts go through this: a WAV and a FLAC of the same render
 * are **sample-identical**, and that is a claim doc 16 makes rather than a
 * coincidence two encoders arrive at. One definition is what makes it true by
 * construction — two copies of a rounding rule agree right up until somebody
 * fixes one of them.
 */

import type { Pcm } from "@demake/chip";

/** The largest magnitude a sample of this depth can hold. */
export function peakFor(bitDepth: 16 | 24): number {
  return bitDepth === 16 ? 32767 : 8388607;
}

/**
 * Clamp and round to an integer sample, half to even.
 *
 * Half-to-even rather than half-away-from-zero because it has no bias, and bias
 * in a quantizer is a DC offset that accumulates over a whole track. No dither:
 * dither is a random process, and an output that has to be byte-identical
 * across engines cannot contain one.
 */
export function quantize(sample: number, peak: number): number {
  const scaled = sample * peak;
  if (scaled >= peak) return peak;
  if (scaled <= -peak - 1) return -peak - 1;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Every channel as integer samples at this depth, in channel order. */
export function quantizeChannels(pcm: Pcm, bitDepth: 16 | 24): Int32Array[] {
  const peak = peakFor(bitDepth);
  return pcm.channels.map((channel) => {
    const out = new Int32Array(channel.length);
    for (let i = 0; i < channel.length; i += 1) out[i] = quantize(channel[i] as number, peak);
    return out;
  });
}
