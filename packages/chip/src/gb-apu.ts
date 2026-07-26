/**
 * The Game Boy APU (DMG/CGB) — `gb-apu`.
 *
 * Four channels: two pulses (the first with a frequency sweep), a 32-sample
 * 4-bit wavetable, and an LFSR noise generator, mixed through per-side channel
 * enables and a 3-bit master volume. Registers are addressed as on hardware,
 * `0x10`–`0x26` for NR10–NR52 and `0x30`–`0x3F` for wave RAM, so a schedule reads
 * the way the Pan Docs do.
 *
 * Sources:
 * - Pan Docs — Audio: https://gbdev.io/pandocs/Audio.html
 * - Pan Docs — Audio Registers: https://gbdev.io/pandocs/Audio_Registers.html
 * - Pan Docs — Audio Details (frame sequencer, LFSR): https://gbdev.io/pandocs/Audio_details.html
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/** DMG master clock. Every timer below is in these units. */
export const GB_CLOCK_HZ = 4194304;

/** The frame sequencer ticks at 512 Hz: length, envelope and sweep clocks. */
const FRAME_SEQ_PERIOD = GB_CLOCK_HZ / 512;

/** Duty patterns, 8 steps each: 12.5%, 25%, 50%, 75% (Pan Docs §Pulse). */
const DUTY: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];

/**
 * Noise timer periods in master clocks for divisor codes 0–7, before the shift.
 *
 * Code 0 is the half-divisor case (r = 0.5), which is why the table starts at 8
 * rather than 16 — deriving it from `f = 262144 / (r × 2^s)`.
 */
const NOISE_DIVISOR: readonly number[] = [8, 16, 32, 48, 64, 80, 96, 112];

/** Wave-channel output shifts for NR32 bits 5–6: mute, 100%, 50%, 25%. */
const WAVE_SHIFT: readonly number[] = [4, 0, 1, 2];

/** A channel that can be silenced by its length counter. */
abstract class Channel {
  enabled = false;
  lengthCounter = 0;
  lengthEnable = false;
  /** Clocks until this channel's next waveform event; `0` when it has none. */
  timer = 0;

  protected abstract readonly lengthMax: number;

  /** Digital output, 0–15, before the DAC. */
  abstract digital(): number;
  /** Whether the channel's DAC is powered; a powered DAC always drives a level. */
  abstract dacOn(): boolean;
  /** Reload the waveform timer and advance one waveform step. */
  abstract advanceTimer(): void;

  /** Analog level in [-1, 1]. A powered DAC maps 0→+1 and 15→−1 (Pan Docs). */
  analog(): number {
    if (!this.dacOn()) return 0;
    const digital = this.enabled ? this.digital() : 0;
    return 1 - digital / 7.5;
  }

  clockLength(): void {
    if (this.lengthEnable && this.lengthCounter > 0) {
      this.lengthCounter -= 1;
      if (this.lengthCounter === 0) this.enabled = false;
    }
  }

  protected triggerLength(): void {
    if (this.lengthCounter === 0) this.lengthCounter = this.lengthMax;
  }
}

/** A volume envelope: 4-bit level stepped at 64 Hz (Pan Docs §Envelope). */
class Envelope {
  volume = 0;
  initial = 0;
  period = 0;
  increase = false;
  private counter = 0;
  private finished = true;

  configure(nrx2: number): void {
    this.initial = (nrx2 >> 4) & 0xf;
    this.increase = (nrx2 & 0x08) !== 0;
    this.period = nrx2 & 0x07;
  }

  trigger(): void {
    this.volume = this.initial;
    this.counter = this.period;
    this.finished = this.period === 0;
  }

  clock(): void {
    if (this.finished) return;
    if (this.counter > 0) this.counter -= 1;
    if (this.counter !== 0) return;
    this.counter = this.period;
    const next = this.volume + (this.increase ? 1 : -1);
    if (next < 0 || next > 15) {
      this.finished = true;
      return;
    }
    this.volume = next;
  }
}

class PulseChannel extends Channel {
  protected readonly lengthMax = 64;
  duty = 0;
  step = 0;
  frequency = 0;
  nrx2 = 0;
  readonly envelope = new Envelope();

