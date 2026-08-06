/**
 * The HuC6280's PSG — `huc6280-psg`.
 *
 * Six channels, and every one of them is a wavetable: thirty-two five-bit
 * samples of RAM that the chip walks at a rate a twelve-bit divider sets. That
 * makes it the odd one out among the era's tone generators. A Game Boy has *one*
 * such channel and four in total; a Master System has none at all and four fixed
 * squares. Here the shape of every voice is the driver's to choose, and the same
 * hardware plays a square, a triangle and a sawtooth without a mode bit — which
 * is why `binding/pce-bank.ts` is a bank of waveforms rather than a duty table.
 *
 * Three things about it are worth knowing before touching this file:
 *
 *   - **Volume is three attenuators in series.** A channel's own five bits, its
 *     four-bit left and right balance, and the chip's four-bit global left and
 *     right — and they *add*, in units of 1.5 dB, with the balance fields
 *     counting double. So a level is a table lookup on a sum rather than a
 *     multiply, which is what {@link AMPLITUDE} is.
 *   - **Two of the six can be noise instead.** Channels five and six have a shift
 *     register they can output in place of their waveform, which is this
 *     console's only percussion voice. The other four cannot, and asking is a
 *     no-op rather than an error, because that is what the hardware does.
 *   - **The waveform index is written through a port and reset by a control
 *     write.** Uploading a waveform means turning the channel off, writing
 *     thirty-two bytes and turning it back on; there is no address register, so
 *     a driver that forgot the reset would upload into the middle of a cycle.
 *
 * The **LFO** is here too, and it is the fourth thing worth knowing, because it
 * is unlike every other vibrato in this package: there is no dedicated
 * oscillator at all. Channel two *is* the modulator — its waveform, at its own
 * divider slowed by a factor the LFO frequency register names, is added to
 * channel one's divider — so the shape of the sweep is whatever a driver
 * uploaded into that channel, and the two settings interact rather than
 * combining. Two consequences fall out of that and neither is obvious.
 * Switching the LFO on costs a *voice*, because channel two is then playing a
 * control signal rather than a note. And the depth is a **shift on the
 * divider**, not on the pitch, so the same setting is a wider interval on a low
 * note than on a high one — the opposite of the YM2612's, which works on the
 * F-number for exactly that reason.
 *
 * What is not here is a **sample player**, and that is a demaker's gap rather
 * than this model's: direct D/A is implemented and a write to it is held for as
 * long as the hardware holds it, so a binding that fed the port a stream would
 * be heard. Nothing above this file does, which is doc 16's outstanding work
 * and not a register this file disbelieves.
 *
 * Sources:
 * - Archaic Pixels — PSG: https://archaicpixels.com/PSG
 * - Charles MacDonald — PC Engine hardware notes (`pcetech.txt`), §PSG
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The PSG's clock, which is the CPU's slow rate rather than its fast one.
 *
 * The chip is fed the master clock divided by six — the same 3.58 MHz an NTSC
 * colourburst is, and the same number a Master System's PSG runs at, which is a
 * coincidence of the era's crystals rather than a shared design.
 */
export const HUC6280_PSG_CLOCK_HZ = 3579545;

/** Samples in one channel's waveform, and the bits each of them has. */
export const HUC6280_WAVE_SAMPLES = 32;
export const HUC6280_WAVE_BITS = 5;

/** Channels the chip has, and the first one with a noise generator. */
export const HUC6280_PSG_CHANNELS = 6;
export const HUC6280_FIRST_NOISE_CHANNEL = 4;

/**
 * The two channels the LFO is wired between, which the hardware fixes.
 *
 * Channel two modulates channel one and no other pair can be chosen — there is
 * no routing register, which is why these are constants rather than state.
 */
export const LFO_TARGET = 0;
export const LFO_MODULATOR = 1;

/**
 * The order the six channels are stepped in, with and without the LFO.
 *
 * Only the first two entries differ, and only when the LFO is on: the modulator
 * has to be brought up to date before the channel that reads it, or a reload
 * landing on the same clock as one of its steps takes the previous sample.
 */
const PLAIN_ORDER: readonly number[] = [0, 1, 2, 3, 4, 5];
const LFO_ORDER: readonly number[] = [1, 0, 2, 3, 4, 5];

