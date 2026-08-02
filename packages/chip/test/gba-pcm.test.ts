/**
 * The Game Boy Advance's mixer, as a chip.
 *
 * Analytic vectors rather than a rendered waveform, for the reason every model
 * in this package gets them: the mixer is the *definition* an ARM driver has to
 * reproduce sample for sample (doc 16 §The proof, for a mixer console), so what
 * has to be pinned is the arithmetic — the accumulation order, where the shift
 * falls, and what happens at the ends of the range — rather than what it sounds
 * like.
 *
 * Two of these are the things a second implementation gets wrong. The shift is
 * applied to the *sum*, not per voice, which is what keeps a quiet voice from
 * quantising to nothing; and key-on is a **pulse**, so it starts the voices whose
 * bits are set and does nothing whatever to the rest.
 */

import { describe, expect, it } from "vitest";

import { GBA_PCM_KOF, GBA_PCM_KON, GbaPcm, type GbaSample } from "../src/gba-pcm.js";

/** A sample of ascending values, so a wrong position is a wrong number. */
function ramp(length: number, loop: number | null = null): GbaSample {
  return { data: Int8Array.from({ length }, (_, index) => index + 1), loop };
}

/** Set one voice up and start it. */
function voice(
  chip: GbaPcm,
  index: number,
  options: { source?: number; step?: number; left?: number; right?: number },
): void {
  const base = index * 8;
  chip.write(base + 0, options.source ?? 0);
  const step = options.step ?? 0x10000;
  chip.write(base + 2, step & 0xff);
  chip.write(base + 3, (step >> 8) & 0xff);
  chip.write(base + 4, (step >> 16) & 0xff);
  chip.write(base + 5, options.left ?? 0);
  chip.write(base + 6, options.right ?? 0);
  chip.write(GBA_PCM_KON, 1 << index);
}

/** `count` output samples from the left side. */
function left(chip: GbaPcm, count: number): number[] {
  return Array.from({ length: count }, () => chip.mix().left);
}

describe("the direct-sound mixer", () => {
  it("plays a sample at its own rate when the step is one", () => {
    const chip = new GbaPcm({ bank: [ramp(4)] });
    // Volume 256 would be unity, and the field is a byte — so 255 is as loud as
    // a voice gets and a sample of 4 comes back as 3.
    voice(chip, 0, { left: 255 });
    expect(left(chip, 5)).toEqual([0, 1, 2, 3, 0]);
  });

  it("advances by the step, so the pitch is a multiplier rather than a divider", () => {
    const chip = new GbaPcm({ bank: [ramp(8, 0)] });
    voice(chip, 0, { left: 255, step: 0x20000 });
    // Twice the rate: every other sample of the ramp.
    expect(left(chip, 4)).toEqual([0, 2, 4, 6]);
  });

  it("shifts the sum rather than each voice, so a quiet voice still counts", () => {
    const chip = new GbaPcm({ bank: [{ data: Int8Array.of(127), loop: 0 }] });
    // Four voices at a quarter volume each. Shifted per voice, 127 × 64 >> 8 is
    // 31 and the sum would be 124; shifted once, it is 127.
    for (let index = 0; index < 4; index += 1) voice(chip, index, { left: 64 });
    expect(chip.mix().left).toBe(127);
  });

  it("clips at the converter's range rather than wrapping", () => {
    const chip = new GbaPcm({ bank: [{ data: Int8Array.of(127, -128), loop: 0 }] });
    for (let index = 0; index < 4; index += 1) voice(chip, index, { left: 255, right: 255 });
    const first = chip.mix();
    expect(first.left).toBe(127);
    const second = chip.mix();
    expect(second.left).toBe(-128);
  });

  it("stops a one-shot at its end and returns a looping sample to its point", () => {
    const chip = new GbaPcm({ bank: [ramp(3), ramp(3, 1)] });
    voice(chip, 0, { source: 0, left: 255 });
    voice(chip, 1, { source: 1, left: 0, right: 255 });
    const output = Array.from({ length: 6 }, () => chip.mix());
    // The one-shot plays 1,2,3 and then nothing; the loop returns to index 1.
    expect(output.map((sample) => sample.left)).toEqual([0, 1, 2, 0, 0, 0]);
    expect(output.map((sample) => sample.right)).toEqual([0, 1, 2, 1, 2, 1]);
  });

  it("keys on as a pulse: the voices named, and nothing to the rest", () => {
    const chip = new GbaPcm({ bank: [ramp(4, 0)] });
    voice(chip, 0, { left: 255 });
    chip.mix();
    chip.mix();
    // Voice 1 starts; voice 0 is *not* restarted, because its bit is clear.
    voice(chip, 1, { left: 0, right: 255 });
    const next = chip.mix();
    expect(next.left).toBe(2); // the third sample of the ramp, scaled
    expect(next.right).toBe(0); // the first sample of the ramp, scaled
  });

  it("keys off only the voices named", () => {
    const chip = new GbaPcm({ bank: [ramp(4, 0)] });
    voice(chip, 0, { left: 255 });
    voice(chip, 1, { right: 255 });
    chip.write(GBA_PCM_KOF, 1 << 0);
    const sample = chip.mix();
    expect(sample.left).toBe(0);
    // Voice 1 is untouched and still playing — its first sample is 1, which at
    // full volume is 255 and lands on 0 once the sum is shifted. A key-off that
    // silenced everything would look the same here, which is why the loop below
    // checks that it comes back.
    expect(sample.right).toBe(0);
    expect(chip.mix().right).toBe(1);
  });

  it("plays nothing for a voice whose source is not in the bank", () => {
    const chip = new GbaPcm({ bank: [ramp(4, 0)] });
    voice(chip, 0, { source: 7, left: 255 });
    expect(left(chip, 3)).toEqual([0, 0, 0]);
  });

  it("renders through a sink at one output sample per clock", () => {
    const chip = new GbaPcm({ bank: [{ data: Int8Array.of(127), loop: 0 }] });
    voice(chip, 0, { left: 255, right: 255 });
    const seen: number[] = [];
    chip.run(3, {
      clocksUntilSampleBoundary: () => 1,
      add: (l, _r, clocks) => {
        expect(clocks).toBe(1);
        seen.push(l);
      },
    });
    // 127 × 255 >> 8 is 126, and the sink is handed it normalised.
    expect(seen).toEqual([126 / 128, 126 / 128, 126 / 128]);
  });
});
