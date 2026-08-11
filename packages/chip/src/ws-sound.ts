/**
 * The WonderSwan's sound hardware — `ws-sound`.
 *
 * Four channels, and every one of them is a wavetable: thirty-two four-bit
 * samples the chip walks at a rate an eleven-bit divider sets. That makes it the
 * PC Engine's arrangement with two fewer voices and one bit less depth — and one
 * difference that reaches much further than either.
 *
 * **The waveforms are in the console's own RAM.** There is no wave port to
 * upload through and no sound RAM to upload into: port `$8F` holds bits 6–13 of
 * an address, and the chip reads sixty-four bytes from there — sixteen per
 * channel, two samples a byte, the *low* nibble first. So a driver changes a
 * timbre by writing memory, and this model is handed the machine's RAM the way
 * {@link NdsSpu} is handed the Nintendo DS's. It is also why the base must be
 * sixty-four-byte aligned and below `$4000`: those are the bits the register has.
 *
 * Four more things are worth knowing before touching this file:
 *
 *   - **Volume is four bits a side and it is linear.** No envelope, no global
 *     attenuator on the wavetable path, and no decibel table — a level is a
 *     multiply, which is the Game Boy's arrangement rather than the PC Engine's
 *     three attenuators in series.
 *   - **Only channel four can be noise, and only channel three can sweep.** The
 *     other two are wavetable and nothing else, and asking is a no-op rather
 *     than an error, because that is what the hardware does. The noise generator
 *     is a fifteen-bit shift register with *eight* tap positions rather than a
 *     rate divider — the sequence's length is the timbre, and its pitch is still
 *     the channel's own divider.
 *   - **A channel's own enable is in one shared register.** `$90` carries four
 *     enable bits and the three mode bits, so it is the byte two streams both
 *     write and the one a driver has to merge (doc 16 §`NR51` is merged).
 *   - **Channel two can stop being a wavetable.** `$90` bit 5 turns it into a
 *     direct D/A: `$89` stops being two volume nibbles and becomes an eight-bit
 *     sample the chip holds until the next write, and `$94` supplies the only
 *     level it has — full, half or silent, per side. So this voice is a
 *     *sample player* on hardware whose other three channels cannot be one, and
 *     it costs a channel rather than adding one.
 *
 * Deliberately absent, and neither is a hardware fact this file disbelieves: the
 * **Hyper Voice** stage, which is a WonderSwan Color addition on ports of its
 * own (`$6A`, `$6B`, `$95`) rather than a mode of this chip; and the
 * **readable output registers** at `$96`–`$9B`, which no reference this project
 * could reach describes and which no model it could compare against implements.
 * This model has no `read` at all, so there is nothing for them to be absent
 * from.
 *
 * Sources:
 * - WSdev wiki — Sound: https://ws.nesdev.org/wiki/Sound
 * - WSdev wiki — Timers: https://ws.nesdev.org/wiki/Timers
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The chip's clock, which is the console's whole master clock.
 *
 * A channel's sample rate is `3072000 / (2048 - divider)`, so the divider counts
 * this clock directly and there is no prescaler anywhere in the path.
 */
export const WS_SOUND_CLOCK_HZ = 3072000;

/** Samples in one channel's waveform, and the bits each of them has. */
export const WS_WAVE_SAMPLES = 32;
export const WS_WAVE_BITS = 4;

/** Bytes one channel's waveform occupies, and the four together. */
export const WS_WAVE_CHANNEL_BYTES = WS_WAVE_SAMPLES / 2;
export const WS_WAVE_BYTES = WS_WAVE_CHANNEL_BYTES * 4;

/** Channels the chip has, and the ones with a generator of their own. */
export const WS_SOUND_CHANNELS = 4;
export const WS_VOICE_CHANNEL = 1;
export const WS_SWEEP_CHANNEL = 2;
export const WS_NOISE_CHANNEL = 3;

