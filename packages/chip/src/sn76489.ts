/**
 * The SN76489 PSG — `sn76489`.
 *
 * Three square-wave tone channels at a fixed 50% duty and one noise channel,
 * each with 4-bit attenuation and nothing else: no envelopes, no duty control,
 * no panning (except on the Game Gear's stereo variant). That poverty is the
 * point — every volume shape a Master System song has was written by the driver,
 * one register write at a time, which is why doc 17 treats expression as a cost
 * rather than a free choice.
 *
 * The chip is written through a single data port, so `write()` ignores its
 * register argument: latch/data bytes carry their own addressing. The Game Gear
 * stereo latch lives at its own port and is modelled as register `0x06`.
 *
 * Sources:
 * - SMS Power — SN76489: https://www.smspower.org/Development/SN76489
 * - Sega Game Gear stereo port ($06): https://www.smspower.org/Development/AudioPort
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The PSG clock on the SMS/GG (NTSC colourburst).
 *
 * Counters below are kept in *master* clocks rather than the chip's internal
 * ÷16 domain, so sample boundaries stay exact integers: a tone toggles every
 * `16 × period` clocks, giving the documented `f = clock / (32 × period)`.
 */
export const SN76489_CLOCK_HZ = 3579545;

/** Internal divider: the tone counters tick once per 16 master clocks. */
const DIVIDER = 16;

/**
 * Attenuation in 2 dB steps, as a linear amplitude, with 15 as full mute.
 *
 * A table rather than a computed curve: this is what the hardware does, these
 * are the values every reference implementation uses, and it keeps the package
 * free of transcendentals (doc 16 §Determinism engineering).
 */
const VOLUME: readonly number[] = [
  8191, 6499, 5152, 4096, 3262, 2588, 2059, 1638, 1291, 1024, 815, 647, 514, 408, 323, 0,
];

/** Data byte written to the stereo port; every channel on both sides. */
const STEREO_ALL = 0xff;

interface ToneChannel {
  period: number;
  counter: number;
  output: number;
  volume: number;
}

/** The SN76489 as a register-driven model. */
export class Sn76489 implements ChipModel {
  readonly id: ChipId = "sn76489";
  readonly clockHz = SN76489_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly tone: ToneChannel[] = [];
  private noisePeriod = 512;
  private noiseCounter = 512;
  private noiseControl = 0;
  private noiseVolume = 15;
  private lfsr = 0x8000;
  private noiseOutput = 0;
  private latched = 0;
  private stereo = STEREO_ALL;

  /** Whether the stereo port exists (Game Gear); otherwise both sides are equal. */
  readonly stereoCapable: boolean;

  constructor(options: { stereo?: boolean } = {}) {
    this.stereoCapable = options.stereo ?? false;
    for (let i = 0; i < 3; i += 1) {
      this.tone.push({ period: 0, counter: 0, output: 1, volume: 15 });
    }
    this.reset();
  }

  reset(): void {
    for (const channel of this.tone) {
      channel.period = 0;
      channel.counter = 0;
      channel.output = 1;
      channel.volume = 15;
    }
    this.noisePeriod = 512;
    this.noiseCounter = 512;
    this.noiseControl = 0;
    this.noiseVolume = 15;
    this.lfsr = 0x8000;
    this.noiseOutput = 0;
    this.latched = 0;
    this.stereo = STEREO_ALL;
  }

