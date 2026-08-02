/**
 * The Game Boy Advance's sample half, as a chip.
 *
 * Every other model in this package is a *generator*: registers describe a
 * waveform and the hardware makes it. This console's direct-sound channels are
 * neither — they are two eight-bit digital-to-analogue converters fed by DMA out
 * of a queue, and everything musical about them happens in software, on the
 * processor, between one timer overflow and the next.
 *
 * That is a real difference and doc 16's contract survives it, restated one
 * level up (§The proof, for a mixer console). The compliant artifact is still a
 * timed schedule of writes; what the writes address is a **mixer register file**
 * rather than a chip's, and what a driver must reproduce is not a register
 * stream but *the samples themselves* — which is a sharper claim, not a weaker
 * one, because the comparison is against the audio rather than against an
 * instruction to make it. The mixing is integer throughout, so "byte for byte"
 * means byte for byte.
 *
 * The register file below is demake's own, and it is deliberately the S-DSP's
 * shape: a source number, a pitch that *multiplies*, a level per side, and a
 * key-on that is a pulse. That is not decoration — the arranger already knows
 * how to target a sample-playing voice with a uniform frequency lattice
 * (doc 17), and a second, different shape would be a second set of decisions to
 * make and to get wrong.
 *
 * What the mixer is, exactly, because two implementations have to agree:
 *
 *     out = clamp((Σ sample[v] × volume[v]) >> 8, −128, 127)
 *
 * per side, per output sample, with voices accumulated in index order. The
 * shift is the mixer's scale rather than a tuning knob: one voice at full volume
 * reaches full scale, and the sum of several is allowed to clip, which is what
 * every mixer on this console does and what the arranger's own level fitting
 * plans around.
 *
 * Sources: GBATEK — *GBA Sound Controller*, *Sound Channel A and B*
 * (https://problemkaputt.de/gbatek.htm).
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/**
 * The rate a demade cartridge clocks its direct sound at.
 *
 * A convention rather than a hardware constant — the timer's reload decides it —
 * but it is *one* convention, stated here, because the mixer's pitch lattice,
 * the driver's timer reload and this model's clock are three statements of it
 * and two of them being right is not enough. 16777216 ÷ 512 exactly, so the
 * reload is a whole number and the rate has no remainder.
 */
export const GBA_PCM_RATE_HZ = 32768;

/** Voices the mixer runs. */
export const GBA_PCM_VOICES = 6;

/** One waveform the mixer can play. */
export interface GbaSample {
  /** Signed eight-bit PCM, which is what the console's DAC takes. */
  data: Int8Array;
  /**
   * Where playback returns to when it runs off the end, or `null` for one-shot.
   *
   * A property of the *sample* rather than of the voice, because it is a fact
   * about the waveform: a single-cycle shape loops at zero and a drum does not.
   * The driver reads the same flag out of the same table in cartridge ROM.
   */
  loop: number | null;
}

/** Register numbers, per voice and global. */
const VOICE_STRIDE = 8;
/** Which waveform this voice plays. */
const REG_SRCN = 0;
/** The three bytes of the 16.16 step, low first. */
const REG_STEP0 = 2;
/** Left level, 0–255. */
const REG_VOLL = 5;
/** Right level. */
const REG_VOLR = 6;
/** Key on: a pulse, one bit per voice. */
export const GBA_PCM_KON = 0x30;
/** Key off: the same shape. */
export const GBA_PCM_KOF = 0x31;
/** The highest register the file holds. */
export const GBA_PCM_REGISTERS = 0x32;

/** One voice's state. */
interface Voice {
  source: number;
  /** Playback position, 16.16, in samples of the source. */
  position: number;
  /** How far it advances per output sample, 16.16. */
  step: number;
  left: number;
  right: number;
  playing: boolean;
}

/** The direct-sound mixer, as a register-driven model. */
export class GbaPcm implements ChipModel {
  readonly id: ChipId = "gba-pcm";
  readonly clockHz = GBA_PCM_RATE_HZ;
  readonly outputChannels = 2 as const;

  private readonly registers = new Uint8Array(GBA_PCM_REGISTERS);
  private readonly voices: Voice[] = Array.from({ length: GBA_PCM_VOICES }, () => ({
    source: 0,
    position: 0,
    step: 0,
    left: 0,
    right: 0,
    playing: false,
  }));
  private bank: readonly GbaSample[];

