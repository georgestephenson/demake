/**
 * The live stream and the offline render are the same renderer.
 *
 * This is the test that keeps doc 07's "the page plays what the CLI writes"
 * honest at the level it is actually decided: if a chip driven in emulator-sized
 * chunks produced different samples from the same chip driven by `render`, the
 * web app would have a synthesizer in it, however carefully it was written.
 */

import { describe, expect, it } from "vitest";

import { GbApu, GB_CLOCK_HZ } from "../src/gb-apu.js";
import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import { StreamSink } from "../src/stream.js";
import type { RegisterWrite } from "../src/types.js";

/** A pulse on channel 1 and a noise burst on channel 4 — two voices, both on. */
const WRITES: RegisterWrite[] = [
  { reg: 0x26, value: 0x80 },
  { reg: 0x24, value: 0x77 },
  { reg: 0x25, value: 0xff },
  { reg: 0x11, value: 0x80 },
  { reg: 0x12, value: 0xf0 },
  { reg: 0x13, value: 0xd6 },
  { reg: 0x14, value: 0x86 },
  { reg: 0x21, value: 0xa0 },
  { reg: 0x22, value: 0x25 },
  { reg: 0x23, value: 0x80 },
];

const SECONDS = 0.25;
const SAMPLE_RATE = 48000;

/** What `render` produces: one tick carrying the writes, then that long held. */
function offline(): Float32Array[] {
  const schedule: ScheduleTick[] = [{ writes: WRITES }];
  const pcm = renderSchedule(
    new GbApu(),
    schedule,
    { num: 1, den: SECONDS },
    {
      sampleRate: SAMPLE_RATE,
    },
  );
  return pcm.channels;
}

/** What an emulator produces: the same writes, then time in ragged chunks. */
function streamed(chunks: readonly number[]): Float32Array[] {
  const apu = new GbApu();
  const sink = new StreamSink(GB_CLOCK_HZ, { sampleRate: SAMPLE_RATE, capacitySeconds: 2 });
  for (const write of WRITES) apu.write(write.reg, write.value);

  const total = Math.round(SECONDS * GB_CLOCK_HZ);
  let done = 0;
  let at = 0;
  while (done < total) {
    const span = Math.min(chunks[at % chunks.length] as number, total - done);
    apu.run(span, sink);
    done += span;
    at += 1;
  }

  const left = new Float32Array(sink.available);
  const right = new Float32Array(sink.available);
  sink.read(left, right, left.length);
  return [left, right];
}

describe("StreamSink", () => {
  it("produces exactly what the offline renderer does, in any chunk size", () => {
    const want = offline();
    // Frame-sized, scanline-sized and deliberately awkward: the chunking is the
    // emulator's business and must not be able to move a sample boundary.
    const got = streamed([70224, 456, 17, 4096, 1]);
    const length = Math.min(want[0]!.length, got[0]!.length);
    // A quarter second at 48 kHz — if the two disagreed at all it would be here.
    expect(length).toBeGreaterThan(SECONDS * SAMPLE_RATE - 2);
    for (const channel of [0, 1]) {
      for (let i = 0; i < length; i += 1) {
        expect(got[channel]![i], `channel ${channel}, sample ${i}`).toBe(want[channel]![i]);
      }
    }
  });

  it("carries the DC blocker across calls rather than restarting it", () => {
    // Restarting the filter per chunk puts a step at every boundary, which is
    // sixty clicks a second in a running game and is invisible to any test that
    // only looks at one chunk.
    const oneGo = streamed([Math.round(SECONDS * GB_CLOCK_HZ)]);
    const chunked = streamed([1024]);
    const length = Math.min(oneGo[0]!.length, chunked[0]!.length);
    for (let i = 0; i < length; i += 1) expect(chunked[0]![i]).toBe(oneGo[0]![i]);
  });

  it("reports what it read, and drops the oldest audio when nobody listens", () => {
    const sink = new StreamSink(GB_CLOCK_HZ, { sampleRate: 1000, capacitySeconds: 0.01 });
    // Ten samples of capacity, thirty samples of silence pushed through it.
    const apu = new GbApu();
    apu.run(Math.round(GB_CLOCK_HZ * 0.03), sink);
    expect(sink.available).toBe(10);
    expect(sink.dropped).toBeGreaterThan(0);

    const left = new Float32Array(4);
    const right = new Float32Array(4);
    expect(sink.read(left, right, 4)).toBe(4);
    expect(sink.available).toBe(6);
    expect(sink.read(left, right, 100)).toBe(4);
  });
});
