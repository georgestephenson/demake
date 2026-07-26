/**
 * WAV encoding — the artifact that carries the guarantee (doc 16 §Artifacts).
 *
 * Lossless, sample-exact, and byte-golden: because the chip models are
 * deterministic, the bytes this produces are a regression test in their own
 * right, compared the way the image path compares a PNG.
 *
 * Quantization rounds half to even and applies **no dither**. Dither is a random
 * process, and an output that has to be byte-identical across engines cannot
 * contain one.
 */

import type { Pcm } from "@demake/chip";

export interface WavOptions {
  /** 16 or 24 bits per sample. */
  bitDepth?: 16 | 24;
}

/** Encode PCM as a RIFF/WAVE file. */
export function encodeWav(pcm: Pcm, options: WavOptions = {}): Uint8Array {
  const bitDepth = options.bitDepth ?? 16;
  const channels = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth / 8;
  const dataBytes = frames * channels * bytesPerSample;

  const buffer = new Uint8Array(44 + dataBytes);
  const view = new DataView(buffer.buffer);
  writeAscii(buffer, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(buffer, 8, "WAVE");
  writeAscii(buffer, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(buffer, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  const peak = bitDepth === 16 ? 32767 : 8388607;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = quantize(pcm.channels[channel]![frame]!, peak);
      if (bitDepth === 16) {
        view.setInt16(offset, value, true);
        offset += 2;
      } else {
        buffer[offset] = value & 0xff;
        buffer[offset + 1] = (value >> 8) & 0xff;
        buffer[offset + 2] = (value >> 16) & 0xff;
        offset += 3;
      }
    }
  }
  return buffer;
}

/**
 * Clamp and round to an integer sample, half to even.
 *
 * Half-to-even rather than half-away-from-zero because it has no bias, and bias
 * in a quantizer is a DC offset that accumulates over a whole track.
 */
function quantize(sample: number, peak: number): number {
  const scaled = sample * peak;
  if (scaled >= peak) return peak;
  if (scaled <= -peak - 1) return -peak - 1;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
}
