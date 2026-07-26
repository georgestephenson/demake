/**
 * The NES 2A03 APU — `nes-apu`.
 *
 * Two pulses with duty and envelope, a triangle with **no volume control at
 * all**, an LFSR noise channel with sixteen fixed periods, and a DMC. The
 * triangle is the shape that drives NES arrangement: it is a bass voice that can
 * only be on or off, so dynamics have to come from somewhere else (doc 16 §The
 * chips).
 *
 * Registers are addressed as offsets from `$4000`, so `0x00`–`0x17`.
 *
 * The channels do **not** sum linearly: the hardware's two DAC ladders are
 * modelled with the documented non-linear mixer, which is why a loud pulse pair
 * squashes the triangle rather than adding to it.
 *
 * Sources:
 * - nesdev wiki — APU: https://www.nesdev.org/wiki/APU
 * - nesdev wiki — APU Mixer: https://www.nesdev.org/wiki/APU_Mixer
 * - nesdev wiki — APU Frame Counter: https://www.nesdev.org/wiki/APU_Frame_Counter
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/** NTSC CPU clock; every timer here is in these units. */
export const NES_CLOCK_HZ = 1789773;

/** Pulse duty sequences: 12.5%, 25%, 50%, 25% negated (nesdev §Pulse). */
const DUTY: readonly (readonly number[])[] = [
  [0, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 0, 0, 0],
  [1, 0, 0, 1, 1, 1, 1, 1],
];

/** The triangle's 32-step sequence: down 15→0 then back up. */
const TRIANGLE_SEQ: readonly number[] = [
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15,
];

/** Noise timer periods in CPU cycles (NTSC). */
const NOISE_PERIOD: readonly number[] = [
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
];

/** Length-counter reload values indexed by the 5-bit field (nesdev §Length). */
const LENGTH_TABLE: readonly number[] = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192,
  24, 72, 26, 16, 28, 32, 30,
];

/** Frame-counter step boundaries in CPU cycles, 4-step and 5-step modes. */
const FRAME_4: readonly number[] = [7457, 14913, 22371, 29829];
const FRAME_5: readonly number[] = [7457, 14913, 22371, 29829, 37281];

/** The shared envelope/volume unit of the pulse and noise channels. */
class Envelope {
  constantVolume = false;
  loop = false;
  volume = 0;
  private start = false;
  private divider = 0;
  private decay = 0;

  configure(value: number): void {
    this.loop = (value & 0x20) !== 0;
    this.constantVolume = (value & 0x10) !== 0;
    this.volume = value & 0x0f;
  }

  trigger(): void {
    this.start = true;
  }

  output(): number {
    return this.constantVolume ? this.volume : this.decay;
  }

  clock(): void {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
      return;
    }
    if (this.divider > 0) {
      this.divider -= 1;
      return;
    }
    this.divider = this.volume;
    if (this.decay > 0) this.decay -= 1;
    else if (this.loop) this.decay = 15;
  }
}

class PulseChannel {
  readonly envelope = new Envelope();
  enabled = false;
  duty = 0;
  step = 0;
  timer = 0;
  period = 0;
  lengthCounter = 0;

  sweepEnabled = false;
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  private sweepCounter = 0;
  private sweepReload = false;

  /** Pulse 1 negates with a one's-complement, pulse 2 with a two's — nesdev. */
  constructor(private readonly onesComplement: boolean) {}

  output(): number {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    if (this.period < 8 || this.targetPeriod() > 0x7ff) return 0;
    return DUTY[this.duty]![this.step] === 1 ? this.envelope.output() : 0;
  }

  reload(): number {
    return (this.period + 1) * 2;
  }

  advance(): void {
    this.timer = this.reload();
    this.step = (this.step + 1) & 7;
  }

  trigger(): void {
    this.step = 0;
    this.envelope.trigger();
  }

  writeSweep(value: number): void {
    this.sweepEnabled = (value & 0x80) !== 0;
    this.sweepPeriod = (value >> 4) & 0x07;
    this.sweepNegate = (value & 0x08) !== 0;
    this.sweepShift = value & 0x07;
    this.sweepReload = true;
  }

  private targetPeriod(): number {
    const delta = this.period >> this.sweepShift;
    if (!this.sweepNegate) return this.period + delta;
    return this.period - delta - (this.onesComplement ? 1 : 0);
  }

  clockSweep(): void {
    if (this.sweepCounter === 0 && this.sweepEnabled && this.sweepShift !== 0) {
      const target = this.targetPeriod();
      if (target <= 0x7ff && this.period >= 8) this.period = Math.max(target, 0);
    }
    if (this.sweepCounter === 0 || this.sweepReload) {
      this.sweepCounter = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepCounter -= 1;
    }
  }

