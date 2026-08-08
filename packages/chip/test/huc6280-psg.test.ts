/**
 * The HuC6280's PSG against documented hardware behaviour.
 *
 * Four of these cases are about things no other chip in the set does, and they
 * are the ones worth having: the pitch is `clock / (32 × divider)` because a
 * *waveform* is thirty-two samples long rather than because a counter says so;
 * the volume is three attenuators summing in 1.5 dB steps; turning a channel off
 * is what resets its wave pointer, so the upload has no address register; and the
 * shift register lives on two of the six channels and nowhere else.
 *
 * The fifth is the model's own arithmetic — six channels at full amplitude reach
 * nominal full scale — which is the house convention every chip here keeps
 * (`sn76489.ts` §levels) and the reason a waveform may use all five of its bits.
 */

import { describe, expect, it } from "vitest";

import {
  Huc6280Psg,
  HUC6280_FIRST_NOISE_CHANNEL,
  HUC6280_PSG_CHANNELS,
  HUC6280_PSG_CLOCK_HZ,
  HUC6280_PSG_REG as REG,
  HUC6280_WAVE_SAMPLES,
  LFO_MODULATOR,
  LFO_TARGET,
} from "../src/huc6280-psg.js";
import { renderSchedule, type ScheduleTick } from "../src/mix.js";
import type { RegisterWrite } from "../src/types.js";

const RATE = { num: 60, den: 1 };

function hold(writes: RegisterWrite[], ticks: number): ScheduleTick[] {
  const out: ScheduleTick[] = [{ writes }];
  for (let i = 1; i < ticks; i += 1) out.push({ writes: [] });
  return out;
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

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += (samples[i] as number) * (samples[i] as number);
  return Math.sqrt(sum / (to - from));
}

/** A 50% square, as the thirty-two five-bit samples the chip walks. */
const SQUARE = Array.from({ length: HUC6280_WAVE_SAMPLES }, (_, i) =>
  i < HUC6280_WAVE_SAMPLES / 2 ? 31 : 0,
);

/** Select a channel, silence it, and upload one cycle of `samples`. */
function upload(channel: number, samples: readonly number[]): RegisterWrite[] {
  return [
    { reg: REG.SELECT, value: channel },
    // Off with direct D/A off, which is the only thing that rewinds the wave
    // pointer — there is no address register on this chip.
    { reg: REG.CONTROL, value: 0x00 },
    ...samples.map((value) => ({ reg: REG.WAVE, value })),
  ];
}

/** Programme a channel's twelve-bit divider and turn it on at `volume`. */
function play(channel: number, divider: number, volume = 31): RegisterWrite[] {
  return [
    { reg: REG.SELECT, value: channel },
    { reg: REG.FREQ_LOW, value: divider & 0xff },
    { reg: REG.FREQ_HIGH, value: (divider >> 8) & 0x0f },
    { reg: REG.BALANCE, value: 0xff },
    { reg: REG.CONTROL, value: 0x80 | volume },
  ];
}

