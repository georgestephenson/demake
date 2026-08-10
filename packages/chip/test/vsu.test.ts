/**
 * The Virtual Boy's VSU.
 *
 * What gets the attention is what a register diff one layer up cannot see —
 * the same argument `ws-sound.test.ts` runs under, and here it covers four
 * things this chip has that no other wavetable part in the matrix does:
 *
 *   - **The waveform tables are a shared pool**, so two channels naming the same
 *     table have to play the same shape, and moving the table has to move both.
 *     A model that gave each channel its own would pass every note test there is.
 *   - **A sample is six bits at a four-byte stride**, which is two facts a
 *     schedule cannot express: a write to an address that is not a multiple of
 *     four reaches nothing, and the top two bits of a byte are not part of the
 *     sample.
 *   - **The envelope is hardware**, so a level falls with no further writes —
 *     which is the whole reason this console's drums cost a driver one write
 *     rather than one a tick.
 *   - **Nothing is shared.** Enabling, panning and level are all in the
 *     channel's own registers, which is what lets a driver for this chip emit no
 *     merge routine at all — so a write to one channel must not move another.
 */

import { describe, expect, it } from "vitest";

import {
  Vsu,
  VSU_CHANNELS,
  VSU_CLOCK_HZ,
  VSU_NOISE_CHANNEL,
  VSU_REG,
  VSU_SSTOP,
  VSU_WAVE_SAMPLES,
  VSU_WAVE_TABLES,
} from "../src/vsu.js";
import type { SampleSink } from "../src/types.js";

/** A sink that just accumulates, so a test can ask what came out. */
class Probe implements SampleSink {
  left: number[] = [];
  right: number[] = [];
  /** The levels themselves, which is what "did it move" is a question about. */
  levels: number[] = [];
  constructor(private readonly window = 100) {}
  clocksUntilSampleBoundary(): number {
    return this.window;
  }
  add(left: number, right: number, clocks: number): void {
    this.left.push(left * clocks);
    this.right.push(right * clocks);
    this.levels.push(left);
  }
  peakLeft(): number {
    return this.left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  }
  peakRight(): number {
    return this.right.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  }
}

/** Fill a table with a square, through the register port the hardware has. */
function loadSquare(vsu: Vsu, table: number): void {
  for (let index = 0; index < VSU_WAVE_SAMPLES; index += 1) {
    vsu.write(Vsu.waveBase(table) + index * 4, index < 16 ? 63 : 0);
  }
}

/** Start a channel: a table, a pitch, a level, a pan and the enable. */
function play(vsu: Vsu, channel: number, table: number, level = 15): void {
  const base = Vsu.channelBase(channel);
  vsu.write(base + VSU_REG.RAM, table);
  vsu.write(base + VSU_REG.FQL, 0x00);
  vsu.write(base + VSU_REG.FQH, 0x00);
  vsu.write(base + VSU_REG.LRV, 0xff);
  vsu.write(base + VSU_REG.EV0, (level << 4) & 0xf0);
  vsu.write(base + VSU_REG.EV1, 0x00);
  vsu.write(base + VSU_REG.INT, 0x80);
}

