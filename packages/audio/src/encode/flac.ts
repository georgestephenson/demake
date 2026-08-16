/**
 * FLAC encoding — the lossless artifact you can actually share (doc 16 §Artifacts).
 *
 * Doc 16 calls FLAC "the recommended shareable file: lossless *and* plays
 * natively in Chrome, Firefox, Safari, macOS and Windows", and it carries the
 * same guarantee a WAV does — the samples are **identical**, because both go
 * through `pcm.ts`'s one quantizer. What FLAC adds is that somebody can send it
 * to a friend without the friend needing this project.
 *
 * **Ours, like every other codec here.** The image path writes its own PNG, BMP,
 * GIF and JPEG for reasons doc 02 sets out, and the strongest of them applies
 * again: a byte-identical artifact across the CLI, the browser and the desktop
 * cannot depend on a library that ships a different version in each. Every
 * arithmetic operation below is integer, so the file this produces is the same
 * file on every engine.
 *
 * ### What is implemented, and what is deliberately not
 *
 * Subframes are **constant**, **fixed** (orders 0–4) and **verbatim**, with
 * Rice-coded residuals over a searched partition order. What is absent is the
 * **LPC** subframe, and its absence is a decision rather than a gap: computing
 * LPC coefficients means autocorrelation and Levinson-Durbin in floating point,
 * and this package runs under the determinism rule — a predictor derived from
 * `Math` would be a different file on a different engine, which is exactly the
 * property the format is here to provide. Fixed predictors are integer,
 * exhaustively searched here, and on chip audio they are close to LPC anyway:
 * a square wave is piecewise constant, so its first difference is zero almost
 * everywhere.
 *
 * Every choice below is made by **measuring the encoded size** rather than by a
 * heuristic — five predictor orders times five partition orders is small enough
 * to enumerate, and enumerating removes a whole class of "the estimate was
 * wrong" bugs.
 *
 * Source: the FLAC format specification (xiph.org/flac/format.html) and
 * RFC 9639.
 */

import type { Pcm } from "@demake/chip";

import { md5 } from "./md5.js";
import { quantizeChannels } from "./pcm.js";

export interface FlacOptions {
  /** 16 or 24 bits per sample; matches `encodeWav`'s. */
  bitDepth?: 16 | 24;
  /**
   * Samples per frame.
   *
   * 4096 is what every reference encoder uses at default settings and what the
   * block-size table can name in four bits, so a frame header stays short.
   */
  blockSize?: number;
}

/** Highest fixed predictor order the format defines. */
const MAX_FIXED_ORDER = 4;

/** Highest Rice partition order this encoder searches. */
const MAX_PARTITION_ORDER = 4;

/** Rice parameters are four bits, and `0b1111` is the escape code. */
const MAX_RICE_PARAMETER = 14;

