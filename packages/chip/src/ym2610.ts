/**
 * The YM2610 (OPNB) — the Neo Geo's whole sound system on one die.
 *
 * Fourteen voices in four sections that have almost nothing to do with each
 * other: four four-operator FM channels, three square waves with a shared noise
 * generator, six fixed-rate ADPCM sample channels, and one variable-rate ADPCM
 * channel. It is the widest single chip in this package by voice count and the
 * only one that is a synthesizer *and* a sample player at once.
 *
 * ### The FM section is a YM2612, and that is the hardware rather than a shortcut
 *
 * OPNB and OPN2 are the same FM core, and the register map says so out loud. The
 * `$30`–`$B6` block is addressed at per-channel offsets **1 and 2** on each of the
 * two ports — offset 0 is simply absent — and the `$28` key-on byte names the four
 * channels `001`, `010`, `101`, `110`. Those are exactly a six-channel part's
 * channels 2, 3, 5 and 6 with 1 and 4 removed, which is what the Neo Geo
 * development wiki concludes as well: a YM2610 is a YM2610B with two FM channels
 * taken out. The internal sample rate agrees too — 8 MHz over 144 is 55555 Hz,
 * which is exactly the ADPCM-B ceiling and three times the ADPCM-A rate.
 *
 * So {@link Ym2612} *is* this section, driven at this board's clock and reached at
 * the offsets the OPNB wires out. Nothing is transcribed twice, which is doc 16's
 * rule about a chip being implemented once arriving from an unexpected direction:
 * the two chips are not similar, they are one design. What this file has to do is
 * refuse the facilities the OPNB does not have — the LFO at `$22` and the DAC at
 * `$2A`/`$2B` — because routing them through would offer a binding hardware the
 * console does not own.
 *
 * ### The one run loop
 *
 * Four sections, one output, and the box integration in {@link SampleSink} only
 * works if the span it is handed carries a *constant* level. So the loop steps to
 * the nearest event over all four — an FM sample, an SSG edge, an ADPCM-A sample,
 * an ADPCM-B sample — and every section is asked what it is holding before it is
 * advanced. That is why {@link Ym2612.clocksUntilSample} and
 * {@link Ym2610Ssg.clocksUntilEvent} exist: each is a section saying when it will
 * next move, and without them a span could straddle an edge and average the wrong
 * two levels together.
 *
 * ### The two ADPCM sections are different codecs, not one at two rates
 *
 * **ADPCM-A** is six channels at a fixed 18518.5 Hz — 8 MHz over 432, the FM
 * sample rate divided by three — decoding four bits to a **twelve-bit accumulator
 * that wraps**. That wrap is not a modelling choice: the reference decoders sign
 * extend a masked twelve-bit value, so an overdriven sample folds rather than
 * clipping, which is audible and is part of how this console's drums sound.
 *
 * **ADPCM-B** is one channel whose rate is a phase increment — `55555 × ΔN / 65536`
 * — decoding into a sixteen-bit accumulator that **clamps**, with a step size that
 * scales multiplicatively rather than by table index. Different accumulator width,
 * different step law, different clipping behaviour. A model that shared one decoder
 * between them would be wrong in both directions at once.
 *
 * ### What is absent, and stated rather than hidden
 *
 * The **relative level of the SSG against the FM** is a board question this project
 * could not find published in a citable form, and it cannot be expressed the way
 * every other console's balance is: `mix()` takes per-chip gains from the binding,
 * and this is *one* chip. {@link SSG_GAIN} is therefore a named judgement with its
 * reasoning attached rather than a number folded into an expression.
 *
 * The ADPCM-B channel's **interpolation between decoded samples** is not modelled —
 * a sample is held until the next one, where the hardware ramps — on the terms
 * `s-dsp.ts`'s Gaussian window is absent: the exact filter is not published and a
 * transcription with one coefficient wrong is worse than a stated approximation.
 * The **status byte's busy flag** is always clear, for {@link Ym2612.read}'s reason.
 *
 * Sources:
 * - Neo Geo Development Wiki — YM2610: https://wiki.neogeodev.org/index.php?title=YM2610
 * - Neo Geo Development Wiki — YM2610 registers:
 *   https://wiki.neogeodev.org/index.php?title=YM2610_registers
 * - Neo Geo Development Wiki — FM: https://wiki.neogeodev.org/index.php?title=FM
 * - Neo Geo Development Wiki — ADPCM: https://wiki.neogeodev.org/index.php?title=ADPCM
 * - Neo Geo Development Wiki — ADPCM codecs (the step tables and the twelve-bit
 *   wrap): https://wiki.neogeodev.org/index.php?title=ADPCM_codecs
 * - Yamaha — YM2610 Application Manual and Application Manual II
 */

