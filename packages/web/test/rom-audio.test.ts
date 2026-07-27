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

/** A machine to point the stream at: the two things `Listenable` asks for. */
function machine(clockHz: number) {
  return { audioSink: undefined, apu: { clockHz } };
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
  audio.sink.add(0.5, -0.5, clockHz);
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
      expect(target.audioSink).toBeUndefined();

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