  // Sweep (channel 1 only; `sweepAvailable` keeps channel 2 honest).
  readonly sweepAvailable: boolean;
  private sweepPace = 0;
  private sweepStep = 0;
  private sweepDecrease = false;
  private sweepTimer = 0;
  private sweepEnabled = false;
  private sweepShadow = 0;

  constructor(sweepAvailable: boolean) {
    super();
    this.sweepAvailable = sweepAvailable;
  }

  dacOn(): boolean {
    return (this.nrx2 & 0xf8) !== 0;
  }

  digital(): number {
    return DUTY[this.duty]![this.step] === 1 ? this.envelope.volume : 0;
  }

  period(): number {
    return (2048 - this.frequency) * 4;
  }

  advanceTimer(): void {
    this.timer = this.period();
    this.step = (this.step + 1) & 7;
  }

  writeSweep(value: number): void {
    this.sweepPace = (value >> 4) & 0x07;
    this.sweepDecrease = (value & 0x08) !== 0;
    this.sweepStep = value & 0x07;
  }

  trigger(): void {
    this.enabled = this.dacOn();
    this.triggerLength();
    this.timer = this.period();
    this.envelope.trigger();
    if (!this.sweepAvailable) return;
    this.sweepShadow = this.frequency;
    this.sweepTimer = this.sweepPace === 0 ? 8 : this.sweepPace;
    this.sweepEnabled = this.sweepPace !== 0 || this.sweepStep !== 0;
    // A trigger with a non-zero step performs the overflow check immediately,
    // which can disable the channel before it ever sounds.
    if (this.sweepStep !== 0) this.computeSweep();
  }

  clockSweep(): void {
    if (!this.sweepAvailable) return;
    if (this.sweepTimer > 0) this.sweepTimer -= 1;
    if (this.sweepTimer !== 0) return;
    this.sweepTimer = this.sweepPace === 0 ? 8 : this.sweepPace;
    if (!this.sweepEnabled || this.sweepPace === 0) return;
    const next = this.computeSweep();
    if (next <= 2047 && this.sweepStep !== 0) {
      this.sweepShadow = next;
      this.frequency = next;
      // The second calculation is discarded, but its overflow check still runs
      // and can disable the channel — the documented hardware behaviour.
      this.computeSweep();
    }
  }

  /** One sweep calculation, including the overflow check that mutes on carry. */
  private computeSweep(): number {
    const delta = this.sweepShadow >> this.sweepStep;
    const next = this.sweepDecrease ? this.sweepShadow - delta : this.sweepShadow + delta;
    if (next > 2047) this.enabled = false;
    return next;
  }
}

class WaveChannel extends Channel {
  protected readonly lengthMax = 256;
  dacEnabled = false;
  frequency = 0;
  volumeShift = 4;
  position = 0;
  readonly ram = new Uint8Array(16);

  dacOn(): boolean {
    return this.dacEnabled;
  }

  digital(): number {
    const byte = this.ram[this.position >> 1]!;
    const nibble = (this.position & 1) === 0 ? byte >> 4 : byte & 0x0f;
    return nibble >> this.volumeShift;
  }

  period(): number {
    return (2048 - this.frequency) * 2;
  }

  advanceTimer(): void {
    this.timer = this.period();
    this.position = (this.position + 1) & 31;
  }

  trigger(): void {
    this.enabled = this.dacEnabled;
    this.triggerLength();
    this.timer = this.period();
    this.position = 0;
  }
}

class NoiseChannel extends Channel {
  protected readonly lengthMax = 64;
  nrx2 = 0;
  divisorCode = 0;
  shift = 0;
  widthMode = false;
  lfsr = 0x7fff;
  readonly envelope = new Envelope();

  dacOn(): boolean {
    return (this.nrx2 & 0xf8) !== 0;
  }

  digital(): number {
    return (this.lfsr & 1) === 0 ? this.envelope.volume : 0;
  }

