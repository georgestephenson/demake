/**
 * The Game Boy APU against hand-computed hardware vectors (doc 16 §Claim 2).
 *
 * These are the analytic half of chip validation: every number here comes from a
 * documented formula in the Pan Docs, not from a recording of our own output, so
 * the tests fail if the model drifts rather than merely changing.
 */

import { describe, expect, it } from "vitest";

import { GbApu, GB_CLOCK_HZ } from "../src/gb-apu.js";
import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import type { RegisterWrite } from "../src/types.js";

const RATE = { num: 60, den: 1 };

/** A schedule that writes once and then holds for `ticks` driver ticks. */
function hold(writes: RegisterWrite[], ticks: number): ScheduleTick[] {
  const out: ScheduleTick[] = [{ writes }];
  for (let i = 1; i < ticks; i += 1) out.push({ writes: [] });
  return out;
}

/** Count zero crossings, which for a square wave is twice the frequency. */
function frequencyOf(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const current = samples[i];
    if (previous <= 0 && current > 0) crossings += 1;
    previous = current;
  }
  return (crossings * sampleRate) / samples.length;
}

describe("GB APU — pulse channels", () => {
  it("plays the frequency the Pan Docs formula predicts", () => {
    // f = 131072 / (2048 - x). x = 1750 → 439.84 Hz, the closest the lattice
    // gets to A4 and the reason doc 16 measures pitch error in cents.
    const period = 1750;
    const pcm = renderSchedule(
      new GbApu(),
      hold(
        [
          { reg: 0x26, value: 0x80 },
          { reg: 0x25, value: 0xff },
          { reg: 0x24, value: 0x77 },
          { reg: 0x11, value: 0x80 }, // 50% duty
          { reg: 0x12, value: 0xf0 }, // full volume, no envelope decay
          { reg: 0x13, value: period & 0xff },
          { reg: 0x14, value: 0x80 | (period >> 8) },
        ],
        60,
      ),
      RATE,
    );

    const expected = 131072 / (2048 - period);
    expect(expected).toBeCloseTo(439.84, 1);
    expect(frequencyOf(pcm.channels[0], pcm.sampleRate)).toBeCloseTo(expected, 0);
  });

  it("holds silence when the DAC is off", () => {
    const pcm = renderSchedule(
      new GbApu(),
      hold(
        [
          { reg: 0x26, value: 0x80 },
          { reg: 0x25, value: 0xff },
          { reg: 0x24, value: 0x77 },
          { reg: 0x12, value: 0x00 }, // NRx2 = 0 powers the DAC down
          { reg: 0x13, value: 0x00 },
          { reg: 0x14, value: 0x87 },
        ],
        30,
      ),
      RATE,
    );
    for (const sample of pcm.channels[0]) expect(sample).toBe(0);
  });

  it("steps a decaying envelope at 64 Hz", () => {
    // Envelope period 1 steps every 1/64 s, so volume 15 reaches 0 after 15
    // steps ≈ 234 ms — audible as a plucked note rather than a held one.
    const apu = new GbApu();
    const pcm = renderSchedule(
      apu,
      hold(
        [
          { reg: 0x26, value: 0x80 },
          { reg: 0x25, value: 0xff },
          { reg: 0x24, value: 0x77 },
          { reg: 0x11, value: 0x80 },
          { reg: 0x12, value: 0xf1 }, // volume 15, decreasing, period 1
          { reg: 0x13, value: 0x00 },
          { reg: 0x14, value: 0x86 },
        ],
        30,
      ),
      RATE,
    );

    const window = (from: number, to: number): number => {
      let peak = 0;
      const start = Math.floor(from * pcm.sampleRate);
      const end = Math.floor(to * pcm.sampleRate);
      for (let i = start; i < end; i += 1) {
        const value = Math.abs(pcm.channels[0][i]);
        if (value > peak) peak = value;
      }
      return peak;
    };

    expect(window(0.01, 0.05)).toBeGreaterThan(window(0.15, 0.2));
    expect(window(0.3, 0.4)).toBeLessThan(0.02);
  });

  it("mutes a sweep that overflows the frequency register", () => {
    // Sweep up from a high frequency: the overflow check disables the channel,
    // which hardware does silently and a naive model does not do at all.
    const pcm = renderSchedule(
      new GbApu(),
      hold(
        [
          { reg: 0x26, value: 0x80 },
          { reg: 0x25, value: 0xff },
          { reg: 0x24, value: 0x77 },
          { reg: 0x10, value: 0x11 }, // pace 1, increase, step 1
          { reg: 0x11, value: 0x80 },
          { reg: 0x12, value: 0xf0 },
          { reg: 0x13, value: 0xff },
          { reg: 0x14, value: 0x87 }, // frequency 2047
        ],
        30,
      ),
      RATE,
    );
    let peak = 0;
    for (let i = Math.floor(0.2 * pcm.sampleRate); i < pcm.channels[0].length; i += 1) {
      peak = Math.max(peak, Math.abs(pcm.channels[0][i]));
    }
    expect(peak).toBeLessThan(0.01);
  });
});

