/**
 * The Game Boy Advance mixer's built-in waveform bank (doc 16 §The sample bank).
 *
 * The Super Nintendo's bank exists for the same reason and this one is not a
 * copy of it: the S-DSP plays BRR blocks out of a second processor's RAM, and
 * this mixer plays *signed eight-bit PCM* out of cartridge ROM, which the driver
 * reads directly. So the format is the console's rather than a chip's, and the
 * two decisions that matter are different ones.
 *
 * **A cycle is thirty-two samples, not sixteen.** There is no block length to
 * respect here, so the length is chosen against the lattice instead: a voice
 * advances by a 16.16 step at 32768 samples a second, so a thirty-two-sample
 * cycle puts middle C at a step of about 0.51 and a top C at about 8.2 — which
 * keeps the *whole* melodic range inside a step small enough that the linear
 * interpolation the model performs is reading between real samples rather than
 * skipping over them. Sixteen would halve that headroom for no saving worth
 * having: the entire tone bank is under two hundred bytes either way.
 *
 * **Noise is a sample, because a mixer has no noise generator.** Every other
 * console in the set has a shift register in hardware; here the only thing that
 * exists is playback, so percussion plays a *recording* of one — 4096 samples of
 * a deterministic LFSR, looping. That is honest rather than a compromise: it is
 * what the hardware can do, and it is why the spec declares one noise period
 * rather than sixteen.
 *
 * **This file is the one definition of the layout**, and it has two readers that
 * must agree byte for byte: the binding, which puts a waveform's index in a
 * voice's `SRCN`, and the driver, which reads these bytes out of ROM. A second
 * copy of either number is a game whose bass plays the snare.
 */

import type { GbaSample } from "@demake/chip";

/** Samples in one tone cycle. See the file header for why it is not sixteen. */
export const WAVE_SAMPLES = 32;

/**
 * Samples in the noise waveform.
 *
 * Long enough that a loop at 32768 Hz repeats eight times a second, which is
 * below the pitch a listener hears as a tone and above the length a snare
 * occupies. A shorter table buzzes; a longer one costs cartridge for nothing.
 */
export const NOISE_SAMPLES = 4096;

/**
 * Peak amplitude of a waveform, and the reason it is not full scale.
 *
 * Six voices sum into an eight-bit converter before anything attenuates them, so
 * a bank at full scale is a bank whose loudest chord is also its most distorted.
 * A quarter of the range lets four voices sound together inside the DAC and
 * still puts a single voice well above the noise floor — the same trade the
 * Super Nintendo's bank makes, at a different depth.
 */
const PEAK = 32;

/** The waveforms, in the order their indices number them. */
export const WAVEFORMS = ["pulse12", "pulse25", "pulse50", "triangle", "saw", "noise"] as const;

/** One of the built-in waveforms. */
export type Waveform = (typeof WAVEFORMS)[number];

/** The sample number a waveform is reached by, which is its `SRCN`. */
export function sampleNumber(waveform: Waveform): number {
  const index = WAVEFORMS.indexOf(waveform);
  if (index < 0) throw new Error(`unknown waveform '${waveform}'`);
  return index;
}

/** One cycle of a waveform, as the signed bytes the converter takes. */
function cycle(waveform: Waveform): Int8Array {
  const data = new Int8Array(WAVE_SAMPLES);
  for (let index = 0; index < WAVE_SAMPLES; index += 1) {
    const phase = index / WAVE_SAMPLES;
    let value: number;
    switch (waveform) {
      case "pulse12":
        value = phase < 0.125 ? 1 : -1;
        break;
      case "pulse25":
        value = phase < 0.25 ? 1 : -1;
        break;
      case "pulse50":
        value = phase < 0.5 ? 1 : -1;
        break;
      case "triangle":
        value = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
        break;
      case "saw":
        value = 1 - 2 * phase;
        break;
      default:
        value = 0;
    }
    data[index] = Math.max(-PEAK, Math.min(PEAK, Math.round(value * PEAK)));
  }
  return data;
}

/**
 * The noise waveform: a fifteen-bit LFSR, sampled.
 *
 * The Game Boy's own polynomial and seed, taken deliberately — this is a
 * *recording* of the generator the other consoles have in hardware, so a demade
 * snare that moves from a Game Boy to this machine keeps its character rather
 * than acquiring a new one. Deterministic by construction: no host randomness
 * anywhere near a build (AGENTS.md §Iron rules).
 */
function noiseCycle(): Int8Array {
  const data = new Int8Array(NOISE_SAMPLES);
  let lfsr = 0x7fff;
  for (let index = 0; index < NOISE_SAMPLES; index += 1) {
    const bit = (lfsr ^ (lfsr >> 1)) & 1;
    lfsr = (lfsr >> 1) | (bit << 14);
    data[index] = (lfsr & 1) === 0 ? PEAK : -PEAK;
  }
  return data;
}

/**
 * The bank, in index order — what the mixer plays and what the driver uploads.
 *
 * Every waveform loops, including the noise: a voice is silenced by its level
 * rather than by running off the end, so a one-shot would be a second mechanism
 * for something the level already does.
 */
export function sampleBank(): GbaSample[] {
  return WAVEFORMS.map((waveform) =>
    waveform === "noise" ? { data: noiseCycle(), loop: 0 } : { data: cycle(waveform), loop: 0 },
  );
}

/** The bank as the flat bytes a cartridge carries, and where each waveform starts. */
export function bankBytes(): { bytes: Uint8Array; offsets: readonly number[] } {
  const bank = sampleBank();
  const offsets: number[] = [];
  let total = 0;
  for (const sample of bank) {
    offsets.push(total);
    total += sample.data.length;
  }
  const bytes = new Uint8Array(total);
  for (const [index, sample] of bank.entries()) {
    bytes.set(
      new Uint8Array(sample.data.buffer, sample.data.byteOffset, sample.data.length),
      offsets[index]!,
    );
  }
  return { bytes, offsets };
}
