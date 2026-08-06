/**
 * The T6W28 — `t6w28`, the Neo Geo Pocket's sound chip.
 *
 * Toshiba's part, and an SN76489 with the one thing that chip is poorest in:
 * **stereo that is a level rather than a switch**. Three square-wave tones at a
 * fixed 50% duty and one noise channel, exactly as on a Master System — but each
 * of the four has *two* four-bit attenuators, one a side, so a part can sit
 * anywhere across the image instead of hard left, hard right or both. A Game
 * Gear's stereo latch is one bit per channel per side; this is four.
 *
 * Two other things are this chip's rather than the SN76489's restated.
 *
 *   - **There are two write ports and they carry different registers.** Each
 *     port owns its side's four attenuators, and beyond that the split is
 *     asymmetric: the *left* port carries the three tone periods and the *right*
 *     port carries the noise's. So a note is written through one port and its
 *     stereo image through both, and there is no port through which a whole
 *     voice can be set.
 *   - **The noise has a period register of its own.** On an SN76489 the fourth
 *     noise rate follows tone channel 2, so a drum below the tone floor costs a
 *     voice; here rate 3 divides a register nothing else reads, and the chip
 *     keeps all three tones. That is the enhancement the part exists for.
 *
 * The two references this model was written against **agree about the register
 * split and disagree about the noise generator**, so the disagreement is stated
 * rather than averaged: MAME's `t6w28.cpp` uses a sixteen-bit shift register fed
 * back from bits 1 and 2, and higan's uses a fifteen-bit one fed back from bits
 * 0 and 2 with the output inverted. This model takes MAME's, because it is the
 * SN76489**A** configuration this part is a member of and because it is the same
 * shape as {@link Sn76489}'s — which is a tested artifact here. What would
 * settle it is a hardware capture of the periodic-noise waveform, whose period
 * differs between the two by a factor of two.
 *
 * Sources:
 * - MAME — `src/devices/sound/t6w28.cpp` (register split, noise, volume curve)
 * - higan — `component/audio/t6w28` (register split, independently)
 * - MAME — `src/mame/snk/ngp.cpp`: `T6W28(config, m_t6w28, 6.144_MHz_XTAL/2)`
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/** The chip's clock: the console's 6.144 MHz crystal, halved. */
export const T6W28_CLOCK_HZ = 3_072_000;

/** Internal divider: the tone counters tick once per 16 master clocks. */
const DIVIDER = 16;

/**
 * Attenuation in 2 dB steps, as a linear amplitude, with 15 as full mute.
 *
 * The SN76489's own curve, because MAME generates both from one function — so
 * this is the same table {@link Sn76489} uses, kept here rather than imported
 * because a shared table would say the two chips are one part.
 */
const VOLUME: readonly number[] = [
  8191, 6499, 5152, 4096, 3262, 2588, 2059, 1638, 1291, 1024, 815, 647, 514, 408, 323, 0,
];

/** The two write ports, as this model's register numbers. */
export const T6W28_RIGHT = 0;
export const T6W28_LEFT = 1;

interface ToneChannel {
  period: number;
  counter: number;
  output: number;
  /** Attenuation a side, indexed by {@link T6W28_RIGHT} / {@link T6W28_LEFT}. */
  volume: [number, number];
}

/** The T6W28 as a register-driven model. */
export class T6w28 implements ChipModel {
  readonly id: ChipId = "t6w28";
  readonly clockHz = T6W28_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly tone: ToneChannel[] = [];
  private noisePeriod = 512;
  private noiseCounter = 512;
  private noiseControl = 0;
  /** The noise's *own* divisor, which rate 3 uses. */
  private noisePitch = 0;
  private noiseVolume: [number, number] = [15, 15];
  private lfsr = 0x8000;
  private noiseOutput = 0;
  /** One latched register a port, because each port has its own. */
  private latched: [number, number] = [0, 0];

  constructor() {
    for (let i = 0; i < 3; i += 1) {
      this.tone.push({ period: 0, counter: 0, output: 1, volume: [15, 15] });
    }
    this.reset();
  }