describe("the HuC6280 PSG", () => {
  it("plays f = clock / (32 × divider), because a cycle is thirty-two samples", () => {
    const divider = 254; // 3579545 / (32 × 254) ≈ 440.5 Hz
    const pcm = renderSchedule(
      new Huc6280Psg(),
      hold([{ reg: REG.GLOBAL, value: 0xff }, ...upload(0, SQUARE), ...play(0, divider)], 60),
      RATE,
    );
    const expected = HUC6280_PSG_CLOCK_HZ / (32 * divider);
    expect(expected).toBeCloseTo(440.5, 0);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(expected, -1);
  });

  it("reads a divider of zero as 4096, which is its pitch floor", () => {
    // The floor is an octave and a half below a Master System's tone channels,
    // which is the whole reason a bass line never has to be transposed here.
    const pcm = renderSchedule(
      new Huc6280Psg(),
      hold([{ reg: REG.GLOBAL, value: 0xff }, ...upload(0, SQUARE), ...play(0, 0)], 120),
      RATE,
    );
    const expected = HUC6280_PSG_CLOCK_HZ / (32 * 4096);
    expect(expected).toBeCloseTo(27.3, 0);
    expect(frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate)).toBeCloseTo(expected, -1);
  });

  it("attenuates in 1.5 dB steps, and the balance field counts double", () => {
    const divider = 254;
    const at = (volume: number, balance: number): number => {
      const pcm = renderSchedule(
        new Huc6280Psg(),
        hold(
          [
            { reg: REG.GLOBAL, value: 0xff },
            ...upload(0, SQUARE),
            { reg: REG.SELECT, value: 0 },
            { reg: REG.FREQ_LOW, value: divider & 0xff },
            { reg: REG.FREQ_HIGH, value: (divider >> 8) & 0x0f },
            { reg: REG.BALANCE, value: (balance << 4) | balance },
            { reg: REG.CONTROL, value: 0x80 | volume },
          ],
          60,
        ),
        RATE,
      );
      const samples = pcm.channels[0] as Float32Array;
      return rms(samples, samples.length >> 2);
    };
    const full = at(31, 15);
    // Four channel steps is 6 dB, so half the amplitude.
    expect(at(27, 15) / full).toBeCloseTo(0.5, 1);
    // Two balance steps is the same 6 dB, because that field counts twice.
    expect(at(31, 13) / full).toBeCloseTo(0.5, 1);
  });

  it("rewinds the wave pointer only when the channel is turned off", () => {
    // The upload's "seek to zero" *is* the control write, so a driver that
    // skipped it would write into the middle of a cycle. Reading back is the
    // only way to see it, and the read port is the write port's twin.
    const psg = new Huc6280Psg();
    for (const write of upload(0, SQUARE)) psg.write(write.reg, write.value);
    expect(psg.read(REG.WAVE)).toBe(31);
    // Thirty-two writes wrapped the write index; a fresh one lands at sample 0.
    psg.write(REG.WAVE, 7);
    psg.write(REG.CONTROL, 0x00);
    psg.write(REG.WAVE, 9);
    expect(psg.read(REG.WAVE)).toBe(9);
  });

  it("has a shift register on the last two channels and nowhere else", () => {
    const noiseOn = (channel: number): number => {
      const pcm = renderSchedule(
        new Huc6280Psg(),
        hold(
          [
            { reg: REG.GLOBAL, value: 0xff },
            // No waveform at all: a flat table is silence, so anything audible
            // here is the shift register rather than a leftover cycle.
            { reg: REG.SELECT, value: channel },
            { reg: REG.CONTROL, value: 0x00 },
            ...Array.from({ length: HUC6280_WAVE_SAMPLES }, () => ({ reg: REG.WAVE, value: 16 })),
            { reg: REG.BALANCE, value: 0xff },
            { reg: REG.NOISE, value: 0x80 | 20 },
            { reg: REG.CONTROL, value: 0x80 | 31 },
          ],
          30,
        ),
        RATE,
      );
      const samples = pcm.channels[0] as Float32Array;
      return rms(samples, samples.length >> 2);
    };
    expect(noiseOn(HUC6280_FIRST_NOISE_CHANNEL)).toBeGreaterThan(0.02);
    expect(noiseOn(HUC6280_PSG_CHANNELS - 1)).toBeGreaterThan(0.02);
    // The register is not decoded at all on the first four, so asking is a
    // no-op rather than an error — which is what the hardware does.
    expect(noiseOn(0)).toBeLessThan(1e-3);
  });

  it("sums six channels to full scale, and one to a sixth of it", () => {
    // Measured as RMS past the DC blocker's settling transient. Peak would be
    // measuring `mix.ts` rather than the model: a square at 440 Hz droops
    // thirteen per cent across each half-cycle of a 20 Hz single-pole
    // high-pass, so the sample after every edge overshoots by about that much.
    const levelOf = (count: number): number => {
      const writes: RegisterWrite[] = [{ reg: REG.GLOBAL, value: 0xff }];
      for (let channel = 0; channel < count; channel += 1) {
        // One pitch for all of them, so what is measured is the summing rather
        // than the beat between six nearly-equal frequencies.
        writes.push(...upload(channel, SQUARE), ...play(channel, 254));
      }
      const samples = renderSchedule(new Huc6280Psg(), hold(writes, 60), RATE)
        .channels[0] as Float32Array;
      return rms(samples, samples.length >> 1);
    };
    const full = levelOf(HUC6280_PSG_CHANNELS);
    // A full-scale square, near enough: the droop is what keeps it off 1.0.
    expect(full).toBeGreaterThan(0.9);
    expect(full).toBeLessThan(1.0);
    // Which is the whole point of the normalisation: a solo voice is a sixth of
    // the range, and six of them fill it without the chip clipping.
    expect(levelOf(1) * HUC6280_PSG_CHANNELS).toBeCloseTo(full, 5);
  });

  it("places a channel with the balance field rather than an enable bit", () => {
    const pcm = renderSchedule(
      new Huc6280Psg(),
      hold(
        [
          { reg: REG.GLOBAL, value: 0xff },
          ...upload(0, SQUARE),
          { reg: REG.SELECT, value: 0 },
          { reg: REG.FREQ_LOW, value: 254 },
          { reg: REG.FREQ_HIGH, value: 0 },
          { reg: REG.BALANCE, value: 0xf0 }, // hard left
          { reg: REG.CONTROL, value: 0x80 | 31 },
        ],
        60,
      ),
      RATE,
    );
    const left = pcm.channels[0] as Float32Array;
    const right = pcm.channels[1] as Float32Array;
    expect(rms(left, left.length >> 2)).toBeGreaterThan(0.05);
    expect(rms(right, right.length >> 2)).toBeLessThan(1e-3);
  });

  it("stores the LFO's two registers where a caller can read them", () => {
    const psg = new Huc6280Psg();
    psg.write(REG.LFO_FREQ, 0x42);
    psg.write(REG.LFO_CONTROL, 0x03);
    expect(psg.lfoFrequency).toBe(0x42);
    expect(psg.lfoControl).toBe(0x03);
  });
});

