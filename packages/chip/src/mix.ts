/**
 * Turning a register schedule into audio (doc 16 §The render contract).
 *
 * This is the only place a chip's output becomes samples, and there is exactly
 * one of it: the CLI writes files from here, the browser plays a buffer from
 * here, and the compliance oracle listens to the same thing. That is what makes
 * "the file sounds like the cartridge" a testable claim rather than a hope.
 *
 * Everything below is exact. Sample boundaries come from integer arithmetic on
 * the chip's own clock, so a three-minute render has no accumulated drift; each
 * sample is the true average of the chip's output over its window; and the only
 * floating-point state that crosses a sample boundary is the DC blocker, which
 * is a two-multiply recurrence with a constant coefficient. No engine has a
 * choice to make anywhere in here.
 */

import type { ChipModel, Pcm, RegisterWrite, SampleSink } from "./types.js";

/** An exact rate, e.g. `{ num: 5972750, den: 100000 }` for a Game Boy frame. */
export interface Rational {
  num: number;
  den: number;
}

/** One driver tick: the writes the chip receives before time moves on. */
export interface ScheduleTick {
  writes: readonly RegisterWrite[];
}

/**
 * How a chip's raw DAC output becomes something to listen to.
 *
 * - `raw` — the chip's own output, DC-blocked. Blocking DC is not colouration:
 *   a unipolar DAC's absolute level is not audio, every console AC-couples its
 *   output, and so does every emulator, so this is the encoding in which our
 *   model and a core can actually be compared.
 * - `board` — additionally simulates the console's analog stage. Reserved for
 *   the per-console filters; today it applies the same DC block at the
 *   hardware's own corner frequency.
 */
export type OutputStage = "raw" | "board";

export interface RenderOptions {
  /** Delivery rate; 48 kHz unless a caller has a reason (doc 16 §Claim 3). */
  sampleRate?: number;
  outputStage?: OutputStage;
  /** Extra seconds rendered after the last tick, for decays and releases. */
  tailSeconds?: number;
}

const DEFAULT_SAMPLE_RATE = 48000;
/** Two π to the precision a double carries; used only for the DC blocker. */
const TWO_PI = 6.283185307179586;
/** DC-blocker corner, low enough to leave the lowest playable notes alone. */
const DC_CUTOFF_HZ = 20;

/**
 * A sink that box-integrates a chip's output into evenly spaced samples.
 *
 * Boundaries are `floor(i × clockHz / sampleRate)`, computed fresh from `i`
 * rather than accumulated, so the mapping between clocks and samples is exact
 * for the whole render however awkward the ratio is.
 */
class BoxSink implements SampleSink {
  private pos = 0;
  private index = 0;
  private start = 0;
  private next: number;
  private accLeft = 0;
  private accRight = 0;
  private written = 0;

  constructor(
    private readonly clockHz: number,
    private readonly sampleRate: number,
    private readonly left: Float32Array,
    private readonly right: Float32Array,
  ) {
    this.next = this.boundary(1);
  }

  private boundary(index: number): number {
    return Math.floor((index * this.clockHz) / this.sampleRate);
  }

  clocksUntilSampleBoundary(): number {
    const remaining = this.next - this.pos;
    return remaining > 0 ? remaining : 1;
  }

  add(left: number, right: number, clocks: number): void {
    this.accLeft += left * clocks;
    this.accRight += right * clocks;
    this.pos += clocks;
    while (this.pos >= this.next && this.written < this.left.length) {
      const width = this.next - this.start;
      if (width > 0) {
        this.left[this.written] = this.accLeft / width;
        this.right[this.written] = this.accRight / width;
        this.accLeft = 0;
        this.accRight = 0;
      } else {
        // The chip is slower than the output rate, so this sample's box falls
        // entirely inside one clock — and the mean of a constant is that
        // constant. This is not a fallback for a degenerate case: it is what
        // box integration *means* when the box is narrower than a clock, and
        // the only model here it happens for is `GbaPcm`, whose 32768 Hz is
        // below the 48 kHz a render defaults to because it is a mixer rather
        // than an oscillator. Every other chip clocks in megahertz.
        //
        // The accumulator is deliberately **not** cleared. No clock elapsed in
        // this box, so whatever is in it belongs to a box still to come —
        // clearing it here is what turns the sample after a zero-width one into
        // silence, which is a far quieter failure than the `0 / 0` this
        // replaces and would have looked like a chip that stutters.
        this.left[this.written] = left;
        this.right[this.written] = right;
      }
      this.written += 1;
      this.start = this.next;
      this.index += 1;
      this.next = this.boundary(this.index + 1);
    }
  }

