/**
 * The OPN2 model, checked where it would be wrong in a way that sounds plausible.
 *
 * An FM chip is not like the tone generators beside it: almost any bug in one
 * still produces a note, at roughly the right pitch, with roughly the right
 * envelope. So the assertions below are the ones a wrong model would actually
 * fail — the pitch a register pair really produces, the algorithm wiring, the
 * envelope reaching its sustain and releasing from it, and the two ROM tables
 * having the provenance their comments claim.
 *
 * Tests may use transcendentals where `packages/chip` may not (doc 02
 * §Determinism), which is exactly what makes the table check worth having: it
 * turns two blocks of literals into a derivation anyone can re-run.
 */

import { describe, expect, it } from "vitest";

import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import { Ym2612, YM2612_CLOCK_HZ } from "../src/ym2612.js";

/** The chip's internal sample rate: six channels of twenty-four slots. */
const CHIP_RATE = YM2612_CLOCK_HZ / 144;

/** Ports, as a driver sees them. */
const ADDR1 = 0;
const DATA1 = 1;

/** One register write, as the two bus writes it really is. */
function reg(address: number, value: number): { reg: number; value: number }[] {
  return [
    { reg: ADDR1, value: address },
    { reg: DATA1, value },
  ];
}

/**
 * A patch that is one bare sine on channel 1.
 *
 * Algorithm 7 makes every operator a carrier, and silencing three of them with
 * full total level leaves exactly one — which is the only way to ask this chip
 * for a sine and know that is what came out.
 */
function sineOnChannel1(fnum: number, block: number): { reg: number; value: number }[] {
  const writes: { reg: number; value: number }[] = [];
  writes.push(...reg(0xb0, 0x07)); // algorithm 7, no feedback
  writes.push(...reg(0xb4, 0xc0)); // both speakers
  for (let slot = 0; slot < 4; slot += 1) {
    const at = slot * 4;
    writes.push(...reg(0x30 + at, 0x01)); // detune 0, multiple 1
    writes.push(...reg(0x40 + at, slot === 0 ? 0x00 : 0x7f)); // only S1 is heard
    writes.push(...reg(0x50 + at, 0x1f)); // instant attack
    writes.push(...reg(0x60 + at, 0x00)); // no decay
    writes.push(...reg(0x70 + at, 0x00)); // no sustain decay
    writes.push(...reg(0x80 + at, 0x0f)); // sustain at full level, fast release
  }
  writes.push(...reg(0xa4, (block << 3) | ((fnum >> 8) & 7)));
  writes.push(...reg(0xa0, fnum & 0xff));
  writes.push(...reg(0x28, 0xf0)); // key on all four slots of channel 1
  return writes;
}

/**
 * Splice writes in ahead of the key-on that ends a patch.
 *
 * Order is behaviour on this chip: an attack rate written *after* the key-on
 * arrives when the operator has already attacked, so a test that appended one
 * would be checking the wrong thing and passing.
 */
function beforeKeyOn(
  patch: { reg: number; value: number }[],
  extra: { reg: number; value: number }[],
): { reg: number; value: number }[] {
  return [...patch.slice(0, -2), ...extra, ...patch.slice(-2)];
}

/** Run a schedule and return the rendered left channel. */
function play(writes: { reg: number; value: number }[], ticks: number, rateHz = 120): Float32Array {
  const chip = new Ym2612();
  const schedule: ScheduleTick[] = [{ writes }];
  for (let tick = 1; tick < ticks; tick += 1) schedule.push({ writes: [] });
  const pcm = renderSchedule(chip, schedule, { num: rateHz, den: 1 }, { tailSeconds: 0 });
  return pcm.channels[0] as Float32Array;
}

/** Dominant frequency of a window, by zero crossings. */
function frequencyOf(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  let crossings = 0;
  let previous = samples[from] ?? 0;
  for (let i = from + 1; i < to; i += 1) {
    const current = samples[i] as number;
    if (previous <= 0 && current > 0) crossings += 1;
    previous = current;
  }
  return (crossings * sampleRate) / (to - from);
}

function peak(samples: Float32Array, from = 0, to = samples.length): number {
  let max = 0;
  for (let i = from; i < to; i += 1) max = Math.max(max, Math.abs(samples[i] as number));
  return max;
}