import { Ym2610Ssg, YM2610_CLOCK_HZ } from "./ym2610-ssg.js";
import { Ym2612 } from "./ym2612.js";
import type { ChipId, ChipModel, SampleSink } from "./types.js";

export { YM2610_CLOCK_HZ };

/** FM channels this part wires out, of the six the core has. */
export const YM2610_FM_CHANNELS = 4;

/** Fixed-rate sample channels. */
export const YM2610_ADPCM_A_CHANNELS = 6;

/**
 * Master clocks per ADPCM-A sample: the FM sample period times three.
 *
 * 8 MHz over 432 is 18518.5 Hz, which is the figure the hardware documentation
 * quotes. Stating it as `144 × 3` rather than as 432 is the point — it says these
 * two rates are one clock rather than two numbers that happen to divide.
 */
export const ADPCM_A_DIVIDER = 432;

/**
 * Master clocks per ADPCM-B sample step, which is the chip's own sample rate.
 *
 * The B channel does not have a rate of its own: it steps a sixteen-bit phase by
 * ΔN at 55555 Hz and consumes a nibble on each carry, so its ceiling *is* the FM
 * sample rate and its floor is that over 65536.
 */
export const ADPCM_B_DIVIDER = 144;

/**
 * The ADPCM-A step table: forty-nine sizes, each about 10% above the last.
 *
 * Shared in shape with every Yamaha/IMA-family codec and different in every
 * detail from ADPCM-B's, which is why the two decoders below are separate.
 */
const ADPCM_A_STEPS: readonly number[] = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552,
];

/** How far a code moves the step index. The sign bit does not change it. */
const ADPCM_A_ADJUST: readonly number[] = [-1, -1, -1, -1, 2, 5, 7, 9];

/**
 * Every (step, code) pair's signed delta, built once.
 *
 * `delta = (2 × magnitude + 1) × step ÷ 8`, negated by the code's top bit. It is
 * a table rather than the expression because that is how the decoders it came
 * from are written and because the division is a truncation the arithmetic has to
 * keep — computing it per sample with a floating divide would round differently.
 */
const ADPCM_A_DELTA: Int16Array = (() => {
  const table = new Int16Array(ADPCM_A_STEPS.length * 16);
  for (const [index, step] of ADPCM_A_STEPS.entries()) {
    for (let code = 0; code < 16; code += 1) {
      const magnitude = Math.trunc(((2 * (code & 7) + 1) * step) / 8);
      table[index * 16 + code] = (code & 8) === 0 ? magnitude : -magnitude;
    }
  }
  return table;
})();

/** ADPCM-B's step law: a *multiplier* over 64, not an index step. */
const ADPCM_B_ADJUST: readonly number[] = [57, 57, 57, 57, 77, 102, 128, 153];

/** ADPCM-B's step size is clamped rather than indexed. */
const ADPCM_B_STEP_MIN = 127;
const ADPCM_B_STEP_MAX = 24576;

/**
 * Attenuation in 0.75 dB steps, sixty-four of them, normalised to ±1.
 *
 * An ADPCM-A voice's level is two registers — five bits of its own and six shared
 * — and they combine into one attenuation index. Literal for the SSG's `LEVELS`
 * reason: it keeps the package free of transcendentals, which the determinism lint
 * refuses. Index 63 is silence, which is what the hardware does with a fully
 * attenuated voice rather than leaving a floor on it.
 */
