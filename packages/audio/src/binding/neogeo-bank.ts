/**
 * The Neo Geo's sample ROMs — and the fourth kind of bank in the set.
 *
 * A Super Nintendo's bank is BRR blocks, a Game Boy Advance's is raw signed PCM,
 * a WonderSwan's is a page of bytes the driver copies and a PC Engine's is a
 * stream of register writes. This one is **two ROMs in two different codecs**,
 * because the chip's two sample sections do not share a decoder: the six
 * fixed-rate voices read ADPCM-A out of one and the variable-rate voice reads
 * ADPCM-B out of the other. On a cartridge those are the two V regions.
 *
 * What is in them follows from what each section can do, and the two answers are
 * as far apart as the codecs are.
 *
 *   - **The A ROM holds drums, because ADPCM-A has no pitch.** It plays at
 *     18518.5 Hz and there is no register that would change that, so a recording
 *     is the only thing it can usefully be. Four of them — kick, tom, snare, hat —
 *     chosen by the pitch the arranger gives a drum hit, which is
 *     `compile.ts`'s `DRUM_MAP` read backwards. This is the first console in the
 *     matrix whose percussion is a *sample* rather than a noise generator with an
 *     envelope on it.
 *   - **The B ROM holds single-cycle waveforms**, because ADPCM-B's rate is a
 *     phase increment and a cycle per note is what turns that into a pitch. Same
 *     idea as `sdsp-bank.ts` and `nds-bank.ts`, in a codec that was designed for
 *     speech.
 *
 * **Both encoders are exact against the decoders in `@demake/chip`.** An ADPCM
 * encoder is a search over sixteen codes per sample, and the only way to search
 * correctly is to run the decoder's own arithmetic — the twelve-bit wrap for A,
 * the sixteen-bit clamp and multiplicative step for B — so the bytes here decode
 * to what was intended rather than to something close. The two loops look alike
 * and are not: swapping their state updates produces a bank that plays as noise.
 *
 * Everything is deterministic: the noise bed is an integer shift register and the
 * envelopes come from `core`'s math kernels, so a bank built in a browser is the
 * bank built by the CLI (doc 02 §Determinism).
 */

import { math } from "@demake/core";

/** ADPCM addresses are in 256-byte units, so everything starts on a block. */
export const NEOGEO_SAMPLE_BLOCK = 256;

/** The fixed rate every ADPCM-A voice plays at. */
export const ADPCM_A_RATE_HZ = 8000000 / 432;

/** Where a sample sits, in the 256-byte blocks the registers count. */
export interface SampleRegion {
  /** First block, which is what `$10`/`$18` (A) or `$12`/`$13` (B) hold. */
  startBlock: number;
  /** Last block, inclusive — the hardware plays to its end. */
  endBlock: number;
}

/** The four drums the A ROM holds. */
export type NeogeoDrum = "kick" | "tom" | "snare" | "hat";

/** The waveforms the B ROM holds, named as `sdsp-bank.ts` names its own. */
export type NeogeoWaveform = "pulse12" | "pulse25" | "pulse50" | "triangle" | "saw";

/** Samples in one cycle of a B waveform; the spec's lattice divides by this. */
export const NEOGEO_WAVE_SAMPLES = 32;

/**
 * Which drum a percussion hit's pitch means.
 *
 * `compile.ts` gives a non-noise channel carrying percussion the drum's own pitch
 * out of its `DRUM_MAP`, and this reads that back: a kick is 65 Hz, a tom 110, a
 * snare 293, and everything above is a cymbal or a hat. It is a *band* rather
 * than a table because the map is the arranger's and may gain entries, and a band
 * that meets a new one puts it on the nearest drum rather than on nothing.
 */
export function drumFor(hz: number): NeogeoDrum {
  if (hz < 90) return "kick";
  if (hz < 200) return "tom";
  if (hz < 600) return "snare";
  return "hat";
}

/** Which waveform a melodic channel plays, decided once by its declared kind. */
export function waveformFor(kind: string, duty: number | undefined): NeogeoWaveform {
  if (kind === "triangle" || kind === "wave") return "triangle";
  // The duty first, and *whatever* the channel's declared kind is: the one voice
  // that reaches this is declared `sample`, because that is what the hardware is,
  // and asking about the kind would send every note to the fallback. What a duty
  // means here is which waveform the bank holds, which is the demaker's decision
  // (`sdsp-bank.ts`'s rule on a chip with no opinion).
  if (duty !== undefined) {
    const index = Math.max(0, Math.min(2, Math.round(duty)));
    return (["pulse12", "pulse25", "pulse50"] as const)[index] as NeogeoWaveform;
  }
  return "saw";
}

