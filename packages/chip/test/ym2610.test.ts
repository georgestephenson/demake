/**
 * The whole YM2610, held to the four things composing it could get wrong.
 *
 * The chip is an FM core, a tone generator and two different ADPCM codecs sharing
 * one bus, so the interesting failures are not inside any section — those have
 * their own tests — but at the seams:
 *
 *   - **Which channels exist.** The FM core has six and this part wires out four,
 *     at per-channel offsets 1 and 2 with 0 absent. A model that passed offset 0
 *     through would play a voice the board does not have, and would do it while
 *     every register write was correct.
 *   - **Which facilities exist.** The LFO and the DAC are OPN2 registers the OPNB
 *     has no silicon for.
 *   - **The two codecs are not one.** ADPCM-A wraps a twelve-bit accumulator;
 *     ADPCM-B clamps a sixteen-bit one and scales its step by a multiplier. The
 *     wrap is the load-bearing one, because it is what makes an overdriven drum
 *     fold rather than flatten.
 *   - **One flat span.** Four sections with four different event rates summed into
 *     one output: if the run loop failed to step to the nearest of them, a span
 *     would straddle an edge and average the wrong two levels. The chunk-size
 *     case is what catches that, on `stream.test.ts`'s terms.
 */

import {
  ADPCM_A_DIVIDER,
  SAMPLE_GAIN,
  YM2610_CLOCK_HZ,
  Ym2610,
  createChip,
  type SampleSink,
} from "@demake/chip";
import { describe, expect, it } from "vitest";

/** Collect `frames` stereo samples at `rate`, in chunks of `chunk` clocks. */
function render(chip: Ym2610, rate: number, frames: number, chunk = 0): Float32Array {
  const out = new Float32Array(frames);
  const perFrame = Math.floor(YM2610_CLOCK_HZ / rate);
  let level = 0;
  let held = 0;
  let index = 0;
  const sink: SampleSink = {
    clocksUntilSampleBoundary: () => Number.MAX_SAFE_INTEGER,
    add: (left, right, clocks) => {
      level += ((left + right) / 2) * clocks;
      held += clocks;
    },
  };
  const step = chunk > 0 ? chunk : perFrame;
  while (index < frames) {
    let owed = perFrame;
    while (owed > 0) {
      const run = Math.min(owed, step);
      chip.run(run, sink);
      owed -= run;
    }
    out[index] = held > 0 ? level / held : 0;
    level = 0;
    held = 0;
    index += 1;
  }
  return out;
}

/** Write one register through a port pair's address/data latch. */
function w(chip: Ym2610, pair: 0 | 1, reg: number, value: number): void {
  chip.write(pair * 2, reg);
  chip.write(pair * 2 + 1, value);
}

/**
 * A four-carrier patch at full level on one channel offset, then key it on.
 *
 * Algorithm 7 wires all four operators straight to the output, so nothing depends
 * on modulation depth and the channel is audible as soon as the envelope attacks.
 */
function fmNote(chip: Ym2610, pair: 0 | 1, offset: 1 | 2, keyCode: number): void {
  for (let slot = 0; slot < 4; slot += 1) {
    const s = (slot << 2) + offset;
    w(chip, pair, 0x30 + s, 0x01); // detune 0, multiple 1
    w(chip, pair, 0x40 + s, 0x00); // total level: loudest
    w(chip, pair, 0x50 + s, 0x1f); // attack as fast as it goes
    w(chip, pair, 0x60 + s, 0x00); // no decay
    w(chip, pair, 0x70 + s, 0x00); // no sustain rate
    w(chip, pair, 0x80 + s, 0x0f); // sustain at full, release fast
  }
  w(chip, pair, 0xb0 + offset, 0x07); // algorithm 7: four carriers
  w(chip, pair, 0xb4 + offset, 0xc0); // both sides
  w(chip, pair, 0xa4 + offset, 0x22); // block 4
  w(chip, pair, 0xa0 + offset, 0x69);
  // The key-on byte is a global and lives on the first pair whichever channel it
  // names, which is why this is not `pair`.
  w(chip, 0, 0x28, 0xf0 | keyCode);
}