/** Encode PCM as a FLAC stream. */
export function encodeFlac(pcm: Pcm, options: FlacOptions = {}): Uint8Array {
  const bitDepth = options.bitDepth ?? 16;
  const blockSize = options.blockSize ?? 4096;
  const channels = quantizeChannels(pcm, bitDepth);
  const channelCount = channels.length;
  const total = channels[0]?.length ?? 0;

  if (channelCount < 1 || channelCount > 8) {
    throw new Error(`FLAC carries 1-8 channels; this render has ${channelCount}`);
  }

  const frames: Uint8Array[] = [];
  let minBlock = blockSize;
  let maxBlock = 0;
  let minFrame = Number.MAX_SAFE_INTEGER;
  let maxFrame = 0;

  for (let at = 0, number = 0; at < total; at += blockSize, number += 1) {
    const count = Math.min(blockSize, total - at);
    const frame = encodeFrame(channels, at, count, number, bitDepth);
    frames.push(frame);
    if (count < minBlock) minBlock = count;
    if (count > maxBlock) maxBlock = count;
    if (frame.length < minFrame) minFrame = frame.length;
    if (frame.length > maxFrame) maxFrame = frame.length;
  }
  if (frames.length === 0) {
    minBlock = blockSize;
    maxBlock = blockSize;
    minFrame = 0;
  }

  const header = streamInfo({
    minBlock,
    maxBlock,
    minFrame: minFrame === Number.MAX_SAFE_INTEGER ? 0 : minFrame,
    maxFrame,
    sampleRate: pcm.sampleRate,
    channels: channelCount,
    bitDepth,
    total,
    md5: audioMd5(channels, bitDepth),
  });

  let length = header.length;
  for (const frame of frames) length += frame.length;
  const out = new Uint8Array(length);
  out.set(header, 0);
  let offset = header.length;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** `fLaC` and the mandatory STREAMINFO block. */
function streamInfo(info: {
  minBlock: number;
  maxBlock: number;
  minFrame: number;
  maxFrame: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  total: number;
  md5: Uint8Array;
}): Uint8Array {
  const bits = new BitWriter();
  // The last-metadata-block flag is set: this encoder writes STREAMINFO and
  // nothing else, so there is no seek table, no padding and no tags. A decoder
  // needs none of them, and every byte of a metadata block is a byte that is
  // not audio.
  bits.write(1, 1);
  bits.write(0, 7); // STREAMINFO
  bits.write(34, 24); // its fixed length
  bits.write(info.minBlock, 16);
  bits.write(info.maxBlock, 16);
  bits.write(info.minFrame, 24);
  bits.write(info.maxFrame, 24);
  bits.write(info.sampleRate, 20);
  bits.write(info.channels - 1, 3);
  bits.write(info.bitDepth - 1, 5);
  // Thirty-six bits of sample count, which is more than fits in a bitwise
  // integer — so the top four go separately rather than through a shift that
  // would silently truncate.
  bits.write(Math.floor(info.total / 0x100000000), 4);
  bits.write(info.total >>> 0, 32);
  const out = new Uint8Array(4 + bits.bytes.length + 16);
  out.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
  out.set(bits.bytes, 4);
  out.set(info.md5, 4 + bits.bytes.length);
  return out;
}

/**
 * The MD5 of the unencoded audio, which is what `flac -t` verifies against.
 *
 * Optional in the format — a stream may leave it zero — and written anyway,
 * because it turns the reference decoder into an end-to-end oracle for this
 * encoder rather than merely a parser of it. The bytes hashed are the samples
 * interleaved little-endian at the stream's own depth, which is the same layout
 * `encodeWav` writes.
 */
function audioMd5(channels: readonly Int32Array[], bitDepth: number): Uint8Array {
  const bytesPerSample = bitDepth / 8;
  const frames = channels[0]?.length ?? 0;
  const raw = new Uint8Array(frames * channels.length * bytesPerSample);
  let at = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const value = channel[frame] as number;
      for (let byte = 0; byte < bytesPerSample; byte += 1) {
        raw[at] = (value >> (byte * 8)) & 0xff;
        at += 1;
      }
    }
  }
  return md5(raw);
}

/** One FLAC frame: header, a subframe per channel, and a CRC over the whole. */
function encodeFrame(
  channels: readonly Int32Array[],
  at: number,
  count: number,
  number: number,
  bitDepth: number,
): Uint8Array {
  const chosen = decorrelate(channels, at, count, bitDepth);
  const bits = new BitWriter();
  bits.write(0x3ffe, 14); // sync
  bits.write(0, 1); // reserved
  bits.write(0, 1); // fixed block size, so the coded number is a frame number

  const blockCode = blockSizeCode(count);
  bits.write(blockCode.code, 4);
  // Sample rate is read from STREAMINFO. The four-bit table names only a dozen
  // rates and this project renders at whatever the caller asked for, so naming
  // it here would be a second statement of something already stated exactly.
  bits.write(0, 4);
  bits.write(chosen.assignment, 4);
  bits.write(bitDepth === 16 ? 4 : 6, 3);
  bits.write(0, 1); // reserved
  writeUtf8Number(bits, number);
  if (blockCode.extra === 8) bits.write(count - 1, 8);
  else if (blockCode.extra === 16) bits.write(count - 1, 16);
  bits.align();
  bits.write(crc8(bits.bytes), 8);

  for (const body of chosen.bodies) bits.append(body);
  bits.align();
  bits.write(crc16(bits.bytes), 16);
  return bits.bytes;
}