  reset(): void {
    for (const channel of this.tone) {
      channel.period = 0;
      channel.counter = 0;
      channel.output = 1;
      channel.volume = [15, 15];
    }
    this.noisePeriod = 512;
    this.noiseCounter = 512;
    this.noiseControl = 0;
    this.noisePitch = 0;
    this.noiseVolume = [15, 15];
    this.lfsr = 0x8000;
    this.noiseOutput = 0;
    this.latched = [0, 0];
  }

  /**
   * `reg` is the *port*, not a register: {@link T6W28_RIGHT} or
   * {@link T6W28_LEFT}.
   *
   * Latch and data bytes carry their own addressing, exactly as on an SN76489,
   * so what the port decides is which side's attenuator a volume write reaches
   * and whether a period write is a tone's or the noise's.
   */
  write(reg: number, value: number): void {
    const port = reg & 1;
    const v = value & 0xff;
    let latched: number;
    if ((v & 0x80) !== 0) {
      // Latch byte: %1cctdddd — channel, type, low 4 data bits.
      latched = (v >> 4) & 0x07;
      this.latched[port] = latched;
    } else {
      latched = this.latched[port] as number;
    }
    const channel = (latched >> 1) & 0x03;
    const isVolume = (latched & 0x01) !== 0;
    if (isVolume) {
      const attenuation = v & 0x0f;
      if (channel === 3) this.noiseVolume[port] = attenuation;
      else (this.tone[channel] as ToneChannel).volume[port] = attenuation;
      return;
    }
    // A period write, and which period it is belongs to the port. The left port
    // carries the three tones and the right port carries the noise — so channel
    // 3 on the left and channels 0 and 1 on the right address nothing, which is
    // what makes a stereo image cost two writes and a note one.
    const low = (v & 0x80) !== 0;
    if (port === T6W28_LEFT) {
      if (channel === 3) return;
      const tone = this.tone[channel] as ToneChannel;
      tone.period = low
        ? (tone.period & 0x3f0) | (v & 0x0f)
        : ((v & 0x3f) << 4) | (tone.period & 0x0f);
      return;
    }
    if (channel === 3) {
      this.setNoiseControl(v & 0x0f);
      return;
    }
    // The noise's own divisor sits where tone 2's period would be, which is why
    // this chip keeps three tones where an SN76489 spends one on a low drum.
    if (channel !== 2) return;
    this.noisePitch = low
      ? (this.noisePitch & 0x3f0) | (v & 0x0f)
      : ((v & 0x3f) << 4) | (this.noisePitch & 0x0f);
    if ((this.noiseControl & 0x03) === 0x03) this.noiseCounter = this.noiseReload();
  }

  private setNoiseControl(value: number): void {
    this.noiseControl = value;
    this.lfsr = 0x8000;
    const rate = value & 0x03;
    // Rates 0–2 clock the shift register at N/512, N/1024 and N/2048; rate 3
    // divides the noise's own period register.
    this.noisePeriod = rate === 3 ? 0 : 512 << rate;
    this.noiseCounter = this.noiseReload();
  }

  /** Master clocks between shift-register clocks. */
  private noiseReload(): number {
    if (this.noisePeriod > 0) return this.noisePeriod;
    return DIVIDER * Math.max(this.noisePitch, 1);
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
    // Bits 1 and 2 rather than the SN76489's 0 and 3 — this part's taps, and the
    // one place the two references disagree (see the file's header).
    const feedback = white ? ((this.lfsr >> 1) & 1) ^ ((this.lfsr >> 2) & 1) : this.lfsr & 1;
    this.lfsr = (this.lfsr >> 1) | (feedback << 15);
    this.noiseOutput = this.lfsr & 1;
  }

  private levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (const channel of this.tone) {
      const output = channel.output;
      left += output * (VOLUME[channel.volume[T6W28_LEFT]] as number);
      right += output * (VOLUME[channel.volume[T6W28_RIGHT]] as number);
    }
    const noise = this.noiseOutput === 1 ? 1 : -1;
    left += noise * (VOLUME[this.noiseVolume[T6W28_LEFT]] as number);
    right += noise * (VOLUME[this.noiseVolume[T6W28_RIGHT]] as number);
    // Four channels at full amplitude reach nominal full scale.
    const scale = 4 * 8191;
    return [left / scale, right / scale];
  }
}
