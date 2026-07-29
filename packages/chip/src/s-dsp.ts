/**
 * The Super Nintendo's S-DSP — `s-dsp`.
 *
 * Eight voices, and every one of them is the same thing: a **sample player**.
 * There is no oscillator on this chip and no duty cycle to choose; a voice reads
 * compressed waveform blocks out of the sound chip's own 64 KiB of RAM at a rate
 * a fourteen-bit register multiplies, shapes them with an envelope generator, and
 * places them between two signed volume registers. Three consequences run through
 * everything above this file:
 *
 *   - **Pitch is a multiplier, not a divider.** Every other chip demake models
 *     counts *down* — the register is a period, so the reachable pitches crowd
 *     together at the bottom and thin out where the melody is. Here the steps are
 *     uniform in frequency (`f = 32000 × PITCH / 4096` per sample of the
 *     waveform), so it is the bass that quantises, and nothing ever has to be
 *     octave-folded to fit. `PitchLattice.kind` exists to say so.
 *   - **A schedule is not enough on its own.** "Play sample 3" means nothing
 *     without the samples, so this model is handed the ARAM it reads them from
 *     and `ChipScript` carries it. The register stream is still the whole of the
 *     compliance contract — what the driver must write — but a *render* needs the
 *     waveform bank as well, which is a fact about sample hardware rather than a
 *     leak in the abstraction.
 *   - **Nothing here is shared between voices** except the master volume, the
 *     noise generator and the key-on/key-off pulses. That is why the SNES driver
 *     emits no merge routine: two streams sharing this chip never write the same
 *     register, because an effect owns whole voices.
 *
 * **What is deliberately absent**, on the same terms as `@demake/snes`'s renderer
 * (which draws BG1 and the objects and nothing else): the echo unit (`EON`,
 * `EVOL`, `EFB`, `ESA`, `EDL` and the eight FIR coefficients) and pitch
 * modulation (`PMON`). Their registers are accepted and stored so a driver that
 * initialises them is not refused, and they do nothing. A half-implemented echo
 * would be a filter nobody is checking; an absent one is a stated gap.
 *
 * **The one place this is not the hardware** is interpolation. A real S-DSP
 * resamples through a four-tap Gaussian window held in a 512-entry constant
 * table; this model interpolates linearly. The difference is timbre, not timing
 * or level, and it is confined here — doc 16's Level A proof compares register
 * writes, which are unaffected. Transcribing five hundred constants from memory
 * is how a table gets one entry wrong and nobody finds out, so the approximation
 * is stated instead of guessed at.
 *
 * Sources:
 * - SNESdev Wiki — S-DSP registers: https://snes.nesdev.org/wiki/S-DSP
 * - SNESdev Wiki — BRR sample format: https://snes.nesdev.org/wiki/BRR_samples
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The DSP's master clock.
 *
 * 24.576 MHz, from which everything on the sound side divides: one output sample
 * every 768 clocks (32 kHz exactly), and one SPC700 cycle every 24 (1.024 MHz).
 * Counting in master clocks rather than samples is what keeps `SampleSink`'s box
 * integration exact — a sample's level is held for a whole number of clocks, and
 * a chip slower than the delivery rate cannot close two output samples at once.
 */
export const SDSP_CLOCK_HZ = 24576000;

/** Master clocks per DSP output sample: 24576000 / 768 = 32000 Hz. */
export const SDSP_SAMPLE_CLOCKS = 768;

/** The DSP's output sample rate, which is also its pitch reference. */
export const SDSP_SAMPLE_RATE = SDSP_CLOCK_HZ / SDSP_SAMPLE_CLOCKS;

/** Bytes of RAM the sound side has, and the only memory the DSP can see. */
export const ARAM_SIZE = 0x10000;

/** Voices. Not a configuration: the register map is laid out around it. */
export const SDSP_VOICES = 8;

/**
 * Samples between envelope steps, by rate index (0 = never step).
 *
 * The hardware's own counter table, in units of output samples at 32 kHz. It is
 * a table rather than a formula because that is what the chip contains, and it
 * keeps this package free of transcendentals (doc 16 §Determinism engineering).
 */
const RATE: readonly number[] = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32,
  24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1,
];

