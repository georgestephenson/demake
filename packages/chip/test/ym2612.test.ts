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

/**
 * The three things that used to be stored and inert.
 *
 * Each of them is reachable only through a register this project's binding does
 * not write, so nothing above these tests exercises them — which is exactly why
 * they are here. A model that kept the writes and ignored them would pass every
 * other case in this file.
 */

/**
 * How much a tone's period wobbles, as a fraction of its own length.
 *
 * The right measurement for vibrato and the wrong one for everything else: a
 * windowed pitch is quantised by how many cycles fit in the window, which at
 * these frequencies is coarser than the sweep being looked for. Successive
 * zero crossings are not — one sample of jitter in a hundred is well under a
 * per-cent, and the deepest setting this chip has is several.
 */
function periodWobble(samples: Float32Array, from: number, to: number): number {
  const crossings: number[] = [];
  let previous = samples[from] ?? 0;
  for (let index = from + 1; index < to; index += 1) {
    const current = samples[index] as number;
    if (previous <= 0 && current > 0) crossings.push(index);
    previous = current;
  }
  if (crossings.length < 8) return 0;
  const periods: number[] = [];
  for (let index = 1; index < crossings.length; index += 1) {
    periods.push((crossings[index] as number) - (crossings[index - 1] as number));
  }
  const mean = periods.reduce((sum, value) => sum + value, 0) / periods.length;
  return (Math.max(...periods) - Math.min(...periods)) / mean;
}

describe("the LFO's pitch modulation", () => {
  /** A sine on channel 1 with the LFO running and a given depth. */
  function vibrato(depth: number, block = 4): { reg: number; value: number }[] {
    return [
      ...reg(0x22, 0x08), // LFO on, slowest sweep
      ...beforeKeyOn(sineOnChannel1(1083, block), reg(0xb4, 0xc0 | depth)),
    ];
  }

  it("moves the pitch when a depth is set, and not when it is zero", () => {
    // The whole of what "stored and inert" used to mean: the register was
    // written and the note came out at exactly its F-number's pitch, for ever.
    const flat = periodWobble(play(vibrato(0), 90), 4800, 40000);
    const swept = periodWobble(play(vibrato(7), 90), 4800, 40000);
    expect(flat).toBeLessThan(0.03);
    expect(swept).toBeGreaterThan(0.06);
  });

  it("is proportional to the pitch, which is what makes it an interval", () => {
    // The offset is summed over the F-number's *bits*, so the same depth is the
    // same number of cents at every pitch rather than the same number of hertz.
    // A model that added a fixed increment would fail this and nothing else.
    const low = periodWobble(play(vibrato(7, 3), 90), 4800, 40000);
    const high = periodWobble(play(vibrato(7, 5), 90), 4800, 40000);
    expect(low).toBeGreaterThan(0.06);
    // Two octaves apart, and the *relative* swing is within a third of itself —
    // a fixed-increment model would differ by a factor of four.
    expect(high / low).toBeGreaterThan(0.7);
    expect(high / low).toBeLessThan(1.4);
  });

  it("holds the sweep still while the LFO is off", () => {
    // Switching the LFO off parks pitch modulation at the centre rather than
    // freeing it, so a channel with a depth set plays its written pitch — which
    // is the state every cartridge this project builds leaves the chip in.
    const samples = play(
      [...reg(0x22, 0x00), ...beforeKeyOn(sineOnChannel1(1083, 4), reg(0xb4, 0xc7))],
      90,
    );
    expect(periodWobble(samples, 4800, 40000)).toBeLessThan(0.03);
  });
});

