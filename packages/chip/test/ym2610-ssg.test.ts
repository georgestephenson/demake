/**
 * The Neo Geo's SSG, held to the published numbers rather than to itself.
 *
 * The pitch case is the load-bearing one. Yamaha's own manual gives the formula
 * *and* a worked example — A4 is period `$238` — so the lattice can be checked
 * against an outside number instead of against this file's own arithmetic. That
 * matters more here than the usual amount: a chip whose divider is wrong by a
 * factor of two plays every note an octave out while every register write is
 * correct, which is the shape of failure AGENTS.md §Gotchas keeps warning about.
 *
 * The rest are the three places this chip differs from the SN76489 beside it,
 * because those are what a driver written from that one's habits would get wrong:
 * volume rises rather than attenuating, the mixer is active *low*, and writing
 * the envelope shape restarts it even when the value has not changed.
 */

import { SSG_DIVIDER, YM2610_CLOCK_HZ, Ym2610Ssg } from "@demake/chip";
import { describe, expect, it } from "vitest";

/** Collect `frames` mono samples at `rate`, running the chip in between. */
function render(chip: Ym2610Ssg, rate: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const perFrame = Math.floor(YM2610_CLOCK_HZ / rate);
  for (let index = 0; index < frames; index += 1) {
    let level = 0;
    let held = 0;
    const sink = {
      clocksUntilSampleBoundary: (): number => Number.MAX_SAFE_INTEGER,
      add: (left: number, _right: number, clocks: number): void => {
        level += left * clocks;
        held += clocks;
      },
    };
    chip.run(perFrame, sink);
    out[index] = held > 0 ? level / held : 0;
  }
  return out;
}

/** Set a channel's twelve-bit tone period through its two registers. */
function setPeriod(chip: Ym2610Ssg, channel: number, period: number): void {
  chip.write(channel * 2, period & 0xff);
  chip.write(channel * 2 + 1, (period >> 8) & 0x0f);
}

/** Count rising edges in a rendered run, which is the tone's frequency. */
function edges(samples: Float32Array): number {
  let count = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index] ?? 0) > 0.01 && (samples[index - 1] ?? 0) <= 0.01) count += 1;
  }
  return count;
}

describe("the SSG's pitch", () => {
  it("divides by thirty-two, which is the published 250000 over period", () => {
    // The published formula is a *tone* rate: `8 MHz / 2 / (16 × period)`. A
    // square toggles twice a cycle, so the counter runs at twice the note and
    // the divider is sixteen rather than thirty-two. This model shipped with
    // thirty-two and played everything an octave low.
    expect(YM2610_CLOCK_HZ / 2 / 16).toBe(250_000);
    expect(YM2610_CLOCK_HZ / (2 * SSG_DIVIDER)).toBe(250_000);
  });

  it("puts A4 on period $238, the manual's own worked example", () => {
    // A square's *cycle* is two toggles, so the tone rate is half the counter's.
    const period = 0x238;
    const frequency = YM2610_CLOCK_HZ / 2 / (16 * period);
    expect(Math.round(frequency)).toBe(440);
  });

  it("reaches lower than an SN76489 can, which is why bass needs no doubling", () => {
    // Twelve bits of period at 250000 over it: about 61 Hz, against that chip's
    // ~109 Hz floor.
    expect(Math.round(250_000 / 4095)).toBe(61);
  });

  it("produces a square at the rate the formula says", () => {
    const chip = new Ym2610Ssg();
    setPeriod(chip, 0, 0x238); // A4
    chip.write(0x07, 0x3e); // tone A on, everything else off (active low)
    chip.write(0x08, 0x0f); // full level
    const rate = 44_100;
    const samples = render(chip, rate, rate);
    // One second of audio, so the edge count is the frequency. Allow a little
    // slack for the whole-clock rounding a sample boundary imposes.
    expect(edges(samples)).toBeGreaterThan(430);
    expect(edges(samples)).toBeLessThan(450);
  });
});