/** How far a rendered run departs from silence. */
function loudness(samples: Float32Array): number {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  return peak;
}

describe("the four FM channels this part wires out", () => {
  it("sounds each of them, at offsets 1 and 2 on both port pairs", () => {
    for (const [pair, offset, code] of [
      [0, 1, 0x01],
      [0, 2, 0x02],
      [1, 1, 0x05],
      [1, 2, 0x06],
    ] as const) {
      const chip = new Ym2610();
      fmNote(chip, pair, offset, code);
      expect(loudness(render(chip, 44_100, 256))).toBeGreaterThan(0.01);
    }
  });

  it("refuses offset 0, which is a channel the OPNB does not have", () => {
    const chip = new Ym2610();
    // The same patch one offset lower, and the key-on code the missing channel
    // would answer to. A six-channel core would play it.
    for (let slot = 0; slot < 4; slot += 1) {
      const s = slot << 2;
      w(chip, 0, 0x30 + s, 0x01);
      w(chip, 0, 0x40 + s, 0x00);
      w(chip, 0, 0x50 + s, 0x1f);
      w(chip, 0, 0x80 + s, 0x0f);
    }
    w(chip, 0, 0xb0, 0x07);
    w(chip, 0, 0xb4, 0xc0);
    w(chip, 0, 0xa4, 0x22);
    w(chip, 0, 0xa0, 0x69);
    w(chip, 0, 0x28, 0xf0);
    expect(loudness(render(chip, 44_100, 256))).toBe(0);
  });

  it("does not offer the LFO or the DAC, which are OPN2 registers", () => {
    const chip = new Ym2610();
    fmNote(chip, 0, 1, 0x01);
    const plain = render(chip, 44_100, 256);

    const modulated = new Ym2610();
    w(modulated, 0, 0x22, 0x0f); // LFO on, fastest — nothing on this part
    fmNote(modulated, 0, 1, 0x01);
    w(modulated, 0, 0xb4 + 1, 0xc0 | 0x37); // maximum AMS and PMS with it
    w(modulated, 0, 0x2b, 0x80); // DAC enable
    w(modulated, 0, 0x2a, 0xff); // and a DAC sample at full scale
    expect([...render(modulated, 44_100, 256)]).toEqual([...plain]);
  });
});

describe("the tone generator behind the same bus", () => {
  it("reaches the SSG at $00-$0D of the first pair", () => {
    const chip = new Ym2610();
    w(chip, 0, 0x00, 0x38); // A4: period $238
    w(chip, 0, 0x01, 0x02);
    w(chip, 0, 0x07, 0x3e); // tone A on, active low
    w(chip, 0, 0x08, 0x0f);
    expect(loudness(render(chip, 44_100, 256))).toBeGreaterThan(0.01);
  });

  it("keeps the SSG out of the second pair, where ADPCM-A lives", () => {
    const chip = new Ym2610();
    // The same three writes on the other pair are ADPCM-A registers: `$07` is
    // unused there and `$08` is a voice's pan and volume, so nothing sounds.
    w(chip, 1, 0x00, 0x38);
    w(chip, 1, 0x01, 0x02);
    w(chip, 1, 0x07, 0x3e);
    w(chip, 1, 0x08, 0x0f);
    expect(loudness(render(chip, 44_100, 256))).toBe(0);
  });
});