describe("SSG-EG", () => {
  /**
   * A patch whose envelope decays to silence, so the mode has something to
   * reach.
   *
   * Everything SSG-EG does happens at *half* attenuation, which an ordinary
   * envelope passes straight through — so the only patch that can show it is one
   * that would otherwise have gone quiet.
   */
  function withSsg(mode: number): { reg: number; value: number }[] {
    return beforeKeyOn(sineOnChannel1(1083, 4), [
      ...reg(0x60, 0x1f), // decay as fast as the chip can
      ...reg(0x80, 0xff), // sustain at full attenuation, fastest release
      ...reg(0x90, mode),
    ]);
  }

  it("restarts the attack rather than stopping, when it is a loop", () => {
    // Mode `$08` is the looping one: reaching half attenuation begins the attack
    // again, so a patch that would have decayed to nothing is still sounding at
    // the end of the render. That is the mode turning an envelope into an
    // oscillator, which no other setting on this chip can do.
    const once = play(withSsg(0x00), 90);
    const looped = play(withSsg(0x08), 90);
    const late = Math.floor(once.length * 0.5);
    expect(peak(once, late)).toBeLessThan(0.002);
    expect(peak(looped, late)).toBeGreaterThan(0.01);
  });

  it("runs the envelope four times as fast, and stops it at half scale", () => {
    // Both halves of the same fact, and only together: armed, the operator
    // steps by four and gives up at `$200` rather than `$3FF`. Measured against
    // the identical patch with bit 3 clear that is about four times sooner —
    // not the eight the two numbers suggest, because a tone falls under the
    // threshold well before full attenuation. Stepping by one and stopping at
    // half would be no sooner at all, which is the margin this is sized for.
    const rate = 0x14; // slow enough that both decays fit inside the render
    const silenceAt = (mode: number): number => {
      const samples = play(
        beforeKeyOn(sineOnChannel1(1083, 4), [
          ...reg(0x60, rate),
          ...reg(0x80, 0xff),
          ...reg(0x90, mode),
        ]),
        90,
      );
      for (let index = samples.length - 1; index >= 0; index -= 1) {
        if (Math.abs(samples[index] as number) > 0.002) return index;
      }
      return 0;
    };
    const armed = silenceAt(0x09); // hold, so it stops rather than looping
    const plain = silenceAt(0x01); // the same shape with the mode bit clear
    expect(armed).toBeGreaterThan(0);
    expect(armed * 3).toBeLessThan(plain);
  });

  it("holds the envelope where it lands when the hold bit is set", () => {
    // Mode `$09` is hold with no inversion, which parks the operator silent —
    // and it must stay silent rather than looping, because the difference
    // between hold and loop is bit 0 alone. A model that treated the low bits as
    // one number would loop here.
    const samples = play(withSsg(0x09), 90);
    const late = Math.floor(samples.length * 0.5);
    expect(peak(samples, late)).toBeLessThan(0.002);
  });

  it("does nothing at all unless bit 3 is set", () => {
    // The low three bits are a shape and bit 3 is the arming, so a driver may
    // leave a shape in the register with the mode off — which is what makes it
    // safe to write unconditionally and why every other test here can ignore it.
    const off = play(withSsg(0x07), 90);
    const armed = play(withSsg(0x00), 90);
    expect(peak(off)).toBeCloseTo(peak(armed), 5);
  });
});