/**
 * The sweep's own clock: 375 Hz, which is one step every 8192 master clocks.
 *
 * Stated as clocks rather than as a rate because everything else in this model
 * counts in them, and `3072000 / 375` is exact.
 */
const SWEEP_CLOCKS = WS_SOUND_CLOCK_HZ / 375;

/**
 * How far the noise register is tapped, by mode.
 *
 * Eight positions rather than eight rates: the shift register is fifteen bits
 * and the tap decides how long the sequence is before it repeats, so this is a
 * timbre control and the channel's divider is still its pitch. The lengths the
 * hardware produces are 32767, 1953, 254, 217, 73, 63, 42 and 28.
 */
const NOISE_TAPS: readonly number[] = [14, 10, 13, 4, 8, 6, 9, 11];

/** Ports, as the numbers a program writes in the console's I/O space. */
export const WS_SOUND_REG = {
  CH1_FREQ_LOW: 0x80,
  CH1_FREQ_HIGH: 0x81,
  CH2_FREQ_LOW: 0x82,
  CH2_FREQ_HIGH: 0x83,
  CH3_FREQ_LOW: 0x84,
  CH3_FREQ_HIGH: 0x85,
  CH4_FREQ_LOW: 0x86,
  CH4_FREQ_HIGH: 0x87,
  /** Left volume in the high nibble, right in the low one. */
  CH1_VOLUME: 0x88,
  /** The same, until `$90` bit 5 makes the whole byte a PCM sample instead. */
  CH2_VOLUME: 0x89,
  CH3_VOLUME: 0x8a,
  CH4_VOLUME: 0x8b,
  /** Channel three's sweep: a signed step, and the ticks between steps. */
  SWEEP_STEP: 0x8c,
  SWEEP_TIME: 0x8d,
  /** Channel four's shift register: enable, reset, and the tap. */
  NOISE: 0x8e,
  /** Bits 6–13 of the address the sixty-four bytes of waveform are read from. */
  WAVE_BASE: 0x8f,
  /** The four enables and the three mode bits — the register two streams share. */
  CONTROL: 0x90,
  /** Speaker and headphone enable, and the speaker's attenuation. */
  OUTPUT: 0x91,
  /** Channel two's PCM level: two bits a side, and the voice's only volume. */
  VOICE_VOLUME: 0x94,
} as const;

/** The lowest and highest port this chip decodes, for a bus to route by. */
export const WS_SOUND_PORT_FIRST = 0x80;
export const WS_SOUND_PORT_LAST = 0x9f;

interface Channel {
  /** The eleven-bit divider; the sample rate is the clock over `2048 - this`. */
  frequency: number;
  counter: number;
  enabled: boolean;
  left: number;
  right: number;
  /**
   * The volume register's whole byte, which channel two's PCM voice reads.
   *
   * Kept beside the two nibbles rather than instead of them, because the mode
   * bit that decides which reading applies is in a *different* register and may
   * be written either side of this one.
   */
  volumeByte: number;
  readIndex: number;
}

function newChannel(): Channel {
  return {
    frequency: 0,
    // About to reload rather than a whole period out, for `Huc6280Psg`'s reason:
    // the hardware's power-on counter is undefined, and starting here is what
    // stops a channel's first cycle holding sample zero for a millisecond.
    counter: 1,
    enabled: false,
    left: 0,
    right: 0,
    volumeByte: 0,
    readIndex: 0,
  };
}

/** What the model needs beyond its registers. */
export interface WsSoundOptions {
  /** The console's RAM, which is where the waveforms are. */
  ram?: Uint8Array;
}