const ATTENUATION: readonly number[] = [
  1, 0.9172759353897796, 0.841395141645195, 0.7717915155850125, 0.7079457843841379,
  0.6493816315762113, 0.5956621435290105, 0.5463865498818542, 0.5011872336272722,
  0.4597269885308721, 0.4216965034285822, 0.3868120546330522, 0.3548133892335755,
  0.3254617834980459, 0.2985382618917959, 0.2738419634264361, 0.251188643150958, 0.2304092976055846,
  0.2113489039836647, 0.1938652635952207, 0.1778279410038923, 0.1631172909227838,
  0.1496235656094433, 0.1372460961007562, 0.1258925411794167, 0.1154781984689458,
  0.1059253725177289, 0.09716279515771063, 0.08912509381337455, 0.08175230379436502,
  0.07498942093324558, 0.06878599123088075, 0.06309573444801933, 0.05787619883491206,
  0.05308844442309885, 0.04869675251658631, 0.04466835921509631, 0.04097321098135415,
  0.03758374042884442, 0.03447466065731494, 0.03162277660168379, 0.02900681198693153,
  0.0266072505979881, 0.0244061906804198, 0.0223872113856834, 0.02053525026457146,
  0.018836490894898, 0.01727825980507864, 0.01584893192461113, 0.01453784385607662,
  0.01333521432163324, 0.01223207119049931, 0.01122018454301964, 0.01029200527194428,
  0.009440608762859235, 0.008659643233600654, 0.007943282347242814, 0.007286181745132275,
  0.006683439175686149, 0.006130557921498208, 0.005623413251903491, 0.005158221650723055,
  0.004731512589614803, 0,
];

/**
 * How loud the SSG is against the FM and ADPCM halves.
 *
 * On the board the FM and ADPCM sections leave through an external DAC and the
 * SSG has its own analog output, so their relative level is a property of the
 * *board* — exactly the kind of thing `mix()` takes per-chip gains for everywhere
 * else in this package. It cannot be expressed that way here, because this is one
 * chip and a binding sees one entry: a caller who wanted the SSG quieter would
 * have to turn the FM down too.
 *
 * So it is a named judgement rather than a citation. Half is what keeps three
 * squares at full level from dominating four FM voices at a musical balance, and
 * it is the number to change if a source turns up.
 */
export const SSG_GAIN = 0.5;

/**
 * How loud each sample voice is, which is the section normalising by its count.
 *
 * The FM core divides by its six channels and the SSG by its three, so a voice at
 * full scale contributes the same wherever it sits and no section can drown
 * another merely by having more voices in it. The seven ADPCM voices — six fixed
 * and one variable — follow the same rule. Without it one drum at full level is
 * six times one FM voice, which is a demake that clips the moment a kick lands.
 */
export const SAMPLE_GAIN = 1 / 7;

/** One fixed-rate sample voice. */
interface AdpcmAVoice {
  playing: boolean;
  /** Byte addresses into the A sample ROM; `end` is the last byte, inclusive. */
  start: number;
  end: number;
  position: number;
  /** Whether the next nibble is the high half of the byte at {@link position}. */
  high: boolean;
  accumulator: number;
  /** Index into {@link ADPCM_A_STEPS}, held ×16 as the reference decoders do. */
  step: number;
  left: boolean;
  right: boolean;
  /** Five bits, `$1F` loudest. */
  volume: number;
  /** The level this voice is holding, per side, in ±1. */
  outLeft: number;
  outRight: number;
}

function newAdpcmAVoice(): AdpcmAVoice {
  return {
    playing: false,
    start: 0,
    end: 0,
    position: 0,
    high: true,
    accumulator: 0,
    step: 0,
    left: true,
    right: true,
    volume: 0,
    outLeft: 0,
    outRight: 0,
  };
}