/**
 * Amplitude for a total attenuation of `n` steps of 1.5 dB.
 *
 * A table rather than a computed curve, for the reason the SN76489's is: this is
 * what the hardware does, and it keeps the package free of transcendentals
 * (doc 16 §Determinism engineering). Ninety-two entries because that is the
 * largest sum the three attenuators can reach — a channel's own 31 plus twice
 * fifteen for each balance field — and everything past about fifty-seven is
 * silence at this scale, which is the hardware's answer too.
 */
const AMPLITUDE: readonly number[] = [
  8191, 6892, 5799, 4879, 4105, 3454, 2906, 2445, 2057, 1731, 1457, 1226, 1031, 868, 730, 614, 517,
  435, 366, 308, 259, 218, 183, 154, 130, 109, 92, 77, 65, 55, 46, 39, 33, 27, 23, 19, 16, 14, 12,
  10, 8, 7, 6, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

/** Registers, as the offsets a program writes in the hardware page. */
export const HUC6280_PSG_REG = {
  /** Which channel every register below addresses. */
  SELECT: 0x00,
  /** Global left and right level, four bits each. */
  GLOBAL: 0x01,
  FREQ_LOW: 0x02,
  FREQ_HIGH: 0x03,
  /** Channel enable, direct D/A, and the five-bit level. */
  CONTROL: 0x04,
  /** This channel's left and right level, four bits each. */
  BALANCE: 0x05,
  /** One waveform sample, or the direct D/A value. */
  WAVE: 0x06,
  /** Noise enable and rate — channels five and six only. */
  NOISE: 0x07,
  LFO_FREQ: 0x08,
  LFO_CONTROL: 0x09,
} as const;

interface Channel {
  /** The twelve-bit divider, where zero means 4096. */
  frequency: number;
  counter: number;
  enabled: boolean;
  /** Direct D/A: the output is the last byte written rather than the waveform. */
  dda: boolean;
  volume: number;
  left: number;
  right: number;
  wave: Uint8Array;
  writeIndex: number;
  readIndex: number;
  ddaSample: number;
  noiseEnabled: boolean;
  noiseFrequency: number;
  noiseCounter: number;
  lfsr: number;
  noiseOutput: number;
}

function newChannel(): Channel {
  return {
    frequency: 0,
    // About to reload, rather than a whole period out. The hardware's own
    // power-on counter is undefined, and starting it here is what stops a
    // channel's *first* cycle after reset holding sample zero for up to a
    // millisecond — an artefact of the model rather than of the chip.
    counter: 1,
    enabled: false,
    dda: false,
    volume: 0,
    left: 0,
    right: 0,
    wave: new Uint8Array(HUC6280_WAVE_SAMPLES),
    writeIndex: 0,
    readIndex: 0,
    ddaSample: 16,
    noiseEnabled: false,
    noiseFrequency: 0,
    noiseCounter: 2048,
    lfsr: 0x0001,
    noiseOutput: 0,
  };
}

/** The HuC6280's sound half, as a register-driven model. */
export class Huc6280Psg implements ChipModel {
  readonly id: ChipId = "huc6280-psg";
  readonly clockHz = HUC6280_PSG_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly channels: Channel[] = [];
  /** Which channel the register window addresses. */
  private selected = 0;
  private globalLeft = 15;
  private globalRight = 15;
  /**
   * The LFO's two registers, and both of them do something.
   *
   * `$08` is how much channel two's own divider is multiplied by — zero meaning
   * 256, which is the slowest and therefore the most vibrato-shaped setting.
   * `$09` carries the depth in its low two bits (zero being off, and one to
   * three shifting channel two's sample by nothing, two bits or four before it
   * is added), and in bit 7 a *halt* that freezes the modulator where it stands
   * rather than switching it off. Public because they are the two the chip
   * cannot be asked to read back.
   */
  lfoFrequency = 0;
  lfoControl = 0;

  constructor() {
    for (let index = 0; index < HUC6280_PSG_CHANNELS; index += 1) this.channels.push(newChannel());
  }

  reset(): void {
    for (let index = 0; index < HUC6280_PSG_CHANNELS; index += 1)
      this.channels[index] = newChannel();
    this.selected = 0;
    this.globalLeft = 15;
    this.globalRight = 15;
    this.lfoFrequency = 0;
    this.lfoControl = 0;
  }

  write(reg: number, value: number): void {
    const byte = value & 0xff;
    switch (reg & 0x0f) {
      case HUC6280_PSG_REG.SELECT:
        this.selected = byte & 0x07;
        return;
      case HUC6280_PSG_REG.GLOBAL:
        this.globalLeft = (byte >> 4) & 0x0f;
        this.globalRight = byte & 0x0f;
        return;
      case HUC6280_PSG_REG.LFO_FREQ:
        this.lfoFrequency = byte;
        return;
      case HUC6280_PSG_REG.LFO_CONTROL:
        this.lfoControl = byte;
        return;
      default:
        break;
    }
    // Channel six and seven do not exist; the select register is three bits and
    // the hardware simply has nothing behind the top two values.
    const channel = this.channels[this.selected];
    if (channel === undefined) return;

    switch (reg & 0x0f) {
      case HUC6280_PSG_REG.FREQ_LOW:
        channel.frequency = (channel.frequency & 0xf00) | byte;
        return;
      case HUC6280_PSG_REG.FREQ_HIGH:
        channel.frequency = (channel.frequency & 0x0ff) | ((byte & 0x0f) << 8);
        return;
      case HUC6280_PSG_REG.CONTROL: {
        const enabled = (byte & 0x80) !== 0;
        const dda = (byte & 0x40) !== 0;
        // Turning a channel off with direct D/A also off is what resets the
        // waveform pointers — there is no address register, so this *is* the
        // upload's "seek to zero", and a driver that skipped it would write into
        // the middle of a cycle.
        if (!enabled && !dda) {
          channel.writeIndex = 0;
          channel.readIndex = 0;
        }
        channel.enabled = enabled;
        channel.dda = dda;
        channel.volume = byte & 0x1f;
        return;
      }
      case HUC6280_PSG_REG.BALANCE:
        channel.left = (byte >> 4) & 0x0f;
        channel.right = byte & 0x0f;
        return;
      case HUC6280_PSG_REG.WAVE:
        if (channel.dda) {
          channel.ddaSample = byte & 0x1f;
          return;
        }
        channel.wave[channel.writeIndex] = byte & 0x1f;
        channel.writeIndex = (channel.writeIndex + 1) & (HUC6280_WAVE_SAMPLES - 1);
        return;
      case HUC6280_PSG_REG.NOISE:
        // Only the last two channels have a shift register; on the others the
        // register is not decoded at all.
        if (this.selected < HUC6280_FIRST_NOISE_CHANNEL) return;
        channel.noiseEnabled = (byte & 0x80) !== 0;
        channel.noiseFrequency = byte & 0x1f;
        channel.noiseCounter = noiseReload(channel.noiseFrequency);
        return;
      default:
        return;
    }
  }

  read(reg: number): number {
    // Only the waveform port reads back, and only while the channel is stopped —
    // which is the state an upload leaves it in.
    if ((reg & 0x0f) !== HUC6280_PSG_REG.WAVE) return 0;
    const channel = this.channels[this.selected];
    if (channel === undefined) return 0;
    return channel.wave[channel.readIndex] as number;
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

  /**
   * Whether channel two is being spent as a modulator rather than as a voice.
   *
   * Three things have to be true and the third is the one a driver gets wrong:
   * a depth is selected, channel two is *running*, and the halt bit is clear.
   * Halting is not the same as switching off — it freezes the modulator's
   * waveform where it stands, which holds channel one at whatever detune the
   * last sample asked for.
   */
  private lfoActive(): boolean {
    if ((this.lfoControl & 0x03) === 0) return false;
    if ((this.lfoControl & 0x80) !== 0) return false;
    return (this.channels[LFO_MODULATOR] as Channel).enabled;
  }

  /**
   * The clocks between one channel's waveform steps, LFO included.
   *
   * Two of the six answer differently while the LFO is on: the modulator runs
   * slower by the whole of `$08`, and the channel it modulates has the
   * modulator's current sample added to its divider. Everything else asks this
   * and gets `divider()`.
   */
  private dividerOf(index: number): number {
    const channel = this.channels[index] as Channel;
    if ((this.lfoControl & 0x03) === 0) return divider(channel.frequency);
    if (index === LFO_MODULATOR) {
      return divider(channel.frequency) * (this.lfoFrequency === 0 ? 256 : this.lfoFrequency);
    }
    if (index !== LFO_TARGET || !this.lfoActive()) return divider(channel.frequency);
    // Centred at sixteen, exactly as the output is: a modulator sitting at the
    // middle of its range detunes nothing, so a flat waveform is silence here
    // for the same reason it is silence in `levels()`.
    const modulator = this.channels[LFO_MODULATOR] as Channel;
    const shift = ((this.lfoControl & 0x03) - 1) << 1;
    const sample = (modulator.wave[modulator.readIndex] as number) - 16;
    const detuned = (channel.frequency + (sample << shift)) & 0xfff;
    return detuned === 0 ? 4096 : detuned;
  }

  /** Clocks until the next waveform step or shift-register clock. */
  private clocksToEvent(): number {
    let next = Number.MAX_SAFE_INTEGER;
    for (const [index, channel] of this.channels.entries()) {
      if (!channel.enabled) continue;
      // A channel in direct D/A mode holds its byte until the next write, so it
      // has no event of its own at all — and neither has a halted modulator,
      // whose counter is not clocked. Leaving either in would pin every step to
      // a counter that never moves, which is a correct render at a crawl.
      const held = channel.dda || (index === LFO_MODULATOR && (this.lfoControl & 0x80) !== 0);
      if (!held && channel.counter > 0 && channel.counter < next) next = channel.counter;
      if (channel.noiseEnabled && channel.noiseCounter > 0 && channel.noiseCounter < next) {
        next = channel.noiseCounter;
      }
    }
    return next > 0 && next !== Number.MAX_SAFE_INTEGER ? next : 1;
  }

  private advance(clocks: number): void {
    // The modulator is stepped before the channel it modulates, so a reload
    // that lands on the same clock as one of its steps takes the sample the
    // hardware would have had rather than the one before it.
    const order = this.lfoActive() ? LFO_ORDER : PLAIN_ORDER;
    for (const index of order) {
      const channel = this.channels[index] as Channel;
      if (!channel.enabled) continue;
      // Halting freezes the modulator's waveform pointer without silencing it,
      // which is the whole difference between bit 7 and clearing the depth.
      const frozen = index === LFO_MODULATOR && (this.lfoControl & 0x80) !== 0;
      if (!channel.dda && !frozen) {
        channel.counter -= clocks;
        while (channel.counter <= 0) {
          channel.counter += this.dividerOf(index);
          channel.readIndex = (channel.readIndex + 1) & (HUC6280_WAVE_SAMPLES - 1);
        }
      }
      if (!channel.noiseEnabled) continue;
      channel.noiseCounter -= clocks;
      while (channel.noiseCounter <= 0) {
        channel.noiseCounter += noiseReload(channel.noiseFrequency);
        // A seventeen-bit maximal sequence, tapped at bits 0 and 1 — which is
        // the run this chip's noise is documented as producing.
        const feedback = (channel.lfsr ^ (channel.lfsr >> 1)) & 1;
        channel.lfsr = (channel.lfsr >> 1) | (feedback << 16);
        channel.noiseOutput = channel.lfsr & 1;
      }
    }
  }

  private levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (const channel of this.channels) {
      if (!channel.enabled) continue;
      // Five bits centred at sixteen: the waveform is unsigned and the chip
      // subtracts the midpoint, which is why a flat waveform of sixteen is
      // silence rather than a click.
      const sample = channel.noiseEnabled
        ? channel.noiseOutput === 1
          ? 31
          : 0
        : channel.dda
          ? channel.ddaSample
          : (channel.wave[channel.readIndex] as number);
      const signed = sample - 16;
      left += (signed * attenuate(channel.volume, channel.left, this.globalLeft)) / 16;
      right += (signed * attenuate(channel.volume, channel.right, this.globalRight)) / 16;
    }
    // Six channels at full amplitude reach nominal full scale.
    const scale = HUC6280_PSG_CHANNELS * 8191;
    return [left / scale, right / scale];
  }
}

/** The chip clocks a waveform step every `divider` clocks; zero means 4096. */
function divider(frequency: number): number {
  const value = frequency & 0xfff;
  return value === 0 ? 4096 : value;
}

/**
 * Clocks between shift-register steps.
 *
 * The five-bit register counts *down* from the top, so `$1F` is the fastest
 * setting and `$00` the slowest — which puts the range at roughly 1.7 kHz to
 * 56 kHz and makes the low end a rattle rather than a hiss.
 */
function noiseReload(frequency: number): number {
  return 64 * (32 - (frequency & 0x1f));
}

/**
 * Amplitude for one side of one channel.
 *
 * Three attenuators in series, in units of 1.5 dB, with the two balance fields
 * counting double — which is the whole of this chip's mixing and the reason a
 * level here is a table lookup rather than a multiply.
 */
function attenuate(volume: number, balance: number, global: number): number {
  const steps = 31 - (volume & 0x1f) + 2 * (15 - (balance & 0x0f)) + 2 * (15 - (global & 0x0f));
  return AMPLITUDE[steps] ?? 0;
}