  /** Samples produced so far. */
  get length(): number {
    return this.written;
  }
}

/**
 * A first-order DC blocker: `y[n] = a × (y[n-1] + x[n] − x[n-1])`.
 *
 * Multiplies and adds only, so it is bit-identical on every engine (doc 02
 * §Floating-point discipline) — which is exactly why the coefficient is computed
 * from a literal rather than through `Math.exp`.
 *
 * A class rather than a loop because a *live* stream needs the same recurrence
 * carried across calls (`stream.ts`): the offline render can start it at zero
 * once, an emulator handing over a frame at a time cannot, and two
 * implementations of one filter is two things to keep in step.
 */
export class DcBlocker {
  private prevIn = 0;
  private prevOut = 0;

  constructor(private readonly a: number) {}

  static forRate(sampleRate: number, cutoffHz = DC_CUTOFF_HZ): DcBlocker {
    return new DcBlocker(1 - (TWO_PI * cutoffHz) / sampleRate);
  }

  step(x: number): number {
    const y = this.a * (this.prevOut + x - this.prevIn);
    this.prevIn = x;
    this.prevOut = y;
    return y;
  }
}

/** Remove DC from a finished render, in place. */
export function blockDc(samples: Float32Array, sampleRate: number, cutoffHz = DC_CUTOFF_HZ): void {
  const filter = DcBlocker.forRate(sampleRate, cutoffHz);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = filter.step(samples[i] as number);
  }
}

/** Exact clock count for driver tick `index` of a schedule at `rate` ticks/s. */
function tickBoundary(index: number, clockHz: number, rate: Rational): number {
  return Math.floor((index * clockHz * rate.den) / rate.num);
}

/**
 * Render a register schedule through a chip model.
 *
 * The schedule's writes land at the start of their tick and time advances by
 * exactly the clocks that tick owns, so what the model receives is what a driver
 * would deliver on hardware — the property doc 16 §Claim 1 turns into a test.
 */
export function renderSchedule(
  chip: ChipModel,
  schedule: readonly ScheduleTick[],
  rate: Rational,
  options: RenderOptions = {},
): Pcm {
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const tailSeconds = options.tailSeconds ?? 0;
  const tickClocks = tickBoundary(schedule.length, chip.clockHz, rate);
  const tailClocks = Math.round(tailSeconds * chip.clockHz);
  const totalClocks = tickClocks + tailClocks;
  const sampleCount = Math.floor((totalClocks * sampleRate) / chip.clockHz);

  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  const sink = new BoxSink(chip.clockHz, sampleRate, left, right);

  let consumed = 0;
  for (let i = 0; i < schedule.length; i += 1) {
    for (const write of schedule[i]!.writes) chip.write(write.reg, write.value);
    const until = tickBoundary(i + 1, chip.clockHz, rate);
    const span = until - consumed;
    if (span > 0) chip.run(span, sink);
    consumed = until;
  }
  if (tailClocks > 0) chip.run(tailClocks, sink);

  blockDc(left, sampleRate);
  if (chip.outputChannels === 2) blockDc(right, sampleRate);
  else right.set(left);

  return { sampleRate, channels: [left, right] };
}

/** Sum several chips' renders into one buffer (the Mega Drive's two, say). */
export function mix(parts: readonly Pcm[], gains?: readonly number[]): Pcm {
  if (parts.length === 0) throw new Error("mix: nothing to mix");
  const sampleRate = parts[0]!.sampleRate;
  let length = 0;
  for (const part of parts) {
    if (part.sampleRate !== sampleRate) {
      throw new Error("mix: every part must share one sample rate");
    }
    length = Math.max(length, part.channels[0]!.length);
  }
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const gain = gains?.[index] ?? 1;
    const l = part.channels[0]!;
    const r = part.channels[1] ?? l;
    for (let i = 0; i < l.length; i += 1) left[i] = left[i]! + l[i]! * gain;
    for (let i = 0; i < r.length; i += 1) right[i] = right[i]! + r[i]! * gain;
  }
  return { sampleRate, channels: [left, right] };
}

/**
 * Scale a render so its loudest sample sits at `peak`.
 *
 * Deliberately *not* applied by default: a normalized render is no longer the
 * hardware's own level, and a bank of sound effects has to keep its relative
 * levels to sit properly against music (doc 18 §Living with music).
 */
export function normalize(pcm: Pcm, peak = 0.98): Pcm {
  let max = 0;
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = channel[i]! < 0 ? -channel[i]! : channel[i]!;
      if (value > max) max = value;
    }
  }
  if (max === 0) return pcm;
  const gain = peak / max;
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i += 1) channel[i] = channel[i]! * gain;
  }
  return pcm;
}