/** The WonderSwan's sound hardware, as a register-driven model. */
export class WsSound implements ChipModel {
  readonly id: ChipId = "ws-sound";
  readonly clockHz = WS_SOUND_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly channels: Channel[] = [];
  /** Where the sixty-four bytes of waveform begin: `$8F` shifted into place. */
  private waveBase = 0;
  private sweepStep = 0;
  private sweepTime = 0;
  private sweepCounter = SWEEP_CLOCKS;
  private sweepTicks = 0;
  private sweepEnabled = false;
  private noiseEnabled = false;
  /** Whether channel four plays its shift register rather than its waveform. */
  private noiseSelected = false;
  private noiseTap = 0;
  private lfsr = 1;
  private noiseOutput = 0;

  /**
   * The shift register's current state.
   *
   * Exposed because a sequence *length* is the one thing about this generator
   * that is observable and not a matter of taste, and reading it off the audio
   * cannot distinguish 28 steps from 42 — both are a buzz. `ws-sound.test.ts`
   * walks it against the eight lengths the hardware documents.
   */
  get noiseRegister(): number {
    return this.lfsr;
  }
  private speakerEnabled = true;
  private speakerShift = 0;
  private headphoneEnabled = false;
  private ram: Uint8Array;

  /**
   * Channel two's PCM voice: whether it is on, and the four bits of level.
   *
   * Public because they are the two pieces of this chip's state a caller may
   * legitimately want to inspect — the mode lives in the register two streams
   * share, so "is channel two a voice right now" is a question a driver's own
   * merge has to be able to answer.
   */
  voiceEnabled = false;
  voiceVolume = 0;

  constructor(options: WsSoundOptions = {}) {
    this.ram = options.ram ?? new Uint8Array(0x10000);
    for (let index = 0; index < WS_SOUND_CHANNELS; index += 1) this.channels.push(newChannel());
  }

  /** Point the model at the memory its waveforms are in, after construction. */
  setRam(ram: Uint8Array): void {
    this.ram = ram;
  }

  reset(): void {
    for (let index = 0; index < WS_SOUND_CHANNELS; index += 1) this.channels[index] = newChannel();
    this.waveBase = 0;
    this.sweepStep = 0;
    this.sweepTime = 0;
    this.sweepCounter = SWEEP_CLOCKS;
    this.sweepTicks = 0;
    this.sweepEnabled = false;
    this.noiseEnabled = false;
    this.noiseSelected = false;
    this.noiseTap = 0;
    this.lfsr = 1;
    this.noiseOutput = 0;
    this.speakerEnabled = true;
    this.speakerShift = 0;
    this.headphoneEnabled = false;
    this.voiceEnabled = false;
    this.voiceVolume = 0;
  }

