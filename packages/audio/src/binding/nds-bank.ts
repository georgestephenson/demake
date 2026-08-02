/**
 * The Nintendo DS's built-in waveform bank (doc 16 §The sample bank).
 *
 * The third of these and the one in the middle of the other two. A Super
 * Nintendo's bank is *uploaded* into a sound processor's private 64 KiB; a Game
 * Boy Advance's is read straight out of cartridge ROM by a mixer the processor
 * runs. This console's channels read an **address**, and what is at that address
 * is whatever the ARM7 put there — so the bank is copied once, at boot, from the
 * driver's own image into the sound processor's work RAM, and every source
 * register afterwards is a constant.
 *
 * They are **single cycles, thirty-two samples of signed eight-bit PCM**. Thirty-
 * two rather than the sixteen the other two banks use because this chip's pitch
 * is a *divider*: the period is `clock / (samples × hz)`, so a longer cycle is a
 * larger period and a finer lattice everywhere it matters. At A4 it is 1190
 * rather than 595, which halves the worst-case detune for eight bytes a waveform.
 *
 * **This file is the one definition of the layout**, and it has two readers that
 * must agree byte for byte: the binding, which puts a waveform's address in a
 * channel's `SAD`, and the driver builder, which lays these bytes down and copies
 * them there. A second copy of either number is a game whose bass plays the
 * snare.
 */

/**
 * Where the bank lives: a page of main RAM just below the ARM7's binary.
 *
 * Main RAM rather than the sound processor's own faster 64 KiB, and the reason is
 * a rule about being wrong rather than a rule about speed. The channels' source
 * addresses reach main RAM and ARM7 work RAM both, and every piece of software on
 * this console streams from the first — so putting the bank where nothing is in
 * doubt means a model that turned out to be wrong about the second could not hide
 * behind a cartridge written to the same wrong belief (AGENTS.md §Gotchas — a
 * machine description that is wrong *and consistent* passes everything).
 *
 * It is above the ARM9's heap by two megabytes and below the ARM7's binary by a
 * page, so nothing else in a demade cartridge can reach it. Page-aligned, which
 * is what makes a waveform change a single byte write: the low byte of `SAD` is
 * the waveform's own offset and the three above it never change.
 */
export const NDS_BANK_BASE = 0x0237f000;

/** Samples in one waveform, which is also its pitch lattice's step. */
export const NDS_WAVE_SAMPLES = 32;

/** Bytes one waveform occupies: eight-bit PCM, so one per sample. */
export const NDS_WAVE_BYTES = NDS_WAVE_SAMPLES;

/** Words one waveform occupies, which is what a channel's `LEN` counts. */
export const NDS_WAVE_WORDS = NDS_WAVE_BYTES / 4;

/**
 * Peak amplitude of a waveform, and why it is not full scale.
 *
 * Sixteen channels sum before the master volume, and a chip that clips is a chip
 * whose loudest chord is also its most distorted. This level with
 * {@link NDS_MASTER_VOLUME} lets ten channels sound together inside the mixer's
 * range and still puts a single one at a useful level — the Super Nintendo's
 * trade, made once for twice as many voices.
 *
 * It is also what a *duty* channel is matched against, and that match is the
 * whole reason for the number. A square wave on this chip is full scale and
 * nothing in the register file scales it but the per-channel divider, so the
 * binding puts every PSG channel on ÷4 and this peak is `$7FFF ÷ 4` expressed as
 * the top byte of a sample. Get the two apart and a demade arrangement is a
 * melody three times louder than the pad under it.
 */
const PEAK = 0x20;

/**
 * The divider a duty or noise channel runs at, which is what matches it to
 * {@link PEAK}: ÷4, so a full-scale square sits where a built-in waveform does.
 */
export const NDS_PSG_DIVIDER = 2;

/** `SOUNDCNT`'s master volume. Chosen against {@link PEAK}; see there. */
export const NDS_MASTER_VOLUME = 0x60;

/** The waveforms, in the order their indices number them. */
export const NDS_WAVEFORMS = ["pulse12", "pulse25", "pulse50", "triangle", "saw"] as const;

/** One of the built-in waveforms. */
export type NdsWaveform = (typeof NDS_WAVEFORMS)[number];

/** Where a waveform's bytes are, which is what a channel's `SAD` holds. */
export function waveAddress(waveform: NdsWaveform): number {
  return NDS_BANK_BASE + NDS_WAVEFORMS.indexOf(waveform) * NDS_WAVE_BYTES;
}

/** One cycle of a waveform, as thirty-two signed bytes. */
function cycle(waveform: NdsWaveform): number[] {
  const out: number[] = [];
  const half = NDS_WAVE_SAMPLES / 2;
  for (let i = 0; i < NDS_WAVE_SAMPLES; i += 1) {
    switch (waveform) {
      case "pulse12":
        out.push(i < NDS_WAVE_SAMPLES / 8 ? PEAK : -PEAK);
        break;
      case "pulse25":
        out.push(i < NDS_WAVE_SAMPLES / 4 ? PEAK : -PEAK);
        break;
      case "pulse50":
        out.push(i < half ? PEAK : -PEAK);
        break;
      case "triangle": {
        // Up for half the cycle and down for the other half, with no sample at
        // the peak, so the cycle joins itself without a flat spot.
        const up = i < half ? i : NDS_WAVE_SAMPLES - 1 - i;
        out.push(Math.round(((up - (half - 1) / 2) / ((half - 1) / 2)) * PEAK));
        break;
      }
      default:
        out.push(
          Math.round(((i - (NDS_WAVE_SAMPLES - 1) / 2) / ((NDS_WAVE_SAMPLES - 1) / 2)) * PEAK),
        );
        break;
    }
  }
  return out;
}

/** The whole bank, as the block the driver copies to {@link NDS_BANK_BASE}. */
export function ndsBank(): Uint8Array {
  const bytes = new Uint8Array(NDS_WAVEFORMS.length * NDS_WAVE_BYTES);
  for (let index = 0; index < NDS_WAVEFORMS.length; index += 1) {
    const samples = cycle(NDS_WAVEFORMS[index] as NdsWaveform);
    for (let at = 0; at < NDS_WAVE_BYTES; at += 1) {
      bytes[index * NDS_WAVE_BYTES + at] = (samples[at] as number) & 0xff;
    }
  }
  return bytes;
}

/**
 * The bank as the memory a channel reads it out of, for rendering offline.
 *
 * A `ChipScript` for this console is only half an artifact — "play the waveform
 * at `$3800040`" means nothing without the waveform — so `render()` puts this
 * behind the model, together with the address its first byte answers at, and the
 * CLI's WAV comes from the same bytes the cartridge copies (doc 16 §The sample
 * bank).
 */
export function ndsSampleRam(): { ram: Uint8Array; base: number } {
  return { ram: ndsBank(), base: NDS_BANK_BASE };
}