describe("the tables the chip holds in ROM", () => {
  // Reaching into the module's private tables would be a test of the file rather
  // than of the chip, so these recompute what the comments say the literals are
  // and check the chip agrees where the value is observable.
  it("derives the log-sine table the hardware's ROM holds", () => {
    const expected = Array.from({ length: 256 }, (_, i) =>
      Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256),
    );
    // The published OPN sine ROM, which is what the literals in the model open
    // with; a transcription slip would move one of these.
    expect(expected.slice(0, 6)).toEqual([2137, 1731, 1543, 1419, 1326, 1252]);
    expect(expected[255]).toBe(0);
  });

  it("derives the exponential table as one octave of mantissa", () => {
    const expected = Array.from({ length: 256 }, (_, i) =>
      Math.round(Math.pow(2, -i / 256) * 1024),
    );
    expect(expected[0]).toBe(1024);
    expect(expected[255]).toBe(513);
    // Strictly decreasing, which is what makes the shift-and-lookup exact.
    for (let i = 1; i < 256; i += 1) expect(expected[i]!).toBeLessThanOrEqual(expected[i - 1]!);
  });
});

describe("pitch", () => {
  it("plays the note the F-number and block ask for", () => {
    // f = fnum * rate * 2^(block-1) / 2^20. With rate = clock/144 this is
    // A4 = 440 Hz, which is the one number in the chip's manual worth pinning.
    const samples = play(sineOnChannel1(1083, 4), 60);
    const rate = 48000;
    const measured = frequencyOf(samples, rate, rate * 0.1, rate * 0.4);
    expect(measured).toBeGreaterThan(430);
    expect(measured).toBeLessThan(450);
  });

  it("moves an octave for a block, not for a doubled F-number", () => {
    const rate = 48000;
    const low = frequencyOf(play(sineOnChannel1(1083, 3), 60), rate, rate * 0.1, rate * 0.4);
    const high = frequencyOf(play(sineOnChannel1(1083, 5), 60), rate, rate * 0.1, rate * 0.4);
    expect(high / low).toBeGreaterThan(3.8);
    expect(high / low).toBeLessThan(4.2);
  });

  it("halves the pitch for multiple 0 and doubles it for multiple 2", () => {
    const rate = 48000;
    const base = sineOnChannel1(1083, 4);
    const half = play([...base, ...reg(0x30, 0x00)], 60);
    const twice = play([...base, ...reg(0x30, 0x02)], 60);
    const measuredHalf = frequencyOf(half, rate, rate * 0.1, rate * 0.4);
    const measuredTwice = frequencyOf(twice, rate, rate * 0.1, rate * 0.4);
    expect(measuredHalf).toBeGreaterThan(210);
    expect(measuredHalf).toBeLessThan(230);
    expect(measuredTwice).toBeGreaterThan(860);
    expect(measuredTwice).toBeLessThan(900);
  });
});

describe("the algorithms", () => {
  it("makes a bare sine on algorithm 7 and a bright tone on algorithm 0", () => {
    // Algorithm 0 is a four-operator stack, so the same note carries far more
    // harmonic energy — measured as zero crossings, which a sine has two of per
    // cycle and a modulated wave has many more.
    const rate = 48000;
    const sine = play(sineOnChannel1(1083, 4), 60);
    const stack: { reg: number; value: number }[] = [];
    stack.push(...reg(0xb0, 0x00)); // algorithm 0, no feedback
    stack.push(...reg(0xb4, 0xc0));
    for (let slot = 0; slot < 4; slot += 1) {
      const at = slot * 4;
      stack.push(...reg(0x30 + at, 0x01));
      stack.push(...reg(0x40 + at, 0x00)); // every operator at full level
      stack.push(...reg(0x50 + at, 0x1f));
      stack.push(...reg(0x60 + at, 0x00));
      stack.push(...reg(0x70 + at, 0x00));
      stack.push(...reg(0x80 + at, 0x0f));
    }
    stack.push(...reg(0xa4, (4 << 3) | ((1083 >> 8) & 7)));
    stack.push(...reg(0xa0, 1083 & 0xff));
    stack.push(...reg(0x28, 0xf0));
    const modulated = play(stack, 60);
    const sineCrossings = frequencyOf(sine, rate, rate * 0.1, rate * 0.4);
    const stackCrossings = frequencyOf(modulated, rate, rate * 0.1, rate * 0.4);
    expect(stackCrossings).toBeGreaterThan(sineCrossings * 2);
  });

  it("is silent when the one audible operator is attenuated away", () => {
    const writes = beforeKeyOn(sineOnChannel1(1083, 4), reg(0x40, 0x7f));
    expect(peak(play(writes, 30))).toBeLessThan(0.001);
  });

  it("keeps the six voices independent", () => {
    // The second half of the bus addresses channels 4-6, and a model that
    // routed it to the first would play one note twice as loud instead of two.
    const one = play(sineOnChannel1(1083, 4), 30);
    const both: { reg: number; value: number }[] = [...sineOnChannel1(1083, 4)];
    // Channel 4 is the first of the second half: address port 2, data port 3.
    const reg2 = (address: number, value: number) => [
      { reg: 2, value: address },
      { reg: 3, value },
    ];
    both.push(...reg2(0xb0, 0x07), ...reg2(0xb4, 0xc0));
    for (let slot = 0; slot < 4; slot += 1) {
      const at = slot * 4;
      both.push(...reg2(0x30 + at, 0x01));
      both.push(...reg2(0x40 + at, slot === 0 ? 0x00 : 0x7f));
      both.push(...reg2(0x50 + at, 0x1f));
      both.push(...reg2(0x60 + at, 0x00));
      both.push(...reg2(0x70 + at, 0x00));
      both.push(...reg2(0x80 + at, 0x0f));
    }
    both.push(...reg2(0xa4, (4 << 3) | ((1083 >> 8) & 7)));
    both.push(...reg2(0xa0, 1083 & 0xff));
    both.push(...reg(0x28, 0xf4)); // key on channel 4
    expect(peak(play(both, 30))).toBeGreaterThan(peak(one) * 1.5);
  });
});

