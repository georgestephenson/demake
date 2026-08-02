/**
 * The Nintendo DS's sound hardware — `nds-spu`.
 *
 * Sixteen channels, and they are the widest palette in the set by a factor of
 * three. Every one of them is a **sample player** first: a source address, a
 * length, a loop point and a timer that clocks one sample out per period. Six of
 * them (8–13) can be switched to a square-wave generator with a duty instead, and
 * the last two (14–15) to a noise shift register — so the chip is an S-DSP and a
 * Game Boy APU on one die, with the sample half four voices wider than a Super
 * Nintendo's and the tone half two voices wider than a Game Boy's.
 *
 * Four things run through everything above this file:
 *
 *   - **The channel is its own clock.** There is no shared sample rate: each
 *     channel reloads a sixteen-bit timer at {@link NDS_SPU_CLOCK_HZ} and steps
 *     when it overflows, so `f = clock / (0x10000 − TMR)` is a *sample* rate for
 *     a PCM channel, an eighth of a square wave's frequency for a PSG one, and a
 *     shift for the noise generator. One divider lattice, three meanings, and
 *     which one applies is the channel's format.
 *   - **A schedule is not enough on its own.** "Play the waveform at `$23807C0`"
 *     means nothing without the waveform, so the model is handed the memory it
 *     reads from and `ChipScript` carries it — the S-DSP's arrangement, reached
 *     by hardware that reads main RAM rather than a private 64 KiB.
 *   - **Panning is a level, not a switch.** Seven bits of position per channel,
 *     which no other chip here has: a Game Boy's `NR51` is one bit each way and
 *     an SN76489 has none at all. It is also *per channel*, so there is no shared
 *     byte two streams could erase for each other — the driver merges nothing.
 *   - **Nothing here is shared between channels** but the master volume and the
 *     enable, which is why the whole preemption story on this console is a
 *     question of which channels an effect took.
 *
 * **What is deliberately absent**, on the terms `@demake/snes`'s renderer and the
 * S-DSP's echo unit set (AGENTS.md §Iron rules — a gap is named, never
 * half-implemented):
 *
 *   - **IMA-ADPCM (format 2).** The register is stored and the channel is
 *     silent. It is a decoder with an eighty-nine-entry step table, and a table
 *     transcribed with one entry wrong is worse than a format that says it is not
 *     there; nothing demake emits asks for it, because the built-in bank is
 *     eight-bit PCM.
 *   - **The two capture units and `SOUNDBIAS`.** Capture writes the mixer's
 *     output back into memory, which is a feature for a game recording the
 *     microphone; a demade cartridge never programs one.
 *   - **The hold bit**, which decides whether a channel that has run out keeps
 *     its last sample or falls to zero. Every waveform here loops, so nothing
 *     ever runs out.
 *
 * **The one place this is not the hardware** is the output stage. A real SPU
 * mixes its sixteen channels into a 32.7 kHz stereo pair and the DACs run from
 * that; this model sums the channels continuously and lets the sink integrate
 * exactly (`types.ts` §box integration), so what is missing is one resampling
 * step. It affects timbre only — doc 16's Level A proof compares register writes,
 * which are unaffected — and it is stated rather than approximated, for the same
 * reason the S-DSP's Gaussian window is.
 *
 * Sources: GBATEK — *DS Sound Channels*, *DS Sound Control Registers*
 * (https://problemkaputt.de/gbatek.htm#dssound).
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The rate a channel's timer counts at: half the 33.513982 MHz system clock.
 *
 * Every pitch on this console divides it, so it is the one number the spec's
 * lattices, the binding's timer values and this model's clock are three
 * statements of. It is exact — 33513982 is even — which is what keeps
 * `f = clock / period` a rational rather than a rounding.
 */
export const NDS_SPU_CLOCK_HZ = 16756991;

/** Channels. Not a configuration: the register map is laid out around it. */
export const NDS_SPU_CHANNELS = 16;

/** Bytes one channel's registers occupy, which is also how far apart they are. */
export const NDS_CHANNEL_STRIDE = 16;

/**
 * The first channel that can generate a square wave rather than play a sample.
 *
 * 8–13 have a duty generator and 14–15 have the noise shift register; 0–7 have
 * neither and are sample players whatever their format field says. That is the
 * hardware's own division and it is why the spec declares three kinds of channel.
 */