  write(reg: number, value: number): void {
    const byte = value & 0xff;
    const port = reg & 0xff;
    if (port >= WS_SOUND_REG.CH1_FREQ_LOW && port <= WS_SOUND_REG.CH4_FREQ_HIGH) {
      const channel = this.channels[(port - WS_SOUND_REG.CH1_FREQ_LOW) >> 1] as Channel;
      if ((port & 1) === 0) channel.frequency = (channel.frequency & 0x700) | byte;
      else channel.frequency = (channel.frequency & 0x0ff) | ((byte & 0x07) << 8);
      return;
    }
    if (port >= WS_SOUND_REG.CH1_VOLUME && port <= WS_SOUND_REG.CH4_VOLUME) {
      const channel = this.channels[port - WS_SOUND_REG.CH1_VOLUME] as Channel;
      channel.left = (byte >> 4) & 0x0f;
      channel.right = byte & 0x0f;
      channel.volumeByte = byte;
      return;
    }
    switch (port) {
      case WS_SOUND_REG.SWEEP_STEP:
        // Signed: a sweep runs down as well as up, and the register is eight
        // bits of two's complement added to an eleven-bit divider.
        this.sweepStep = (byte << 24) >> 24;
        return;
      case WS_SOUND_REG.SWEEP_TIME:
        // "Ticks per step minus one", and writing it restarts the count — which
        // is why the counter is reset here rather than left to run on.
        this.sweepTime = byte & 0x1f;
        this.sweepTicks = 0;
        this.sweepCounter = SWEEP_CLOCKS;
        return;
      case WS_SOUND_REG.NOISE:
        this.noiseEnabled = (byte & 0x80) !== 0;
        this.noiseTap = byte & 0x07;
        if ((byte & 0x40) !== 0) this.lfsr = 1;
        return;
      case WS_SOUND_REG.WAVE_BASE:
        // Eight bits standing for bits 6–13, so the table is sixty-four-byte
        // aligned and lives in the first sixteen kilobytes. A driver that put it
        // anywhere else would be pointing the chip at a truncated address.
        this.waveBase = (byte & 0xff) << 6;
        return;
      case WS_SOUND_REG.CONTROL:
        for (let index = 0; index < WS_SOUND_CHANNELS; index += 1) {
          (this.channels[index] as Channel).enabled = (byte & (1 << index)) !== 0;
        }
        this.voiceEnabled = (byte & 0x20) !== 0;
        this.sweepEnabled = (byte & 0x40) !== 0;
        // Bit 7 selects noise *instead of* the waveform on channel four; the
        // generator's own enable is `$8E`'s, and the hardware wants both.
        this.noiseSelected = (byte & 0x80) !== 0;
        return;
      case WS_SOUND_REG.OUTPUT:
        this.speakerEnabled = (byte & 0x01) !== 0;
        this.speakerShift = (byte >> 2) & 0x03;
        this.headphoneEnabled = (byte & 0x10) !== 0;
        return;
      case WS_SOUND_REG.VOICE_VOLUME:
        this.voiceVolume = byte & 0x0f;
        return;
      default:
        return;
    }
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

  /** Clocks until the next waveform step, shift-register clock or sweep step. */
  private clocksToEvent(): number {
    let next = Number.MAX_SAFE_INTEGER;
    for (const channel of this.channels) {
      if (!channel.enabled) continue;
      if (channel.counter > 0 && channel.counter < next) next = channel.counter;
    }
    if (this.sweepEnabled && this.sweepCounter > 0 && this.sweepCounter < next) {
      next = this.sweepCounter;
    }
    return next > 0 && next !== Number.MAX_SAFE_INTEGER ? next : 1;
  }

  private advance(clocks: number): void {
    for (const [index, channel] of this.channels.entries()) {
      if (!channel.enabled) continue;
      channel.counter -= clocks;
      while (channel.counter <= 0) {
        channel.counter += divider(channel.frequency);
        channel.readIndex = (channel.readIndex + 1) & (WS_WAVE_SAMPLES - 1);
        // The shift register is clocked by the channel it lives on, so its rate
        // is that channel's divider and not a rate register of its own.
        if (index === WS_NOISE_CHANNEL && this.noiseEnabled) this.clockNoise();
      }
    }
    if (!this.sweepEnabled) return;
    this.sweepCounter -= clocks;
    while (this.sweepCounter <= 0) {
      this.sweepCounter += SWEEP_CLOCKS;
      if (this.sweepTicks > 0) {
        this.sweepTicks -= 1;
        continue;
      }
      this.sweepTicks = this.sweepTime;
      const channel = this.channels[WS_SWEEP_CHANNEL] as Channel;
      channel.frequency = (channel.frequency + this.sweepStep) & 0x7ff;
    }
  }

  /**
   * One step of the fifteen-bit shift register, tapped where the mode says.
   *
   * The feedback is the **inverted** exclusive-or of bit 7 with the tap bit, and
   * both halves of that are load-bearing rather than stylistic: the sequence
   * lengths in {@link NOISE_TAPS}' comment are what the pair produces, and no
   * other reading of "bit 7 and the tap" reproduces them. `ws-sound.test.ts`
   * checks all eight against the documented table, which is the only oracle here
   * that cannot be satisfied by agreeing with ourselves — a generator that
   * XOR-ed the top bit with `14 - tap` instead is white noise on every mode
   * rather than the eight colours the hardware has, and it is what this chip
   * shipped with until Mednafen's own output disagreed with it (doc 16 §The
   * proof, Level B).
   */
  private clockNoise(): void {
    const tap = NOISE_TAPS[this.noiseTap] as number;
    const feedback = 1 ^ (((this.lfsr >> 7) ^ (this.lfsr >> tap)) & 1);
    this.lfsr = ((this.lfsr << 1) | feedback) & 0x7fff;
    this.noiseOutput = feedback;
  }

  /** One channel's current sample, as the four-bit number the chip reads. */
  private sampleOf(index: number, channel: Channel): number {
    if (index === WS_NOISE_CHANNEL && this.noiseSelected) return this.noiseOutput === 1 ? 15 : 0;
    // Two samples a byte, the *low* nibble first — which is the opposite of what
    // a reader expects from "the higher bits specify the later samples" read
    // quickly, and is why this is one line rather than a shift the caller does.
    const at = (this.waveBase + index * WS_WAVE_CHANNEL_BYTES + (channel.readIndex >> 1)) & 0xffff;
    const byte = this.ram[at] ?? 0;
    return (channel.readIndex & 1) === 0 ? byte & 0x0f : (byte >> 4) & 0x0f;
  }

  private levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (const [index, channel] of this.channels.entries()) {
      if (!channel.enabled) continue;
      if (index === WS_VOICE_CHANNEL && this.voiceEnabled) {
        // Eight bits against the wavetable path's four times four, which lands
        // a voice at full level slightly *louder* than a channel at volume
        // fifteen — as it is on the hardware, where the two share one mixer.
        // The channel's divider keeps running underneath; only what is heard
        // changes, so switching the mode off mid-note resumes the waveform
        // where it would have been rather than where it was left.
        left += voiceLevel(channel.volumeByte, (this.voiceVolume >> 2) & 0x03);
        right += voiceLevel(channel.volumeByte, this.voiceVolume & 0x03);
        continue;
      }
      // Four bits centred at eight: the sample is unsigned and the chip subtracts
      // the midpoint, so a flat waveform of eight is silence rather than a click.
      const signed = this.sampleOf(index, channel) - 8;
      left += signed * channel.left;
      right += signed * channel.right;
    }
    // The speaker's attenuator is a shift and it does not touch the headphone
    // path; a demade cartridge enables the headphones, so this is the mix the
    // chip presents when anything is listening.
    const shift = this.headphoneEnabled ? 0 : this.speakerEnabled ? this.speakerShift : 4;
    // Four channels of ±8 at a volume of 15 is nominal full scale.
    const scale = WS_SOUND_CHANNELS * 8 * 15 * (1 << shift);
    return [left / scale, right / scale];
  }
}

/** The chip steps a waveform sample every `2048 - divider` clocks. */
function divider(frequency: number): number {
  return 2048 - (frequency & 0x7ff);
}

/**
 * One side of the PCM voice, from its sample byte and that side's two bits.
 *
 * The two bits are not a two-bit number: the higher one is full level and the
 * lower one is half, and full wins — so `3` and `2` sound the same and only `0`
 * is silence. Halving happens *before* the midpoint is taken away, because the
 * chip halves the unsigned byte it was handed, which is why the two branches
 * subtract different numbers rather than sharing one and scaling after.
 *
 * The two models this project could compare against disagree about which bit of
 * each pair is which, so this follows the newer one; the choice is only audible
 * on a value of one or two, and never on the three or the zero a driver setting
 * a level would write.
 */
function voiceLevel(sample: number, bits: number): number {
  const byte = sample & 0xff;
  if ((bits & 0x02) !== 0) return byte - 0x80;
  if ((bits & 0x01) !== 0) return (byte >> 1) - 0x40;
  return 0;
}