describe("the Virtual Boy's VSU", () => {
  it("runs at the console's clock over four", () => {
    expect(VSU_CLOCK_HZ).toBe(5_000_000);
    expect(VSU_CHANNELS).toBe(6);
    expect(VSU_WAVE_TABLES).toBe(5);
  });

  it("plays a waveform table, and silence before one is loaded", () => {
    const vsu = new Vsu();
    const quiet = new Probe();
    play(vsu, 0, 0);
    vsu.run(20_000, quiet);
    // An empty table is thirty-two zeroes, which is *not* silence on this chip:
    // a sample is unsigned and the model centres it, so a flat zero is a
    // constant offset rather than nothing. What matters is that it does not
    // move, which is what makes a loaded table's motion meaningful.
    // The *level* rather than the area, because a sink chops a constant into
    // spans of different lengths and `level × clocks` moves when the level does
    // not.
    expect(new Set(quiet.levels.map((value) => value.toFixed(9))).size).toBe(1);

    loadSquare(vsu, 0);
    const loud = new Probe();
    vsu.run(20_000, loud);
    expect(new Set(loud.levels.map((value) => value.toFixed(9))).size).toBeGreaterThan(1);
  });

  it("shares one table between two channels", () => {
    // The pool is the thing: a model that gave each channel its own table would
    // pass every note test there is and be wrong about the one property that
    // makes five tables enough for six voices.
    const vsu = new Vsu();
    loadSquare(vsu, 3);
    const probe = new Probe();
    play(vsu, 0, 3);
    play(vsu, 1, 3);
    vsu.run(20_000, probe);
    const both = probe.peakLeft();

    const single = new Vsu();
    loadSquare(single, 3);
    const one = new Probe();
    play(single, 0, 3);
    single.run(20_000, one);
    // Two voices on one table are twice one voice on it, which is only true if
    // they are reading the same thirty-two bytes.
    expect(both).toBeGreaterThan(one.peakLeft() * 1.5);
  });

  it("takes six bits at a four-byte stride, and nothing between", () => {
    const vsu = new Vsu();
    // The top two bits are not part of the sample.
    vsu.write(Vsu.waveBase(0) + 0, 0xff);
    expect(vsu.waves[0]![0]).toBe(0x3f);
    // And an address that is not a multiple of four reaches nothing at all.
    vsu.write(Vsu.waveBase(0) + 1, 0x3f);
    vsu.write(Vsu.waveBase(0) + 2, 0x3f);
    vsu.write(Vsu.waveBase(0) + 3, 0x3f);
    expect(vsu.waves[0]![1]).toBe(0);
  });

  it("pans with the channel's own register and nothing shared", () => {
    const vsu = new Vsu();
    loadSquare(vsu, 0);
    play(vsu, 0, 0);
    vsu.write(Vsu.channelBase(0) + VSU_REG.LRV, 0xf0); // left only
    const probe = new Probe();
    vsu.run(20_000, probe);
    expect(probe.peakLeft()).toBeGreaterThan(0);
    expect(probe.peakRight()).toBe(0);
  });

  it("leaves every other channel alone when one is written", () => {
    // The property a driver for this chip rests on: there is no shared enable
    // and no shared mixer, so this console emits no merge routine at all.
    const vsu = new Vsu();
    loadSquare(vsu, 0);
    play(vsu, 0, 0);
    play(vsu, 2, 0);
    const before = new Probe();
    vsu.run(20_000, before);
    // Silence channel zero the way the binding does — its level, then its enable.
    vsu.write(Vsu.channelBase(0) + VSU_REG.EV0, 0x00);
    vsu.write(Vsu.channelBase(0) + VSU_REG.INT, 0x00);
    const after = new Probe();
    vsu.run(20_000, after);
    expect(after.peakLeft()).toBeGreaterThan(0);
    expect(after.peakLeft()).toBeLessThan(before.peakLeft());
  });

  it("decays in hardware, with no further writes", () => {
    const vsu = new Vsu();
    loadSquare(vsu, 0);
    const base = Vsu.channelBase(0);
    play(vsu, 0, 0);
    // Full level, stepping down at the fastest interval, envelope enabled.
    vsu.write(base + VSU_REG.EV0, 0xf0);
    vsu.write(base + VSU_REG.EV1, 0x01);
    const early = new Probe();
    vsu.run(60_000, early);
    const late = new Probe();
    // Fifteen steps of 19200 clocks empties it, and nothing was written between.
    vsu.run(15 * 19_200, late);
    const tail = new Probe();
    vsu.run(60_000, tail);
    expect(early.peakLeft()).toBeGreaterThan(0);
    expect(tail.peakLeft()).toBe(0);
  });

  it("stops every channel when SSTOP is written", () => {
    const vsu = new Vsu();
    loadSquare(vsu, 0);
    for (let index = 0; index < 4; index += 1) play(vsu, index, 0);
    vsu.write(VSU_SSTOP, 0x01);
    const probe = new Probe();
    vsu.run(20_000, probe);
    expect(probe.peakLeft()).toBe(0);
  });

  it("puts the shift register on the last channel and nowhere else", () => {
    const vsu = new Vsu();
    const probe = new Probe();
    const base = Vsu.channelBase(VSU_NOISE_CHANNEL);
    vsu.write(base + VSU_REG.FQL, 0x00);
    vsu.write(base + VSU_REG.FQH, 0x00);
    vsu.write(base + VSU_REG.LRV, 0xff);
    vsu.write(base + VSU_REG.EV0, 0xf0);
    vsu.write(base + VSU_REG.EV1, 0x00);
    vsu.write(base + VSU_REG.INT, 0x80);
    vsu.run(200_000, probe);
    // A shift register with no waveform behind it still makes a signal, and it
    // is not periodic at the channel's own rate.
    expect(new Set(probe.levels.map((value) => value.toFixed(9))).size).toBeGreaterThan(1);
  });

  it("turns a channel off by itself when the interval says to", () => {
    const vsu = new Vsu();
    loadSquare(vsu, 0);
    play(vsu, 0, 0);
    // Auto-deactivate after one interval — a note that ends without a second
    // write, which is the other half of what makes this chip cheap to drive.
    vsu.write(Vsu.channelBase(0) + VSU_REG.INT, 0x80 | 0x20 | 0x00);
    const probe = new Probe();
    vsu.run(19_200 * 2, probe);
    const after = new Probe();
    vsu.run(20_000, after);
    expect(after.peakLeft()).toBe(0);
  });
});
