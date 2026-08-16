/**
 * The FLAC encoder against the reference decoder.
 *
 * `packages/audio/test/flac.test.ts` checks everything the encoder's own
 * arithmetic can be held to — the MD5 vectors, the stream's shape, and that the
 * samples it *claims* to carry are the WAV's. What it cannot check is that the
 * **bitstream decodes to them**, because an encoder verified only by itself is
 * verified against its own misreadings of the format. That is what this file is
 * for, and the oracle is libFLAC.
 *
 * Two checks, and the first is the stronger one. `flac -t` decodes the whole
 * stream and compares its own MD5 of the result against the one in STREAMINFO —
 * so it passes only if what came out is bit-for-bit what we hashed going in. The
 * second decodes to a WAV and compares the samples against `encodeWav`'s, which
 * is doc 16's "sample-identical" claim measured end to end through somebody
 * else's code.
 *
 * It self-skips without the tool, exactly as `arm-gnu.test.ts` does, and sits
 * beside `flac.test.ts` for the same reason that file sits beside `arm.test.ts`:
 * the hand-checked oracle and the reference-tool one are two views of one
 * encoder. It is deliberately *not* named `*.e2e.test.ts` — that suffix belongs
 * to a console's pixel-perfect suite, which `support.test.ts` cross-checks
 * against the consoles that claim one. `flac` is a stock distro package;
 * `pnpm toolchains` installs it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Pcm } from "@demake/chip";
import { encodeFlac } from "../src/encode/flac.js";
import { encodeWav } from "../src/encode/wav.js";

/** Whether the reference tool is installed. */
function available(): boolean {
  try {
    execFileSync("flac", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = available();

/** A deterministic buffer; no `Math.random` anywhere in this project. */
function pcm(channels: number, frames: number, shape: (i: number, c: number) => number): Pcm {
  return {
    sampleRate: 48000,
    channels: Array.from(
      { length: channels },
      (_, c) => new Float32Array(Array.from({ length: frames }, (_, i) => shape(i, c))),
    ),
  };
}

/**
 * A cheap deterministic noise source.
 *
 * Noise is the case that defeats every predictor, so it is the one that forces
 * the verbatim subframe — the path a stream of music never reaches and the one
 * whose absence would only show up on somebody else's file.
 */
function noise(seed: number): (i: number) => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x40000000 - 1;
  };
}

/** The `data` chunk of a RIFF file, walked rather than assumed. */
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

const CASES: readonly (readonly [string, Pcm])[] = [
  ["silence", pcm(2, 10000, () => 0)],
  ["a held level", pcm(2, 5000, () => 0.5)],
  ["a tone", pcm(2, 9000, (i, c) => Math.sin(i / (11 + c * 3)) * 0.6)],
  ["identical channels", pcm(2, 9000, (i) => Math.sin(i / 20) * 0.7)],
  ["one side only", pcm(2, 9000, (i, c) => (c === 0 ? Math.sin(i / 13) * 0.9 : 0))],
  ["full-scale noise", pcm(2, 12000, noise(12345))],
  ["clipping", pcm(2, 3000, (i) => (i % 2 ? 2 : -2))],
  ["mono", pcm(1, 8000, noise(999))],
  ["eight channels", pcm(8, 3000, (i, c) => Math.sin((i + c * 7) / 11) * 0.5)],
  ["one sample", pcm(2, 1, () => 0.25)],
  ["two samples", pcm(2, 2, (i) => (i ? 0.5 : -0.5))],
  ["exactly one block", pcm(2, 4096, (i) => Math.sin(i / 7) * 0.4)],
  ["a block and one", pcm(2, 4097, (i) => Math.sin(i / 7) * 0.4)],
  ["one short of a block", pcm(2, 4095, (i) => Math.sin(i / 7) * 0.4)],
];

describe.skipIf(!AVAILABLE)("the FLAC encoder against libFLAC", () => {
  const dir = mkdtempSync(join(tmpdir(), "demake-flac-"));

  for (const bitDepth of [16, 24] as const) {
    it.each(CASES)(`decodes %s at ${bitDepth} bits to exactly our samples`, (name, input) => {
      const stream = join(dir, `${name.replace(/\W+/g, "-")}-${bitDepth}.flac`);
      const decoded = `${stream}.wav`;
      writeFileSync(stream, encodeFlac(input, { bitDepth }));

      // Verifies the stream's own MD5 against what it decoded, which is the
      // whole guarantee in one command: it can only pass if the bitstream is
      // exactly the samples we hashed.
      execFileSync("flac", ["-t", "-s", stream], { stdio: "pipe" });

      execFileSync("flac", ["-d", "-f", "-s", "-o", decoded, stream], { stdio: "pipe" });
      // Compared by *data chunk* rather than whole file: the reference decoder
      // writes an extensible WAV header for 24-bit and for more than two
      // channels, which is a container difference and not a sample one.
      const ours = dataChunk(encodeWav(input, { bitDepth }));
      const theirs = dataChunk(readFileSync(decoded));
      expect(theirs.length).toBe(ours.length);
      expect(Buffer.compare(Buffer.from(theirs), Buffer.from(ours))).toBe(0);
    });
  }

  it("compresses a tone well below the reference's verbatim fallback", () => {
    // Not a benchmark against libFLAC — a guard that the predictors run at all.
    // A stream that fell back to verbatim everywhere would still pass every
    // check above and be larger than the samples it holds.
    const input = pcm(2, 40000, (i) => Math.sin(i / 17) * 0.5);
    expect(encodeFlac(input).length).toBeLessThan(encodeWav(input).length * 0.7);
  });
});
