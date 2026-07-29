/**
 * The Super Nintendo's built-in waveform bank (doc 16 §The sample bank).
 *
 * Every other chip demake targets *generates* its waveform: a duty cycle, a
 * triangle staircase, a shift register. The S-DSP does not generate anything —
 * it plays compressed samples out of the sound processor's RAM — so a demade
 * arrangement needs waveforms to exist before a note can sound, and this is where
 * they come from.
 *
 * They are **single cycles, sixteen samples long**, which is one BRR block each
 * looping to itself. That is not a compromise: sixteen samples is the block
 * length the format is built around, a looping single cycle is exactly what an
 * oscillator is, and it makes the pitch register a plain multiplier of
 * `32000 / 16 = 2000 Hz` (see `PitchLattice.kind`). The whole bank is under a
 * hundred bytes of the 64 KiB, which leaves the rest for the schedule.
 *
 * **This file is the one definition of the layout**, and it has two readers that
 * must agree byte for byte: the binding, which puts a waveform's index in a
 * voice's `SRCN`, and the driver builder, which uploads these bytes to that
 * address at boot. A second copy of either number is a game whose bass plays the
 * snare.
 */

import { encodeBrrBlock } from "@demake/chip";

/**
 * Where the sample directory lives in the sound processor's RAM.
 *
 * Page-aligned because the `DIR` register is the *page*, not the address. Low
 * enough to sit under the driver and its data, which start after the bank.
 */
export const ARAM_DIR = 0x0200;

/** The `DIR` register value that names it. */
export const ARAM_DIR_PAGE = ARAM_DIR >> 8;

/** Directory entries. Eight, so the whole thing is a round 32 bytes. */
const DIR_ENTRIES = 8;

/** Where the BRR blocks start, immediately after the directory. */
export const ARAM_WAVES = ARAM_DIR + DIR_ENTRIES * 4;

/** Samples in one waveform: one BRR block, and one cycle. */
export const WAVE_SAMPLES = 16;

/** Bytes one waveform occupies. */
const BLOCK_BYTES = 9;

/**
 * Peak amplitude of a waveform, and the reason it is not full scale.
 *
 * Eight voices sum before the master volume, and a chip that clips is a chip
 * whose loudest chord is also its most distorted. This level with
 * {@link MASTER_VOLUME} lets six voices sound together inside the DAC's range and
 * still puts a single voice at a useful level — which is the trade every mixing
 * decision on this console comes down to, made once and stated.
 */
const PEAK = 0x2000;

/** `MVOL`, both sides. Chosen against {@link PEAK}; see there. */
export const MASTER_VOLUME = 0x50;

/** The waveforms, in the order their indices number them. */
export const WAVEFORMS = ["pulse12", "pulse25", "pulse50", "triangle", "saw"] as const;

/** One of the built-in waveforms. */
export type Waveform = (typeof WAVEFORMS)[number];

/** The sample number a waveform is reached by, which is its `SRCN`. */
export function sampleNumber(waveform: Waveform): number {
  return WAVEFORMS.indexOf(waveform);
}

/** One cycle of a waveform, as sixteen signed samples. */
function cycle(waveform: Waveform): number[] {
  const out: number[] = [];
  for (let i = 0; i < WAVE_SAMPLES; i += 1) {
    switch (waveform) {
      case "pulse12":
        out.push(i < 2 ? PEAK : -PEAK);
        break;
      case "pulse25":
        out.push(i < 4 ? PEAK : -PEAK);
        break;
      case "pulse50":
        out.push(i < 8 ? PEAK : -PEAK);
        break;
      case "triangle": {
        // Up for eight samples, down for eight: a staircase with no sample at
        // the peak, so the cycle joins itself without a flat spot.
        const up = i < 8 ? i : 15 - i;
        out.push(Math.round(((up - 3.5) / 3.5) * PEAK));
        break;
      }
      default:
        out.push(Math.round(((i - 7.5) / 7.5) * PEAK));
        break;
    }
  }
  return out;
}

/**
 * The directory and the waveforms, as one block to upload at {@link ARAM_DIR}.
 *
 * Every block is flagged `loop` and `end` and points its loop address at itself,
 * which is how a sixteen-sample waveform becomes an oscillator that runs for as
 * long as the note does.
 */
export function waveformBank(): Uint8Array {
  const bytes = new Uint8Array(DIR_ENTRIES * 4 + WAVEFORMS.length * BLOCK_BYTES);
  for (let index = 0; index < WAVEFORMS.length; index += 1) {
    const at = ARAM_WAVES + index * BLOCK_BYTES;
    const entry = index * 4;
    bytes[entry] = at & 0xff;
    bytes[entry + 1] = at >> 8;
    bytes[entry + 2] = at & 0xff;
    bytes[entry + 3] = at >> 8;
    bytes.set(
      encodeBrrBlock(cycle(WAVEFORMS[index] as Waveform), { loop: true, end: true }),
      at - ARAM_DIR,
    );
  }
  return bytes;
}

/**
 * A 64 KiB image with the bank in place, for rendering a schedule offline.
 *
 * A `ChipScript` for this console is only half an artifact: "play sample 3" means
 * nothing without the samples. `render()` puts this behind the model so the CLI's
 * WAV and the cartridge's output come from the same waveforms.
 */
export function sampleAram(): Uint8Array {
  const ram = new Uint8Array(0x10000);
  ram.set(waveformBank(), ARAM_DIR);
  return ram;
}