/**
 * Choose how a frame's channels are correlated, by encoding each way.
 *
 * A stereo pair is usually two views of one thing, so the format lets a frame
 * carry a **difference** in place of one of them: `side = left - right` is near
 * silence wherever the two agree, and near silence is what a Rice-coded
 * residual is cheapest at. Four arrangements are legal — independent, left and
 * side, side and right, and mid and side — and the smallest is kept.
 *
 * Four candidate *pairs* but only four candidate *subframes*: left, right, mid
 * and side are each encoded once and then combined, which is what keeps this at
 * twice the work of coding independently rather than four times it.
 *
 * A side channel needs **one more bit** than the stream's depth, because a
 * difference of two `n`-bit values does not fit in `n` — and the format says so
 * rather than leaving it implied, which is the one thing here a decoder cannot
 * recover if an encoder gets it wrong.
 *
 * Mono and anything above two channels are coded independently: the format has
 * no decorrelation for them.
 */
function decorrelate(
  channels: readonly Int32Array[],
  at: number,
  count: number,
  bitDepth: number,
): { assignment: number; bodies: BitWriter[] } {
  if (channels.length !== 2) {
    return {
      assignment: channels.length - 1,
      bodies: channels.map((channel) => encodeSubframe(channel.subarray(at, at + count), bitDepth)),
    };
  }

  const left = (channels[0] as Int32Array).subarray(at, at + count);
  const right = (channels[1] as Int32Array).subarray(at, at + count);
  const mid = new Int32Array(count);
  const side = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const l = left[i] as number;
    const r = right[i] as number;
    // `>> 1` rather than a divide: the decoder recovers the lost bit from the
    // difference's own parity, which only works if this floors.
    mid[i] = (l + r) >> 1;
    side[i] = l - r;
  }

  const leftBody = encodeSubframe(left, bitDepth);
  const rightBody = encodeSubframe(right, bitDepth);
  const midBody = encodeSubframe(mid, bitDepth);
  const sideBody = encodeSubframe(side, bitDepth + 1);

  const options: { assignment: number; bodies: BitWriter[] }[] = [
    { assignment: 1, bodies: [leftBody, rightBody] },
    { assignment: 8, bodies: [leftBody, sideBody] },
    { assignment: 9, bodies: [sideBody, rightBody] },
    { assignment: 10, bodies: [midBody, sideBody] },
  ];
  let best = options[0] as { assignment: number; bodies: BitWriter[] };
  let bestBits = best.bodies[0]!.length + best.bodies[1]!.length;
  for (const option of options.slice(1)) {
    const bits = option.bodies[0]!.length + option.bodies[1]!.length;
    if (bits < bestBits) {
      bestBits = bits;
      best = option;
    }
  }
  return best;
}

/**
 * The smallest subframe this encoder can produce for one channel of one frame.
 *
 * Measured rather than estimated: a constant run, five fixed predictor orders
 * and a verbatim fallback are each encoded and the shortest kept. The verbatim
 * case is what makes the encoder total — noise at full scale genuinely does not
 * predict, and a format that had no answer for it would produce a file larger
 * than the samples it holds.
 */
function encodeSubframe(samples: Int32Array, bitDepth: number): BitWriter {
  const bits = new BitWriter();

  let constant = true;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] !== samples[0]) {
      constant = false;
      break;
    }
  }
  if (constant) {
    bits.write(0, 1);
    bits.write(0x00, 6); // CONSTANT
    bits.write(0, 1);
    bits.writeSigned(samples[0] ?? 0, bitDepth);
    return bits;
  }

  let best: { order: number; body: BitWriter } | undefined;
  const orders = Math.min(MAX_FIXED_ORDER, Math.max(0, samples.length - 1));
  for (let order = 0; order <= orders; order += 1) {
    const body = fixedSubframe(samples, order, bitDepth);
    if (body === undefined) continue;
    if (best === undefined || body.length < best.body.length) best = { order, body };
  }

  const verbatimBits = samples.length * bitDepth;
  if (best !== undefined && best.body.length <= verbatimBits) {
    bits.write(0, 1);
    bits.write(0x08 | best.order, 6); // FIXED
    bits.write(0, 1);
    bits.append(best.body);
    return bits;
  }

  bits.write(0, 1);
  bits.write(0x01, 6); // VERBATIM
  bits.write(0, 1);
  for (const sample of samples) bits.writeSigned(sample, bitDepth);
  return bits;
}