  /**
   * A mixer with no samples renders silence, so whoever holds the waveform bank
   * passes it in — the S-DSP's arrangement, and for the same reason (doc 16 §The
   * sample bank).
   */
  constructor(options: { bank?: readonly GbaSample[] } = {}) {
    this.bank = options.bank ?? [];
  }

  /** Replace the waveform bank; a build does this once, before anything plays. */
  setBank(bank: readonly GbaSample[]): void {
    this.bank = bank;
  }

  reset(): void {
    this.registers.fill(0);
    for (const voice of this.voices) {
      voice.source = 0;
      voice.position = 0;
      voice.step = 0;
      voice.left = 0;
      voice.right = 0;
      voice.playing = false;
    }
  }

  write(reg: number, value: number): void {
    const byte = value & 0xff;
    if (reg === GBA_PCM_KON) {
      // A pulse, like the Super Nintendo's: it starts the voices whose bits are
      // set and does nothing at all to the rest, which is what makes preemption
      // a mask rather than two shadows folded together.
      for (let index = 0; index < GBA_PCM_VOICES; index += 1) {
        if ((byte & (1 << index)) === 0) continue;
        const voice = this.voices[index] as Voice;
        voice.position = 0;
        voice.playing = this.sampleOf(voice.source) !== undefined;
      }
      return;
    }
    if (reg === GBA_PCM_KOF) {
      for (let index = 0; index < GBA_PCM_VOICES; index += 1) {
        if ((byte & (1 << index)) !== 0) (this.voices[index] as Voice).playing = false;
      }
      return;
    }
    if (reg >= GBA_PCM_VOICES * VOICE_STRIDE) return;
    this.registers[reg] = byte;
    const index = (reg / VOICE_STRIDE) | 0;
    const voice = this.voices[index] as Voice;
    const base = index * VOICE_STRIDE;
    switch (reg - base) {
      case REG_SRCN:
        voice.source = byte;
        return;
      case REG_STEP0:
      case REG_STEP0 + 1:
      case REG_STEP0 + 2:
        voice.step =
          ((this.registers[base + REG_STEP0] as number) |
            ((this.registers[base + REG_STEP0 + 1] as number) << 8) |
            ((this.registers[base + REG_STEP0 + 2] as number) << 16)) >>>
          0;
        return;
      case REG_VOLL:
        voice.left = byte;
        return;
      case REG_VOLR:
        voice.right = byte;
        return;
      default:
        return;
    }
  }

  read(reg: number): number {
    return reg < GBA_PCM_REGISTERS ? (this.registers[reg] as number) : 0;
  }

  private sampleOf(index: number): GbaSample | undefined {
    const found = this.bank[index];
    return found !== undefined && found.data.length > 0 ? found : undefined;
  }

  /**
   * Produce one output sample per side, and advance every playing voice.
   *
   * This is the definition the ARM driver has to match instruction for
   * instruction; it is written as plainly as possible for exactly that reason.
   */
  mix(): { left: number; right: number } {
    let left = 0;
    let right = 0;
    for (const voice of this.voices) {
      if (!voice.playing) continue;
      const sample = this.sampleOf(voice.source);
      if (sample === undefined) {
        voice.playing = false;
        continue;
      }
      const at = voice.position >>> 16;
      const value = sample.data[at] as number;
      left += value * voice.left;
      right += value * voice.right;
      voice.position = (voice.position + voice.step) >>> 0;
      const next = voice.position >>> 16;
      if (next >= sample.data.length) {
        if (sample.loop === null) voice.playing = false;
        else voice.position = (voice.position - ((sample.data.length - sample.loop) << 16)) >>> 0;
      }
    }
    return { left: clamp8(left >> 8), right: clamp8(right >> 8) };
  }

  /**
   * Advance by `clocks` output samples, reporting each to the sink.
   *
   * One clock is one output sample here, which is unlike every other model in
   * this package — their clocks are megahertz and their events are edges. There
   * is nothing to band-limit: the hardware's own output *is* a stepped
   * eight-bit signal at this rate, so reporting each sample held for one clock
   * is the exact thing the DAC does.
   */
  run(clocks: number, sink: SampleSink): void {
    for (let clock = 0; clock < clocks; clock += 1) {
      const { left, right } = this.mix();
      sink.add(left / 128, right / 128, 1);
    }
  }
}

/** Hold a mixed accumulator inside the eight bits the converter has. */
function clamp8(value: number): number {
  if (value > 127) return 127;
  if (value < -128) return -128;
  return value;
}
