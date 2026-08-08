/**
 * The YM2610's SSG: three square waves, a noise generator and one envelope.
 *
 * This is the Neo Geo's tone hardware, and it is a YM2149 — the AY-3-8910 family
 * — sitting on the same die as four FM channels and seven ADPCM ones. It is
 * modelled on its own because it is a *separate generator* with its own clock
 * divider and its own register file at `$00`–`$0D`, not because the rest of the
 * chip is out of scope: {@link Ym2610Ssg} is what a demade cartridge's Z80 driver
 * reaches today, and the FM and ADPCM halves are gaps to close rather than
 * hardware the console does not have (the console spec declares all of it).
 *
 * Four things about it are worth knowing before touching this file, and three of
 * them are places it differs from the SN76489 next door.
 *
 *   - **The pitch lattice is 250000 ÷ period.** The chip runs at 8 MHz on this
 *     board and the SSG takes half of it, then divides by sixteen — so a
 *     twelve-bit period covers 61 Hz to 250 kHz and A4 is period 568. That floor
 *     is *lower* than an SN76489's ~109 Hz, so this console needs none of the
 *     octave-doubling a Master System's bass does.
 *   - **Volume is a level, not an attenuation.** Register `$08`–`$0A` hold 0–15
 *     rising, where an SN76489's 0–15 falls; and bit 4 hands the channel to the
 *     envelope instead, which is a thing that chip has no equivalent of at all.
 *   - **Tone and noise are mixed per channel and enabled *low*.** Register `$07`
 *     is six active-low bits — tone off for A/B/C in bits 0–2, noise off in bits
 *     3–5 — so `$3F` is silence and `$00` is everything at once. A driver that
 *     wrote it as active-high produces a channel that is on when it should be
 *     off, which is audible and not obviously wrong.
 *   - **The noise generator is one 17-bit shift register shared by all three
 *     channels**, so noise has a single period however many channels take it.
 *
 * The output stage is the family's logarithmic DAC: sixteen levels about 3 dB
 * apart rather than a linear ramp, which is why {@link LEVELS} is a table and not
 * arithmetic.
 *
 * Sources:
 * - Neo Geo Development Wiki — SSG: https://wiki.neogeodev.org/index.php?title=SSG
 * - Neo Geo Development Wiki — YM2610 registers:
 *   https://wiki.neogeodev.org/index.php?title=YM2610_registers
 * - Yamaha — YM2610 Application Manual II (the tone formula, and A4 = `$238`).
 */

import type { ChipId, ChipModel, SampleSink } from "./types.js";

/** The chip's master clock on a Neo Geo board. */
export const YM2610_CLOCK_HZ = 8_000_000;

/**
 * Master clocks per *toggle* of a square, which is half a cycle.
 *
 * The published formula is a **tone** rate — `8 MHz / 2 / (16 × period)`, or
 * `250000 / period` — and a square toggles twice a cycle, so the counter this
 * divides runs at twice the note. That factor of two is the whole reason this is
 * a named constant with a paragraph attached: setting it to 32 makes the
 * arithmetic read like the manual and plays every note an *octave low*, with
 * every register write correct. The chip test pins it against Yamaha's own worked
 * example (A4 is period `$238`) rather than against this file.
 */
export const SSG_DIVIDER = 16;

/** Registers this generator answers, which is the low fourteen of port 0. */
export const SSG_REGISTERS = 0x0e;

/**
 * The family's logarithmic DAC, normalised to ±1.
 *
 * Sixteen steps about 3 dB apart. Literal rather than computed, for
 * `sn76489.ts`'s reason: it keeps the package free of transcendentals, which
 * `Math.pow` is and which the determinism lint refuses (doc 16 §Determinism
 * engineering). A *linear* ramp here is the single most common way an AY-family
 * model comes out sounding wrong while every register write is correct, because
 * the error is loudest exactly where music spends its time.
 */
const LEVELS: readonly number[] = [
  0, 0.0079432823472428, 0.0112201845430196, 0.0158489319246111, 0.0223872113856834,
  0.0316227766016838, 0.0446683592150963, 0.0630957344480193, 0.0891250938133746,
  0.1258925411794167, 0.1778279410038923, 0.251188643150958, 0.3548133892335755, 0.5011872336272722,
  0.7079457843841379, 1,
];

