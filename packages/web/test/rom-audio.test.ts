/**
 * What the cartridge player does with audio it has already handed the device.
 *
 * Here rather than in the browser suite for the reason the service worker's test
 * is: Playwright can see that a page makes sound, and cannot hear that it is
 * making two sounds at once. The player schedules a tenth of a second ahead, so
 * when the section rebuilds the cartridge — a keystroke in the editor, a
 * different console, Restart — there is always audio queued that belongs to the
 * machine being thrown away. A started `AudioBufferSourceNode` plays whatever
 * happens to the sink afterwards, so the queue has to be stopped rather than
 * abandoned; left alone it is the last cartridge's music over the new one's, at
 * whatever moment the rebuild landed.
 */

import { describe, expect, it } from "vitest";

import type { SampleSink } from "@demake/chip";

import { RomAudio } from "../src/lib/rom-audio.js";

/** Everything `RomAudio` asks of a browser, and nothing else. */
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  stopped = false;
  connect(): void {}
  start(when: number): void {
    this.started = when;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeContext {
  static made: FakeContext[] = [];
  readonly sampleRate: number;
  readonly destination = {};
  readonly sources: FakeSource[] = [];
  state = "running";
  currentTime = 0;
  onstatechange: (() => void) | null = null;

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100;
    FakeContext.made.push(this);
  }
  createBuffer(channels: number, length: number, rate: number) {
    void channels;
    void rate;
    const data = [new Float32Array(length), new Float32Array(length)];
    return { getChannelData: (index: number) => data[index] as Float32Array };
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {
    this.state = "suspended";
  }
  async close(): Promise<void> {}
}

/**
 * A machine to point the stream at: the two things `Listenable` asks for.
 *
 * A list, because the player takes one — a console may have two chips on two
 * clocks, and every other console is a list of one.
 */
function machine(clockHz: number) {
  return [{ audioSink: undefined as SampleSink | undefined, apu: { clockHz } }];
}

function withFakeAudio<T>(body: () => T): T {
  const original = (globalThis as { AudioContext?: unknown }).AudioContext;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeContext;
  try {
    return body();
  } finally {
    (globalThis as { AudioContext?: unknown }).AudioContext = original;
  }
}

/** Fill the sink with a second of something and hand it to the device. */
function play(audio: RomAudio, clockHz: number): void {
  for (const { sink } of audio.sinks) sink.add(0.5, -0.5, clockHz);
  audio.flush();
}

describe("the cartridge player's queue", () => {
  it("stops what is still scheduled when the stream is re-pointed", () => {
    withFakeAudio(() => {
      const audio = new RomAudio();
      const first = machine(4_194_304);
      audio.attach(first);
      play(audio, 4_194_304);

      const context = FakeContext.made.at(-1) as FakeContext;
      expect(context.sources.length).toBe(1);
      const queued = context.sources[0] as FakeSource;
      expect(queued.stopped).toBe(false);

      // A rebuilt cartridge — a different console, even, which is why the sink is
      // replaced rather than reused.
      audio.attach(machine(1_789_773));
      expect(queued.stopped).toBe(true);
      audio.close();
    });
  });

  it("stops it when sound is turned off, and again when it comes back", async () => {
    await withFakeAudio(async () => {
      const audio = new RomAudio();
      const target = machine(4_194_304);
      audio.attach(target);
      play(audio, 4_194_304);
      const context = FakeContext.made.at(-1) as FakeContext;
      const first = context.sources[0] as FakeSource;

      await audio.suspend(target);
      expect(first.stopped).toBe(true);
      expect(target[0]!.audioSink).toBeUndefined();

      context.state = "running";
      audio.attach(target);
      play(audio, 4_194_304);
      const second = context.sources[1] as FakeSource;
      expect(second.stopped).toBe(false);
      await audio.resume();
      expect(second.stopped).toBe(true);
      audio.close();
    });
  });

  it("sums a console's two chips at the board's own levels", () => {
    // The Mega Drive is the only machine here with two of them, and Playwright
    // can see that a page makes sound without hearing that it is making two at
    // once (this file's opening paragraph, in the case it was written for). The
    // relative level is the *board's* rather than either chip's, which is why it
    // arrives on the machine — so a mix that ignored it would play a four-voice
    // PSG as loudly as six four-operator FM voices.
    withFakeAudio(() => {
      const audio = new RomAudio();
      const ym = { audioSink: undefined as SampleSink | undefined, apu: { clockHz: 7_670_453 } };
      const psg = {
        audioSink: undefined as SampleSink | undefined,
        apu: { clockHz: 3_579_545 },
        gain: 0.5,
      };
      audio.attach([ym, psg]);
      expect(audio.sinks.length).toBe(2);
      expect(audio.sinks.map(({ gain }) => gain)).toEqual([1, 0.5]);

      // Each chip is clocked at its own rate, which is the reason for two sinks:
      // the same number of samples takes a different number of chip cycles.
      const rate = (FakeContext.made.at(-1) as FakeContext).sampleRate;
      for (let sample = 0; sample < 64; sample += 1) {
        audio.sinks[0]!.sink.add(0.5, 0.5, 7_670_453 / rate);
        audio.sinks[1]!.sink.add(0.25, 0.25, 3_579_545 / rate);
      }
      audio.flush();

      const context = FakeContext.made.at(-1) as FakeContext;
      const played = (context.sources[0] as FakeSource).buffer as {
        getChannelData(index: number): Float32Array;
      };
      // 0.5 from the FM chip plus 0.25 from the PSG at half gain: 0.625, and the
      // window is narrow on purpose. Dropping a chip or overwriting instead of
      // adding lands on 0.5 or 0.125; applying the gain to neither lands on 0.75.
      // Only the sum the board asks for is inside it.
      const peak = Math.max(...played.getChannelData(0));
      expect(peak).toBeGreaterThan(0.6);
      expect(peak).toBeLessThan(0.65);
      audio.close();
    });
  });

  it("forgets a source that finished on its own", () => {
    withFakeAudio(() => {
      const audio = new RomAudio();
      audio.attach(machine(4_194_304));
      play(audio, 4_194_304);
      const context = FakeContext.made.at(-1) as FakeContext;
      const source = context.sources[0] as FakeSource;
      source.onended?.();
      // Nothing to stop, and stopping it anyway would be a call on a node the
      // browser has already finished with.
      audio.attach(machine(4_194_304));
      expect(source.stopped).toBe(false);
      audio.close();
    });
  });
});