describe("channel 3's per-operator frequencies", () => {
  /**
   * The same bare sine, on channel 3 rather than channel 1.
   *
   * Only S1 is audible, which is what makes the note that comes out name the
   * register that reached it — the other three slots would otherwise blur four
   * pitches into one measurement.
   */
  function sineOnChannel3(fnum: number, block: number): { reg: number; value: number }[] {
    const writes: { reg: number; value: number }[] = [];
    writes.push(...reg(0xb2, 0x07)); // algorithm 7, no feedback
    writes.push(...reg(0xb6, 0xc0)); // both speakers
    for (let slot = 0; slot < 4; slot += 1) {
      const at = slot * 4 + 2;
      writes.push(...reg(0x30 + at, 0x01));
      writes.push(...reg(0x40 + at, slot === 0 ? 0x00 : 0x7f));
      writes.push(...reg(0x50 + at, 0x1f));
      writes.push(...reg(0x60 + at, 0x00));
      writes.push(...reg(0x70 + at, 0x00));
      writes.push(...reg(0x80 + at, 0x0f));
    }
    writes.push(...reg(0xa6, (block << 3) | ((fnum >> 8) & 7)));
    writes.push(...reg(0xa2, fnum & 0xff));
    writes.push(...reg(0x28, 0xf2)); // key on all four slots of channel 3
    return writes;
  }

  /** Set one of the three extra F-numbers, high byte first. */
  function slotPitch(register: number, fnum: number, block: number) {
    return [...reg(register + 4, (block << 3) | ((fnum >> 8) & 7)), ...reg(register, fnum & 0xff)];
  }

  /** What the audible operator's note comes out as, under a given mode. */
  function heard(mode: number): number {
    const writes = [
      ...reg(0x27, mode),
      ...slotPitch(0xa8, 1083, 3), // S3's, an octave down
      ...slotPitch(0xa9, 1083, 5), // S1's, an octave up
      ...sineOnChannel3(1083, 4), // and the channel's own, in the middle
    ];
    return frequencyOf(play(writes, 60), 48000, 4800, 24000);
  }

  it("gives S1 the F-number at `$A9`, not the one at `$A8`", () => {
    // The permutation is the whole of what a model can get wrong here, and it is
    // silent about it: every slot still plays, at the wrong three pitches. Three
    // registers an octave apart is what makes the answer readable.
    const measured = heard(0x40);
    expect(measured).toBeGreaterThan(840);
    expect(measured).toBeLessThan(920);
  });

  it("leaves the channel's own F-number in charge until the mode is on", () => {
    const measured = heard(0x00);
    expect(measured).toBeGreaterThan(420);
    expect(measured).toBeLessThan(460);
  });

  it("keeps a latch of its own, separate from every other channel's", () => {
    // `$AC` and `$A4` are two different high-byte latches, so a driver may leave
    // one half-written and set the other. Sharing them would put channel 3's
    // slots on whatever block was written for some other channel — here, four
    // octaves up rather than one down.
    const writes = [
      ...reg(0x27, 0x40),
      ...reg(0xad, (3 << 3) | ((1083 >> 8) & 7)), // S1's block, through `$AC`'s latch
      ...reg(0xa4, (7 << 3) | ((1083 >> 8) & 7)), // and a wild one through `$A4`'s
      ...reg(0xa9, 1083 & 0xff),
      ...sineOnChannel3(1083, 4),
    ];
    const measured = frequencyOf(play(writes, 60), 48000, 4800, 24000);
    expect(measured).toBeGreaterThan(205);
    expect(measured).toBeLessThan(235);
  });
});

describe("CSM", () => {
  it("strikes channel 3 from timer A rather than from a driver", () => {
    // The mode exists so a program can re-strike one voice at an exact rate
    // without touching the bus, and it is the one place on this chip where a
    // note begins with no key-on write at all. A model that ignored `$27`'s top
    // bits would be silent here and correct everywhere else.
    const patch = (mode: number): { reg: number; value: number }[] => {
      const writes: { reg: number; value: number }[] = [];
      writes.push(...reg(0xb2, 0x07)); // channel 3, algorithm 7
      writes.push(...reg(0xb6, 0xc0));
      for (let slot = 0; slot < 4; slot += 1) {
        const at = slot * 4 + 2;
        writes.push(...reg(0x30 + at, 0x01));
        writes.push(...reg(0x40 + at, slot === 0 ? 0x00 : 0x7f));
        writes.push(...reg(0x50 + at, 0x1f)); // instant attack
        writes.push(...reg(0x60 + at, 0x08)); // and a decay, so a strike is heard
        writes.push(...reg(0x70 + at, 0x00));
        writes.push(...reg(0x80 + at, 0xf0));
      }
      writes.push(...reg(0xa6, (4 << 3) | ((1083 >> 8) & 7)));
      writes.push(...reg(0xa2, 1083 & 0xff));
      // CSM is the four-pitch mode with a timer on top, so the three extra
      // F-numbers have to be set as well — a voice struck by the timer with
      // `$A8`-`$AA` left at zero would key on and hold a phase that never moves.
      for (const register of [0xa8, 0xa9, 0xaa]) {
        writes.push(...reg(register + 4, (4 << 3) | ((1083 >> 8) & 7)));
        writes.push(...reg(register, 1083 & 0xff));
      }
      // Timer A at about 300 Hz, enabled and running — and no key-on anywhere.
      writes.push(...reg(0x24, 0xd8));
      writes.push(...reg(0x25, 0x00));
      writes.push(...reg(0x27, mode | 0x05));
      return writes;
    };
    expect(peak(play(patch(0x80), 60))).toBeGreaterThan(0.005);
    // The same registers with the mode bits clear: nothing ever keys the voice,
    // so a model that struck on the timer regardless would pass the first
    // assertion and fail this one.
    expect(peak(play(patch(0x40), 60))).toBeLessThan(0.0005);
  });
});