/** What a caller with sample ROMs hands the model. */
export interface Ym2610Options {
  /** The ADPCM-A sample ROM, which on a cartridge is the first V region. */
  pcmA?: Uint8Array;
  /** The ADPCM-B sample ROM, which is the second. */
  pcmB?: Uint8Array;
}

/** Four FM voices, three squares, six sample channels and one more. */
export class Ym2610 implements ChipModel {
  readonly id: ChipId = "ym2610";
  readonly clockHz = YM2610_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  /** The FM core, reached only at the offsets this part wires out. */
  private readonly fm = new Ym2612();
  /** The tone generator, which owns `$00`–`$0D` of the first port. */
  private readonly ssg = new Ym2610Ssg();

  private readonly pcmA: Uint8Array;
  private readonly pcmB: Uint8Array;

  private readonly fmTap = new Tap();
  private readonly ssgTap = new Tap();

  /** The two address latches, one per port pair. */
  private readonly address = new Int32Array(2);

  private readonly voices: AdpcmAVoice[] = [];
  /** Six bits, `$3F` loudest — the level every ADPCM-A voice passes through. */
  private adpcmAMaster = 0;
  private adpcmAClocks = ADPCM_A_DIVIDER;

  private bPlaying = false;
  private bRepeat = false;
  private bStart = 0;
  private bEnd = 0;
  private bPosition = 0;
  private bHigh = true;
  private bDelta = 0;
  private bPhase = 0;
  private bAccumulator = 0;
  private bStep = ADPCM_B_STEP_MIN;
  private bVolume = 0;
  private bLeft = true;
  private bRight = true;
  private bOutLeft = 0;
  private bOutRight = 0;
  private bClocks = ADPCM_B_DIVIDER;

  constructor(options: Ym2610Options = {}) {
    this.pcmA = options.pcmA ?? new Uint8Array(0);
    this.pcmB = options.pcmB ?? new Uint8Array(0);
    for (let index = 0; index < YM2610_ADPCM_A_CHANNELS; index += 1) {
      this.voices.push(newAdpcmAVoice());
    }
    this.reset();
  }

  reset(): void {
    this.fm.reset();
    this.ssg.reset();
    this.address.fill(0);
    for (const voice of this.voices) Object.assign(voice, newAdpcmAVoice());
    this.adpcmAMaster = 0;
    this.adpcmAClocks = ADPCM_A_DIVIDER;
    this.bPlaying = false;
    this.bRepeat = false;
    this.bStart = 0;
    this.bEnd = 0;
    this.bPosition = 0;
    this.bHigh = true;
    this.bDelta = 0;
    this.bPhase = 0;
    this.bAccumulator = 0;
    this.bStep = ADPCM_B_STEP_MIN;
    this.bVolume = 0;
    this.bLeft = true;
    this.bRight = true;
    this.bOutLeft = 0;
    this.bOutRight = 0;
    this.bClocks = ADPCM_B_DIVIDER;
  }

  /**
   * Write one byte to one of the chip's four bus addresses.
   *
   * `0` and `2` latch an address, `1` and `3` write the datum it names — the
   * YM2612's arrangement, because it is the same bus. What differs is where a
   * register goes: the first pair carries the SSG, ADPCM-B, the timers and FM
   * channels 1–2; the second carries ADPCM-A and FM channels 3–4. A driver stores
   * exactly these four bytes, at Z80 ports `$04`–`$07`.
   */
  write(port: number, value: number): void {
    const half = (port >> 1) & 1;
    const byte = value & 0xff;
    if ((port & 1) === 0) {
      this.address[half] = byte;
      return;
    }
    this.writeRegister(half, this.address[half] as number, byte);
  }

  /**
   * The status byte: the two timer overflow flags, and a busy bit always clear.
   *
   * Same shape and same reasoning as {@link Ym2612.read} — this model applies a
   * write the instant it arrives, so a driver's busy-wait finds the chip ready.
   * A Neo Geo driver's clock is timer A and it reads exactly this.
   */
  read(): number {
    return this.fm.read();
  }