/** A fixed-predictor subframe body: warm-up samples then the residual. */
function fixedSubframe(
  samples: Int32Array,
  order: number,
  bitDepth: number,
): BitWriter | undefined {
  if (samples.length <= order) return undefined;
  const residual = new Int32Array(samples.length - order);
  for (let i = order; i < samples.length; i += 1) {
    residual[i - order] = predict(samples, i, order);
  }

  const partition = bestPartitioning(residual, samples.length, order);
  if (partition === undefined) return undefined;

  const body = new BitWriter();
  for (let i = 0; i < order; i += 1) body.writeSigned(samples[i] as number, bitDepth);
  body.write(0, 2); // Rice with a four-bit parameter
  body.write(partition.order, 4);
  let offset = 0;
  for (let index = 0; index < 1 << partition.order; index += 1) {
    const length = partitionLength(samples.length, order, partition.order, index);
    const parameter = partition.parameters[index] as number;
    body.write(parameter, 4);
    for (let i = 0; i < length; i += 1) {
      body.writeRice(residual[offset + i] as number, parameter);
    }
    offset += length;
  }
  return body;
}

/** The fixed predictor's residual at `i`, for orders 0 through 4. */
function predict(samples: Int32Array, i: number, order: number): number {
  const x = (back: number): number => samples[i - back] as number;
  switch (order) {
    case 0:
      return x(0);
    case 1:
      return x(0) - x(1);
    case 2:
      return x(0) - 2 * x(1) + x(2);
    case 3:
      return x(0) - 3 * x(1) + 3 * x(2) - x(3);
    default:
      return x(0) - 4 * x(1) + 6 * x(2) - 4 * x(3) + x(4);
  }
}

/** How many residual samples partition `index` holds. */
function partitionLength(
  blockSize: number,
  order: number,
  partitionOrder: number,
  index: number,
): number {
  const per = blockSize >> partitionOrder;
  return index === 0 ? per - order : per;
}

/**
 * The partition order and Rice parameters that encode this residual smallest.
 *
 * Both are searched exhaustively, which is affordable because both spaces are
 * tiny — five partition orders and fifteen parameters — and exact, which
 * removes the usual family of bugs where an estimator disagrees with the
 * encoder that follows it.
 */
function bestPartitioning(
  residual: Int32Array,
  blockSize: number,
  order: number,
): { order: number; parameters: number[]; bits: number } | undefined {
  let best: { order: number; parameters: number[]; bits: number } | undefined;
  for (let partitionOrder = 0; partitionOrder <= MAX_PARTITION_ORDER; partitionOrder += 1) {
    const partitions = 1 << partitionOrder;
    // Every partition but the first must be whole, and the first loses the
    // warm-up samples — so a block that does not divide evenly, or whose first
    // partition would be empty, cannot use this order at all.
    if (blockSize % partitions !== 0) continue;
    if (blockSize >> partitionOrder <= order) continue;

    const parameters: number[] = [];
    let bits = 4 * partitions;
    let offset = 0;
    let usable = true;
    for (let index = 0; index < partitions; index += 1) {
      const length = partitionLength(blockSize, order, partitionOrder, index);
      const chosen = bestParameter(residual, offset, length);
      if (chosen === undefined) {
        usable = false;
        break;
      }
      parameters.push(chosen.parameter);
      bits += chosen.bits;
      offset += length;
    }
    if (!usable) continue;
    if (best === undefined || bits < best.bits) {
      best = { order: partitionOrder, parameters, bits };
    }
  }
  return best;
}

/** The Rice parameter that encodes one partition smallest, and what it costs. */
function bestParameter(
  residual: Int32Array,
  offset: number,
  length: number,
): { parameter: number; bits: number } | undefined {
  let best: { parameter: number; bits: number } | undefined;
  for (let parameter = 0; parameter <= MAX_RICE_PARAMETER; parameter += 1) {
    let bits = 0;
    for (let i = 0; i < length; i += 1) {
      bits += riceBits(residual[offset + i] as number, parameter);
    }
    if (best === undefined || bits < best.bits) best = { parameter, bits };
  }
  return best;
}