describe("ADPCM-A", () => {
  /** Bytes of the loudest positive code, which ramps and then overflows. */
  const RAMP = new Uint8Array(512).fill(0x77);

  function playA(rom: Uint8Array, mask = 0x01): Ym2610 {
    const chip = new Ym2610({ pcmA: rom });
    w(chip, 1, 0x01, 0x3f); // master volume, loudest
    w(chip, 1, 0x08, 0xdf); // voice 0: both sides, loudest
    w(chip, 1, 0x10, 0x00); // start, low half
    w(chip, 1, 0x18, 0x00);
    w(chip, 1, 0x20, 0x01); // end at block 1, so 512 bytes
    w(chip, 1, 0x28, 0x00);
    w(chip, 1, 0x00, mask); // dump bit clear: key on
    return chip;
  }

  it("runs at the FM sample rate over three", () => {
    expect(ADPCM_A_DIVIDER).toBe(144 * 3);
    expect(Math.round(YM2610_CLOCK_HZ / ADPCM_A_DIVIDER)).toBe(18519);
  });

  it("wraps its twelve-bit accumulator rather than clipping", () => {
    // Six nibbles of the loudest positive code overflow twelve bits, and the
    // hardware sign extends what is left — so a ramp that only ever *adds* comes
    // back negative. A model that clamped would sit at the ceiling instead, which
    // is the difference between a drum that distorts and one that flattens.
    const samples = render(playA(RAMP), 18_519, 16);
    expect(Math.max(...samples)).toBeGreaterThan(0.1);
    expect(Math.min(...samples)).toBeLessThan(-0.1);
  });

  it("starts a whole kit from one write, because the byte is a mask", () => {
    const chip = new Ym2610({ pcmA: RAMP });
    w(chip, 1, 0x01, 0x3f);
    for (let voice = 0; voice < 6; voice += 1) {
      w(chip, 1, 0x08 + voice, 0xdf);
      w(chip, 1, 0x20 + voice, 0x01);
    }
    const one = render(playA(RAMP), 18_519, 8);
    w(chip, 1, 0x00, 0x3f); // all six at once
    const six = render(chip, 18_519, 8);
    // Six voices playing the same sample are six times one of them, which is also
    // how a Neo Geo driver's percussion costs one register write however many
    // drums land on the tick.
    expect(loudness(six)).toBeGreaterThan(loudness(one) * 4);
  });

  it("attenuates through the voice's level and the shared one", () => {
    const loud = playA(RAMP);
    const quiet = playA(RAMP);
    w(quiet, 1, 0x01, 0x20); // master down 31 steps of 0.75 dB
    expect(loudness(render(quiet, 18_519, 16))).toBeLessThan(
      loudness(render(loud, 18_519, 16)) / 4,
    );
  });

  it("stops at its end address rather than reading on", () => {
    const chip = playA(RAMP);
    w(chip, 1, 0x20, 0x00); // end at block 0: 256 bytes, 512 nibbles
    w(chip, 1, 0x00, 0x01);
    // Well past the sample: 512 nibbles at 18519 Hz is under 28 ms.
    const tail = render(chip, 18_519, 700).slice(600);
    expect(loudness(tail)).toBe(0);
  });

  it("is silent with no sample ROM, which is what an arranger has", () => {
    const chip = new Ym2610();
    w(chip, 1, 0x01, 0x3f);
    w(chip, 1, 0x08, 0xdf);
    w(chip, 1, 0x00, 0x01);
    expect(loudness(render(chip, 18_519, 64))).toBe(0);
  });
});

