import { describe, expect, it } from "vitest";

import {
  ARAM_SIZE,
  SDSP_SAMPLE_CLOCKS,
  SDSP_SAMPLE_RATE,
  SDsp,
  encodeBrrBlock,
  type SampleSink,
} from "../src/index.js";

/** A sink that just collects, with a boundary far enough away to never bind. */
class Collect implements SampleSink {
  readonly left: number[] = [];
  readonly right: number[] = [];
  clocksUntilSampleBoundary(): number {
    return SDSP_SAMPLE_CLOCKS;
  }
  add(left: number, right: number, clocks: number): void {
    this.left.push(left);
    this.right.push(right);
    void clocks;
  }
}

/** A square wave one BRR block long, looping to itself: the driver's `pulse`. */
function squareRam(at = 0x0200, dir = 0x0100): Uint8Array {
  const ram = new Uint8Array(ARAM_SIZE);
  const samples: number[] = [];
  for (let i = 0; i < 16; i += 1) samples.push(i < 8 ? 0x3000 : -0x3000);
  ram.set(encodeBrrBlock(samples, { loop: true, end: true }), at);
  // Directory entry 0: start address, then loop address.
  ram[dir] = at & 0xff;
  ram[dir + 1] = at >> 8;
  ram[dir + 2] = at & 0xff;
  ram[dir + 3] = at >> 8;
  return ram;
}

function run(dsp: SDsp, samples: number): Collect {
  const sink = new Collect();
  dsp.run(samples * SDSP_SAMPLE_CLOCKS, sink);
  return sink;
}

/** Bring a voice up playing sample 0 at full volume, on direct gain. */
function keyOn(dsp: SDsp, voice: number, pitch: number, gain = 0x7f): void {
  const base = voice << 4;
  dsp.write(0x5d, 0x01); // DIR = $0100
  dsp.write(0x0c, 0x7f); // MVOL left
  dsp.write(0x1c, 0x7f); // MVOL right
  dsp.write(0x6c, 0x00); // FLG: unmute, no reset
  dsp.write(base + 0x00, 0x7f);
  dsp.write(base + 0x01, 0x7f);
  dsp.write(base + 0x02, pitch & 0xff);
  dsp.write(base + 0x03, (pitch >> 8) & 0x3f);
  dsp.write(base + 0x04, 0x00); // SRCN
  dsp.write(base + 0x05, 0x00); // ADSR off: the driver shapes the note itself
  dsp.write(base + 0x07, gain);
  dsp.write(0x4c, 1 << voice);
}

