/**
 * The two direct-sound channels, as hardware rather than as a mixer.
 *
 * There are two objects with a claim to the name "the GBA's sample sound" and
 * they are not the same thing, so they are not the same file. `@demake/chip`'s
 * `GbaPcm` is the *mixer*: voices, pitches, levels, and the byte stream they
 * produce — the compliant artifact, and what a driver has to reproduce. This is
 * the *converter* that stream arrives at: a sixteen-byte queue per channel, one
 * byte leaving it per timer overflow, and a DMA request when it runs half empty.
 *
 * Keeping them apart is what makes the proof mean something. The mixer says what
 * the samples should be; this says nothing about them at all and only carries
 * them, so a comparison between the two is a comparison between a schedule and a
 * cartridge rather than between two copies of the same code.
 *
 * Sources: GBATEK — *Sound Channel A and B (DMA Sound)*
 * (https://problemkaputt.de/gbatek.htm).
 */

import type { SampleSink } from "@demake/chip";

/** Bytes each channel's queue holds. */
export const FIFO_SIZE = 32;

/** Bytes at or below which the queue asks its DMA channel to refill it. */
export const FIFO_REFILL_AT = 16;

/** One channel's queue and the level currently at its converter. */
interface Channel {
  bytes: Int8Array;
  head: number;
  count: number;
  /** The byte most recently clocked out, which the converter holds. */
  level: number;
}

/** A fresh channel. */
function channel(): Channel {
  return { bytes: new Int8Array(FIFO_SIZE), head: 0, count: 0, level: 0 };
}

/** The pair of eight-bit converters DMA feeds. */
export class DirectSound {
  private readonly channels: readonly Channel[] = [channel(), channel()];
  /**
   * How loud each channel is: half or full, from `SOUNDCNT_H`.
   *
   * Kept here rather than read back from the register on every sample, because
   * the machine owns the register and this owns what it means.
   */
  readonly volume = [1, 1];
  /** Whether each channel reaches the left and right outputs. */
  readonly enable = [
    [true, true],
    [true, true],
  ];

  /** Empty a channel's queue, which is what the reset bit in `SOUNDCNT_H` does. */
  resetFifo(index: number): void {
    const target = this.channels[index] as Channel;
    target.head = 0;
    target.count = 0;
    target.bytes.fill(0);
  }

  /** Queue one sample. A full queue drops it, exactly as the hardware does. */
  push(index: number, byte: number): void {
    const target = this.channels[index] as Channel;
    if (target.count >= FIFO_SIZE) return;
    target.bytes[(target.head + target.count) % FIFO_SIZE] = (byte << 24) >> 24;
    target.count += 1;
  }

  /**
   * A timer overflow: move `count` samples out of the queue and into the
   * converter.
   *
   * An empty queue holds its last level rather than going silent, which is what
   * the hardware does and why an under-fed channel buzzes at the tick rate
   * instead of clicking.
   */
  clock(index: number, count: number): void {
    const target = this.channels[index] as Channel;
    for (let step = 0; step < count; step += 1) {
      if (target.count === 0) break;
      target.level = target.bytes[target.head] as number;
      target.head = (target.head + 1) % FIFO_SIZE;
      target.count -= 1;
    }
  }

  /** Whether this channel's DMA should transfer another four words. */
  wantsRefill(index: number): boolean {
    return (this.channels[index] as Channel).count <= FIFO_REFILL_AT;
  }

  /** The level at each converter, as the mixer's own scale. */
  levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (let index = 0; index < 2; index += 1) {
      const target = this.channels[index] as Channel;
      const value = (target.level * (this.volume[index] as number)) / 256;
      if ((this.enable[index] as boolean[])[0] === true) left += value;
      if ((this.enable[index] as boolean[])[1] === true) right += value;
    }
    return [left, right];
  }

  /**
   * Hold the current levels for `clocks` system cycles.
   *
   * There is nothing to band-limit and no event to advance to: the converter's
   * output is a step that changes only when a timer overflows, which the machine
   * has already told it about. So the whole of running is reporting what is
   * there — which is exactly what box integration wants.
   */
  run(clocks: number, sink: SampleSink): void {
    const [left, right] = this.levels();
    let remaining = clocks;
    while (remaining > 0) {
      const step = Math.min(remaining, sink.clocksUntilSampleBoundary());
      sink.add(left, right, step);
      remaining -= step;
    }
  }
}
