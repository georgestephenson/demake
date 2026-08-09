/**
 * The Virtual Boy's sound hardware — the VSU.
 *
 * Six channels, and five of them are wavetables: thirty-two **six-bit** samples
 * apiece, stepped at a rate an eleven-bit divider sets. That is the PC Engine's
 * arrangement with the WonderSwan's channel count and a bit more depth than
 * either — and three things this chip has that no other wavetable part in the
 * matrix does.
 *
 *   - **The waveforms are a shared pool of five, not one per channel.** A
 *     channel names a table in `SxRAM`, so two voices can play the same timbre
 *     without a second copy of it, and a fifth table exists for a fifth
 *     *sound* rather than a fifth channel. That is why {@link VSU_WAVE_TABLES}
 *     is five where the channel count is six: the noise voice has no waveform at
 *     all.
 *   - **Every channel has a hardware envelope**, four bits stepping up or down
 *     on its own clock, with a repeat bit. The Game Boy's has one direction and
 *     no repeat; the PC Engine's and the WonderSwan's have none at all. So a
 *     note's *shape* here is a register rather than something a driver writes
 *     every tick, which is what makes this chip cheap to drive.
 *   - **Channel five can modulate as well as sweep**, from a table of
 *     thirty-two signed steps applied to the frequency register itself. A sweep
 *     is a shift-and-add repeated; a modulation is that table walked once or for
 *     ever. One bit chooses between them and the rest of the register is shared,
 *     which is why they are one counter here rather than two.
 *
 * A fourth thing is worth stating because it decides what a *driver* looks like:
 * **nothing on this chip is shared between channels.** Panning is two nibbles in
 * the channel's own register, enabling is the channel's own bit 7, and the one
 * global register — `SSTOP` — is a panic button rather than a mixer. So a
 * console whose music and effects share this chip emits no merge routine at all,
 * which puts it with the Master System, the Mega Drive, the PC Engine, the
 * Nintendo DS and the Neo Geo Pocket rather than with the Game Boy.
 *
 * Deliberately absent: the **`SxINT` auto-deactivate** interval is modelled, but
 * the chip's own *envelope-driven* channel shutdown on `S6EV1` bit 1 for the
 * noise voice is treated as the repeat bit it is on every other channel, because
 * no reference this project could reach distinguishes them; and there is no
 * `read`, because nothing on this chip reads back.
 *
 * Sources: the Virtual Boy *Sacred Tech Scroll* (`vbtech`, David Tucker) — VSU
 * register map, waveform and modulation table layout, envelope and sweep timing;
 * Planet Virtual Boy — *Sound* wiki page.
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The chip's clock, in hertz.
 *
 * Five megahertz — the console's twenty divided by four — and a channel steps
 * one waveform sample every `2048 - frequency` of them, so a whole cycle of
 * thirty-two samples is `32 × (2048 - F)` clocks and the note is
 * `5000000 / (32 × (2048 - F))` hertz.
 */
export const VSU_CLOCK_HZ = 5_000_000;

/** Channels the chip has. */
export const VSU_CHANNELS = 6;

/** Waveform tables the chip holds, and the samples and bits of each. */
export const VSU_WAVE_TABLES = 5;
export const VSU_WAVE_SAMPLES = 32;
export const VSU_WAVE_BITS = 6;

/** The one channel that can sweep or modulate, and the one that can be noise. */
export const VSU_MOD_CHANNEL = 4;
export const VSU_NOISE_CHANNEL = 5;

/** Bytes one waveform table occupies in the chip's address space. */
export const VSU_TABLE_STRIDE = 0x80;

/** Where each region begins, as a byte offset from the chip's base. */
export const VSU_WAVE_BASE = 0x000;
export const VSU_MOD_BASE = 0x280;
export const VSU_CHANNEL_BASE = 0x400;
export const VSU_CHANNEL_STRIDE = 0x40;
export const VSU_SSTOP = 0x580;