interface ToneChannel {
  /** Twelve bits; zero and one are treated as one, as the hardware does. */
  period: number;
  counter: number;
  /** The square's current half, as +1 or 0 — this chip's output is unipolar. */
  output: number;
  /** Four bits of level, or −1 when the envelope drives this channel. */
  level: number;
  envelope: boolean;
}

/** The sixteen envelope shapes, as the four bits that describe them. */
const CONT = 0x08;
const ATTACK = 0x04;
const ALTERNATE = 0x02;
const HOLD = 0x01;

/** Three square waves, a noise source and an envelope. */
export class Ym2610Ssg implements ChipModel {
  readonly id: ChipId = "ym2610-ssg";
  readonly clockHz = YM2610_CLOCK_HZ;
  readonly outputChannels = 2 as const;

  private readonly tone: ToneChannel[] = [];
  private readonly registers = new Uint8Array(SSG_REGISTERS);

  private noisePeriod = 1;
  private noiseCounter = SSG_DIVIDER;
  private lfsr = 1;
  private noiseOutput = 0;

  private envelopePeriod = 1;
  private envelopeCounter = SSG_DIVIDER;
  private envelopeShape = 0;
  private envelopeStep = 0;
  private envelopeLevel = 0;
  private envelopeHeld = false;
  private envelopeAttack = false;

  /** Mixer, register `$07`: six active-low enables. */
  private mixer = 0x3f;

  constructor() {
    for (let index = 0; index < 3; index += 1) {
      this.tone.push({ period: 1, counter: SSG_DIVIDER, output: 0, level: 0, envelope: false });
    }
    this.reset();
  }

  reset(): void {
    this.registers.fill(0);
    for (const channel of this.tone) {
      channel.period = 1;
      channel.counter = SSG_DIVIDER;
      channel.output = 0;
      channel.level = 0;
      channel.envelope = false;
    }
    this.noisePeriod = 1;
    this.noiseCounter = SSG_DIVIDER;
    this.lfsr = 1;
    this.noiseOutput = 0;
    this.envelopePeriod = 1;
    this.envelopeCounter = SSG_DIVIDER;
    this.envelopeShape = 0;
    this.envelopeStep = 0;
    this.envelopeLevel = 0;
    this.envelopeHeld = false;
    this.envelopeAttack = false;
    // Everything off: this register is active low, so `$3F` is silence.
    this.mixer = 0x3f;
  }

  /** Read a register back, which this generator allows for all of them. */
  read(reg: number): number {
    return this.registers[reg & 0x0f] ?? 0;
  }

  write(reg: number, value: number): void {
    const index = reg & 0xff;
    if (index >= SSG_REGISTERS) return;
    const v = value & 0xff;
    this.registers[index] = v;

    if (index <= 0x05) {
      const channel = this.tone[index >> 1] as ToneChannel;
      const fine = this.registers[(index & ~1) + 0] as number;
      const coarse = (this.registers[(index & ~1) + 1] as number) & 0x0f;
      channel.period = (coarse << 8) | fine;
      return;
    }
    if (index === 0x06) {
      this.noisePeriod = v & 0x1f;
      return;
    }
    if (index === 0x07) {
      this.mixer = v & 0x3f;
      return;
    }
    if (index <= 0x0a) {
      const channel = this.tone[index - 0x08] as ToneChannel;
      channel.envelope = (v & 0x10) !== 0;
      channel.level = v & 0x0f;
      return;
    }
    if (index <= 0x0c) {
      const fine = this.registers[0x0b] as number;
      const coarse = this.registers[0x0c] as number;
      this.envelopePeriod = (coarse << 8) | fine;
      return;
    }
    // `$0D` — writing the shape *restarts* the envelope, which is the whole way
    // a driver retriggers a note on this chip. Writing the same value again is
    // therefore not a no-op, and a model that skipped an unchanged write would
    // hold a decayed note instead of striking a new one.
    this.envelopeShape = v & 0x0f;
    this.envelopeStep = 0;
    this.envelopeHeld = false;
    this.envelopeAttack = (this.envelopeShape & ATTACK) !== 0;
    this.envelopeLevel = this.envelopeAttack ? 0 : 15;
    this.envelopeCounter = this.envelopeReload();
  }

