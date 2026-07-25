/**
 * Sound input (doc 18 §Input).
 *
 * WAV today, and the lossy formats when their pinned WASM decoders land. Saying
 * so in an error is better than accepting a file and producing something wrong:
 * a decoder that silently misreads a header sounds like a broken effect, not
 * like a missing feature.
 *
 * Everything ends up as mono float at the canonical analysis rate, because the
 * rest of the sound demaker should not have to care what arrived.
 */

import { ANALYSIS_RATE, resample } from "../dsp.js";

/** Thrown when a sound file cannot be read, with the reason. */
export class SoundDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoundDecodeError";
  }
}

export interface DecodedSound {
  /** Mono, at {@link ANALYSIS_RATE}. */
  samples: Float32Array;
  sampleRate: number;
  /** What the file actually held, for reporting. */
  source: { format: string; sampleRate: number; channels: number };
}

/** Decode a sound file to mono analysis-rate float. */
export function decodeSound(bytes: Uint8Array): DecodedSound {
  if (!isWav(bytes)) {
    throw new SoundDecodeError(
      "only WAV input is supported today; MP3, AAC, Ogg and Opus arrive with their pinned decoders (doc 18 §Input)",
    );
  }
  const wav = decodeWav(bytes);
  const mono = toMono(wav.channels);
  return {
    samples: resample(mono, wav.sampleRate, ANALYSIS_RATE),
    sampleRate: ANALYSIS_RATE,
    source: { format: "wav", sampleRate: wav.sampleRate, channels: wav.channels.length },
  };
}

/** True when the bytes begin with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length > 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

/** Decode PCM (8/16/24/32-bit integer) and 32-bit float WAV. */
function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitDepth = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, bytes.length - body);
    }
    // Chunks are word-aligned, and a file that ignores that is a file that
    // decodes as noise from the second chunk on.
    offset = body + size + (size % 2);
  }

  if (dataOffset < 0 || channelCount === 0 || sampleRate === 0) {
    throw new SoundDecodeError("WAV file has no usable fmt/data chunks");
  }
  // 0xFFFE is WAVE_FORMAT_EXTENSIBLE, whose sub-format we treat as PCM — the
  // common case for anything above 16-bit written by a modern editor.
  if (format !== 1 && format !== 3 && format !== 0xfffe) {
    throw new SoundDecodeError(`unsupported WAV encoding (format ${format}); PCM or float only`);
  }

  const bytesPerSample = bitDepth / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channelCount));
  const channels: Float32Array[] = [];
  for (let c = 0; c < channelCount; c += 1) channels.push(new Float32Array(frames));

  for (let frame = 0; frame < frames; frame += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const at = dataOffset + (frame * channelCount + c) * bytesPerSample;
      channels[c]![frame] = readSample(view, at, bitDepth, format);
    }
  }
  return { sampleRate, channels };
}

function readSample(view: DataView, at: number, bitDepth: number, format: number): number {
  if (format === 3) {
    return bitDepth === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
  }
  switch (bitDepth) {
    case 8:
      // 8-bit WAV is unsigned, alone among the integer depths.
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32768;
    case 24: {
      const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return value / 8388608;
    }
    case 32:
      return view.getInt32(at, true) / 2147483648;
    default:
      throw new SoundDecodeError(`unsupported WAV bit depth ${bitDepth}`);
  }
}

/**
 * Fold to mono.
 *
 * Almost no console can pan a single effect meaningfully, and the ones that can
 * are better served by a placement decision than by inheriting the source's
 * stereo image (doc 18 §Input).
 */
function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i] ?? 0;
    out[i] = sum / channels.length;
  }
  return out;
}