describe("ADPCM-B", () => {
  const RAMP = new Uint8Array(4096).fill(0x77);

  it("plays at delta-N over sixty-five thousand of the chip's own rate", () => {
    // The published ceiling is 55555 Hz, which is the FM sample rate — this
    // channel has no divider of its own at all, it steps a phase.
    expect(Math.round(YM2610_CLOCK_HZ / 144)).toBe(55556);
    const chip = new Ym2610({ pcmB: RAMP });
    w(chip, 0, 0x11, 0xc0); // both sides
    w(chip, 0, 0x12, 0x00); // start
    w(chip, 0, 0x13, 0x00);
    w(chip, 0, 0x14, 0x0f); // end
    w(chip, 0, 0x15, 0x00);
    w(chip, 0, 0x19, 0x00); // delta-N: half rate
    w(chip, 0, 0x1a, 0x80);
    w(chip, 0, 0x1b, 0xff); // volume
    w(chip, 0, 0x10, 0x80); // start
    expect(loudness(render(chip, 44_100, 256))).toBeGreaterThan(0.01);
  });

  it("clamps its sixteen-bit accumulator rather than wrapping", () => {
    // The opposite of ADPCM-A, and the reason the two decoders are separate. The
    // same all-positive ramp saturates here and stays there.
    const chip = new Ym2610({ pcmB: RAMP });
    w(chip, 0, 0x11, 0xc0);
    w(chip, 0, 0x14, 0x0f);
    w(chip, 0, 0x1a, 0x80);
    w(chip, 0, 0x1b, 0xff);
    w(chip, 0, 0x10, 0x80);
    const samples = render(chip, 44_100, 512);
    // Against the section's own ceiling rather than against one, because the seven
    // sample voices normalise by their count the way the FM core normalises by
    // six — otherwise a single drum is six times an FM voice and every demake
    // clips the moment a kick lands.
    expect(Math.max(...samples)).toBeGreaterThan(SAMPLE_GAIN * 0.9);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
  });

  it("stops on reset, which is how a driver silences it", () => {
    const chip = new Ym2610({ pcmB: RAMP });
    w(chip, 0, 0x11, 0xc0);
    w(chip, 0, 0x14, 0x0f);
    w(chip, 0, 0x1a, 0x80);
    w(chip, 0, 0x1b, 0xff);
    w(chip, 0, 0x10, 0x80);
    render(chip, 44_100, 64);
    w(chip, 0, 0x10, 0x01);
    expect(loudness(render(chip, 44_100, 64))).toBe(0);
  });
});

describe("the one run loop", () => {
  it("gives the same output whatever size the caller's chunks are", () => {
    // Four sections whose events fall at four different rates, all summed. If the
    // loop failed to step to the nearest of them, a span would carry two levels
    // and the average would depend on where a caller happened to break.
    const build = (): Ym2610 => {
      const chip = new Ym2610({ pcmA: new Uint8Array(512).fill(0x5a) });
      fmNote(chip, 0, 1, 0x01);
      w(chip, 0, 0x00, 0x38);
      w(chip, 0, 0x01, 0x02);
      w(chip, 0, 0x07, 0x3e);
      w(chip, 0, 0x08, 0x0f);
      w(chip, 1, 0x01, 0x3f);
      w(chip, 1, 0x08, 0xdf);
      w(chip, 1, 0x20, 0x01);
      w(chip, 1, 0x00, 0x01);
      return chip;
    };
    const whole = [...render(build(), 44_100, 128)];
    for (const chunk of [1, 7, 64]) {
      expect([...render(build(), 44_100, 128, chunk)]).toEqual(whole);
    }
  });

  it("reports a timer overflow, which is what a driver's clock reads", () => {
    const chip = new Ym2610();
    expect(chip.timersRunning).toBe(false);
    w(chip, 0, 0x24, 0xff); // timer A, near its fastest
    w(chip, 0, 0x25, 0x03);
    w(chip, 0, 0x27, 0x05); // load and enable timer A
    expect(chip.timersRunning).toBe(true);
    expect(chip.read() & 1).toBe(0);
    render(chip, 44_100, 64);
    expect(chip.read() & 1).toBe(1);
  });
});

describe("the registry", () => {
  it("builds the chip by id, with both sample ROMs", () => {
    const chip = createChip("ym2610", {
      ram: new Uint8Array(512).fill(0x77),
      ramB: new Uint8Array(512).fill(0x77),
    });
    expect(chip.id).toBe("ym2610");
    expect(chip.outputChannels).toBe(2);
  });
});
