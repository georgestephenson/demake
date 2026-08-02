/**
 * The Nintendo DS's sound hardware, checked against what GBATEK says it does.
 *
 * Three kinds of channel on one chip, and each is a different reading of the same
 * timer — so most of what can go wrong here is a period meaning the wrong thing.
 * The cases below measure the *output* rather than reading state back: a duty
 * channel's period is checked by counting edges, a sample channel's by counting
 * how often its waveform comes round, and the noise channel's by seeing that it
 * is neither of those.
 */

import { describe, expect, it } from "vitest";

import {
  NdsSpu,
  NDS_CH,
  NDS_CHANNEL_STRIDE,
  NDS_FIRST_NOISE_CHANNEL,
  NDS_FIRST_PSG_CHANNEL,
  NDS_MASTER_ENABLE,
  NDS_MASTER_VOLUME,
  NDS_RAM_BASE,
  NDS_SPU_CLOCK_HZ,
  type SampleSink,
} from "../src/index.js";

/** A sink with a boundary far enough away that a model never has to split. */
class Collect implements SampleSink {
  readonly left: number[] = [];
  readonly right: number[] = [];
  clocksUntilSampleBoundary(): number {
    return 1 << 20;
  }
  add(left: number, right: number, clocks: number): void {
    this.left.push(left);
    this.right.push(right);
    void clocks;
  }
}

/** Where the waveform bank sits in the test's own memory. */
const BANK_AT = 0x0237f000;

/** A square wave of `samples` bytes, at {@link BANK_AT}. */
function squareRam(samples = 32): { ram: Uint8Array; base: number } {
  const ram = new Uint8Array(samples);
  for (let i = 0; i < samples; i += 1) ram[i] = i < samples / 2 ? 0x20 : 0xe0;
  return { ram, base: BANK_AT };
}

/** Set a channel up and start it; `control` carries the format and the start. */
function play(
  spu: NdsSpu,
  channel: number,
  options: { period: number; control: number; volume?: number; pan?: number; words?: number },
): void {
  const base = channel * NDS_CHANNEL_STRIDE;
  const timer = (0x10000 - options.period) & 0xffff;
  spu.write(base + NDS_CH.volume, options.volume ?? 0x7f);
  spu.write(base + NDS_CH.panning, options.pan ?? 64);
  spu.write(base + NDS_CH.timer, timer & 0xff);
  spu.write(base + NDS_CH.timer + 1, timer >> 8);
  spu.write(base + NDS_CH.source, BANK_AT & 0xff);
  spu.write(base + NDS_CH.source + 1, (BANK_AT >> 8) & 0xff);
  spu.write(base + NDS_CH.source + 2, (BANK_AT >> 16) & 0xff);
  spu.write(base + NDS_CH.source + 3, (BANK_AT >> 24) & 0xff);
  spu.write(base + NDS_CH.length, options.words ?? 8);
  spu.write(base + NDS_CH.control, options.control);
}

/** A chip that is powered up and pointed at the square-wave bank. */
function chip(): NdsSpu {
  const { ram, base } = squareRam();
  const spu = new NdsSpu({ ram, ramBase: base });
  spu.write(NDS_MASTER_VOLUME, 0x7f);
  spu.write(NDS_MASTER_ENABLE, 0x80);
  return spu;
}

/** How many times the left output changes sign over a run of clocks. */
function edges(spu: NdsSpu, clocks: number): number {
  const sink = new Collect();
  spu.run(clocks, sink);
  let count = 0;
  let last = 0;
  for (const value of sink.left) {
    const sign = value > 0 ? 1 : value < 0 ? -1 : 0;
    if (sign !== 0 && last !== 0 && sign !== last) count += 1;
    if (sign !== 0) last = sign;
  }
  return count;
}

describe("a duty channel", () => {
  it("produces one cycle every eight timer periods", () => {
    const spu = chip();
    // 1000 Hz wants a period of clock / (8 × 1000).
    const period = Math.round(NDS_SPU_CLOCK_HZ / (8 * 1000));
    play(spu, NDS_FIRST_PSG_CHANNEL, { period, control: 0x03 | (1 << 3) | (3 << 5) | 0x80 });
    // Two edges a cycle, so a tenth of a second at 1 kHz is about 200.
    const count = edges(spu, NDS_SPU_CLOCK_HZ / 10);
    expect(count).toBeGreaterThan(190);
    expect(count).toBeLessThan(210);
  });

  it("holds a level and never moves at the duty the hardware calls 0%", () => {
    const spu = chip();
    const period = Math.round(NDS_SPU_CLOCK_HZ / (8 * 1000));
    play(spu, NDS_FIRST_PSG_CHANNEL, { period, control: 0x07 | (1 << 3) | (3 << 5) | 0x80 });
    expect(edges(spu, NDS_SPU_CLOCK_HZ / 10)).toBe(0);
  });
});