export const NDS_FIRST_PSG_CHANNEL = 8;
/** The first channel whose PSG mode is noise rather than a duty. */
export const NDS_FIRST_NOISE_CHANNEL = 14;

/** Register numbers inside a channel, as byte offsets from its base. */
export const NDS_CH = {
  /** Volume multiplier, 0–127. */
  volume: 0,
  /** Volume divider: 0 = ÷1, 1 = ÷2, 2 = ÷4, 3 = ÷16. */
  divider: 1,
  /** Panning, 0 = hard left, 64 = centre, 127 = hard right. */
  panning: 2,
  /** Duty (0–2), repeat mode (3–4), format (5–6) and the start bit (7). */
  control: 3,
  /** Source address, four bytes, little-endian. */
  source: 4,
  /** Timer reload, two bytes; the period is `$10000 −` this. */
  timer: 8,
  /** Loop start, two bytes, in words. */
  loop: 10,
  /** Length after the loop point, four bytes, in words. */
  length: 12,
} as const;

/** `SOUNDCNT`, which is at `$4000500` on the hardware and past the channels here. */
export const NDS_SOUNDCNT = 0x100;
/** Master volume, 0–127, in `SOUNDCNT`'s low byte. */
export const NDS_MASTER_VOLUME = NDS_SOUNDCNT;
/** The master enable is bit 15, which is the third byte of the word. */
export const NDS_MASTER_ENABLE = NDS_SOUNDCNT + 1;

/** One past the highest register the file holds. */
export const NDS_SPU_REGISTERS = NDS_SOUNDCNT + 4;

/** What a channel's format field selects. */
const FORMAT = { pcm8: 0, pcm16: 1, adpcm: 2, psg: 3 } as const;

/** What the volume divider field divides by, as a shift. */
const DIVIDER_SHIFT = [0, 1, 2, 4] as const;

/** One channel's state, beyond the registers themselves. */
interface Channel {
  /** Whether the start bit is set and the channel has something to play. */
  playing: boolean;
  /** Chip clocks until the next sample, duty step or shift. */
  until: number;
  /** Sample index into the source, for a channel playing one. */
  position: number;
  /** Where the duty generator is in its eight-step cycle. */
  phase: number;
  /** The noise generator's shift register. */
  lfsr: number;
  /** The level the channel is holding, −0x8000…0x7FFF before volume. */
  sample: number;
}

function newChannel(): Channel {
  return { playing: false, until: 0, position: 0, phase: 0, lfsr: 0x7fff, sample: 0 };
}

/** What the model needs beyond its registers. */
export interface NdsSpuOptions {
  /**
   * The memory the channels read their waveforms out of.
   *
   * Main RAM on the hardware, and a source address is an absolute address into
   * it — so the model is told where the array starts as well as what is in it. A
   * channel pointed outside it plays silence, which is what a bus that answers
   * with nothing does.
   */
  ram?: Uint8Array;
  /** The address {@link NdsSpuOptions.ram}'s first byte answers at. */
  ramBase?: number;
}

/** Where main RAM starts, and therefore what a source address is measured from. */
export const NDS_RAM_BASE = 0x02000000;

/** The Nintendo DS's sound hardware, as a register-driven model. */
export class NdsSpu implements ChipModel {
  readonly id: ChipId = "nds-spu";
  readonly clockHz = NDS_SPU_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly reg = new Uint8Array(NDS_SPU_REGISTERS);
  private readonly channels: Channel[] = Array.from({ length: NDS_SPU_CHANNELS }, newChannel);
  private ram: Uint8Array;
  private ramBase: number;
  private left = 0;
  private right = 0;

  constructor(options: NdsSpuOptions = {}) {
    this.ram = options.ram ?? new Uint8Array(0);
    this.ramBase = options.ramBase ?? NDS_RAM_BASE;
    this.reset();
  }

  /** Point the model at the memory its channels read, after construction. */
  setRam(ram: Uint8Array, base = NDS_RAM_BASE): void {
    this.ram = ram;
    this.ramBase = base;
  }

  reset(): void {
    this.reg.fill(0);
    for (let index = 0; index < NDS_SPU_CHANNELS; index += 1) {
      this.channels[index] = newChannel();
    }
    this.left = 0;
    this.right = 0;
  }

