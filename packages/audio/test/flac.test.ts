/**
 * The FLAC encoder, without needing a decoder (doc 16 §Artifacts).
 *
 * This file asserts everything that can be checked from the encoder's own
 * output: the MD5 against the standard's vectors, the stream's shape, and —
 * the load-bearing one — that the samples a FLAC *claims* to carry are exactly
 * the samples the WAV of the same render carries. That last check ties the two
 * lossless artifacts together without a decoder in the room, because the
 * stream's own MD5 is computed over the same interleaved little-endian layout
 * `encodeWav` writes into its data chunk.
 *
 * What it cannot do is prove the *bitstream* decodes to those samples — an
 * encoder checked only by its own arithmetic is checked against itself. That is
 * `packages/cli/test/flac.e2e.test.ts`'s job, where the reference decoder is
 * the oracle: `flac -t` verifies this MD5 against what it actually decoded.
 */

import { describe, expect, it } from "vitest";

import type { Pcm } from "@demake/chip";

import { encodeFlac } from "../src/encode/flac.js";
import { encodeWav } from "../src/encode/wav.js";
import { md5 } from "../src/encode/md5.js";

/** A deterministic PCM buffer; no `Math.random`, per the determinism rule. */
function pcm(channels: number, frames: number, shape: (i: number, c: number) => number): Pcm {
  return {
    sampleRate: 48000,
    channels: Array.from(
      { length: channels },
      (_, c) => new Float32Array(Array.from({ length: frames }, (_, i) => shape(i, c))),
    ),
  };
}

/** The `data` chunk of a RIFF file, found by walking rather than assuming 44. */
function dataChunk(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** The 16-byte MD5 a stream carries, which sits at the end of STREAMINFO. */
function streamMd5(flac: Uint8Array): Uint8Array {
  return flac.subarray(4 + 4 + 34 - 16, 4 + 4 + 34);
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("MD5", () => {
  // The standard's own vectors. This is here rather than in a file of its own
  // because the digest exists for exactly one caller.
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  ])("digests %j", (input, expected) => {
    expect(hex(md5(new TextEncoder().encode(input)))).toBe(expected);
  });

  it("digests the standard's long vector", () => {
    expect(hex(md5(new TextEncoder().encode("1234567890".repeat(8))))).toBe(
      "57edf4a22be3c955ac49da2e2107b67a",
    );
  });

  // The padding boundary, which is where an MD5 goes wrong if it goes wrong at
  // all: a message with 56 or more bytes in its final block has no room for the
  // 64-bit length and needs a whole extra block. 55/56 straddle that, and 63/64/65
  // straddle the block itself.
  it.each([
    [55, "ef1772b6dff9a122358552954ad0df65"],
    [56, "3b0c8ac703f828b04c6c197006d17218"],
    [57, "652b906d60af96844ebd21b674f35e93"],
    [63, "b06521f39153d618550606be297466d5"],
    [64, "014842d480b571495a4a0363793f7367"],
    [65, "c743a45e0d2e6a95cb859adae0248435"],
    [119, "8a7bd0732ed6a28ce75f6dabc90e1613"],
    [120, "5f61c0ccad4cac44c75ff505e1f1e537"],
  ])("digests %i bytes across the padding boundary", (length, expected) => {
    expect(hex(md5(new TextEncoder().encode("a".repeat(length))))).toBe(expected);
  });
});

describe("the stream", () => {
  const sample = pcm(2, 9000, (i, c) => Math.sin(i / (11 + c * 3)) * 0.6);

  it("opens with the magic and a last-block STREAMINFO", () => {
    const flac = encodeFlac(sample);
    expect([...flac.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    // Bit 7 of the block header is the last-block flag; the low seven bits are
    // the type, and STREAMINFO is 0. The length that follows is always 34.
    expect(flac[4]).toBe(0x80);
    expect([flac[5], flac[6], flac[7]]).toEqual([0, 0, 34]);
  });

  it("states the rate, the channels, the depth and the length", () => {
    const flac = encodeFlac(sample);
    const view = new DataView(flac.buffer, flac.byteOffset, flac.byteLength);
    // Sample rate is 20 bits, then 3 of channels-1 and 5 of depth-1.
    const packed = view.getUint32(8 + 10, false);
    expect(packed >>> 12).toBe(48000);
    expect(((packed >>> 9) & 0x07) + 1).toBe(2);
    expect(((packed >>> 4) & 0x1f) + 1).toBe(16);
    // The bottom four bits of that word are the top of a 36-bit sample count.
    const total = (packed & 0x0f) * 0x100000000 + view.getUint32(8 + 14, false);
    expect(total).toBe(9000);
  });

  it.each([16, 24] as const)("carries the WAV's own samples at %i bits", (bitDepth) => {
    // The claim doc 16 makes — that the two lossless artifacts are *sample*
    // identical — checked without a decoder: the stream's MD5 is taken over the
    // same interleaved layout the WAV's data chunk holds, so if the two digests
    // agree then the FLAC is carrying the WAV's samples exactly.
    const flac = encodeFlac(sample, { bitDepth });
    const wav = encodeWav(sample, { bitDepth });
    expect(hex(streamMd5(flac))).toBe(hex(md5(dataChunk(wav))));
  });

  it("is deterministic", () => {
    // The reason this codec is ours rather than a dependency's.
    expect(hex(encodeFlac(sample))).toBe(hex(encodeFlac(sample)));
  });

  it("is smaller than the WAV it came from", () => {
    // Not a compression benchmark — a guard that the predictors are being used
    // at all. A bug that fell back to verbatim everywhere would still decode
    // perfectly and produce a file larger than the samples.
    expect(encodeFlac(sample).length).toBeLessThan(encodeWav(sample).length * 0.8);
  });

  it("collapses silence to almost nothing", () => {
    // Silence is the constant subframe, and a stream that did not use it would
    // be thousands of times this size. It is also the shape a demade track has
    // most of, between one scene's music and the next.
    const quiet = encodeFlac(pcm(2, 100000, () => 0));
    expect(quiet.length).toBeLessThan(4000);
  });

  it.each([
    ["one sample", pcm(2, 1, () => 0.25)],
    ["mono", pcm(1, 5000, (i) => Math.sin(i / 9) * 0.5)],
    ["eight channels", pcm(8, 2000, (i, c) => Math.sin((i + c) / 7) * 0.4)],
    ["a partial final block", pcm(2, 4097, (i) => Math.sin(i / 7) * 0.4)],
    ["nothing at all", pcm(2, 0, () => 0)],
  ])("encodes %s", (_name, input) => {
    const flac = encodeFlac(input);
    expect([...flac.subarray(0, 4)]).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(hex(streamMd5(flac))).toBe(hex(md5(dataChunk(encodeWav(input)))));
  });

  it("refuses more channels than the format holds", () => {
    expect(() => encodeFlac(pcm(9, 100, () => 0))).toThrow(/1-8 channels/);
  });
});