/** A built ROM and where each thing in it lives. */
export interface NeogeoBank<K extends string> {
  rom: Uint8Array;
  regions: Record<K, SampleRegion>;
}

let adpcmACache: NeogeoBank<NeogeoDrum> | undefined;
let adpcmBCache: NeogeoBank<NeogeoWaveform> | undefined;

/** The drum ROM, built once. */
export function adpcmABank(): NeogeoBank<NeogeoDrum> {
  adpcmACache ??= buildBank(["kick", "tom", "snare", "hat"] as const, (drum) =>
    encodeAdpcmA(drumSamples(drum)),
  );
  return adpcmACache;
}

/** The waveform ROM, built once. */
export function adpcmBBank(): NeogeoBank<NeogeoWaveform> {
  adpcmBCache ??= buildBank(
    ["pulse12", "pulse25", "pulse50", "triangle", "saw"] as const,
    (shape) => encodeAdpcmB(waveformSamples(shape)),
  );
  return adpcmBCache;
}

/** Lay encoded blobs out on block boundaries and record where each landed. */
function buildBank<K extends string>(
  names: readonly K[],
  encode: (name: K) => Uint8Array,
): NeogeoBank<K> {
  const blocks: Uint8Array[] = [];
  const regions = {} as Record<K, SampleRegion>;
  let block = 0;
  for (const name of names) {
    const encoded = encode(name);
    const padded = new Uint8Array(
      Math.ceil(encoded.length / NEOGEO_SAMPLE_BLOCK) * NEOGEO_SAMPLE_BLOCK,
    );
    padded.set(encoded);
    blocks.push(padded);
    const span = padded.length / NEOGEO_SAMPLE_BLOCK;
    regions[name] = { startBlock: block, endBlock: block + span - 1 };
    block += span;
  }
  const rom = new Uint8Array(block * NEOGEO_SAMPLE_BLOCK);
  let at = 0;
  for (const piece of blocks) {
    rom.set(piece, at);
    at += piece.length;
  }
  return { rom, regions };
}

// --- synthesis -----------------------------------------------------------------

/**
 * A deterministic noise bed: a 32-bit xorshift, not `Math.random`.
 *
 * The lint would refuse the host generator and it would be wrong anyway — a bank
 * that differed between two builds would change every cartridge's bytes for no
 * reason (doc 02 §Determinism).
 */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state / 0x80000000 - 1) * 0.5;
  };
}

const TAU = 6.283185307179586;

/** How long each drum rings, and the seed its noise bed starts from. */
const DRUMS: Record<NeogeoDrum, { seconds: number; seed: number }> = {
  kick: { seconds: 0.16, seed: 0x9e3779b9 },
  tom: { seconds: 0.18, seed: 0x85ebca6b },
  snare: { seconds: 0.14, seed: 0xc2b2ae35 },
  hat: { seconds: 0.05, seed: 0x27d4eb2f },
};

/** One drum, as signed samples in ±1 at the A section's fixed rate. */
function drumSamples(drum: NeogeoDrum): Float32Array {
  const { seconds, seed } = DRUMS[drum];
  const count = Math.round(ADPCM_A_RATE_HZ * seconds);
  const out = new Float32Array(count);
  const noise = noiseSource(seed);
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const t = index / ADPCM_A_RATE_HZ;
    const raw = noise();
    const value = drumVoice(drum, t, raw, previous);
    previous = raw;
    out[index] = value < -1 ? -1 : value > 1 ? 1 : value;
  }
  return out;
}

function drumVoice(drum: NeogeoDrum, t: number, raw: number, previous: number): number {
  switch (drum) {
    case "kick": {
      // A pitch that falls is what makes a kick a kick rather than a low beep.
      const hz = 48 + 90 * math.exp(-t * 34);
      return math.sin(TAU * hz * t) * math.exp(-t * 24);
    }
    case "tom": {
      const hz = 110 + 60 * math.exp(-t * 22);
      return math.sin(TAU * hz * t) * math.exp(-t * 16);
    }
    case "snare":
      // Body and rattle: a tone that dies fast under noise that dies slower.
      return math.sin(TAU * 190 * t) * math.exp(-t * 34) * 0.5 + raw * math.exp(-t * 24) * 1.4;
    default:
      // A first difference is a one-pole high pass, which is all a hat needs.
      return (raw - previous) * math.exp(-t * 90) * 1.6;
  }
}