  write(reg: number, value: number): void {
    const address = reg & 0x1ff;
    if (address >= NDS_SPU_REGISTERS) return;
    const byte = value & 0xff;
    this.reg[address] = byte;
    if (address >= NDS_SOUNDCNT) {
      this.remix();
      return;
    }
    const index = (address / NDS_CHANNEL_STRIDE) | 0;
    if (address % NDS_CHANNEL_STRIDE === NDS_CH.control) this.control(index, byte);
    this.remix();
  }

  read(reg: number): number {
    const address = reg & 0x1ff;
    return address < NDS_SPU_REGISTERS ? (this.reg[address] as number) : 0;
  }

  /**
   * The start bit, which is the only register write with a side effect.
   *
   * A rising edge restarts the channel from the beginning of its source — that is
   * what "start" means on this hardware, and it is what makes a note-on one byte.
   * A falling one stops it where it stands.
   */
  private control(index: number, byte: number): void {
    const channel = this.channels[index] as Channel;
    const start = (byte & 0x80) !== 0;
    if (!start) {
      channel.playing = false;
      channel.sample = 0;
      return;
    }
    if (channel.playing) return;
    channel.playing = true;
    channel.position = 0;
    channel.phase = 0;
    channel.lfsr = 0x7fff;
    channel.until = this.period(index);
    channel.sample = this.fetch(index);
  }

  /** Chip clocks between one step of a channel and the next. */
  private period(index: number): number {
    const base = index * NDS_CHANNEL_STRIDE;
    const timer =
      (this.reg[base + NDS_CH.timer] as number) |
      ((this.reg[base + NDS_CH.timer + 1] as number) << 8);
    return 0x10000 - timer;
  }

  /** A channel's format, which decides what a step does. */
  private formatOf(index: number): number {
    const control = this.reg[index * NDS_CHANNEL_STRIDE + NDS_CH.control] as number;
    const format = (control >> 5) & 3;
    // Only the last eight channels have a generator to switch to; on the first
    // eight the field selects a sample format and 3 is not one of them, which the
    // hardware answers with silence rather than with a square wave.
    if (format === FORMAT.psg && index < NDS_FIRST_PSG_CHANNEL) return FORMAT.adpcm;
    return format;
  }

  /** The level a channel is producing right now, before volume and panning. */
  private fetch(index: number): number {
    const base = index * NDS_CHANNEL_STRIDE;
    const channel = this.channels[index] as Channel;
    const format = this.formatOf(index);
    if (format === FORMAT.psg) {
      if (index >= NDS_FIRST_NOISE_CHANNEL) return (channel.lfsr & 1) !== 0 ? -0x7fff : 0x7fff;
      const duty = (this.reg[base + NDS_CH.control] as number) & 7;
      // Eight steps to a cycle, high for the last `7 − duty` of them. Duty 7 is
      // therefore a constant, which is what GBATEK's table calls 0%: a level that
      // never moves is silence to a listener whichever rail it sits on.
      return channel.phase >= 7 - duty ? 0x7fff : -0x7fff;
    }
    if (format === FORMAT.adpcm) return 0;
    const source = this.sourceAddress(index) - this.ramBase;
    if (format === FORMAT.pcm16) {
      const at = source + channel.position * 2;
      if (at < 0 || at + 1 >= this.ram.length) return 0;
      const raw = (this.ram[at] as number) | ((this.ram[at + 1] as number) << 8);
      return (raw << 16) >> 16;
    }
    const at = source + channel.position;
    if (at < 0 || at >= this.ram.length) return 0;
    // Eight-bit PCM is the top byte of a sixteen-bit sample, which is what the
    // hardware's own shift does and what keeps one scale for both formats.
    return (((this.ram[at] as number) << 24) >> 24) << 8;
  }

  private sourceAddress(index: number): number {
    const base = index * NDS_CHANNEL_STRIDE + NDS_CH.source;
    return (
      ((this.reg[base] as number) |
        ((this.reg[base + 1] as number) << 8) |
        ((this.reg[base + 2] as number) << 16) |
        ((this.reg[base + 3] as number) << 24)) >>>
      0
    );
  }

