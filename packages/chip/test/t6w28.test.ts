/**
 * The T6W28 — the two things that make it not an SN76489.
 *
 * Everything this part shares with that one is already pinned by `psg.test.ts`:
 * the 2 dB attenuation curve, the fixed 50% duty, the ten-bit divider. What is
 * here is what a Master System cannot do, and both cases are ones a model that
 * had quietly become an SN76489 would fail.
 *
 *   - **Stereo is per channel and per side**, so a voice can be placed rather
 *     than switched. The Game Gear's latch is one bit each way; this is a whole
 *     attenuator, and the two ports are how it is reached.
 *   - **The two ports carry different registers**, which is the fact a driver is
 *     most likely to get backwards: tone periods on the left port and the
 *     noise's on the right. A model that accepted either from either would let a
 *     driver that had them swapped pass every register diff there is.
 *
 * And one that is a consequence: **the noise has a divisor of its own**, so
 * reaching below the tone floor costs no voice — the enhancement this part
 * exists for.
 */

import { describe, expect, it } from "vitest";

import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import { T6w28, T6W28_CLOCK_HZ, T6W28_LEFT, T6W28_RIGHT } from "../src/t6w28.js";
import type { RegisterWrite } from "../src/types.js";

const RATE = { num: 60, den: 1 };

function hold(writes: RegisterWrite[], ticks: number): ScheduleTick[] {
  const out: ScheduleTick[] = [{ writes }];
  for (let i = 1; i < ticks; i += 1) out.push({ writes: [] });
  return out;
}

/** A tone period, which only the left port carries. */
function tone(channel: number, period: number, port = T6W28_LEFT): RegisterWrite[] {
  return [
    { reg: port, value: 0x80 | (channel << 5) | (period & 0x0f) },
    { reg: port, value: (period >> 4) & 0x3f },
  ];
}

/** One side's attenuation for one channel. */
function attenuation(channel: number, value: number, port: number): RegisterWrite {
  return { reg: port, value: 0x90 | (channel << 5) | (value & 0x0f) };
}

/** Every channel silent on both sides, which is what a schedule opens with. */
function silence(): RegisterWrite[] {
  const writes: RegisterWrite[] = [];
  for (const port of [T6W28_RIGHT, T6W28_LEFT]) {
    for (let channel = 0; channel < 4; channel += 1) writes.push(attenuation(channel, 15, port));
  }
  return writes;
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += (samples[i] as number) * (samples[i] as number);
  return Math.sqrt(sum / (to - from));
}

function frequencyOf(samples: Float32Array, sampleRate: number): number {
  let crossings = 0;
  let previous = samples[0] as number;
  for (let i = 1; i < samples.length; i += 1) {
    if (previous <= 0 && (samples[i] as number) > 0) crossings += 1;
    previous = samples[i] as number;
  }
  return (crossings * sampleRate) / samples.length;
}

describe("the T6W28", () => {
  it("plays a tone at the divider the left port names", () => {
    const period = 218;
    const pcm = renderSchedule(
      new T6w28(),
      hold([...silence(), ...tone(0, period), attenuation(0, 0, T6W28_LEFT)], 60),
      RATE,
    );
    // Its own clock — 3.072 MHz, the console's crystal halved — so a period that
    // is A on a Master System is not A here.
    const expected = T6W28_CLOCK_HZ / (32 * period);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(expected, 0);
  });

  it("places a voice on one side, which is the whole point of the part", () => {
    const period = 218;
    const pcm = renderSchedule(
      new T6w28(),
      hold(
        [
          ...silence(),
          ...tone(0, period),
          attenuation(0, 0, T6W28_LEFT),
          attenuation(0, 15, T6W28_RIGHT),
        ],
        40,
      ),
      RATE,
    );
    const left = rms(pcm.channels[0] as Float32Array, 4800);
    const right = rms(pcm.channels[1] as Float32Array, 4800);
    expect(left).toBeGreaterThan(0.05);
    // Not merely quieter: cut. A model that treated the two ports as one would
    // put the same sound on both, and a model that took the Game Gear's latch
    // would need a register this chip has not got.
    expect(right).toBeLessThan(left * 0.02);
  });

  it("takes a tone period from the left port and nothing from the right", () => {
    // The same two bytes, sent to the wrong port. On this chip they address the
    // *noise* divisor for channel 2 and nothing at all for channels 0 and 1 — so
    // a driver that had the ports backwards produces silence rather than a wrong
    // note, which is exactly what this pins.
    const wrong = renderSchedule(
      new T6w28(),
      hold([...silence(), ...tone(0, 218, T6W28_RIGHT), attenuation(0, 0, T6W28_LEFT)], 40),
      RATE,
    );
    // Period 0 holds the output high, so the channel is a DC level the blocker
    // removes rather than a tone.
    expect(frequencyOf(wrong.channels[0] as Float32Array, wrong.sampleRate)).toBeLessThan(20);
  });

  it("gives the noise a divisor of its own, so a low drum costs no voice", () => {
    // Rate 3 divides the noise's own period register, written through the right
    // port where tone 2's period would be. All three tones stay silent and free.
    const noise = (period: number): number => {
      const pcm = renderSchedule(
        new T6w28(),
        hold(
          [
            ...silence(),
            { reg: T6W28_RIGHT, value: 0x80 | (2 << 5) | (period & 0x0f) },
            { reg: T6W28_RIGHT, value: (period >> 4) & 0x3f },
            { reg: T6W28_RIGHT, value: 0xe0 | 0x03 },
            attenuation(3, 0, T6W28_LEFT),
            attenuation(3, 0, T6W28_RIGHT),
          ],
          40,
        ),
        RATE,
      );
      return frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate);
    };
    // A longer divisor is a lower rattle, and both are audible — an SN76489
    // would have had to give up tone channel 2 to say either.
    const high = noise(64);
    const low = noise(512);
    expect(high).toBeGreaterThan(low * 2);
    expect(low).toBeGreaterThan(0);
  });
});