  /** Whether either FM timer is counting, which a bus can observe. */
  get timersRunning(): boolean {
    return this.fm.timersRunning;
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      // Every section says when it will next move, so the span below carries one
      // level in each and the sink's box integration is exact rather than nearly
      // right (§The one run loop).
      const step = Math.min(
        remaining,
        sink.clocksUntilSampleBoundary(),
        this.fm.clocksUntilSample,
        this.ssg.clocksUntilEvent(),
        this.adpcmAClocks,
        this.bClocks,
      );
      // Both sub-models report the level they were *holding* and then advance, so
      // running them here is what fills the taps for this very span.
      this.fm.run(step, this.fmTap);
      this.ssg.run(step, this.ssgTap);
      let left = this.fmTap.left + this.ssgTap.left * SSG_GAIN + this.bOutLeft;
      let right = this.fmTap.right + this.ssgTap.right * SSG_GAIN + this.bOutRight;
      for (const voice of this.voices) {
        left += voice.outLeft;
        right += voice.outRight;
      }
      sink.add(left, right, step);
      this.advanceAdpcm(step);
      remaining -= step;
    }
  }

  // --- registers ---------------------------------------------------------------

  private writeRegister(half: number, address: number, value: number): void {
    if (half === 0) {
      if (address < 0x10) {
        this.ssg.write(address, value);
        return;
      }
      if (address < 0x20) {
        this.writeAdpcmB(address, value);
        return;
      }
      // `$20`-`$2F` is the FM core's global page on a six-channel part, and this
      // one has less of it: no LFO at `$22` and no DAC at `$2A`/`$2B`. Passing
      // those through would offer a binding hardware the console does not own, so
      // only the timers and the key-on byte reach the core.
      if (address >= 0x20 && address < 0x30) {
        // The key-on byte names a channel `001`, `010`, `101` or `110`. The other
        // four codes are the two channels this part does not have, and they are
        // refused rather than passed on: the core would key one, and a model that
        // plays six voices on four-voice hardware is a demake that sounds right
        // here and silent on the board.
        if (address === 0x28 && (value & 3) === 0) return;
        if (address >= 0x24 && address <= 0x28) this.toFm(0, address, value);
        return;
      }
    } else if (address < 0x30) {
      this.writeAdpcmA(address, value);
      return;
    }
    // Same refusal one register block along: the per-channel offset is 1 or 2 and
    // offset 0 is the missing channel. `$A8`-`$AE` sit where a third channel's
    // F-numbers would and belong to the core's four-pitch mode instead, so they
    // are excluded from the test rather than caught by it.
    if (address >= 0x30 && (address & 3) === 0 && (address < 0xa8 || address > 0xae)) return;
    this.toFm(half, address, value);
  }

  /** Address then datum, which is what the core's four-address bus takes. */
  private toFm(half: number, address: number, value: number): void {
    this.fm.write(half * 2, address);
    this.fm.write(half * 2 + 1, value);
  }

  // --- ADPCM-A -----------------------------------------------------------------

  private writeAdpcmA(address: number, value: number): void {
    if (address === 0x00) {
      // Bit 7 is *dump*: set means stop the named voices, clear means start them.
      // The other six bits are a channel mask rather than a channel number, so one
      // write starts a whole drum kit — which is why a Neo Geo driver's percussion
      // costs one register write a tick however many voices sound.
      const mask = value & 0x3f;
      for (const [index, voice] of this.voices.entries()) {
        if ((mask & (1 << index)) === 0) continue;
        if ((value & 0x80) !== 0) {
          voice.playing = false;
          voice.outLeft = 0;
          voice.outRight = 0;
          continue;
        }
        voice.playing = true;
        voice.position = voice.start;
        voice.high = true;
        voice.accumulator = 0;
        voice.step = 0;
      }
      return;
    }
    if (address === 0x01) {
      this.adpcmAMaster = value & 0x3f;
      return;
    }
    if (address >= 0x08 && address <= 0x0d) {
      const voice = this.voices[address - 0x08] as AdpcmAVoice;
      voice.left = (value & 0x80) !== 0;
      voice.right = (value & 0x40) !== 0;
      voice.volume = value & 0x1f;
      return;
    }
    // Start and end are in 256-byte units, low half then high half, and `end` is
    // the last *block* rather than the byte after it — so the final byte a voice
    // plays is that block's last.
    if (address >= 0x10 && address <= 0x15) {
      const voice = this.voices[address - 0x10] as AdpcmAVoice;
      voice.start = (voice.start & 0xff0000) | ((value & 0xff) << 8);
      return;
    }
    if (address >= 0x18 && address <= 0x1d) {
      const voice = this.voices[address - 0x18] as AdpcmAVoice;
      voice.start = (voice.start & 0x00ff00) | ((value & 0xff) << 16);
      return;
    }
    if (address >= 0x20 && address <= 0x25) {
      const voice = this.voices[address - 0x20] as AdpcmAVoice;
      voice.end = (voice.end & 0xff0000) | ((value & 0xff) << 8);
      return;
    }
    if (address >= 0x28 && address <= 0x2d) {
      const voice = this.voices[address - 0x28] as AdpcmAVoice;
      voice.end = (voice.end & 0x00ff00) | ((value & 0xff) << 16);
    }
  }

  /** One ADPCM-A sample for every playing voice. */
  private stepAdpcmA(): void {
    for (const voice of this.voices) {
      if (!voice.playing) continue;
      if (voice.position > (voice.end | 0xff) || voice.position >= this.pcmA.length) {
        voice.playing = false;
        voice.outLeft = 0;
        voice.outRight = 0;
        continue;
      }
      const byte = this.pcmA[voice.position] ?? 0;
      const code = voice.high ? byte >> 4 : byte & 0x0f;
      if (voice.high) {
        voice.high = false;
      } else {
        voice.high = true;
        voice.position += 1;
      }
      // Twelve bits that *wrap*: the accumulator is masked and sign extended, so
      // an overdriven sample folds rather than clipping (§The two ADPCM sections).
      let accumulator = (voice.accumulator + (ADPCM_A_DELTA[voice.step + code] ?? 0)) & 0xfff;
      if ((accumulator & 0x800) !== 0) accumulator -= 0x1000;
      voice.accumulator = accumulator;
      voice.step = clamp(voice.step + (ADPCM_A_ADJUST[code & 7] ?? 0) * 16, 0, 48 * 16);

      // Five bits of its own and six shared, combining into one attenuation index
      // in 0.75 dB steps: a voice at `$1F` under a master of `$3F` is unattenuated.
      const attenuation = (0x1f - voice.volume) * 2 + (0x3f - this.adpcmAMaster);
      const level =
        (accumulator / 2048) * (ATTENUATION[Math.min(attenuation, 63)] ?? 0) * SAMPLE_GAIN;
      voice.outLeft = voice.left ? level : 0;
      voice.outRight = voice.right ? level : 0;
    }
  }

  // --- ADPCM-B -----------------------------------------------------------------

  private writeAdpcmB(address: number, value: number): void {
    switch (address) {
      case 0x10:
        this.bRepeat = (value & 0x10) !== 0;
        if ((value & 0x01) !== 0) {
          // Reset: stop and forget where we were, which is how a driver silences
          // this voice without having to wait for its end address.
          this.bPlaying = false;
          this.bOutLeft = 0;
          this.bOutRight = 0;
          return;
        }
        if ((value & 0x80) !== 0) {
          this.bPlaying = true;
          this.bPosition = this.bStart;
          this.bHigh = true;
          this.bPhase = 0;
          this.bAccumulator = 0;
          this.bStep = ADPCM_B_STEP_MIN;
        } else {
          this.bPlaying = false;
          this.bOutLeft = 0;
          this.bOutRight = 0;
        }
        return;
      case 0x11:
        this.bLeft = (value & 0x80) !== 0;
        this.bRight = (value & 0x40) !== 0;
        return;
      case 0x12:
        this.bStart = (this.bStart & 0xff0000) | ((value & 0xff) << 8);
        return;
      case 0x13:
        this.bStart = (this.bStart & 0x00ff00) | ((value & 0xff) << 16);
        return;
      case 0x14:
        this.bEnd = (this.bEnd & 0xff0000) | ((value & 0xff) << 8);
        return;
      case 0x15:
        this.bEnd = (this.bEnd & 0x00ff00) | ((value & 0xff) << 16);
        return;
      case 0x19:
        this.bDelta = (this.bDelta & 0xff00) | (value & 0xff);
        return;
      case 0x1a:
        this.bDelta = (this.bDelta & 0x00ff) | ((value & 0xff) << 8);
        return;
      case 0x1b:
        this.bVolume = value & 0xff;
        return;
      default:
        // `$16`-`$18` are unused and `$1C` is the flag control, which this model
        // has no interrupt to raise.
        return;
    }
  }

  /**
   * One ADPCM-B step, which is a *phase* step rather than a sample.
   *
   * The channel runs at the chip's own rate and adds ΔN to a sixteen-bit phase
   * each time; a nibble is consumed on each carry. So the playback rate is
   * `55555 × ΔN / 65536` with no divider anywhere, which is why this voice reaches
   * both far below and exactly up to the FM sample rate.
   */
  private stepAdpcmB(): void {
    if (!this.bPlaying) return;
    this.bPhase += this.bDelta;
    while (this.bPhase >= 0x10000) {
      this.bPhase -= 0x10000;
      if (this.bPosition > (this.bEnd | 0xff) || this.bPosition >= this.pcmB.length) {
        if (!this.bRepeat) {
          this.bPlaying = false;
          this.bOutLeft = 0;
          this.bOutRight = 0;
          return;
        }
        this.bPosition = this.bStart;
        this.bHigh = true;
        this.bAccumulator = 0;
        this.bStep = ADPCM_B_STEP_MIN;
      }
      const byte = this.pcmB[this.bPosition] ?? 0;
      const code = this.bHigh ? byte >> 4 : byte & 0x0f;
      if (this.bHigh) {
        this.bHigh = false;
      } else {
        this.bHigh = true;
        this.bPosition += 1;
      }
      // Sixteen bits that *clamp*, and a step size that scales by a multiplier
      // rather than moving along a table — the opposite of ADPCM-A on both counts.
      const magnitude = Math.trunc(((2 * (code & 7) + 1) * this.bStep) / 8);
      const delta = (code & 8) === 0 ? magnitude : -magnitude;
      this.bAccumulator = clamp(this.bAccumulator + delta, -32768, 32767);
      this.bStep = clamp(
        Math.trunc((this.bStep * (ADPCM_B_ADJUST[code & 7] ?? 64)) / 64),
        ADPCM_B_STEP_MIN,
        ADPCM_B_STEP_MAX,
      );
    }
    const level = ((this.bAccumulator / 32768) * this.bVolume * SAMPLE_GAIN) / 255;
    this.bOutLeft = this.bLeft ? level : 0;
    this.bOutRight = this.bRight ? level : 0;
  }

  private advanceAdpcm(clocks: number): void {
    this.adpcmAClocks -= clocks;
    while (this.adpcmAClocks <= 0) {
      this.adpcmAClocks += ADPCM_A_DIVIDER;
      this.stepAdpcmA();
    }
    this.bClocks -= clocks;
    while (this.bClocks <= 0) {
      this.bClocks += ADPCM_B_DIVIDER;
      this.stepAdpcmB();
    }
  }
}

/**
 * A sink that only remembers the last level it was handed.
 *
 * The two composed models report a level and then advance, so running one for a
 * span no longer than its own next event leaves exactly that span's level here.
 * It is a *reader* rather than an output stage, which is why it claims a sample
 * boundary is never coming: the outer loop already bounded the step.
 */
class Tap implements SampleSink {
  left = 0;
  right = 0;

  clocksUntilSampleBoundary(): number {
    return Number.MAX_SAFE_INTEGER;
  }

  add(left: number, right: number): void {
    this.left = left;
    this.right = right;
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