/** Global register addresses; the per-voice ones are `voice << 4 | field`. */
const G = {
  mvolL: 0x0c,
  mvolR: 0x1c,
  evolL: 0x2c,
  evolR: 0x3c,
  kon: 0x4c,
  kof: 0x5c,
  flg: 0x6c,
  endx: 0x7c,
  efb: 0x0d,
  pmon: 0x2d,
  non: 0x3d,
  eon: 0x4d,
  dir: 0x5d,
  esa: 0x6d,
  edl: 0x7d,
} as const;

/** Where a voice is in its envelope. */
type EnvPhase = "off" | "attack" | "decay" | "sustain" | "release" | "gain";

interface Voice {
  /** Address of the BRR block currently being decoded. */
  block: number;
  /** Address the voice returns to when a block says "end, and loop". */
  loop: number;
  /** The sixteen samples of the decoded block, and how far through it we are. */
  decoded: Int16Array;
  position: number;
  /** BRR filter history, which spans blocks. */
  p1: number;
  p2: number;
  /** The block header's loop bit, remembered until the block runs out. */
  blockLoop: boolean;
  blockEnd: boolean;
  /** Fractional sample position, 12 bits, advanced by the pitch register. */
  frac: number;
  /** Interpolation window: the sample being played and the one after it. */
  s0: number;
  s1: number;
  /** Envelope level, 11 bits; `ENVX` is the top eight. */
  env: number;
  phase: EnvPhase;
  /** Samples remaining before the envelope steps again. */
  counter: number;
  /** The voice's most recent output, for `OUTX`. */
  out: number;
  active: boolean;
}

function newVoice(): Voice {
  return {
    block: 0,
    loop: 0,
    decoded: new Int16Array(16),
    position: 16,
    p1: 0,
    p2: 0,
    blockLoop: false,
    blockEnd: false,
    frac: 0,
    s0: 0,
    s1: 0,
    env: 0,
    phase: "off",
    counter: 0,
    out: 0,
    active: false,
  };
}

/** The S-DSP as a register-driven model. */
export class SDsp implements ChipModel {
  readonly id: ChipId = "s-dsp";
  readonly clockHz = SDSP_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  /**
   * The sound side's 64 KiB, which is where the waveforms live.
   *
   * Public because whoever renders a schedule has to put the sample bank in it
   * first — on this console the schedule and the samples are two halves of one
   * artifact, and pretending otherwise would render silence.
   */
  readonly ram: Uint8Array;

  private readonly reg = new Uint8Array(128);
  private readonly voices: Voice[] = [];
  private lfsr = 0x4000;
  private noiseCounter = 0;
  private noise = 0;
  private left = 0;
  private right = 0;
  private untilSample = SDSP_SAMPLE_CLOCKS;

  constructor(options: { ram?: Uint8Array } = {}) {
    this.ram = options.ram ?? new Uint8Array(ARAM_SIZE);
    for (let i = 0; i < SDSP_VOICES; i += 1) this.voices.push(newVoice());
    this.reset();
  }

  reset(): void {
    this.reg.fill(0);
    // A reset chip is muted with every voice released, which is the state
    // `FLG = $E0` describes and what the hardware comes up in.
    this.reg[G.flg] = 0xe0;
    for (let i = 0; i < SDSP_VOICES; i += 1) this.voices[i] = newVoice();
    this.lfsr = 0x4000;
    this.noiseCounter = 0;
    this.noise = 0;
    this.left = 0;
    this.right = 0;
    this.untilSample = SDSP_SAMPLE_CLOCKS;
  }

  write(reg: number, value: number): void {
    const address = reg & 0x7f;
    const byte = value & 0xff;
    // `ENDX` is write-to-clear rather than a stored value: a driver writing it
    // acknowledges the flags it has read.
    if (address === G.endx) {
      this.reg[G.endx] = 0;
      return;
    }
    this.reg[address] = byte;
    if (address === G.kon) {
      for (let v = 0; v < SDSP_VOICES; v += 1) {
        if ((byte & (1 << v)) !== 0) this.keyOn(v);
      }
      return;
    }
    if (address === G.kof) {
      for (let v = 0; v < SDSP_VOICES; v += 1) {
        if ((byte & (1 << v)) !== 0) this.keyOff(v);
      }
      return;
    }
    if (address === G.flg && (byte & 0x80) !== 0) {
      // Bit 7 is the soft reset: every voice stops where it stands.
      for (let v = 0; v < SDSP_VOICES; v += 1) {
        this.voices[v]!.phase = "off";
        this.voices[v]!.env = 0;
        this.voices[v]!.active = false;
      }
    }
  }