  run(clocks: number, sink: SampleSink): void {
    let remaining = clocks;
    while (remaining > 0) {
      const step = Math.min(remaining, sink.clocksUntilSampleBoundary(), this.clocksToEvent());
      const level = this.level();
      sink.add(level, level, step);
      this.advance(step);
      remaining -= step;
    }
  }

  /** Clocks until the next edge anything could produce, so a span is flat. */
  private clocksToEvent(): number {
    let next = Number.MAX_SAFE_INTEGER;
    for (const channel of this.tone) {
      if (channel.counter > 0 && channel.counter < next) next = channel.counter;
    }
    if (this.noiseCounter > 0 && this.noiseCounter < next) next = this.noiseCounter;
    if (this.envelopeCounter > 0 && this.envelopeCounter < next) next = this.envelopeCounter;
    return next > 0 && next !== Number.MAX_SAFE_INTEGER ? next : 1;
  }

  private advance(clocks: number): void {
    for (const channel of this.tone) {
      channel.counter -= clocks;
      while (channel.counter <= 0) {
        channel.counter += SSG_DIVIDER * Math.max(channel.period, 1);
        channel.output ^= 1;
      }
    }

    this.noiseCounter -= clocks;
    while (this.noiseCounter <= 0) {
      this.noiseCounter += SSG_DIVIDER * Math.max(this.noisePeriod, 1);
      // Seventeen bits, taps 0 and 3 — the family's own polynomial.
      const bit = (this.lfsr ^ (this.lfsr >> 3)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 16);
      this.noiseOutput = this.lfsr & 1;
    }

    this.envelopeCounter -= clocks;
    while (this.envelopeCounter <= 0) {
      this.envelopeCounter += this.envelopeReload();
      this.stepEnvelope();
    }
  }

  /** Master clocks between envelope steps: the period times 256, not 16. */
  private envelopeReload(): number {
    return SSG_DIVIDER * 16 * Math.max(this.envelopePeriod, 1);
  }

  /**
   * One envelope step, over the four shape bits.
   *
   * `CONT` decides whether anything happens after the first ramp at all;
   * `ALTERNATE` flips the direction each time round; `HOLD` freezes it. The
   * eight shapes with `CONT` clear all behave the same — one ramp, then silence
   * — which is why they collapse here rather than being enumerated.
   */
  private stepEnvelope(): void {
    if (this.envelopeHeld) return;
    this.envelopeStep += 1;
    if (this.envelopeStep < 16) {
      this.envelopeLevel = this.envelopeAttack ? this.envelopeStep : 15 - this.envelopeStep;
      return;
    }
    this.envelopeStep = 0;
    if ((this.envelopeShape & CONT) === 0) {
      // One ramp and done: the level rests at silence whichever way it ran.
      this.envelopeLevel = 0;
      this.envelopeHeld = true;
      return;
    }
    if ((this.envelopeShape & ALTERNATE) !== 0) this.envelopeAttack = !this.envelopeAttack;
    if ((this.envelopeShape & HOLD) !== 0) {
      this.envelopeLevel = this.envelopeAttack ? 0 : 15;
      this.envelopeHeld = true;
      return;
    }
    this.envelopeLevel = this.envelopeAttack ? 0 : 15;
  }

  /** The three channels summed, as one level in [0, 1]. */
  private level(): number {
    let total = 0;
    for (const [index, channel] of this.tone.entries()) {
      // Active *low*: a set bit disables. A channel with both disabled is a
      // steady level rather than silence, which is what makes the volume
      // register usable as a crude sample player.
      const toneOn = (this.mixer & (1 << index)) === 0;
      const noiseOn = (this.mixer & (1 << (index + 3))) === 0;
      const source = (!toneOn || channel.output === 1) && (!noiseOn || this.noiseOutput === 1);
      if (!source) continue;
      const level = channel.envelope ? this.envelopeLevel : channel.level;
      total += LEVELS[level] ?? 0;
    }
    // Three channels at full scale would clip; the divisor is the channel count
    // rather than a fitted gain, because how loud this chip is against the FM
    // half is the *board's* question and `mix()` takes per-chip gains for it.
    return total / 3;
  }
}