describe("SDsp", () => {
  it("comes up muted and silent", () => {
    const dsp = new SDsp();
    const sink = run(dsp, 8);
    expect(sink.left.every((value) => value === 0)).toBe(true);
    expect(dsp.read(0x6c) & 0x80).toBe(0x80);
  });

  it("plays a looping BRR block at the pitch the register asks for", () => {
    const dsp = new SDsp({ ram: squareRam() });
    // PITCH $1000 is one waveform sample per output sample: a sixteen-sample
    // cycle then sounds at 32000/16 = 2000 Hz.
    keyOn(dsp, 0, 0x1000);
    const sink = run(dsp, 64);
    let edges = 0;
    for (let i = 1; i < sink.left.length; i += 1) {
      if (Math.sign(sink.left[i]!) !== Math.sign(sink.left[i - 1]!)) edges += 1;
    }
    // 64 samples is four cycles of a 16-sample wave: two edges each.
    expect(edges).toBe(8);
    expect(Math.max(...sink.left)).toBeGreaterThan(0.2);
  });

  it("halves the frequency when the pitch register halves", () => {
    function edgesAt(pitch: number): number {
      const dsp = new SDsp({ ram: squareRam() });
      keyOn(dsp, 0, pitch);
      const sink = run(dsp, 128);
      // Zeroes are skipped rather than counted: below one waveform sample per
      // output sample the interpolator walks through zero on the way across, so
      // counting sign changes would report each edge twice.
      let edges = 0;
      let sign = 0;
      for (const value of sink.left) {
        const now = Math.sign(value);
        if (now === 0) continue;
        if (sign !== 0 && now !== sign) edges += 1;
        sign = now;
      }
      return edges;
    }
    // 128 output samples is eight cycles of a sixteen-sample wave at $1000 and
    // four at $0800 — two edges each, less the one sample the run opens on,
    // which carries the level the chip was already holding.
    expect(edgesAt(0x1000)).toBe(15);
    expect(edgesAt(0x0800)).toBe(7);
  });

  it("puts the pitch reference where the lattice says it is", () => {
    // The spec's multiplier lattice is `f = 32000 × PITCH / (16 × 4096)`, and
    // 32000 is the DSP's sample rate. If these ever disagree, every note on the
    // console is transposed.
    expect(SDSP_SAMPLE_RATE).toBe(32000);
    expect((SDSP_SAMPLE_RATE * 0x1000) / (16 * 4096)).toBe(2000);
  });

  it("pans with the per-voice volume registers", () => {
    const dsp = new SDsp({ ram: squareRam() });
    keyOn(dsp, 0, 0x1000);
    dsp.write(0x01, 0x00); // right volume off
    const sink = run(dsp, 32);
    expect(Math.max(...sink.left.map(Math.abs))).toBeGreaterThan(0.1);
    expect(Math.max(...sink.right.map(Math.abs))).toBe(0);
  });

  it("scales by direct gain and falls silent at zero", () => {
    function peak(gain: number): number {
      const dsp = new SDsp({ ram: squareRam() });
      keyOn(dsp, 0, 0x1000, gain);
      return Math.max(...run(dsp, 32).left.map(Math.abs));
    }
    const loud = peak(0x7f);
    const quiet = peak(0x40);
    expect(quiet).toBeLessThan(loud);
    expect(quiet).toBeGreaterThan(loud * 0.3);
    expect(peak(0x00)).toBe(0);
  });

  it("runs an ADSR attack and releases on key-off", () => {
    const dsp = new SDsp({ ram: squareRam() });
    keyOn(dsp, 0, 0x1000);
    // AR = 12 (rate 25), DR = 7, SL = 7 so the note holds at full.
    dsp.write(0x05, 0x80 | (0x07 << 4) | 0x0c);
    dsp.write(0x06, 0xe0);
    dsp.write(0x4c, 0x01);
    run(dsp, 400);
    const attacked = dsp.read(0x08);
    expect(attacked).toBeGreaterThan(0x60);
    dsp.write(0x5c, 0x01);
    run(dsp, 400);
    expect(dsp.read(0x08)).toBe(0);
  });

  it("sets ENDX when a voice reaches its end block, and clears it on write", () => {
    const dsp = new SDsp({ ram: squareRam() });
    keyOn(dsp, 0, 0x1000);
    run(dsp, 32);
    expect(dsp.read(0x7c) & 0x01).toBe(0x01);
    dsp.write(0x7c, 0xff);
    expect(dsp.read(0x7c) & 0x01).toBe(0);
  });

  it("stops a voice whose block ends without looping", () => {
    const ram = new Uint8Array(ARAM_SIZE);
    const samples = Array.from({ length: 16 }, (_, i) => (i < 8 ? 0x3000 : -0x3000));
    ram.set(encodeBrrBlock(samples, { loop: false, end: true }), 0x0200);
    ram[0x0100] = 0x00;
    ram[0x0101] = 0x02;
    ram[0x0102] = 0x00;
    ram[0x0103] = 0x02;
    const dsp = new SDsp({ ram });
    keyOn(dsp, 0, 0x1000);
    const sink = run(dsp, 96);
    // It sounds for its one block and then nothing: a one-shot falls silent
    // instead of ringing, which is what the driver's effects rely on.
    expect(Math.max(...sink.left.slice(0, 16).map(Math.abs))).toBeGreaterThan(0.1);
    expect(Math.max(...sink.left.slice(48).map(Math.abs))).toBe(0);
  });

  it("plays noise on a voice NON selects, at the rate FLG sets", () => {
    const dsp = new SDsp({ ram: squareRam() });
    keyOn(dsp, 0, 0x1000);
    dsp.write(0x3d, 0x01); // NON: voice 0 is noise
    dsp.write(0x6c, 0x1a); // a fast noise clock
    const sink = run(dsp, 256);
    const distinct = new Set(sink.left.map((value) => Math.round(value * 1000)));
    // A square wave gives two levels; noise gives many.
    expect(distinct.size).toBeGreaterThan(8);
  });

  it("silences everything when FLG asks for a reset or a mute", () => {
    const dsp = new SDsp({ ram: squareRam() });
    keyOn(dsp, 0, 0x1000);
    run(dsp, 8);
    dsp.write(0x6c, 0x40); // mute
    // From the *next* sample: a level the chip is already holding runs to the
    // end of its 768 clocks, which is what box integration means and what a
    // write landing mid-sample does on the hardware.
    expect(Math.max(...run(dsp, 16).left.slice(1).map(Math.abs))).toBe(0);
    dsp.write(0x6c, 0x00);
    dsp.write(0x4c, 0x01);
    run(dsp, 4);
    dsp.write(0x6c, 0x80); // reset
    expect(Math.max(...run(dsp, 16).left.slice(1).map(Math.abs))).toBe(0);
  });

  it("encodes a BRR block that decodes back to roughly what went in", () => {
    const samples = Array.from({ length: 16 }, (_, i) => Math.round(3000 * (i - 8)));
    const block = encodeBrrBlock(samples, { loop: true, end: true });
    expect(block).toHaveLength(9);
    expect(block[0]! & 0x03).toBe(0x03);
    const ram = new Uint8Array(ARAM_SIZE);
    ram.set(block, 0x0200);
    ram[0x0100] = 0x00;
    ram[0x0101] = 0x02;
    ram[0x0102] = 0x00;
    ram[0x0103] = 0x02;
    const dsp = new SDsp({ ram });
    keyOn(dsp, 0, 0x1000);
    const sink = run(dsp, 16);
    // A rising ramp comes back rising; quantisation moves levels, not order.
    expect(sink.left[12]!).toBeGreaterThan(sink.left[4]!);
  });
});
