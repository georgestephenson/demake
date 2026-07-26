/**
 * The SN76489 and the NES 2A03 against documented hardware vectors.
 *
 * The two chips are here together because between them they cover the shapes the
 * arranger has to plan around: a PSG with no envelopes and a hard pitch floor,
 * and an APU whose channels do not sum linearly and whose bass voice has no
 * volume control at all.
 */

import { describe, expect, it } from "vitest";

import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import { NesApu, NES_CLOCK_HZ } from "../src/nes-apu.js";
import { Sn76489, SN76489_CLOCK_HZ } from "../src/sn76489.js";
import type { RegisterWrite } from "../src/types.js";

const RATE = { num: 60, den: 1 };

function hold(writes: RegisterWrite[], ticks: number): ScheduleTick[] {
  const out: ScheduleTick[] = [{ writes }];
  for (let i = 1; i < ticks; i += 1) out.push({ writes: [] });
  return out;
}

/**
 * Zero crossings over a window, skipping the DC blocker's settling transient.
 *
 * The NES mixer is unipolar, so a fresh render sits above zero until the DC
 * blocker catches up (~8 ms at its 20 Hz corner) — real behaviour, and a reason
 * to measure pitch away from the attack rather than to widen the tolerance.
 */
function frequencyOf(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    if (previous <= 0 && samples[i] > 0) crossings += 1;
    previous = samples[i];
  }
  return (crossings * sampleRate) / samples.length;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
}

/** Latch + data bytes for a tone channel's 10-bit period. */
function tone(channel: number, period: number): RegisterWrite[] {
  return [
    { reg: 0, value: 0x80 | (channel << 5) | (period & 0x0f) },
    { reg: 0, value: (period >> 4) & 0x3f },
  ];
}

/** Latch byte setting a channel's 4-bit attenuation. */
function attenuation(channel: number, value: number): RegisterWrite {
  return { reg: 0, value: 0x90 | (channel << 5) | (value & 0x0f) };
}

describe("SN76489", () => {
  it("plays f = clock / (32 × period)", () => {
    const period = 254; // 3579545 / (32 × 254) ≈ 440.5 Hz
    const pcm = renderSchedule(
      new Sn76489(),
      hold([...tone(0, period), attenuation(0, 0), attenuation(1, 15), attenuation(2, 15)], 60),
      RATE,
    );
    const expected = SN76489_CLOCK_HZ / (32 * period);
    expect(expected).toBeCloseTo(440.5, 0);
    expect(frequencyOf(pcm.channels[0], pcm.sampleRate)).toBeCloseTo(expected, 0);
  });

  it("cannot reach below its ~109 Hz pitch floor", () => {
    // The 10-bit divider runs out at period 1023. This is not a rounding
    // problem — it is why doc 17's arranger has to octave-fold or hand a low
    // bass to the periodic-noise channel instead.
    const lowest = SN76489_CLOCK_HZ / (32 * 1023);
    expect(lowest).toBeGreaterThan(109);
    expect(lowest).toBeLessThan(110);
  });

  it("steps attenuation in 2 dB increments", () => {
    const at = (value: number): number => {
      const pcm = renderSchedule(
        new Sn76489(),
        hold([...tone(0, 254), attenuation(0, value), attenuation(1, 15), attenuation(2, 15)], 20),
        RATE,
      );
      return rms(pcm.channels[0], 4800);
    };
    const full = at(0);
    const oneStep = at(1);
    // 2 dB is a ratio of 10^(-0.1) ≈ 0.794.
    expect(oneStep / full).toBeCloseTo(0.794, 1);
    expect(at(15)).toBeLessThan(1e-6);
  });

  it("is silent with every channel attenuated", () => {
    const pcm = renderSchedule(
      new Sn76489(),
      hold(
        [
          ...tone(0, 254),
          attenuation(0, 15),
          attenuation(1, 15),
          attenuation(2, 15),
          { reg: 0, value: 0xff }, // noise attenuation 15
        ],
        20,
      ),
      RATE,
    );
    expect(rms(pcm.channels[0], 4800)).toBeLessThan(1e-6);
  });

  it("keeps the Game Gear's stereo port to the stereo part", () => {
    const mono = new Sn76489();
    const gg = new Sn76489({ stereo: true });
    const writes = [...tone(0, 254), attenuation(0, 0), attenuation(1, 15), attenuation(2, 15)];
    const left = { reg: 0x06, value: 0x11 }; // channel 0 both sides only

    const monoPcm = renderSchedule(mono, hold([...writes, left], 20), RATE);
    const ggPcm = renderSchedule(gg, hold([...writes, { reg: 0x06, value: 0x10 }], 20), RATE);
    // The plain part ignores the port entirely and stays dual-mono.
    expect(rms(monoPcm.channels[1], 4800)).toBeCloseTo(rms(monoPcm.channels[0], 4800), 6);
    // The Game Gear silences the right side.
    expect(rms(ggPcm.channels[1], 4800)).toBeLessThan(1e-6);
    expect(rms(ggPcm.channels[0], 4800)).toBeGreaterThan(0.01);
  });
});