  read(reg: number): number {
    const address = reg & 0x7f;
    const voice = this.voices[(address >> 4) & 7]!;
    if ((address & 0x0f) === 0x08) return (voice.env >> 4) & 0x7f;
    if ((address & 0x0f) === 0x09) return (voice.out >> 8) & 0xff;
    return this.reg[address] as number;
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      const step = Math.min(remaining, sink.clocksUntilSampleBoundary(), this.untilSample);
      sink.add(this.left, this.right, step);
      this.untilSample -= step;
      remaining -= step;
      if (this.untilSample === 0) {
        this.tick();
        this.untilSample = SDSP_SAMPLE_CLOCKS;
      }
    }
  }

  // --- one output sample -----------------------------------------------------

  private tick(): void {
    this.stepNoise();
    let sumL = 0;
    let sumR = 0;
    const non = this.reg[G.non] as number;
    for (let v = 0; v < SDSP_VOICES; v += 1) {
      const voice = this.voices[v]!;
      const base = v << 4;
      const sample = (non & (1 << v)) !== 0 ? this.noise : this.advance(voice, v, base);
      this.stepEnvelope(voice, base);
      const out = (sample * voice.env) >> 11;
      voice.out = clamp16(out);
      sumL += (voice.out * signed(this.reg[base] as number)) >> 7;
      sumR += (voice.out * signed(this.reg[base + 1] as number)) >> 7;
    }
    const muted = ((this.reg[G.flg] as number) & 0x40) !== 0;
    if (muted) {
      this.left = 0;
      this.right = 0;
      return;
    }
    const outL = clamp16((sumL * signed(this.reg[G.mvolL] as number)) >> 7);
    const outR = clamp16((sumR * signed(this.reg[G.mvolR] as number)) >> 7);
    this.left = outL / 32768;
    this.right = outR / 32768;
  }

  /** Advance a voice's sample pointer and return the level it is sounding. */
  private advance(voice: Voice, index: number, base: number): number {
    if (!voice.active) return 0;
    const pitch = (((this.reg[base + 3] as number) & 0x3f) << 8) | (this.reg[base + 2] as number);
    voice.frac += pitch;
    while (voice.frac >= 0x1000) {
      voice.frac -= 0x1000;
      voice.s0 = voice.s1;
      voice.s1 = this.nextSample(voice, index);
    }
    // Linear interpolation — the one documented departure from the hardware.
    return voice.s0 + (((voice.s1 - voice.s0) * voice.frac) >> 12);
  }

  /** The next decoded BRR sample, decoding another block when one runs out. */
  private nextSample(voice: Voice, index: number): number {
    if (voice.position >= 16) {
      if (voice.blockEnd) {
        if (voice.blockLoop) {
          voice.block = voice.loop;
        } else {
          // A block that ends without looping stops the voice dead: the envelope
          // is zeroed rather than released, which is what the hardware does and
          // what makes a one-shot sample fall silent instead of ringing.
          voice.active = false;
          voice.phase = "off";
          voice.env = 0;
          return 0;
        }
      }
      this.decodeBlock(voice, index);
    }
    const sample = voice.decoded[voice.position] as number;
    voice.position += 1;
    return sample;
  }

  /** Decode the nine bytes at `voice.block` into sixteen samples. */
  private decodeBlock(voice: Voice, index: number): void {
    const at = voice.block & 0xffff;
    const header = this.ram[at] as number;
    const shift = (header >> 4) & 0x0f;
    const filter = (header >> 2) & 0x03;
    voice.blockEnd = (header & 0x01) !== 0;
    voice.blockLoop = (header & 0x02) !== 0;
    if (voice.blockEnd) {
      this.reg[G.endx] = ((this.reg[G.endx] as number) | (1 << index)) & 0xff;
    }
    for (let i = 0; i < 16; i += 1) {
      const byte = this.ram[(at + 1 + (i >> 1)) & 0xffff] as number;
      const nibble = (i & 1) === 0 ? byte >> 4 : byte & 0x0f;
      // Sign-extend the nibble, then shift by the block's range. Ranges above 12
      // are not a bigger shift on this hardware — they collapse to the sign.
      let s = nibble > 7 ? nibble - 16 : nibble;
      s = shift <= 12 ? (s << shift) >> 1 : s < 0 ? -2048 : 0;
      s = applyFilter(filter, s, voice.p1, voice.p2);
      s = clamp16(s);
      voice.p2 = voice.p1;
      voice.p1 = s;
      voice.decoded[i] = s;
    }
    voice.position = 0;
    voice.block = (at + 9) & 0xffff;
  }

  /** Move a voice's envelope on by one output sample. */
  private stepEnvelope(voice: Voice, base: number): void {
    if (voice.phase === "off") {
      voice.env = 0;
      return;
    }
    if (voice.phase === "release") {
      // Release is not rate-controlled: the envelope falls by a fixed step every
      // sample, which is why a key-off is audibly quicker than a decay.
      voice.env -= 8;
      if (voice.env <= 0) {
        voice.env = 0;
        voice.phase = "off";
        voice.active = false;
      }
      return;
    }

    const adsr1 = this.reg[base + 5] as number;
    const useAdsr = (adsr1 & 0x80) !== 0;
    if (!useAdsr) {
      this.stepGain(voice, this.reg[base + 7] as number);
      return;
    }

    const adsr2 = this.reg[base + 6] as number;
    // Attack, decay and sustain read their rate out of three different fields,
    // and the odd offsets are the hardware's: attack is odd-numbered rates only
    // and decay lives in the top half of the table.
    const rate =
      voice.phase === "attack"
        ? ((adsr1 & 0x0f) << 1) + 1
        : voice.phase === "decay"
          ? (((adsr1 >> 4) & 0x07) << 1) + 16
          : adsr2 & 0x1f;

    if (!this.due(voice, rate)) return;

    if (voice.phase === "attack") {
      // Rate 31 is the "instant" attack: a whole quarter of the envelope a step.
      voice.env += rate === 31 ? 1024 : 32;
      if (voice.env >= 0x7ff) {
        voice.env = 0x7ff;
        voice.phase = "decay";
      }
      return;
    }
    if (voice.phase === "decay") {
      voice.env -= ((voice.env - 1) >> 8) + 1;
      const level = (((adsr2 >> 5) & 0x07) + 1) << 8;
      if (voice.env <= level) {
        voice.env = voice.env < 0 ? 0 : voice.env;
        voice.phase = "sustain";
      }
      return;
    }
    voice.env -= ((voice.env - 1) >> 8) + 1;
    if (voice.env < 0) voice.env = 0;
  }

  /** The GAIN register's five behaviours: one direct, four rate-controlled. */
  private stepGain(voice: Voice, gain: number): void {
    if ((gain & 0x80) === 0) {
      voice.env = (gain & 0x7f) << 4;
      voice.phase = "gain";
      return;
    }
    const rate = gain & 0x1f;
    if (!this.due(voice, rate)) return;
    switch ((gain >> 5) & 0x03) {
      case 0:
        voice.env -= 32;
        break;
      case 1:
        voice.env -= ((voice.env - 1) >> 8) + 1;
        break;
      case 2:
        voice.env += 32;
        break;
      default:
        // "Bent line": fast to three-quarters, then slow, which is the chip's
        // one built-in swell.
        voice.env += voice.env < 0x600 ? 32 : 8;
        break;
    }
    if (voice.env < 0) voice.env = 0;
    if (voice.env > 0x7ff) voice.env = 0x7ff;
  }

  /** Whether a voice's envelope counter has come round at this rate. */
  private due(voice: Voice, rate: number): boolean {
    const period = RATE[rate & 0x1f] as number;
    if (period === 0) return false;
    if (voice.counter > 0) {
      voice.counter -= 1;
      return false;
    }
    voice.counter = period - 1;
    return true;
  }

  private stepNoise(): void {
    const period = RATE[(this.reg[G.flg] as number) & 0x1f] as number;
    if (period === 0) return;
    if (this.noiseCounter > 0) {
      this.noiseCounter -= 1;
      return;
    }
    this.noiseCounter = period - 1;
    const feedback = ((this.lfsr << 13) ^ (this.lfsr << 14)) & 0x4000;
    this.lfsr = ((this.lfsr >> 1) | feedback) & 0x7fff;
    // The generator's output is the shift register shifted up one, read as a
    // signed sixteen-bit sample.
    this.noise = ((this.lfsr << 1) << 16) >> 16;
  }

  private keyOn(v: number): void {
    const voice = this.voices[v]!;
    const dir = ((this.reg[G.dir] as number) << 8) & 0xffff;
    const entry = (dir + (this.reg[(v << 4) + 4] as number) * 4) & 0xffff;
    voice.block = (this.ram[entry] as number) | ((this.ram[(entry + 1) & 0xffff] as number) << 8);
    voice.loop =
      (this.ram[(entry + 2) & 0xffff] as number) |
      ((this.ram[(entry + 3) & 0xffff] as number) << 8);
    voice.position = 16;
    voice.blockEnd = false;
    voice.blockLoop = false;
    voice.p1 = 0;
    voice.p2 = 0;
    voice.frac = 0;
    voice.s0 = 0;
    voice.s1 = 0;
    voice.counter = 0;
    voice.out = 0;
    voice.active = true;
    voice.env = 0;
    voice.phase = ((this.reg[(v << 4) + 5] as number) & 0x80) !== 0 ? "attack" : "gain";
    this.reg[G.endx] = (this.reg[G.endx] as number) & ~(1 << v) & 0xff;
  }

  private keyOff(v: number): void {
    const voice = this.voices[v]!;
    if (voice.phase !== "off") voice.phase = "release";
  }
}