describe("a sample channel", () => {
  it("plays one waveform cycle every thirty-two timer periods", () => {
    const spu = chip();
    // The same 1 kHz, which on a thirty-two-sample cycle is a longer period than
    // a duty channel's by exactly the ratio of the two lattices' steps.
    const period = Math.round(NDS_SPU_CLOCK_HZ / (32 * 1000));
    play(spu, 0, { period, control: (1 << 3) | (0 << 5) | 0x80 });
    const count = edges(spu, NDS_SPU_CLOCK_HZ / 10);
    expect(count).toBeGreaterThan(190);
    expect(count).toBeLessThan(210);
  });

  it("is silent when its source points at memory the model was not given", () => {
    const { ram, base } = squareRam();
    const spu = new NdsSpu({ ram, ramBase: base });
    spu.write(NDS_MASTER_VOLUME, 0x7f);
    spu.write(NDS_MASTER_ENABLE, 0x80);
    const wrong = 0x02000000;
    const channelBase = NDS_CH.source;
    play(spu, 0, { period: 500, control: (1 << 3) | 0x80 });
    spu.write(channelBase, wrong & 0xff);
    spu.write(channelBase + 1, (wrong >> 8) & 0xff);
    spu.write(channelBase + 2, (wrong >> 16) & 0xff);
    spu.write(channelBase + 3, (wrong >> 24) & 0xff);
    // Restarted, so the wrong address is the one the channel reads from.
    spu.write(NDS_CH.control, 0);
    spu.write(NDS_CH.control, (1 << 3) | 0x80);
    const sink = new Collect();
    spu.run(NDS_SPU_CLOCK_HZ / 100, sink);
    expect(sink.left.every((value) => value === 0)).toBe(true);
  });

  it("stops itself at the end when the repeat mode is a one-shot", () => {
    const spu = chip();
    play(spu, 0, { period: 64, control: (2 << 3) | 0x80 });
    const sink = new Collect();
    // Thirty-two samples of sixty-four clocks each, and then some.
    spu.run(64 * 64, sink);
    expect(spu.read(NDS_CH.control) & 0x80).toBe(0);
  });
});

describe("the noise channel", () => {
  it("shifts once a period where a duty channel takes eight", () => {
    const period = Math.round(NDS_SPU_CLOCK_HZ / (8 * 1000));
    const noise = chip();
    play(noise, NDS_FIRST_NOISE_CHANNEL, { period, control: (1 << 3) | (3 << 5) | 0x80 });
    const square = chip();
    play(square, NDS_FIRST_PSG_CHANNEL, { period, control: 0x03 | (1 << 3) | (3 << 5) | 0x80 });
    // A duty channel gives two edges every eight steps; a shift register gives
    // one wherever its output bit changed, which over any real stretch is a good
    // fraction of the steps themselves. Comparing the two rather than asserting a
    // count is what makes this a statement about the *rate* rather than about
    // this particular sequence.
    const clocks = NDS_SPU_CLOCK_HZ / 10;
    expect(edges(noise, clocks)).toBeGreaterThan(edges(square, clocks) * 1.4);
  });
});

describe("the mixer", () => {
  it("puts a hard-left channel on one side only", () => {
    const spu = chip();
    play(spu, NDS_FIRST_PSG_CHANNEL, {
      period: 200,
      control: 0x03 | (1 << 3) | (3 << 5) | 0x80,
      pan: 0,
    });
    const sink = new Collect();
    spu.run(NDS_SPU_CLOCK_HZ / 100, sink);
    expect(sink.left.some((value) => value !== 0)).toBe(true);
    expect(sink.right.every((value) => value === 0)).toBe(true);
  });

  it("is silent with the master enable clear, whatever the channels are doing", () => {
    const spu = chip();
    play(spu, NDS_FIRST_PSG_CHANNEL, { period: 200, control: 0x03 | (1 << 3) | (3 << 5) | 0x80 });
    spu.write(NDS_MASTER_ENABLE, 0);
    const sink = new Collect();
    spu.run(NDS_SPU_CLOCK_HZ / 100, sink);
    expect(sink.left.every((value) => value === 0)).toBe(true);
  });

  it("scales a channel by the master volume", () => {
    const loud = chip();
    play(loud, NDS_FIRST_PSG_CHANNEL, { period: 200, control: 0x03 | (1 << 3) | (3 << 5) | 0x80 });
    const quiet = chip();
    quiet.write(NDS_MASTER_VOLUME, 0x3f);
    play(quiet, NDS_FIRST_PSG_CHANNEL, { period: 200, control: 0x03 | (1 << 3) | (3 << 5) | 0x80 });
    const peak = (spu: NdsSpu): number => {
      const sink = new Collect();
      spu.run(NDS_SPU_CLOCK_HZ / 100, sink);
      return Math.max(...sink.left.map((value) => Math.abs(value)));
    };
    const full = peak(loud);
    const half = peak(quiet);
    expect(half).toBeGreaterThan(0);
    expect(half / full).toBeGreaterThan(0.45);
    expect(half / full).toBeLessThan(0.55);
  });
});

describe("the address a channel reads from", () => {
  it("is absolute, so the model has to be told where its memory begins", () => {
    // The same bytes at a different base is a different source address, and a
    // model that ignored the base would play them anyway — which is exactly the
    // bug a `SAD` written by the binding and a bank laid down by the driver could
    // hide between them.
    const { ram } = squareRam();
    const spu = new NdsSpu({ ram, ramBase: NDS_RAM_BASE });
    spu.write(NDS_MASTER_VOLUME, 0x7f);
    spu.write(NDS_MASTER_ENABLE, 0x80);
    play(spu, 0, { period: 500, control: (1 << 3) | 0x80 });
    const sink = new Collect();
    spu.run(NDS_SPU_CLOCK_HZ / 100, sink);
    expect(sink.left.every((value) => value === 0)).toBe(true);
  });
});