/** A channel register, as its offset within the channel's own block. */
export const VSU_REG = {
  /** Enable in bit 7, auto-deactivate in bit 5, and its interval in bits 4–0. */
  INT: 0x00,
  /** Left level in the high nibble, right in the low one. */
  LRV: 0x04,
  /** The frequency divider's low eight bits. */
  FQL: 0x08,
  /** Its high three. */
  FQH: 0x0c,
  /** Initial envelope value, direction and step interval. */
  EV0: 0x10,
  /** Envelope enable and repeat — and, on two channels, a mode bit of their own. */
  EV1: 0x14,
  /** Which of the five waveform tables this channel plays. */
  RAM: 0x18,
  /** Channel five's sweep and modulation control. */
  SWP: 0x1c,
} as const;

/**
 * Clocks in one envelope step interval, and in the two sweep intervals.
 *
 * The reference gives these as milliseconds — 3.84 for the envelope, 0.96 and
 * 7.68 for the sweep's two clock selections — and at five megahertz all three
 * are whole numbers of clocks, which is why they are written as clocks here:
 * a model that rounded a millisecond would drift over a track.
 */
const ENVELOPE_CLOCKS = 19_200;
const SWEEP_FAST_CLOCKS = 4_800;
const SWEEP_SLOW_CLOCKS = 38_400;

/**
 * How far the noise register is tapped, by mode.
 *
 * Eight positions in a fifteen-bit shift register, exactly as the WonderSwan's —
 * the tap decides how long the sequence runs before it repeats, so it is a
 * timbre control and the channel's own divider is still its pitch.
 */
const NOISE_TAPS: readonly number[] = [14, 10, 13, 4, 8, 6, 9, 11];

interface Channel {
  enabled: boolean;
  /** The eleven-bit divider; a sample lasts `2048 - this` clocks. */
  frequency: number;
  counter: number;
  readIndex: number;
  left: number;
  right: number;
  /** Which of the five tables this channel reads. */
  table: number;

  /** The envelope: its current value, where it started, and how it moves. */
  envelope: number;
  envelopeReload: number;
  envelopeUp: boolean;
  envelopeInterval: number;
  envelopeCounter: number;
  envelopeEnabled: boolean;
  envelopeRepeat: boolean;

  /** The auto-deactivate interval, and the counter running it down. */
  intervalEnabled: boolean;
  intervalData: number;
  intervalCounter: number;
}

function newChannel(): Channel {
  return {
    enabled: false,
    frequency: 0,
    // About to reload rather than a whole period out, for `Huc6280Psg`'s reason:
    // the hardware's power-on counter is undefined, and starting here is what
    // stops a channel's first cycle holding sample zero for a millisecond.
    counter: 1,
    readIndex: 0,
    left: 0,
    right: 0,
    table: 0,
    envelope: 0,
    envelopeReload: 0,
    envelopeUp: false,
    envelopeInterval: 0,
    envelopeCounter: ENVELOPE_CLOCKS,
    envelopeEnabled: false,
    envelopeRepeat: false,
    intervalEnabled: false,
    intervalData: 0,
    intervalCounter: ENVELOPE_CLOCKS,
  };
}

/** The Virtual Boy's sound hardware, as a register-driven model. */
export class Vsu implements ChipModel {
  readonly id: ChipId = "vsu";
  readonly clockHz = VSU_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  /** Five tables of thirty-two six-bit samples. */
  readonly waves: Uint8Array[] = [];

  /** Thirty-two signed steps channel five's modulation walks. */
  readonly modulation = new Int8Array(VSU_WAVE_SAMPLES);

  private readonly channels: Channel[] = [];

  /** Channel five's sweep and modulation state. */
  private modEnabled = false;
  /** False is a sweep, true is the table — one bit, and the rest is shared. */
  private modSelect = false;
  private modRepeat = false;
  private modShift = 0;
  private modUp = false;
  private modInterval = 0;
  private modClocks = SWEEP_FAST_CLOCKS;
  private modCounter = SWEEP_FAST_CLOCKS;
  private modIndex = 0;
  /** The frequency the sweep is working on, which `FQL`/`FQH` reload. */
  private modFrequency = 0;
  private modDone = false;

