/**
 * The one renderer, where a box is narrower than a clock (doc 16 §The render contract).
 *
 * `renderSchedule` box-integrates a chip's output into evenly spaced samples,
 * and every model here but one clocks in megahertz — so the boxes have always
 * been many clocks wide and the arithmetic never met the other case. `GbaPcm`
 * is the exception: it is a *mixer* rather than an oscillator, so its clock is
 * 32768 Hz, below the 48 kHz a render defaults to. Boundaries then collide, the
 * box has zero width, and the mean of nothing is `0 / 0` — which is why
 * `demake render -c gba` wrote a WAV whose every sample after the first was
 * `NaN`, and had since that console was added.
 *
 * A `NaN` render is the *loud* version of this bug. The quiet one is what a
 * careless fix produces: clearing the accumulator on a zero-width box throws
 * away clocks that belong to the box after it, which silences every second
 * sample instead of failing. Both are pinned below.
 */

import { describe, expect, it } from "vitest";

import { renderSchedule } from "../src/mix.js";
import type { ChipModel, SampleSink } from "../src/types.js";

/**
 * A chip that holds one constant value, at whatever clock it is given.
 *
 * The point of a constant is that the correct render is knowable exactly: the
 * mean of a constant is that constant however the boxes fall, so *every* output
 * sample must equal it whether the renderer is upsampling or downsampling.
 */
class Constant implements ChipModel {
  readonly id = "gb-apu" as ChipModel["id"];
  readonly outputChannels = 2;

  constructor(
    readonly clockHz: number,
    private readonly value: number,
  ) {}

  write(): void {}

  run(clocks: number, sink?: SampleSink): void {
    let left = clocks;
    while (left > 0) {
      const step = sink ? Math.min(left, Math.max(1, sink.clocksUntilSampleBoundary())) : left;
      sink?.add(this.value, this.value, step);
      left -= step;
    }
  }
}

/** Render a constant-valued chip for a moment and hand back the left channel. */
function renderConstant(clockHz: number, value: number): Float32Array {
  const chip = new Constant(clockHz, value);
  // Sixty ticks at 60 Hz is a second, which at any of these clocks is plenty of
  // samples for a boundary collision to happen if it is going to.
  const schedule = Array.from({ length: 60 }, () => ({ writes: [] }));
  return renderSchedule(chip, schedule, { num: 60, den: 1 }, { sampleRate: 48000 }).channels[0]!;
}

describe("a chip slower than the sample rate", () => {
  // 32768 Hz is `GbaPcm`'s, and the reason this case exists at all.
  it.each([32768, 8000, 44100])("renders no NaN at %i Hz", (clockHz) => {
    const samples = renderConstant(clockHz, 0.5);
    expect(samples.length).toBeGreaterThan(0);
    const bad = [...samples].filter((value) => Number.isNaN(value)).length;
    expect(bad).toBe(0);
  });

  it("does not silence the sample after a zero-width box", () => {
    // The assertion that catches the careless fix, and the reason it is about
    // the *minimum* rather than about any one sample. A zero-width box must
    // take the value being held — and must leave the accumulator alone, or the
    // clocks in it are thrown away and the box after it renders as silence.
    // That failure alternates full and empty samples, which reads as a chip
    // that stutters and which no NaN check would notice.
    const samples = renderConstant(32768, 0.5);
    let quietest = Infinity;
    for (let i = 0; i < 16; i += 1) quietest = Math.min(quietest, Math.abs(samples[i]!));
    // A constant is the one thing a DC blocker is built to remove, so these
    // decay — but slowly, at 20 Hz against 48 kHz. Alternate silence would put
    // this at zero.
    expect(quietest).toBeGreaterThan(0.4);
  });

  it("agrees with the downsampling path it replaces", () => {
    // The sharp version of "it holds the value", and the one that needs no
    // tolerance argument: **the mean of a constant is that constant however the
    // boxes fall**, so a chip slower than the sample rate and one far faster
    // must render a constant to the same samples. Both runs are the same
    // duration at the same output rate, so they are the same length and go
    // through the same DC blocker — which is what takes that filter's decay out
    // of the comparison entirely rather than budgeting for it.
    const slow = renderConstant(32768, 0.5);
    const fast = renderConstant(4_194_304, 0.5);
    expect(slow.length).toBe(fast.length);
    for (let i = 0; i < slow.length; i += 1) {
      expect(slow[i]).toBeCloseTo(fast[i]!, 6);
    }
  });
});