/** One cycle of a waveform, repeated enough for the encoder to settle. */
function waveformSamples(shape: NeogeoWaveform): Float32Array {
  // ADPCM tracks *deltas*, so a cycle the decoder has never seen starts from an
  // accumulator of zero and a minimum step — which is a first cycle that is not
  // the waveform. Repeating it lets the encoder converge, and the driver points
  // at the whole run and loops it.
  const cycles = 64;
  const out = new Float32Array(NEOGEO_WAVE_SAMPLES * cycles);
  for (let index = 0; index < out.length; index += 1) {
    const phase = (index % NEOGEO_WAVE_SAMPLES) / NEOGEO_WAVE_SAMPLES;
    out[index] = sampleOf(shape, phase) * 0.8;
  }
  return out;
}

function sampleOf(shape: NeogeoWaveform, phase: number): number {
  switch (shape) {
    case "pulse12":
      return phase < 0.125 ? 1 : -1;
    case "pulse25":
      return phase < 0.25 ? 1 : -1;
    case "pulse50":
      return phase < 0.5 ? 1 : -1;
    case "triangle":
      return phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
    default:
      return phase * 2 - 1;
  }
}

// --- encoders ------------------------------------------------------------------

const ADPCM_A_STEPS: readonly number[] = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552,
];
const ADPCM_A_ADJUST: readonly number[] = [-1, -1, -1, -1, 2, 5, 7, 9];
const ADPCM_B_ADJUST: readonly number[] = [57, 57, 57, 57, 77, 102, 128, 153];

/**
 * Encode to ADPCM-A: a search per sample, over the decoder's own arithmetic.
 *
 * The candidate is chosen on the *unwrapped* sum and the wrap is applied
 * afterwards, which matters: a code that overflows twelve bits lands on the far
 * side and would otherwise look like a perfect match for a distant target. That
 * is a click on every loud transient, in a bank that measures as accurate.
 */
function encodeAdpcmA(samples: Float32Array): Uint8Array {
  const nibbles = new Uint8Array(samples.length);
  let accumulator = 0;
  let step = 0;
  for (const [index, sample] of samples.entries()) {
    const target = Math.max(-2048, Math.min(2047, Math.round(sample * 2047)));
    let best = 0;
    let bestError = Infinity;
    for (let code = 0; code < 16; code += 1) {
      const magnitude = Math.trunc(((2 * (code & 7) + 1) * (ADPCM_A_STEPS[step] as number)) / 8);
      const delta = (code & 8) === 0 ? magnitude : -magnitude;
      const error = Math.abs(accumulator + delta - target);
      if (error < bestError) {
        bestError = error;
        best = code;
      }
    }
    const magnitude = Math.trunc(((2 * (best & 7) + 1) * (ADPCM_A_STEPS[step] as number)) / 8);
    accumulator += (best & 8) === 0 ? magnitude : -magnitude;
    accumulator &= 0xfff;
    if ((accumulator & 0x800) !== 0) accumulator -= 0x1000;
    step = Math.max(0, Math.min(48, step + (ADPCM_A_ADJUST[best & 7] as number)));
    nibbles[index] = best;
  }
  return packNibbles(nibbles);
}

/**
 * Encode to ADPCM-B, whose state moves differently in both of its two halves.
 *
 * The accumulator *clamps* rather than wrapping and the step scales by a
 * multiplier rather than moving along a table — so this loop and the one above
 * are the same shape and share not one line of arithmetic.
 */
function encodeAdpcmB(samples: Float32Array): Uint8Array {
  const nibbles = new Uint8Array(samples.length);
  let accumulator = 0;
  let step = 127;
  for (const [index, sample] of samples.entries()) {
    const target = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    let best = 0;
    let bestError = Infinity;
    for (let code = 0; code < 16; code += 1) {
      const magnitude = Math.trunc(((2 * (code & 7) + 1) * step) / 8);
      const delta = (code & 8) === 0 ? magnitude : -magnitude;
      const error = Math.abs(Math.max(-32768, Math.min(32767, accumulator + delta)) - target);
      if (error < bestError) {
        bestError = error;
        best = code;
      }
    }
    const magnitude = Math.trunc(((2 * (best & 7) + 1) * step) / 8);
    accumulator = Math.max(
      -32768,
      Math.min(32767, accumulator + ((best & 8) === 0 ? magnitude : -magnitude)),
    );
    step = Math.max(
      127,
      Math.min(24576, Math.trunc((step * (ADPCM_B_ADJUST[best & 7] as number)) / 64)),
    );
    nibbles[index] = best;
  }
  return packNibbles(nibbles);
}

/** Two nibbles a byte, the first in the high half — which both codecs share. */
function packNibbles(nibbles: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    const byte = index >> 1;
    out[byte] =
      (index & 1) === 0
        ? (nibbles[index] as number) << 4
        : (out[byte] as number) | (nibbles[index] as number);
  }
  return out;
}