/** Zig-zag: a signed residual as the unsigned value Rice coding takes. */
function fold(value: number): number {
  return value < 0 ? -2 * value - 1 : 2 * value;
}

/** What one residual costs at this parameter. */
function riceBits(value: number, parameter: number): number {
  return Math.floor(fold(value) / 2 ** parameter) + 1 + parameter;
}

/** The four-bit block-size code, and how many extra bits it needs after it. */
function blockSizeCode(count: number): { code: number; extra: 0 | 8 | 16 } {
  if (count === 192) return { code: 1, extra: 0 };
  for (let i = 0; i < 4; i += 1) if (count === 576 << i) return { code: 2 + i, extra: 0 };
  for (let i = 0; i < 8; i += 1) if (count === 256 << i) return { code: 8 + i, extra: 0 };
  // The final frame of a stream is whatever is left, and almost never a size
  // the table names — so its length is stated after the header instead.
  if (count <= 256) return { code: 6, extra: 8 };
  return { code: 7, extra: 16 };
}

/**
 * A frame number in the format's UTF-8-shaped encoding.
 *
 * Not UTF-8 — it borrows the *shape*, so a value is a length written in leading
 * ones followed by six bits per continuation byte, and it extends to seven
 * bytes where real UTF-8 stops at four.
 */
function writeUtf8Number(bits: BitWriter, value: number): void {
  if (value < 0x80) {
    bits.write(value, 8);
    return;
  }
  let length = 2;
  while (length < 7 && value >= 2 ** (6 * (length - 1) + (7 - length))) length += 1;
  let lead = 0;
  for (let i = 0; i < length; i += 1) lead = (lead << 1) | 1;
  lead <<= 1;
  const headBits = 7 - length;
  bits.write((lead << headBits) | Math.floor(value / 2 ** (6 * (length - 1))), 8);
  for (let i = length - 1; i > 0; i -= 1) {
    bits.write(0x80 | (Math.floor(value / 2 ** (6 * (i - 1))) & 0x3f), 8);
  }
}

/** A most-significant-bit-first bit writer, which is the order FLAC is in. */
class BitWriter {
  private data: number[] = [];
  private partial = 0;
  private used = 0;

  /** Bits written so far. */
  get length(): number {
    return this.data.length * 8 + this.used;
  }

  get bytes(): Uint8Array {
    return Uint8Array.from(this.data);
  }

  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) {
      // `Math.floor` and a power rather than `>>>`, because a count above 31
      // reaches past what a bitwise shift can address and would wrap silently.
      const bit = Math.floor(value / 2 ** i) % 2;
      this.partial = (this.partial << 1) | (bit < 0 ? bit + 2 : bit);
      this.used += 1;
      if (this.used === 8) {
        this.data.push(this.partial & 0xff);
        this.partial = 0;
        this.used = 0;
      }
    }
  }

  /** A two's-complement value in `count` bits. */
  writeSigned(value: number, count: number): void {
    this.write(value < 0 ? value + 2 ** count : value, count);
  }

  /** One Rice-coded residual: a unary quotient then the remainder. */
  writeRice(value: number, parameter: number): void {
    const folded = fold(value);
    const quotient = Math.floor(folded / 2 ** parameter);
    for (let i = 0; i < quotient; i += 1) this.write(0, 1);
    this.write(1, 1);
    if (parameter > 0) this.write(folded % 2 ** parameter, parameter);
  }

  /** Pad with zeroes to the next byte boundary. */
  align(): void {
    while (this.used !== 0) this.write(0, 1);
  }

  /** Append another writer's bits; the source must be byte-aligned. */
  append(other: BitWriter): void {
    for (const byte of other.data) this.write(byte, 8);
    if (other.used > 0) this.write(other.partial, other.used);
  }
}

/** CRC-8, polynomial `x^8 + x^2 + x + 1`, over a frame header. */
function crc8(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

/** CRC-16, polynomial `x^16 + x^15 + x^2 + 1`, over a whole frame. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