describe("GB APU — panning and master volume", () => {
  it("routes a channel to one side only", () => {
    const pcm = renderSchedule(
      new GbApu(),
      hold(
        [
          { reg: 0x26, value: 0x80 },
          { reg: 0x25, value: 0x10 }, // channel 1 left only
          { reg: 0x24, value: 0x77 },
          { reg: 0x11, value: 0x80 },
          { reg: 0x12, value: 0xf0 },
          { reg: 0x13, value: 0x00 },
          { reg: 0x14, value: 0x86 },
        ],
        20,
      ),
      RATE,
    );
    const energy = (channel: Float32Array): number => {
      let sum = 0;
      for (const sample of channel) sum += sample * sample;
      return sum;
    };
    expect(energy(pcm.channels[0])).toBeGreaterThan(0.1);
    expect(energy(pcm.channels[1])).toBe(0);
  });
});

/** A sink that records the level a model holds, one entry per model event. */
function recordLevels(apu: GbApu, clocks: number): number[] {
  const levels: number[] = [];
  const sink = {
    clocksUntilSampleBoundary: () => Number.MAX_SAFE_INTEGER,
    add: (left: number) => levels.push(left),
  };
  apu.run(clocks, sink);
  return levels;
}

describe("GB APU — noise", () => {
  /** Only channel 4, hard left, full volume, at the given NR43 setting. */
  function noiseApu(nr43: number): GbApu {
    const apu = new GbApu();
    apu.write(0x26, 0x80);
    apu.write(0x25, 0x80); // channel 4 left only
    apu.write(0x24, 0x77);
    apu.write(0x21, 0xf0); // volume 15, no envelope
    apu.write(0x22, nr43);
    apu.write(0x23, 0x80);
    return apu;
  }

  it("repeats every 127 steps in 7-bit width mode", () => {
    // Width mode turns noise into a short *tonal* loop — the setting a
    // period-correct snare uses, and the one a 15-bit-only model gets wrong.
    const levels = recordLevels(noiseApu(0x08), 8 * 400); // divisor 0, shift 0, 7-bit
    const period = 127;
    expect(levels.length).toBeGreaterThan(period * 2);
    for (let i = 0; i < period; i += 1) {
      expect(levels[i]).toBe(levels[i + period]);
    }
  });

  it("does not repeat at 127 steps in 15-bit mode", () => {
    const levels = recordLevels(noiseApu(0x00), 8 * 400); // same rate, 15-bit
    let matches = 0;
    for (let i = 0; i < 127; i += 1) {
      if (levels[i] === levels[i + 127]) matches += 1;
    }
    expect(matches).toBeLessThan(127);
  });
});

describe("the render contract", () => {
  it("produces the sample count the rate demands, with no accumulated drift", () => {
    // 59.7275 Hz is the Game Boy's real frame rate; the awkward ratio is the
    // whole reason sample boundaries are computed rather than accumulated.
    const rate = { num: 5972750, den: 100000 };
    const ticks = 600;
    const pcm = renderSchedule(new GbApu(), hold([{ reg: 0x26, value: 0x80 }], ticks), rate);
    const clocks = Math.floor((ticks * GB_CLOCK_HZ * rate.den) / rate.num);
    expect(pcm.channels[0].length).toBe(Math.floor((clocks * 48000) / GB_CLOCK_HZ));
    // Ten seconds of ticks is ten seconds of audio, to within one sample.
    expect(pcm.channels[0].length / 48000).toBeCloseTo((ticks * rate.den) / rate.num, 3);
  });

  it("renders byte-identically when run twice", () => {
    const script = hold(
      [
        { reg: 0x26, value: 0x80 },
        { reg: 0x25, value: 0xff },
        { reg: 0x24, value: 0x77 },
        { reg: 0x11, value: 0x80 },
        { reg: 0x12, value: 0xf3 },
        { reg: 0x13, value: 0x00 },
        { reg: 0x14, value: 0x86 },
      ],
      30,
    );
    const a = renderSchedule(new GbApu(), script, RATE);
    const b = renderSchedule(new GbApu(), script, RATE);
    expect(new Uint8Array(a.channels[0].buffer)).toEqual(new Uint8Array(b.channels[0].buffer));
  });
});