  clockLength(): void {
    if (!this.envelope.loop && this.lengthCounter > 0) this.lengthCounter -= 1;
  }
}

class TriangleChannel {
  enabled = false;
  step = 0;
  timer = 0;
  period = 0;
  lengthCounter = 0;
  linearCounter = 0;
  linearReload = 0;
  control = false;
  private reloadFlag = false;

  /**
   * The triangle has no gate: silencing it freezes the sequencer where it
   * stands rather than dropping to zero, which is why a muted NES triangle
   * holds a DC level instead of clicking.
   */
  output(): number {
    return TRIANGLE_SEQ[this.step]!;
  }

  /** Whether the sequencer is actually advancing (both counters non-zero). */
  running(): boolean {
    return this.enabled && this.lengthCounter > 0 && this.linearCounter > 0 && this.period >= 2;
  }

  reload(): number {
    return this.period + 1;
  }

  advance(): void {
    this.timer = this.reload();
    if (this.running()) this.step = (this.step + 1) & 31;
  }

  trigger(): void {
    this.reloadFlag = true;
  }

  clockLinear(): void {
    if (this.reloadFlag) this.linearCounter = this.linearReload;
    else if (this.linearCounter > 0) this.linearCounter -= 1;
    if (!this.control) this.reloadFlag = false;
  }

  clockLength(): void {
    if (!this.control && this.lengthCounter > 0) this.lengthCounter -= 1;
  }
}

class NoiseChannel {
  readonly envelope = new Envelope();
  enabled = false;
  timer = 0;
  periodIndex = 0;
  shortMode = false;
  lfsr = 1;
  lengthCounter = 0;

  output(): number {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    return (this.lfsr & 1) === 0 ? this.envelope.output() : 0;
  }

  reload(): number {
    return NOISE_PERIOD[this.periodIndex]!;
  }

  advance(): void {
    this.timer = this.reload();
    const tap = this.shortMode ? (this.lfsr >> 6) & 1 : (this.lfsr >> 1) & 1;
    const feedback = (this.lfsr & 1) ^ tap;
    this.lfsr = (this.lfsr >> 1) | (feedback << 14);
  }

  clockLength(): void {
    if (!this.envelope.loop && this.lengthCounter > 0) this.lengthCounter -= 1;
  }
}

/** The NES APU as a register-driven model. */
export class NesApu implements ChipModel {
  readonly id: ChipId = "nes-apu";
  readonly clockHz = NES_CLOCK_HZ;
  readonly outputChannels = 1 as const;

  private readonly pulse1 = new PulseChannel(true);
  private readonly pulse2 = new PulseChannel(false);
  private readonly triangle = new TriangleChannel();
  private readonly noise = new NoiseChannel();
  /**
   * DMC output level ($4011).
   *
   * Sample playback needs a memory reader the chip does not have; until the
   * DPCM candidate lands (doc 17 §Stage 2), `@demake/audio` emits no
   * `$4010`–`$4013` writes at all rather than accepting them and playing
   * nothing — a backend gap is a build error, never a silent difference.
   */
  private dmcLevel = 0;