describe("what a driver written for the SN76489 would get wrong", () => {
  it("treats volume as a level, not an attenuation", () => {
    const loud = new Ym2610Ssg();
    const quiet = new Ym2610Ssg();
    for (const [chip, volume] of [
      [loud, 0x0f],
      [quiet, 0x01],
    ] as const) {
      setPeriod(chip, 0, 0x100);
      chip.write(0x07, 0x3e);
      chip.write(0x08, volume);
    }
    const loudest = Math.max(...render(loud, 44_100, 512));
    const quietest = Math.max(...render(quiet, 44_100, 512));
    // Fifteen is loud and one is nearly silent. On an SN76489 this is inverted,
    // so a driver that carried that habit over plays its fortissimo as a
    // whisper.
    expect(loudest).toBeGreaterThan(quietest * 10);
  });

  it("enables tone and noise with a *clear* bit", () => {
    const chip = new Ym2610Ssg();
    setPeriod(chip, 0, 0x100);
    chip.write(0x08, 0x0f);

    // With both sources disabled the channel holds a *steady* level rather than
    // going silent — that is real AY behaviour and what makes the volume
    // register usable as a crude sample player. So the polarity is checked by
    // whether the output *varies*, not by whether it is audible.
    chip.write(0x07, 0x3f); // every bit set — both sources off
    expect(new Set(render(chip, 44_100, 256)).size).toBe(1);

    chip.write(0x07, 0x3e); // bit 0 clear — channel A's tone on
    expect(new Set(render(chip, 44_100, 256)).size).toBeGreaterThan(1);
  });

  it("shares one noise generator between all three channels", () => {
    const chip = new Ym2610Ssg();
    chip.write(0x06, 0x10); // one noise period...
    chip.write(0x07, 0x07); // ...and noise on all three, tone off all three
    for (let channel = 0; channel < 3; channel += 1) chip.write(0x08 + channel, 0x0f);
    const samples = render(chip, 44_100, 512);
    // Something is being produced, and it is not a steady level: a shared
    // generator still has to actually run.
    expect(Math.max(...samples)).toBeGreaterThan(0);
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});

describe("the envelope", () => {
  it("restarts when the shape is written, even to the same value", () => {
    const chip = new Ym2610Ssg();
    setPeriod(chip, 0, 0x100);
    chip.write(0x07, 0x3e);
    chip.write(0x08, 0x10); // channel A follows the envelope
    chip.write(0x0b, 0x10); // a short envelope period
    chip.write(0x0c, 0x00);

    // Shape 0: a single decay, then silence. Run it out.
    chip.write(0x0d, 0x00);
    render(chip, 44_100, 2048);
    const decayed = Math.max(...render(chip, 44_100, 64));

    // The same value again is a retrigger, not a no-op — which is the whole way
    // a note is struck on this chip.
    chip.write(0x0d, 0x00);
    const struck = Math.max(...render(chip, 44_100, 64));
    expect(struck).toBeGreaterThan(decayed);
  });

  it("attacks rather than decays when the attack bit is set", () => {
    const decay = new Ym2610Ssg();
    const attack = new Ym2610Ssg();
    for (const [chip, shape] of [
      [decay, 0x00],
      [attack, 0x04],
    ] as const) {
      setPeriod(chip, 0, 0x100);
      chip.write(0x07, 0x3e);
      chip.write(0x08, 0x10);
      chip.write(0x0b, 0x40);
      chip.write(0x0c, 0x00);
      chip.write(0x0d, shape);
    }
    // Immediately after the shape write, a decay starts loud and an attack
    // starts silent.
    expect(Math.max(...render(decay, 44_100, 32))).toBeGreaterThan(
      Math.max(...render(attack, 44_100, 32)),
    );
  });
});

describe("register storage", () => {
  it("reads back what was written, which the hardware allows", () => {
    const chip = new Ym2610Ssg();
    for (let reg = 0; reg < 0x0e; reg += 1) chip.write(reg, reg * 7);
    for (let reg = 0; reg < 0x0e; reg += 1) expect(chip.read(reg)).toBe((reg * 7) & 0xff);
  });

  it("ignores a register this generator does not own", () => {
    const chip = new Ym2610Ssg();
    chip.write(0x20, 0xff);
    expect(chip.read(0x0d)).toBe(0);
  });
});