describe("NES APU", () => {
  it("plays f = CPU / (16 × (period + 1)) on a pulse channel", () => {
    const period = 253; // 1789773 / (16 × 254) ≈ 440.4 Hz
    const pcm = renderSchedule(
      new NesApu(),
      hold(
        [
          { reg: 0x15, value: 0x01 },
          { reg: 0x00, value: 0xbf }, // 50% duty, constant volume 15
          { reg: 0x02, value: period & 0xff },
          { reg: 0x03, value: ((period >> 8) & 0x07) | (0x1f << 3) },
        ],
        60,
      ),
      RATE,
    );
    const expected = NES_CLOCK_HZ / (16 * (period + 1));
    expect(expected).toBeCloseTo(440.4, 0);
    expect(frequencyOf(pcm.channels[0].subarray(4800), pcm.sampleRate)).toBeCloseTo(expected, 0);
  });

  it("plays the triangle an octave below a pulse at the same period", () => {
    // f = CPU / (32 × (period + 1)) — the reason the triangle is the NES's bass
    // voice, and it has no volume register to shape.
    const period = 253;
    const pcm = renderSchedule(
      new NesApu(),
      hold(
        [
          { reg: 0x15, value: 0x04 },
          { reg: 0x08, value: 0xff }, // linear counter loaded and held
          { reg: 0x0a, value: period & 0xff },
          { reg: 0x0b, value: ((period >> 8) & 0x07) | (0x1f << 3) },
        ],
        60,
      ),
      RATE,
    );
    const expected = NES_CLOCK_HZ / (32 * (period + 1));
    expect(frequencyOf(pcm.channels[0].subarray(4800), pcm.sampleRate)).toBeCloseTo(expected, 0);
  });

  it("mixes channels non-linearly, so a second pulse adds less than the first", () => {
    const play = (mask: number, both: boolean): number => {
      const writes: RegisterWrite[] = [
        { reg: 0x15, value: mask },
        { reg: 0x00, value: 0xbf },
        { reg: 0x02, value: 0xfd },
        { reg: 0x03, value: 0xf8 },
      ];
      if (both) {
        writes.push(
          { reg: 0x04, value: 0xbf },
          { reg: 0x06, value: 0xfd },
          { reg: 0x07, value: 0xf8 },
        );
      }
      const pcm = renderSchedule(new NesApu(), hold(writes, 30), RATE);
      return rms(pcm.channels[0], 4800);
    };
    const one = play(0x01, false);
    const two = play(0x03, true);
    expect(two).toBeGreaterThan(one);
    // Linear summing would double it; the hardware's DAC ladder does not.
    expect(two).toBeLessThan(one * 1.9);
  });

  it("silences a pulse whose period is below 8", () => {
    // Hardware mutes rather than emitting an ultrasonic tone, and a driver that
    // does not know that will produce silence it cannot explain.
    const pcm = renderSchedule(
      new NesApu(),
      hold(
        [
          { reg: 0x15, value: 0x01 },
          { reg: 0x00, value: 0xbf },
          { reg: 0x02, value: 0x04 },
          { reg: 0x03, value: 0xf8 },
        ],
        20,
      ),
      RATE,
    );
    expect(rms(pcm.channels[0], 4800)).toBeLessThan(1e-6);
  });
});