  private frameMode5 = false;
  private frameCycle = 0;
  private frameStep = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.pulse1.enabled = false;
    this.pulse2.enabled = false;
    this.triangle.enabled = false;
    this.noise.enabled = false;
    this.noise.lfsr = 1;
    this.dmcLevel = 0;
    this.frameMode5 = false;
    this.frameCycle = 0;
    this.frameStep = 0;
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    switch (reg) {
      case 0x00:
      case 0x04: {
        const ch = reg === 0x00 ? this.pulse1 : this.pulse2;
        ch.duty = v >> 6;
        ch.envelope.configure(v);
        break;
      }
      case 0x01:
      case 0x05:
        (reg === 0x01 ? this.pulse1 : this.pulse2).writeSweep(v);
        break;
      case 0x02:
      case 0x06: {
        const ch = reg === 0x02 ? this.pulse1 : this.pulse2;
        ch.period = (ch.period & 0x700) | v;
        break;
      }
      case 0x03:
      case 0x07: {
        const ch = reg === 0x03 ? this.pulse1 : this.pulse2;
        ch.period = (ch.period & 0xff) | ((v & 0x07) << 8);
        if (ch.enabled) ch.lengthCounter = LENGTH_TABLE[v >> 3]!;
        ch.trigger();
        break;
      }

      case 0x08:
        this.triangle.control = (v & 0x80) !== 0;
        this.triangle.linearReload = v & 0x7f;
        break;
      case 0x0a:
        this.triangle.period = (this.triangle.period & 0x700) | v;
        break;
      case 0x0b:
        this.triangle.period = (this.triangle.period & 0xff) | ((v & 0x07) << 8);
        if (this.triangle.enabled) this.triangle.lengthCounter = LENGTH_TABLE[v >> 3]!;
        this.triangle.trigger();
        break;

      case 0x0c:
        this.noise.envelope.configure(v);
        break;
      case 0x0e:
        this.noise.shortMode = (v & 0x80) !== 0;
        this.noise.periodIndex = v & 0x0f;
        break;
      case 0x0f:
        if (this.noise.enabled) this.noise.lengthCounter = LENGTH_TABLE[v >> 3]!;
        this.noise.envelope.trigger();
        break;

      case 0x11:
        this.dmcLevel = v & 0x7f;
        break;

      case 0x15:
        this.pulse1.enabled = (v & 0x01) !== 0;
        this.pulse2.enabled = (v & 0x02) !== 0;
        this.triangle.enabled = (v & 0x04) !== 0;
        this.noise.enabled = (v & 0x08) !== 0;
        if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0;
        if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
        if (!this.triangle.enabled) this.triangle.lengthCounter = 0;
        if (!this.noise.enabled) this.noise.lengthCounter = 0;
        break;

      case 0x17:
        this.frameMode5 = (v & 0x80) !== 0;
        this.frameCycle = 0;
        this.frameStep = 0;
        // Writing the 5-step mode clocks the sequencer's units immediately.
        if (this.frameMode5) {
          this.clockQuarterFrame();
          this.clockHalfFrame();
        }
        break;

      default:
        break;
    }
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      const step = Math.min(remaining, sink.clocksUntilSampleBoundary(), this.clocksToEvent());
      const level = this.level();
      sink.add(level, level, step);
      this.advance(step);
      remaining -= step;
    }
  }

  private clocksToEvent(): number {
    const boundaries = this.frameMode5 ? FRAME_5 : FRAME_4;
    let next = boundaries[this.frameStep]! - this.frameCycle;
    if (next <= 0) next = 1;
    if (this.pulse1.timer > 0 && this.pulse1.timer < next) next = this.pulse1.timer;
    if (this.pulse2.timer > 0 && this.pulse2.timer < next) next = this.pulse2.timer;
    if (this.triangle.timer > 0 && this.triangle.timer < next) next = this.triangle.timer;
    if (this.noise.timer > 0 && this.noise.timer < next) next = this.noise.timer;
    return next;
  }

  private advance(clocks: number): void {
    // Pulse timers are clocked at half the CPU rate; the reload already accounts
    // for it, so every channel decrements in CPU cycles here.
    for (const ch of [this.pulse1, this.pulse2]) {
      ch.timer -= clocks;
      if (ch.timer <= 0) ch.advance();
    }
    this.triangle.timer -= clocks;
    if (this.triangle.timer <= 0) this.triangle.advance();
    this.noise.timer -= clocks;
    if (this.noise.timer <= 0) this.noise.advance();

    this.frameCycle += clocks;
    const boundaries = this.frameMode5 ? FRAME_5 : FRAME_4;
    while (this.frameCycle >= boundaries[this.frameStep]!) {
      this.clockFrameStep();
      if (this.frameStep === 0) this.frameCycle -= boundaries[boundaries.length - 1]!;
    }
  }

  private clockFrameStep(): void {
    const last = this.frameMode5 ? 4 : 3;
    const step = this.frameStep;
    if (this.frameMode5) {
      if (step !== 3) this.clockQuarterFrame();
      if (step === 1 || step === 4) this.clockHalfFrame();
    } else {
      this.clockQuarterFrame();
      if (step === 1 || step === 3) this.clockHalfFrame();
    }
    this.frameStep = step === last ? 0 : step + 1;
  }

  private clockQuarterFrame(): void {
    this.pulse1.envelope.clock();
    this.pulse2.envelope.clock();
    this.noise.envelope.clock();
    this.triangle.clockLinear();
  }

  private clockHalfFrame(): void {
    this.pulse1.clockLength();
    this.pulse2.clockLength();
    this.triangle.clockLength();
    this.noise.clockLength();
    this.pulse1.clockSweep();
    this.pulse2.clockSweep();
  }

  /** The documented non-linear mixer (nesdev §APU Mixer), output in [0, 1]. */
  private level(): number {
    const p = this.pulse1.output() + this.pulse2.output();
    const pulseOut = p === 0 ? 0 : 95.88 / (8128 / p + 100);
    const t = this.triangle.output();
    const n = this.noise.output();
    const d = this.dmcLevel;
    const tnd = t / 8227 + n / 12241 + d / 22638;
    const tndOut = tnd === 0 ? 0 : 159.79 / (1 / tnd + 100);
    return pulseOut + tndOut;
  }
}