  /** Samples in a channel's source, and where a loop returns to. */
  private extent(index: number): { loop: number; end: number } {
    const base = index * NDS_CHANNEL_STRIDE;
    const words =
      (this.reg[base + NDS_CH.loop] as number) |
      ((this.reg[base + NDS_CH.loop + 1] as number) << 8);
    const length =
      ((this.reg[base + NDS_CH.length] as number) |
        ((this.reg[base + NDS_CH.length + 1] as number) << 8) |
        ((this.reg[base + NDS_CH.length + 2] as number) << 16)) >>>
      0;
    // Both fields count *words*, whatever the format is, which is why a PCM8
    // source holds four samples per unit and a PCM16 one holds two.
    const perWord = this.formatOf(index) === FORMAT.pcm16 ? 2 : 4;
    return { loop: words * perWord, end: (words + length) * perWord };
  }

  /** Advance one channel by one step of whatever it is doing. */
  private step(index: number): void {
    const channel = this.channels[index] as Channel;
    const format = this.formatOf(index);
    if (format === FORMAT.psg) {
      if (index >= NDS_FIRST_NOISE_CHANNEL) {
        // Fifteen bits, tapped at 1 and 0 — the Game Boy's long mode, on hardware
        // three generations later.
        const carry = channel.lfsr & 1;
        channel.lfsr = channel.lfsr >> 1;
        if (carry !== 0) channel.lfsr ^= 0x6000;
      } else {
        channel.phase = (channel.phase + 1) & 7;
      }
      channel.sample = this.fetch(index);
      return;
    }
    channel.position += 1;
    const { loop, end } = this.extent(index);
    if (channel.position >= end) {
      const repeat = ((this.reg[index * NDS_CHANNEL_STRIDE + NDS_CH.control] as number) >> 3) & 3;
      if (repeat === 1) {
        channel.position = loop;
      } else {
        // Every other repeat mode is a one-shot: the hardware clears the start
        // bit itself, which is how a driver can ask whether a sound has finished.
        channel.playing = false;
        channel.sample = 0;
        this.reg[index * NDS_CHANNEL_STRIDE + NDS_CH.control] =
          (this.reg[index * NDS_CHANNEL_STRIDE + NDS_CH.control] as number) & 0x7f;
        return;
      }
    }
    channel.sample = this.fetch(index);
  }

  /**
   * Recompute the stereo pair every channel is contributing to.
   *
   * Called whenever anything that could change it changes — a register write or a
   * channel step — rather than once per output sample, because the sink
   * integrates a level held over a span and the span is exactly "until the next
   * thing happens".
   */
  private remix(): void {
    let left = 0;
    let right = 0;
    const enabled = ((this.reg[NDS_MASTER_ENABLE] as number) & 0x80) !== 0;
    if (enabled) {
      for (let index = 0; index < NDS_SPU_CHANNELS; index += 1) {
        const channel = this.channels[index] as Channel;
        if (!channel.playing) continue;
        const base = index * NDS_CHANNEL_STRIDE;
        const volume = (this.reg[base + NDS_CH.volume] as number) & 0x7f;
        if (volume === 0) continue;
        const shift = DIVIDER_SHIFT[(this.reg[base + NDS_CH.divider] as number) & 3] as number;
        const value = (channel.sample * volume) >> (7 + shift);
        const pan = (this.reg[base + NDS_CH.panning] as number) & 0x7f;
        // 0 is hard left and 127 hard right, so the two sides are the position's
        // complement and the position — and 64 is the half each side the hardware
        // documents as centre.
        left += (value * (128 - pan)) >> 7;
        right += (value * pan) >> 7;
      }
      const master = (this.reg[NDS_MASTER_VOLUME] as number) & 0x7f;
      left = (left * master) >> 7;
      right = (right * master) >> 7;
    }
    this.left = left / 32768;
    this.right = right / 32768;
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      let step = Math.min(remaining, sink.clocksUntilSampleBoundary());
      for (let index = 0; index < NDS_SPU_CHANNELS; index += 1) {
        const channel = this.channels[index] as Channel;
        if (channel.playing && channel.until < step) step = channel.until;
      }
      // A channel whose timer is already due gets its step now; the level held
      // over a span of zero clocks is nothing, so nothing is reported for it.
      if (step > 0) {
        sink.add(this.left, this.right, step);
        remaining -= step;
      }
      let moved = false;
      for (let index = 0; index < NDS_SPU_CHANNELS; index += 1) {
        const channel = this.channels[index] as Channel;
        if (!channel.playing) continue;
        channel.until -= step;
        if (channel.until > 0) continue;
        this.step(index);
        channel.until += this.period(index);
        moved = true;
      }
      if (moved) this.remix();
    }
  }
}