/** The four BRR predictors, in the integer form the hardware computes them in. */
function applyFilter(filter: number, sample: number, p1: number, p2: number): number {
  switch (filter) {
    case 0:
      return sample;
    case 1:
      return sample + p1 + (-p1 >> 4);
    case 2:
      return sample + 2 * p1 + (-(p1 * 3) >> 5) - p2 + (p2 >> 4);
    default:
      return sample + 2 * p1 + (-(p1 * 13) >> 6) - p2 + ((p2 * 3) >> 4);
  }
}

/** Read a register as the signed byte the volume fields are. */
function signed(value: number): number {
  return value > 127 ? value - 256 : value;
}

function clamp16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

/**
 * Encode PCM as one BRR block: nine bytes for sixteen samples.
 *
 * Filter zero only, and the range chosen so the loudest sample in the block
 * survives. That is not the best BRR encoder that could be written — a real one
 * searches all four predictors and carries the quantisation error forward — but
 * the waveforms this project puts in ARAM are single cycles sixteen samples long,
 * where there is no history to predict from and the search would choose filter
 * zero anyway (doc 16 §The sample bank).
 */
export function encodeBrrBlock(
  samples: ArrayLike<number>,
  flags: { loop?: boolean; end?: boolean } = {},
): Uint8Array {
  let peak = 0;
  for (let i = 0; i < 16; i += 1) {
    const value = Math.abs(samples[i] ?? 0);
    if (value > peak) peak = value;
  }
  // A nibble spans −8…7 and decoding shifts left by `range` then right by one,
  // so a block of range r reaches ±(8 << r) / 2 in fifteen-bit sample space.
  let range = 0;
  while (range < 12 && peak > (7 << range) >> 1) range += 1;
  const out = new Uint8Array(9);
  out[0] = (range << 4) | (flags.loop ? 0x02 : 0) | (flags.end ? 0x01 : 0);
  for (let i = 0; i < 16; i += 1) {
    const wanted = samples[i] ?? 0;
    let nibble = Math.round((wanted * 2) / (1 << range));
    if (nibble > 7) nibble = 7;
    if (nibble < -8) nibble = -8;
    const at = 1 + (i >> 1);
    out[at] = ((out[at] as number) | ((nibble & 0x0f) << ((i & 1) === 0 ? 4 : 0))) & 0xff;
  }
  return out;
}
