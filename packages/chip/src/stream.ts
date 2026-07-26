/**
 * Listening to a chip *while it runs* (doc 16 §Claim 3).
 *
 * `renderSchedule` answers "what does this schedule sound like", knows how long
 * the answer is, and allocates it once. An emulator asks the other question —
 * "what has the chip emitted since I last looked" — and never knows how much
 * more is coming. Same integration, same DC blocker, different bookkeeping: this
 * is a {@link SampleSink} that keeps what it produces in a ring buffer until
 * someone drains it.
 *
 * It is here rather than in the web app for the reason everything else about
 * sound is here: **the page must play what the chip emits and never compute a
 * sample of its own** (doc 07). Web Audio is a playback device — a buffer goes
 * in, sound comes out — and the arithmetic that decided what is in the buffer is
 * this file, shared with the renderer that writes WAVs.
 *
 * Two properties are worth stating because a live stream is where they are easy
 * to lose:
 *
 *   - **Sample boundaries stay exact.** They are computed from an absolute
 *     sample index against the chip's own clock, never accumulated, so a stream
 *     left running for hours has the same clocks-per-sample mapping it started
 *     with — the property doc 16 relies on for the offline render, restated for
 *     one with no end.
 *   - **The DC blocker carries across calls.** It is a recurrence, so resetting
 *     it every time the emulator handed over another frame's worth of clocks
 *     would put a step at every frame boundary — sixty clicks a second.
 */

import { DcBlocker } from "./mix.js";
import type { SampleSink } from "./types.js";

/** How much audio a stream holds before the oldest of it is dropped. */
const DEFAULT_CAPACITY_SECONDS = 1;

export interface StreamOptions {
  /** Delivery rate; 48 kHz unless a caller has a reason (doc 16 §Claim 3). */
  sampleRate?: number;
  /** Seconds of audio the ring buffer holds. */
  capacitySeconds?: number;
  /** DC-blocker corner, in Hz. */
  cutoffHz?: number;
}

/**
 * A sink that box-integrates a running chip into a drainable ring buffer.
 *
 * Overrun is not silent: a caller that stops draining loses the *oldest* audio,
 * which is what keeps a resumed stream in the present rather than replaying
 * however long it was away, and {@link dropped} counts the samples it cost.
 */
export class StreamSink implements SampleSink {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly capacity: number;
  private readonly dcLeft: DcBlocker;
  private readonly dcRight: DcBlocker;

  /** Absolute clock position, and the boundary of the sample being filled. */
  private pos = 0;
  private index = 0;
  private start = 0;
  private next: number;
  private accLeft = 0;
  private accRight = 0;

  /** Ring cursors, in samples. */
  private head = 0;
  private count = 0;

  /** Samples the ring dropped because nobody drained it. */
  dropped = 0;

  readonly sampleRate: number;

  constructor(
    private readonly clockHz: number,
    options: StreamOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.capacity = Math.max(
      1,
      Math.round(this.sampleRate * (options.capacitySeconds ?? DEFAULT_CAPACITY_SECONDS)),
    );
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.dcLeft = DcBlocker.forRate(this.sampleRate, options.cutoffHz);
    this.dcRight = DcBlocker.forRate(this.sampleRate, options.cutoffHz);
    this.next = this.boundary(1);
  }

  /** Samples waiting to be read. */
  get available(): number {
    return this.count;
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
    while (this.pos >= this.next) {
      const width = this.next - this.start;
      this.push(this.accLeft / width, this.accRight / width);
      this.accLeft = 0;
      this.accRight = 0;
      this.start = this.next;
      this.index += 1;
      this.next = this.boundary(this.index + 1);
    }
  }

  /**
   * Store one sample, DC-blocked.
   *
   * The integrated value is rounded to single precision *before* it reaches the
   * filter, because that is what the offline renderer does — it fills a
   * `Float32Array` and then filters it in place, so the filter's input is
   * already rounded. Skipping the rounding here would make a live stream differ
   * from a rendered file in the last few bits, which is exactly the divergence
   * `stream.test.ts` exists to catch.
   */
  private push(left: number, right: number): void {
    const at = (this.head + this.count) % this.capacity;
    this.left[at] = this.dcLeft.step(Math.fround(left));
    this.right[at] = this.dcRight.step(Math.fround(right));
    if (this.count === this.capacity) {
      this.head = (this.head + 1) % this.capacity;
      this.dropped += 1;
    } else {
      this.count += 1;
    }
  }

  /**
   * Copy up to `count` samples into `left`/`right` and forget them.
   *
   * Returns how many were really available, which is what a player needs to
   * know: fewer than asked for means the chip has not been run far enough yet,
   * and it is the caller's business whether to run it or to fill with silence.
   */
  read(left: Float32Array, right: Float32Array, count: number): number {
    const taken = Math.min(count, this.count, left.length, right.length);
    for (let i = 0; i < taken; i += 1) {
      const at = (this.head + i) % this.capacity;
      left[i] = this.left[at] as number;
      right[i] = this.right[at] as number;
    }
    this.head = (this.head + taken) % this.capacity;
    this.count -= taken;
    return taken;
  }

  /** Throw away everything buffered, keeping the clock mapping and the filter. */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