  write(reg: number, value: number): void {
    const v = value & 0xff;
    if (reg === 0x06 && this.stereoCapable) {
      this.stereo = v;
      return;
    }
    if ((v & 0x80) !== 0) {
      // Latch byte: %1cctdddd — channel, type, low 4 data bits.
      this.latched = (v >> 4) & 0x07;
      const channel = (v >> 5) & 0x03;
      const isVolume = (v & 0x10) !== 0;
      if (isVolume) {
        this.setVolume(channel, v & 0x0f);
        return;
      }
      if (channel === 3) {
        this.setNoiseControl(v & 0x0f);
        return;
      }
      this.tone[channel]!.period = (this.tone[channel]!.period & 0x3f0) | (v & 0x0f);
      return;
    }
    // Data byte: %0-dddddd — the high 6 bits of the latched register.
    const channel = (this.latched >> 1) & 0x03;
    const isVolume = (this.latched & 0x01) !== 0;
    if (isVolume) {
      this.setVolume(channel, v & 0x0f);
      return;
    }
    if (channel === 3) {
      this.setNoiseControl(v & 0x0f);
      return;
    }
    this.tone[channel]!.period = ((v & 0x3f) << 4) | (this.tone[channel]!.period & 0x0f);
  }

  private setVolume(channel: number, attenuation: number): void {
    if (channel === 3) this.noiseVolume = attenuation;
    else this.tone[channel]!.volume = attenuation;
  }

  private setNoiseControl(value: number): void {
    this.noiseControl = value;
    this.lfsr = 0x8000;
    const rate = value & 0x03;
    // Rates 0–2 clock the shift register at N/512, N/1024 and N/2048; rate 3
    // follows tone channel 2, which is how an SMS reaches notes below the tone
    // channels' ~109 Hz floor (doc 16 §The `AudioSpec` schema).
    this.noisePeriod = rate === 3 ? 0 : 512 << rate;
    this.noiseCounter = this.noiseReload();
  }

  /** Master clocks between shift-register clocks, following tone 2 on rate 3. */
  private noiseReload(): number {
    if (this.noisePeriod > 0) return this.noisePeriod;
    return DIVIDER * Math.max(this.tone[2]!.period, 1);
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

  private clocksToEvent(): number {
    let next = Number.MAX_SAFE_INTEGER;
    for (const channel of this.tone) {
      if (channel.period > 1 && channel.counter > 0 && channel.counter < next) {
        next = channel.counter;
      }
    }
    if (this.noiseCounter > 0 && this.noiseCounter < next) next = this.noiseCounter;
    return next > 0 && next !== Number.MAX_SAFE_INTEGER ? next : 1;
  }

  private advance(clocks: number): void {
    for (const channel of this.tone) {
      // Period 0 or 1 puts the channel above the audio band; hardware holds the
      // output high, which is what makes the "PCM through volume writes" trick
      // work at all.
      if (channel.period <= 1) {
        channel.output = 1;
        continue;
      }
      channel.counter -= clocks;
      while (channel.counter <= 0) {
        channel.counter += DIVIDER * channel.period;
        channel.output = -channel.output;
      }
    }
    this.noiseCounter -= clocks;
    while (this.noiseCounter <= 0) {
      this.noiseCounter += this.noiseReload();
      this.clockNoise();
    }
  }

  private clockNoise(): void {
    const white = (this.noiseControl & 0x04) !== 0;
    // The SMS/GG/MD part taps bits 0 and 3 of a 16-bit shift register.
    const feedback = white ? (this.lfsr & 1) ^ ((this.lfsr >> 3) & 1) : this.lfsr & 1;
    this.lfsr = (this.lfsr >> 1) | (feedback << 15);
    this.noiseOutput = this.lfsr & 1;
  }

  private levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (let i = 0; i < 3; i += 1) {
      const channel = this.tone[i]!;
      const value = channel.output * VOLUME[channel.volume]!;
      if ((this.stereo & (0x10 << i)) !== 0) left += value;
      if ((this.stereo & (1 << i)) !== 0) right += value;
    }
    const noise = (this.noiseOutput === 1 ? 1 : -1) * VOLUME[this.noiseVolume]!;
    if ((this.stereo & 0x80) !== 0) left += noise;
    if ((this.stereo & 0x08) !== 0) right += noise;
    // Four channels at full amplitude reach nominal full scale.
    const scale = 4 * 8191;
    return [left / scale, right / scale];
  }
}