  period(): number {
    // Shifts above 13 stall the channel on hardware; model it as "no events".
    if (this.shift > 13) return 0;
    return NOISE_DIVISOR[this.divisorCode]! << this.shift;
  }

  advanceTimer(): void {
    this.timer = this.period();
    const feedback = (this.lfsr & 1) ^ ((this.lfsr >> 1) & 1);
    this.lfsr = (this.lfsr >> 1) | (feedback << 14);
    if (this.widthMode) this.lfsr = (this.lfsr & ~0x40) | (feedback << 6);
  }

  trigger(): void {
    this.enabled = this.dacOn();
    this.triggerLength();
    this.timer = this.period();
    this.lfsr = 0x7fff;
    this.envelope.trigger();
  }
}

/** The Game Boy APU as a register-driven model. */
export class GbApu implements ChipModel {
  readonly id: ChipId = "gb-apu";
  readonly clockHz = GB_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly ch1 = new PulseChannel(true);
  private readonly ch2 = new PulseChannel(false);
  private readonly ch3 = new WaveChannel();
  private readonly ch4 = new NoiseChannel();
  private readonly channels: readonly Channel[] = [this.ch1, this.ch2, this.ch3, this.ch4];

  private powered = true;
  private leftVolume = 7;
  private rightVolume = 7;
  private panning = 0xff;
  private frameTimer = FRAME_SEQ_PERIOD;
  private frameStep = 0;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.powered = true;
    this.leftVolume = 7;
    this.rightVolume = 7;
    this.panning = 0xff;
    this.frameTimer = FRAME_SEQ_PERIOD;
    this.frameStep = 0;
    for (const ch of this.channels) {
      ch.enabled = false;
      ch.lengthCounter = 0;
      ch.lengthEnable = false;
      ch.timer = 0;
    }
    this.ch1.nrx2 = 0;
    this.ch2.nrx2 = 0;
    this.ch3.dacEnabled = false;
    this.ch4.nrx2 = 0;
    this.ch3.ram.fill(0);
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    if (reg >= 0x30 && reg <= 0x3f) {
      this.ch3.ram[reg - 0x30] = v;
      return;
    }
    // With the APU powered down every register except NR52 ignores writes.
    if (!this.powered && reg !== 0x26) return;

