/**
 * The PC Engine's waveforms (doc 16 §The sample bank).
 *
 * The fourth of these and the one that is not a bank at all. A Super Nintendo's
 * waveforms are uploaded into a sound processor's private 64 KiB; a Game Boy
 * Advance's are read straight out of cartridge ROM by a mixer; a Nintendo DS's
 * are copied into main RAM once at boot. All three are *bytes somewhere*, and a
 * channel is told where.
 *
 * A HuC6280 channel is told nothing. Its thirty-two samples live in wave RAM
 * inside the chip, and the only way in is the register port — so what this file
 * produces is not a block of memory but **register writes**, which reach the
 * cartridge as part of `binding/pce.ts`'s `init()` and are therefore performed by
 * the driver's boot routine exactly as the chip's other initialisation is. There
 * is no bank in ROM, nothing to copy, and no address anybody has to agree about.
 *
 * ### What each channel gets
 *
 * Every voice on this chip is the same hardware, so which shape a channel plays
 * is the *demaker's* decision and it is made once, at boot, per channel. That is
 * the Super Nintendo's rule (`sdsp-bank.ts`) arriving on a console that generates
 * its own waveform rather than playing a sample — and it buys something neither
 * of the eight-bit consoles beside it can have: five pitched voices with **five
 * different timbres**, rather than four duties shared out among two pulses.
 *
 * A waveform is never re-uploaded while a track plays. It could be — thirty-two
 * writes is two per cent of a tick here — but nothing above this line asks for
 * one: the arranger's `duty` is a strategy-wide constant (doc 17 §Stage 4), so a
 * channel's shape cannot change mid-track and a per-note upload would be thirty-
 * two writes to say what the last note already said.
 *
 * Which is also why the pulse voices ignore that constant and take **a duty
 * each**. On a Game Boy the strategy's choice is the only lever there is, because
 * both pulses share one duty field's worth of meaning; here three voices can hold
 * three shapes at once, and three different ones is strictly more of the machine
 * spent than three copies of whichever one the strategy picked.
 *
 * Sources:
 * - Archaic Pixels — PSG: https://archaicpixels.com/PSG
 * - Charles MacDonald — PC Engine hardware notes (`pcetech.txt`), §PSG
 */

/** Samples in one channel's wave table, which is also its pitch lattice's step. */
export const PCE_WAVE_SAMPLES = 32;

/** The waveforms a demade arrangement can be given. */
export const PCE_WAVEFORMS = ["pulse12", "pulse25", "pulse50", "triangle", "saw"] as const;

/** One of them. */
export type PceWaveform = (typeof PCE_WAVEFORMS)[number];

/**
 * Peak and trough, which are the whole five-bit range.
 *
 * Unlike the three sample-playing chips, nothing here has to be held back from
 * full scale: six channels at full amplitude sum to exactly nominal full scale in
 * `Huc6280Psg` (§`levels`), because that is what the hardware's own summing does.
 * So a waveform uses every code it has and the loudness question is the volume
 * register's alone.
 */
const HIGH = 31;
const LOW = 0;

/**
 * One cycle, as thirty-two unsigned five-bit samples.
 *
 * Unsigned because the chip is: it subtracts sixteen itself, so a flat table of
 * sixteen is silence rather than a click, and a waveform's job is to be centred
 * on that. The triangle is built as odd values so it is exactly centred — an
 * even staircase would sit half a step low and leave a DC offset for the
 * renderer's blocker to remove for no reason.
 */
export function pceWaveform(waveform: PceWaveform): Uint8Array {
  const out = new Uint8Array(PCE_WAVE_SAMPLES);
  const half = PCE_WAVE_SAMPLES / 2;
  for (let index = 0; index < PCE_WAVE_SAMPLES; index += 1) {
    switch (waveform) {
      case "pulse12":
        out[index] = index < PCE_WAVE_SAMPLES / 8 ? HIGH : LOW;
        break;
      case "pulse25":
        out[index] = index < PCE_WAVE_SAMPLES / 4 ? HIGH : LOW;
        break;
      case "pulse50":
        out[index] = index < half ? HIGH : LOW;
        break;
      case "triangle": {
        const up = index < half ? index : PCE_WAVE_SAMPLES - 1 - index;
        out[index] = 2 * up + 1;
        break;
      }
      default:
        out[index] = index;
        break;
    }
  }
  return out;
}

/**
 * Which waveform a channel plays, by its declared kind and its position among
 * the channels of that kind.
 *
 * The spec's kinds exist so this table can: the `wave` entries take the two
 * shapes a wavetable voice is prized for — a triangle for the bass the arranger
 * will put on the first of them, a saw for the line that lands on the second —
 * and the `pulse` entries take one duty each, narrowest first, so the voice a
 * sound effect borrows (the spec's first pitched channel, and therefore this
 * one) is the thin blip an arcade cabinet would have used. The ordinal rather
 * than the raw index, so the spec can be reordered without silently reassigning
 * every timbre.
 *
 * A list that runs out repeats its last entry rather than failing: a chip with
 * more voices than shapes is a reason to draw another waveform, not a reason for
 * a build to stop.
 */
export function pceWaveformFor(kind: string, ordinal: number): PceWaveform {
  const shapes =
    kind === "pulse"
      ? (["pulse12", "pulse25", "pulse50"] as const)
      : (["triangle", "saw"] as const);
  const at = ordinal < 0 ? 0 : ordinal >= shapes.length ? shapes.length - 1 : ordinal;
  return shapes[at] as PceWaveform;
}