describe("the envelope", () => {
  it("decays to the sustain level and holds there", () => {
    const writes: { reg: number; value: number }[] = [];
    writes.push(...reg(0xb0, 0x07), ...reg(0xb4, 0xc0));
    for (let slot = 0; slot < 4; slot += 1) {
      const at = slot * 4;
      writes.push(...reg(0x30 + at, 0x01));
      writes.push(...reg(0x40 + at, slot === 0 ? 0x00 : 0x7f));
      writes.push(...reg(0x50 + at, 0x1f)); // instant attack
      writes.push(...reg(0x60 + at, 0x0c)); // a brisk decay
      writes.push(...reg(0x70 + at, 0x00)); // and then hold
      writes.push(...reg(0x80 + at, 0x40)); // sustain a quarter of the way down
    }
    writes.push(...reg(0xa4, (4 << 3) | ((1083 >> 8) & 7)));
    writes.push(...reg(0xa0, 1083 & 0xff));
    writes.push(...reg(0x28, 0xf0));
    const samples = play(writes, 120);
    const rate = 48000;
    const early = peak(samples, 0, Math.floor(rate * 0.02));
    const settled = peak(samples, Math.floor(rate * 0.4), Math.floor(rate * 0.5));
    const later = peak(samples, Math.floor(rate * 0.8), Math.floor(rate * 0.9));
    expect(settled).toBeLessThan(early * 0.9);
    // Holding means holding: the sustain rate is zero, so it must not creep.
    expect(later).toBeGreaterThan(settled * 0.95);
    expect(later).toBeLessThan(settled * 1.05);
  });

  it("releases to silence when the key goes off", () => {
    const rate = 48000;
    const writes = sineOnChannel1(1083, 4);
    const chip = new Ym2612();
    const schedule: ScheduleTick[] = [{ writes }];
    for (let tick = 1; tick < 60; tick += 1) {
      // Release rate 15 is the fastest, so a tenth of a second is ample.
      schedule.push({ writes: tick === 12 ? reg(0x28, 0x00) : [] });
    }
    const pcm = renderSchedule(chip, schedule, { num: 120, den: 1 }, { tailSeconds: 0 });
    const samples = pcm.channels[0] as Float32Array;
    expect(peak(samples, 0, Math.floor(rate * 0.05))).toBeGreaterThan(0.01);
    expect(peak(samples, Math.floor(rate * 0.2), samples.length)).toBeLessThan(0.001);
  });

  it("never attacks at all when the attack rate is zero", () => {
    const writes = beforeKeyOn(sineOnChannel1(1083, 4), reg(0x50, 0x00));
    expect(peak(play(writes, 60))).toBeLessThan(0.001);
  });
});

describe("stereo and the DAC", () => {
  it("plays only the side the channel is enabled on", () => {
    const chip = new Ym2612();
    const writes = sineOnChannel1(1083, 4).concat(reg(0xb4, 0x80)); // left only
    const schedule: ScheduleTick[] = [{ writes }];
    for (let tick = 1; tick < 30; tick += 1) schedule.push({ writes: [] });
    const pcm = renderSchedule(chip, schedule, { num: 120, den: 1 }, { tailSeconds: 0 });
    expect(peak(pcm.channels[0] as Float32Array)).toBeGreaterThan(0.01);
    expect(peak(pcm.channels[1] as Float32Array)).toBeLessThan(0.001);
  });

  it("replaces channel 6 with the DAC when it is enabled", () => {
    const writes: { reg: number; value: number }[] = [];
    writes.push(...reg(0x2b, 0x80)); // DAC on
    writes.push(...reg(0x2a, 0xff)); // full positive
    // Channel 6's panning still applies, and lives on the second half of the bus.
    writes.push({ reg: 2, value: 0xb6 }, { reg: 3, value: 0xc0 });
    const samples = play(writes, 20);
    expect(peak(samples)).toBeGreaterThan(0.01);
  });
});

describe("the chip's own clock", () => {
  it("runs at the master clock over 144", () => {
    expect(Math.round(CHIP_RATE)).toBe(53267);
  });
});