/**
 * The LFO, which on this chip is a *channel* rather than an oscillator.
 *
 * Every case here is one that would pass on a model that stored the registers
 * and ignored them, or on one that wired the pair the other way round — so each
 * asserts a consequence rather than a setting. What makes them checkable at all
 * is that a modulator held at a constant sample is an ordinary detune: the pitch
 * moves by a predictable number of divider steps and can simply be measured.
 */
describe("the HuC6280 PSG's LFO", () => {
  /**
   * Channel two, uploaded with one flat level and running.
   *
   * A flat waveform makes the modulation a constant offset, which is what turns
   * "does the LFO reach the pitch" into a frequency this test can name. The
   * divider is the slowest available so the modulator cannot step during the
   * window measured.
   */
  function modulator(level: number): RegisterWrite[] {
    return [
      ...upload(
        LFO_MODULATOR,
        Array.from({ length: HUC6280_WAVE_SAMPLES }, () => level),
      ),
      ...play(LFO_MODULATOR, 0, 0),
    ];
  }

  /** What the carrier's pitch comes out as under a given LFO setting. */
  function pitchUnder(control: number, level: number, divider = 254): number {
    const pcm = renderSchedule(
      new Huc6280Psg(),
      hold(
        [
          { reg: REG.GLOBAL, value: 0xff },
          ...modulator(level),
          { reg: REG.LFO_FREQ, value: 1 },
          { reg: REG.LFO_CONTROL, value: control },
          ...upload(LFO_TARGET, SQUARE),
          ...play(LFO_TARGET, divider),
        ],
        90,
      ),
      RATE,
    );
    return frequencyOf(pcm.channels[0] as Float32Array, pcm.sampleRate);
  }

  it("adds channel two's sample to channel one's divider, centred at sixteen", () => {
    // A modulator parked at the midpoint detunes nothing, which is the same
    // convention the output stage uses and the reason a flat waveform is silence.
    const divider = 254;
    expect(pitchUnder(0x01, 16, divider)).toBeCloseTo(HUC6280_PSG_CLOCK_HZ / (32 * divider), -1);
    // Depth 1 shifts by nothing, so a sample eight above the midpoint adds eight
    // to the divider — a *lower* note, because the divider is a period.
    expect(pitchUnder(0x01, 24, divider)).toBeCloseTo(
      HUC6280_PSG_CLOCK_HZ / (32 * (divider + 8)),
      -1,
    );
  });

  it("shifts the depth by two bits a step, so the setting is not a multiplier", () => {
    // Depths one, two and three shift by 0, 2 and 4 — which is 1x, 4x and 16x
    // rather than the 1x, 2x, 3x a reader expects from "depth".
    const divider = 254;
    for (const [control, scale] of [
      [0x01, 1],
      [0x02, 4],
      [0x03, 16],
    ] as const) {
      expect(pitchUnder(control, 20, divider)).toBeCloseTo(
        HUC6280_PSG_CLOCK_HZ / (32 * (divider + 4 * scale)),
        -1,
      );
    }
  });

  it("leaves the pitch alone when the depth is zero", () => {
    const divider = 254;
    expect(pitchUnder(0x00, 31, divider)).toBeCloseTo(HUC6280_PSG_CLOCK_HZ / (32 * divider), -1);
  });

  it("holds the modulator where it stands when bit 7 is set, rather than off", () => {
    // The distinction the halt bit exists for: the LFO stops *moving* but its
    // last sample is still the detune, so a halted modulator is a frozen pitch
    // bend and not a return to the written one. Which means a halt with a
    // modulator parked away from the midpoint sounds like neither of the two
    // things a reader would guess.
    const divider = 254;
    expect(pitchUnder(0x83, 20, divider)).toBeCloseTo(HUC6280_PSG_CLOCK_HZ / (32 * divider), -1);
  });

  it("multiplies the modulator's own divider by the frequency register", () => {
    // The LFO rate is the product of two registers rather than either one, so
    // doubling `$08` halves the sweep — which is the whole reason a driver has
    // to think about channel two's divider even when it is not a note.
    //
    // A square modulator makes the carrier alternate between two pitches, so
    // counting how often it changes *is* the sweep rate: a model that ignored
    // `$08` would report the same count both times.
    const flips = (lfoFrequency: number): number => {
      const pcm = renderSchedule(
        new Huc6280Psg(),
        hold(
          [
            { reg: REG.GLOBAL, value: 0xff },
            ...upload(LFO_MODULATOR, SQUARE),
            ...play(LFO_MODULATOR, 256, 0),
            { reg: REG.LFO_FREQ, value: lfoFrequency },
            { reg: REG.LFO_CONTROL, value: 0x01 },
            ...upload(LFO_TARGET, SQUARE),
            ...play(LFO_TARGET, 100),
          ],
          60,
        ),
        RATE,
      );
      const samples = pcm.channels[0] as Float32Array;
      const windows = 60;
      const span = Math.floor(samples.length / windows);
      const pitches: number[] = [];
      for (let index = 0; index < windows; index += 1) {
        pitches.push(
          frequencyOf(samples.subarray(index * span, (index + 1) * span), pcm.sampleRate),
        );
      }
      const mean = pitches.reduce((sum, value) => sum + value, 0) / pitches.length;
      let count = 0;
      for (let index = 1; index < pitches.length; index += 1) {
        const before = (pitches[index - 1] as number) - mean;
        const after = (pitches[index] as number) - mean;
        if (before <= 0 && after > 0) count += 1;
      }
      return count;
    };
    const fast = flips(55);
    const slow = flips(220);
    expect(fast).toBeGreaterThan(4);
    // Four times the multiplier is a quarter the sweep, allowing for the window
    // count being a coarse ruler at the slow end.
    expect(slow).toBeLessThan(fast / 2);
  });
});