  /** Channel six's shift register and the tap that feeds it. */
  private lfsr = 1;
  private noiseTap = 0;
  private noiseOutput = 0;

  constructor() {
    for (let index = 0; index < VSU_WAVE_TABLES; index += 1) {
      this.waves.push(new Uint8Array(VSU_WAVE_SAMPLES));
    }
    for (let index = 0; index < VSU_CHANNELS; index += 1) this.channels.push(newChannel());
  }

  reset(): void {
    for (const wave of this.waves) wave.fill(0);
    this.modulation.fill(0);
    for (let index = 0; index < VSU_CHANNELS; index += 1) this.channels[index] = newChannel();
    this.modEnabled = false;
    this.modSelect = false;
    this.modRepeat = false;
    this.modShift = 0;
    this.modUp = false;
    this.modInterval = 0;
    this.modClocks = SWEEP_FAST_CLOCKS;
    this.modCounter = SWEEP_FAST_CLOCKS;
    this.modIndex = 0;
    this.modFrequency = 0;
    this.modDone = false;
    this.lfsr = 1;
    this.noiseTap = 0;
    this.noiseOutput = 0;
  }

  /**
   * Apply a register write.
   *
   * `reg` is the **byte offset from the chip's base**, which is what a schedule's
   * register number is on this console: the waveform tables, the modulation table
   * and the six channel blocks are one address space rather than a port and an
   * index, so an offset is the only numbering that names all of them.
   */
  write(reg: number, value: number): void {
    const at = reg & 0x7ff;
    const byte = value & 0xff;

    if (at < VSU_MOD_BASE) {
      // Waveform RAM: one sample every four bytes, six bits of each.
      if ((at & 3) !== 0) return;
      const table = (at / VSU_TABLE_STRIDE) | 0;
      const index = ((at % VSU_TABLE_STRIDE) >> 2) & (VSU_WAVE_SAMPLES - 1);
      (this.waves[table] as Uint8Array)[index] = byte & 0x3f;
      return;
    }
    if (at < VSU_CHANNEL_BASE) {
      if (at >= VSU_MOD_BASE + VSU_WAVE_SAMPLES * 4 || (at & 3) !== 0) return;
      this.modulation[(at - VSU_MOD_BASE) >> 2] = (byte << 24) >> 24;
      return;
    }
    if (at === VSU_SSTOP) {
      // The one global register, and it is a panic button rather than a mixer:
      // bit 0 turns every channel off and nothing else.
      if ((byte & 1) !== 0) for (const channel of this.channels) channel.enabled = false;
      return;
    }

    const index = ((at - VSU_CHANNEL_BASE) / VSU_CHANNEL_STRIDE) | 0;
    if (index >= VSU_CHANNELS) return;
    const channel = this.channels[index] as Channel;
    switch ((at - VSU_CHANNEL_BASE) % VSU_CHANNEL_STRIDE) {
      case VSU_REG.INT:
        channel.enabled = (byte & 0x80) !== 0;
        channel.intervalEnabled = (byte & 0x20) !== 0;
        channel.intervalData = byte & 0x1f;
        channel.intervalCounter = ENVELOPE_CLOCKS;
        if ((byte & 0x80) !== 0) {
          // Enabling restarts the voice: the waveform from its first sample and
          // the envelope from the value `EV0` last named. That is what makes a
          // note-on one register write on this chip.
          channel.readIndex = 0;
          channel.counter = 1;
          channel.envelope = channel.envelopeReload;
          channel.envelopeCounter = ENVELOPE_CLOCKS;
          if (index === VSU_MOD_CHANNEL) {
            this.modIndex = 0;
            this.modDone = false;
            this.modCounter = this.modClocks;
            this.modFrequency = channel.frequency;
          }
        }
        return;
      case VSU_REG.LRV:
        channel.left = (byte >> 4) & 0x0f;
        channel.right = byte & 0x0f;
        return;
      case VSU_REG.FQL:
        channel.frequency = (channel.frequency & 0x700) | byte;
        if (index === VSU_MOD_CHANNEL) this.modFrequency = channel.frequency;
        return;
      case VSU_REG.FQH:
        channel.frequency = (channel.frequency & 0x0ff) | ((byte & 0x07) << 8);
        if (index === VSU_MOD_CHANNEL) this.modFrequency = channel.frequency;
        return;
      case VSU_REG.EV0:
        channel.envelopeReload = (byte >> 4) & 0x0f;
        channel.envelope = channel.envelopeReload;
        channel.envelopeUp = (byte & 0x08) !== 0;
        channel.envelopeInterval = byte & 0x07;
        channel.envelopeCounter = ENVELOPE_CLOCKS;
        return;
      case VSU_REG.EV1:
        channel.envelopeEnabled = (byte & 0x01) !== 0;
        channel.envelopeRepeat = (byte & 0x02) !== 0;
        if (index === VSU_MOD_CHANNEL) {
          this.modEnabled = (byte & 0x40) !== 0;
          this.modSelect = (byte & 0x20) !== 0;
        }
        if (index === VSU_NOISE_CHANNEL) this.noiseTap = (byte >> 4) & 0x07;
        return;
      case VSU_REG.RAM:
        channel.table = byte % VSU_WAVE_TABLES;
        return;
      case VSU_REG.SWP:
        if (index !== VSU_MOD_CHANNEL) return;
        this.modClocks = (byte & 0x80) !== 0 ? SWEEP_SLOW_CLOCKS : SWEEP_FAST_CLOCKS;
        this.modInterval = (byte >> 4) & 0x07;
        this.modUp = (byte & 0x08) !== 0;
        this.modShift = byte & 0x07;
        this.modCounter = this.modClocks;
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

  /** Clocks until the next waveform step, envelope step, sweep step or timeout. */
  private clocksToEvent(): number {
    let next = Number.MAX_SAFE_INTEGER;
    const take = (value: number): void => {
      if (value > 0 && value < next) next = value;
    };
    for (const channel of this.channels) {
      if (!channel.enabled) continue;
      take(channel.counter);
      if (channel.envelopeEnabled) take(channel.envelopeCounter);
      if (channel.intervalEnabled) take(channel.intervalCounter);
    }
    if (this.modEnabled && !this.modDone) take(this.modCounter);
    return next === Number.MAX_SAFE_INTEGER ? 1 : next;
  }

  private advance(clocks: number): void {
    for (const [index, channel] of this.channels.entries()) {
      if (!channel.enabled) continue;
      channel.counter -= clocks;
      while (channel.counter <= 0) {
        channel.counter += 2048 - (channel.frequency & 0x7ff);
        channel.readIndex = (channel.readIndex + 1) & (VSU_WAVE_SAMPLES - 1);
        // The shift register is clocked by the channel it lives on, so its rate
        // is that channel's divider and not a rate register of its own — the
        // WonderSwan's arrangement.
        if (index === VSU_NOISE_CHANNEL) this.clockNoise();
      }
      this.advanceEnvelope(channel, clocks);
      this.advanceInterval(channel, clocks);
    }
    this.advanceModulation(clocks);
  }

  private advanceEnvelope(channel: Channel, clocks: number): void {
    if (!channel.envelopeEnabled) return;
    channel.envelopeCounter -= clocks;
    while (channel.envelopeCounter <= 0) {
      channel.envelopeCounter += ENVELOPE_CLOCKS * (channel.envelopeInterval + 1);
      if (channel.envelopeUp) {
        if (channel.envelope < 15) channel.envelope += 1;
        else if (channel.envelopeRepeat) channel.envelope = channel.envelopeReload;
      } else if (channel.envelope > 0) {
        channel.envelope -= 1;
      } else if (channel.envelopeRepeat) {
        channel.envelope = channel.envelopeReload;
      }
    }
  }

  /** The auto-deactivate timer: a channel that names one turns itself off. */
  private advanceInterval(channel: Channel, clocks: number): void {
    if (!channel.intervalEnabled) return;
    channel.intervalCounter -= clocks;
    while (channel.intervalCounter <= 0) {
      channel.intervalCounter += ENVELOPE_CLOCKS * (channel.intervalData + 1);
      channel.enabled = false;
    }
  }

  /**
   * Channel five's sweep or modulation, which share one counter and one enable.
   *
   * A **sweep** shifts the current frequency right by `shift` and adds or
   * subtracts it, which is a geometric glide; a **modulation** adds the next
   * signed byte of the table to the frequency the channel was *enabled* with,
   * which is a fixed contour. The difference is one bit and it is worth the two
   * branches, because the two are not approximations of each other.
   */
  private advanceModulation(clocks: number): void {
    if (!this.modEnabled || this.modDone) return;
    const channel = this.channels[VSU_MOD_CHANNEL] as Channel;
    this.modCounter -= clocks;
    while (this.modCounter <= 0) {
      this.modCounter += this.modClocks * (this.modInterval + 1);
      if (this.modSelect) {
        const step = this.modulation[this.modIndex] as number;
        channel.frequency = (this.modFrequency + step) & 0x7ff;
        this.modIndex += 1;
        if (this.modIndex >= VSU_WAVE_SAMPLES) {
          this.modIndex = 0;
          if (!this.modRepeat) this.modDone = true;
        }
      } else {
        const delta = channel.frequency >> this.modShift;
        const next = this.modUp ? channel.frequency + delta : channel.frequency - delta;
        // The hardware stops rather than wrapping: a sweep that reaches either
        // end of the divider has nowhere to go, and a model that wrapped would
        // turn a glide into a siren.
        if (next < 0 || next > 0x7ff) this.modDone = true;
        else channel.frequency = next;
      }
    }
  }

  /**
   * One step of the fifteen-bit shift register, tapped where the mode says.
   *
   * The WonderSwan's arrangement to the bit — same register width, same eight
   * tap positions, same sequence lengths — which is why this is the same three
   * lines rather than a second formulation of them.
   */
  private clockNoise(): void {
    const tap = NOISE_TAPS[this.noiseTap] as number;
    const feedback = ((this.lfsr >> 14) ^ (this.lfsr >> (14 - tap))) & 1;
    this.lfsr = ((this.lfsr << 1) | feedback) & 0x7fff;
    this.noiseOutput = feedback;
  }

  /** One channel's current sample, as the six-bit number the chip reads. */
  private sampleOf(index: number, channel: Channel): number {
    if (index === VSU_NOISE_CHANNEL) return this.noiseOutput === 1 ? 0x3f : 0;
    return (this.waves[channel.table] as Uint8Array)[channel.readIndex] as number;
  }

  private levels(): [number, number] {
    let left = 0;
    let right = 0;
    for (const [index, channel] of this.channels.entries()) {
      if (!channel.enabled) continue;
      // Six bits centred at thirty-two: the sample is unsigned and a flat
      // waveform is silence rather than a step, which is `ws-sound.ts`'s
      // reasoning at four times the depth. The offset the hardware's DAC really
      // carries is what `mix.ts`'s blocker removes either way.
      const signed = this.sampleOf(index, channel) - 32;
      const scaled = signed * channel.envelope;
      left += scaled * channel.left;
      right += scaled * channel.right;
    }
    // Six channels of ±32 at an envelope and a level of fifteen is full scale.
    const scale = VSU_CHANNELS * 32 * 15 * 15;
    return [left / scale, right / scale];
  }

  /** Where one channel's registers begin, as an offset from the chip's base. */
  static channelBase(index: number): number {
    return VSU_CHANNEL_BASE + index * VSU_CHANNEL_STRIDE;
  }

  /** Where one waveform table begins. */
  static waveBase(table: number): number {
    return VSU_WAVE_BASE + table * VSU_TABLE_STRIDE;
  }
}