    switch (reg) {
      case 0x10:
        this.ch1.writeSweep(v);
        break;
      case 0x11:
        this.ch1.duty = v >> 6;
        this.ch1.lengthCounter = 64 - (v & 0x3f);
        break;
      case 0x12:
        this.ch1.nrx2 = v;
        this.ch1.envelope.configure(v);
        if (!this.ch1.dacOn()) this.ch1.enabled = false;
        break;
      case 0x13:
        this.ch1.frequency = (this.ch1.frequency & 0x700) | v;
        break;
      case 0x14:
        this.ch1.frequency = (this.ch1.frequency & 0xff) | ((v & 0x07) << 8);
        this.ch1.lengthEnable = (v & 0x40) !== 0;
        if ((v & 0x80) !== 0) this.ch1.trigger();
        break;

      case 0x16:
        this.ch2.duty = v >> 6;
        this.ch2.lengthCounter = 64 - (v & 0x3f);
        break;
      case 0x17:
        this.ch2.nrx2 = v;
        this.ch2.envelope.configure(v);
        if (!this.ch2.dacOn()) this.ch2.enabled = false;
        break;
      case 0x18:
        this.ch2.frequency = (this.ch2.frequency & 0x700) | v;
        break;
      case 0x19:
        this.ch2.frequency = (this.ch2.frequency & 0xff) | ((v & 0x07) << 8);
        this.ch2.lengthEnable = (v & 0x40) !== 0;
        if ((v & 0x80) !== 0) this.ch2.trigger();
        break;

      case 0x1a:
        this.ch3.dacEnabled = (v & 0x80) !== 0;
        if (!this.ch3.dacEnabled) this.ch3.enabled = false;
        break;
      case 0x1b:
        this.ch3.lengthCounter = 256 - v;
        break;
      case 0x1c:
        this.ch3.volumeShift = WAVE_SHIFT[(v >> 5) & 0x03]!;
        break;
      case 0x1d:
        this.ch3.frequency = (this.ch3.frequency & 0x700) | v;
        break;
      case 0x1e:
        this.ch3.frequency = (this.ch3.frequency & 0xff) | ((v & 0x07) << 8);
        this.ch3.lengthEnable = (v & 0x40) !== 0;
        if ((v & 0x80) !== 0) this.ch3.trigger();
        break;

      case 0x20:
        this.ch4.lengthCounter = 64 - (v & 0x3f);
        break;
      case 0x21:
        this.ch4.nrx2 = v;
        this.ch4.envelope.configure(v);
        if (!this.ch4.dacOn()) this.ch4.enabled = false;
        break;
      case 0x22:
        this.ch4.shift = v >> 4;
        this.ch4.widthMode = (v & 0x08) !== 0;
        this.ch4.divisorCode = v & 0x07;
        break;
      case 0x23:
        this.ch4.lengthEnable = (v & 0x40) !== 0;
        if ((v & 0x80) !== 0) this.ch4.trigger();
        break;

      case 0x24:
        this.rightVolume = v & 0x07;
        this.leftVolume = (v >> 4) & 0x07;
        break;
      case 0x25:
        this.panning = v;
        break;
      case 0x26: {
        // Powering off clears every register; powering on starts from reset.
        const on = (v & 0x80) !== 0;
        if (on !== this.powered) {
          this.reset();
          this.powered = on;
        }
        break;
      }
      default:
        break;
    }
  }

  read(reg: number): number {
    if (reg >= 0x30 && reg <= 0x3f) return this.ch3.ram[reg - 0x30]!;
    if (reg === 0x26) {
      let status = this.powered ? 0x80 : 0;
      if (this.ch1.enabled) status |= 0x01;
      if (this.ch2.enabled) status |= 0x02;
      if (this.ch3.enabled) status |= 0x04;
      if (this.ch4.enabled) status |= 0x08;
      return status;
    }
    return 0xff;
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      const step = Math.min(remaining, sink.clocksUntilSampleBoundary(), this.clocksToEvent());
      const [left, right] = this.levels();
      sink.add(left, right, step);
      this.advance(step);
      remaining -= step;
    }
  }

  /** Clocks until the next state change: a timer expiry or a sequencer tick. */
  private clocksToEvent(): number {
    let next = this.powered ? this.frameTimer : Number.MAX_SAFE_INTEGER;
    for (const ch of this.channels) {
      if (ch.timer > 0 && ch.timer < next) next = ch.timer;
    }
    return next > 0 ? next : 1;
  }

  private advance(clocks: number): void {
    if (!this.powered) return;
    for (const ch of this.channels) {
      if (ch.timer <= 0) continue;
      ch.timer -= clocks;
      if (ch.timer <= 0) ch.advanceTimer();
    }
    this.frameTimer -= clocks;
    if (this.frameTimer > 0) return;
    this.frameTimer += FRAME_SEQ_PERIOD;
    this.clockFrameSequencer();
  }

  private clockFrameSequencer(): void {
    const step = this.frameStep;
    this.frameStep = (this.frameStep + 1) & 7;
    if ((step & 1) === 0) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (step === 2 || step === 6) this.ch1.clockSweep();
    if (step === 7) {
      this.ch1.envelope.clock();
      this.ch2.envelope.clock();
      this.ch4.envelope.clock();
    }
  }

  /** Current stereo level, each nominally in [-1, 1]. */
  private levels(): [number, number] {
    if (!this.powered) return [0, 0];
    let left = 0;
    let right = 0;
    for (let i = 0; i < 4; i += 1) {
      const value = this.channels[i]!.analog();
      if ((this.panning & (0x10 << i)) !== 0) left += value;
      if ((this.panning & (1 << i)) !== 0) right += value;
    }
    // Master volume is a 3-bit multiplier (Pan Docs: `volume + 1` of 8), and the
    // four summed DACs are normalized so a full mix reaches nominal full scale.
    return [(left * (this.leftVolume + 1)) / 32, (right * (this.rightVolume + 1)) / 32];
  }
}
