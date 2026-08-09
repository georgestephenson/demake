/**
 * Fitting a four-operator FM patch to a part (doc 17 §Stage 3).
 *
 * Every other console in this set has a *fixed* palette of timbres: a Game Boy
 * pulse offers four duties and that is the whole choice. The YM2612 does not —
 * its timbre is thirty-odd register bits per voice, and the space is far too big
 * to pick from a list. So this is the one place in the music demaker where the
 * sound is **searched** rather than selected, which is the axis doc 17 said
 * would appear the day an FM console arrived.
 *
 * The search is hardware-in-the-loop, on the sound demaker's precedent (doc 18):
 * a candidate is not scored by a formula about what it *should* sound like, it
 * is played on {@link Ym2612} and measured. Three numbers come back — where the
 * energy sits, how quickly it arrives, and how much of it is left after half a
 * second — and they are compared with what the part actually asks for. A patch
 * that scores well is one that measured well, which is the same bargain the
 * image path's judge makes.
 *
 * What the part asks for is read off the source rather than assumed:
 *
 *   - **Brightness** from the General MIDI program where the input had one, and
 *     from the role otherwise. A brass program wants harmonics; a flute does not.
 *   - **Attack** from articulation. Notes that are short against their spacing
 *     are being plucked or struck and want an immediate attack; long overlapping
 *     ones are being bowed or held and want a slow one.
 *   - **Sustain** from the same measurement. A part whose notes fill their own
 *     duration wants a patch that holds; one whose notes die before the next
 *     wants one that decays, and asking the chip to hold there would smear the
 *     line.
 *
 * The candidates are *generated* — algorithm, feedback and modulation depth over
 * a grid — rather than a checked-in preset bank, because a preset bank is a list
 * of someone else's opinions and would be the thing that stops improving.
 */

import { renderSchedule, Ym2612, YM2612_CLOCK_HZ } from "@demake/chip";
import { math } from "@demake/core";

import { centroid, envelope, hann, spectrum } from "../dsp.js";
import type { Part } from "../score/types.js";

/** One operator's registers, as the binding will write them. */
export interface FmOperator {
  /** Detune, 0-7: 0-3 sharp, 4-7 the flat mirrors. */
  detune: number;
  /** Frequency multiple, 0-15, where 0 means one half. */
  multiple: number;
  /** Total level, 0 loudest to 127 silent. A carrier's is the note's volume. */
  totalLevel: number;
  /** Rate scaling, 0-3: how much faster the envelope runs at high pitches. */
  keyScale: number;
  attack: number;
  decay: number;
  sustainRate: number;
  /** Attenuation the decay hands over at, 0-15. */
  sustainLevel: number;
  release: number;
}

/** One voice's timbre. */
export interface FmPatch {
  algorithm: number;
  feedback: number;
  operators: readonly [FmOperator, FmOperator, FmOperator, FmOperator];
}

/** What the search measured, kept so a report can say why this patch won. */
export interface FmPatchFit {
  patch: FmPatch;
  /** Candidates the tournament played. */
  candidates: number;
  /** Spectral centroid of the winner, in Hz at the reference note. */
  brightnessHz: number;
  /** Seconds from key-on to the peak of the envelope. */
  attackSeconds: number;
  /** Level at half a second as a fraction of the peak. */
  sustainRatio: number;
  /** Distance from what the part asked for; lower is better. */
  score: number;
}

/**
 * What an arranger hands a binding beyond the frames, on a console with FM.
 *
 * Two consoles take it — a Mega Drive's six voices and a Neo Geo's four — and
 * they take it for the same reason: timbre here is *searched* rather than
 * selected, the search needs to know which part a voice carries, and that is not
 * known until a candidate has been planned. So a candidate rebuilds the console's
 * binding carrying its own fitted patches.
 */
export interface FmBindingOptions {
  /** Patch per FM channel, by channel index; a missing one gets a default. */
  patches?: readonly (FmPatch | undefined)[];
}

/** Which slots an algorithm's carriers are — the ones the note's volume rides. */
export function carriersOf(algorithm: number): readonly number[] {
  return CARRIERS[algorithm] as readonly number[];
}

const CARRIERS: readonly (readonly number[])[] = [
  [3],
  [3],
  [3],
  [3],
  [1, 3],
  [1, 2, 3],
  [1, 2, 3],
  [0, 1, 2, 3],
];

/**
 * What a part wants of a timbre, in the units the search measures.
 *
 * Normalised 0-1 rather than in Hz and seconds, because the point is to compare
 * a part with a candidate and neither is meaningful in absolute terms until they
 * are put beside each other.
 */
export interface TimbreTarget {
  /** 0 dark, 1 brilliant. */
  brightness: number;
  /** 0 immediate, 1 slow swell. */
  attack: number;
  /** 0 dies away, 1 holds. */
  sustain: number;
}

/**
 * General MIDI families, as brightness and attack.
 *
 * Sixteen families of eight programs, which is the resolution GM actually has —
 * a source that says "program 30" is saying "distorted guitar", and the useful
 * part of that for a demake is "bright, immediate, sustained" rather than the
 * name.
 */
const GM_FAMILY: readonly { brightness: number; attack: number; sustain: number }[] = [
  { brightness: 0.45, attack: 0.05, sustain: 0.25 }, // piano
  { brightness: 0.6, attack: 0.05, sustain: 0.2 }, // chromatic percussion
  { brightness: 0.5, attack: 0.3, sustain: 0.95 }, // organ
  { brightness: 0.4, attack: 0.08, sustain: 0.35 }, // guitar
  { brightness: 0.3, attack: 0.1, sustain: 0.5 }, // bass
  { brightness: 0.35, attack: 0.55, sustain: 0.95 }, // strings
  { brightness: 0.4, attack: 0.45, sustain: 0.9 }, // ensemble
  { brightness: 0.8, attack: 0.25, sustain: 0.9 }, // brass
  { brightness: 0.45, attack: 0.3, sustain: 0.9 }, // reed
  { brightness: 0.25, attack: 0.2, sustain: 0.9 }, // pipe
  { brightness: 0.7, attack: 0.15, sustain: 0.7 }, // synth lead
  { brightness: 0.35, attack: 0.6, sustain: 0.95 }, // synth pad
  { brightness: 0.75, attack: 0.1, sustain: 0.4 }, // synth effects
  { brightness: 0.55, attack: 0.05, sustain: 0.2 }, // ethnic
  { brightness: 0.7, attack: 0.02, sustain: 0.1 }, // percussive
  { brightness: 0.85, attack: 0.05, sustain: 0.3 }, // sound effects
];

/** Where a role sits when the source gave no program at all. */
const ROLE_TARGET: Readonly<Record<string, TimbreTarget>> = {
  bass: { brightness: 0.25, attack: 0.05, sustain: 0.45 },
  lead: { brightness: 0.7, attack: 0.1, sustain: 0.8 },
  harmony: { brightness: 0.45, attack: 0.2, sustain: 0.7 },
  pad: { brightness: 0.3, attack: 0.6, sustain: 0.95 },
  arp: { brightness: 0.6, attack: 0.03, sustain: 0.2 },
  fx: { brightness: 0.8, attack: 0.05, sustain: 0.3 },
  percussion: { brightness: 0.9, attack: 0.0, sustain: 0.05 },
};

/**
 * What this part is asking for, from the program it named and how it is played.
 *
 * The program is a *hint* and the articulation is evidence: a source that says
 * "strings" but plays sixteenth notes that stop dead is not asking for a slow
 * swell, whatever its program number says. So the measured articulation moves
 * the family's attack and sustain rather than merely being averaged with them.
 */
export function targetFor(part: Part): TimbreTarget {
  const base =
    part.program === undefined
      ? (ROLE_TARGET[part.role] ?? ROLE_TARGET.harmony!)
      : familyTarget(part.program);
  const played = articulation(part);
  if (played === null) return base;
  return {
    brightness: base.brightness,
    // Short notes cannot show a slow attack however the program is labelled.
    attack: Math.min(base.attack, played.attack),
    sustain: base.sustain * 0.4 + played.sustain * 0.6,
  };
}

function familyTarget(program: number): TimbreTarget {
  const family = GM_FAMILY[Math.min(15, Math.max(0, Math.floor(program / 8)))]!;
  return { brightness: family.brightness, attack: family.attack, sustain: family.sustain };
}

/**
 * How this part is actually played: attack room, and whether notes hold.
 *
 * `null` for a part with too few notes to say anything, which is when the
 * program's own character should stand unmodified.
 */
function articulation(part: Part): { attack: number; sustain: number } | null {
  if (part.notes.length < 3) return null;
  const sorted = [...part.notes].sort((a, b) => a.tick - b.tick);
  let gaps = 0;
  let fill = 0;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const note = sorted[index]!;
    const next = sorted[index + 1]!;
    const spacing = next.tick - note.tick;
    if (spacing <= 0) continue;
    gaps += 1;
    fill += Math.min(1, note.durationTicks / spacing);
    shortest = Math.min(shortest, note.durationTicks);
  }
  if (gaps === 0) return null;
  const held = fill / gaps;
  // A note lasting a whole beat has room for a slow attack; a sixteenth does
  // not. Ticks are the score's own quarter-note division, so this is in beats.
  const beats = shortest / 480;
  return {
    attack: Math.min(1, Math.max(0, beats - 0.15)),
    sustain: held,
  };
}

/** A candidate's rendered character, measured rather than predicted. */
interface Measured {
  brightnessHz: number;
  attackSeconds: number;
  sustainRatio: number;
}

/** Reference note the search plays: A4, near the middle of every part's range. */
const REFERENCE_FNUM = 1083;
const REFERENCE_BLOCK = 4;

/** Seconds of each candidate the search renders and measures. */
const AUDITION_SECONDS = 0.6;

/**
 * Sample rate the audition renders at.
 *
 * Well below the delivery rate, and deliberately: the search compares candidates
 * with each other on where their energy sits, and a spectral centroid needs
 * bandwidth rather than fidelity. A third of the samples is a third of the
 * search's cost, and the winner is rendered properly like everything else.
 */
const AUDITION_RATE = 16000;

/**
 * Play one patch on the chip and measure what came out.
 *
 * Exported because the report wants the winner's numbers and the tests want to
 * assert that a candidate the search prefers really is brighter than one it
 * rejects — a scoring function nobody can measure against is a scoring function
 * that drifts.
 */
export function auditionPatch(patch: FmPatch, sampleRate = AUDITION_RATE): Measured {
  const chip = new Ym2612();
  const writes = patchWrites(patch, 0).concat(pitchWrites(0, REFERENCE_FNUM, REFERENCE_BLOCK), [
    { reg: 0, value: 0xb4 },
    { reg: 1, value: 0xc0 },
    { reg: 0, value: 0x28 },
    { reg: 1, value: 0xf0 },
  ]);
  const rate = 100;
  const ticks = Math.max(2, Math.round(AUDITION_SECONDS * rate));
  const schedule = [{ writes }, ...Array.from({ length: ticks - 1 }, () => ({ writes: [] }))];
  const pcm = renderSchedule(chip, schedule, { num: rate, den: 1 }, { sampleRate, tailSeconds: 0 });
  const samples = pcm.channels[0] as Float32Array;

  const frame = 512;
  const shape = envelope(samples, frame, frame / 2);
  let peak = 0;
  let peakAt = 0;
  for (let index = 0; index < shape.length; index += 1) {
    const value = shape[index] as number;
    if (value > peak) {
      peak = value;
      peakAt = index;
    }
  }
  const halfSecond = Math.min(shape.length - 1, Math.floor((0.5 * sampleRate) / (frame / 2)));
  const sustainRatio = peak > 0 ? (shape[halfSecond] as number) / peak : 0;

  // Measured just after the attack has landed, which is where the timbre is
  // rather than where the transient is.
  const window = hann(frame);
  const at = Math.min(samples.length - frame - 1, Math.floor(0.08 * sampleRate));
  const magnitude = spectrum(samples.subarray(at, at + frame), window);
  return {
    brightnessHz: peak > 0 ? centroid(magnitude, sampleRate, frame) : 0,
    attackSeconds: (peakAt * (frame / 2)) / sampleRate,
    sustainRatio,
  };
}

/**
 * Search the candidate space for the patch that best matches a target.
 *
 * A tournament, in the image path's sense: every candidate is played, measured
 * and scored, and the winner is the lowest score in *candidate order* so that
 * ties break deterministically rather than by whichever finished first.
 */
export function fitPatch(target: TimbreTarget): FmPatchFit {
  const candidates = generateCandidates();
  let best: FmPatchFit | null = null;
  for (const patch of candidates) {
    const measured = auditionPatch(patch);
    const score = distance(target, measured);
    if (best === null || score < best.score) {
      best = {
        patch,
        candidates: candidates.length,
        brightnessHz: measured.brightnessHz,
        attackSeconds: measured.attackSeconds,
        sustainRatio: measured.sustainRatio,
        score,
      };
    }
  }
  return best as FmPatchFit;
}

/** Fit a patch for a part, which is a target and then a search. */
export function fitPatchForPart(part: Part): FmPatchFit {
  return fitPatch(targetFor(part));
}

/**
 * How far a measurement is from a target, in comparable units.
 *
 * Brightness is compared on a log scale because pitch perception is, and the
 * range that matters spans a factor of twenty; attack and sustain are already
 * fractions. Brightness is weighted highest because it is the thing a listener
 * would name if the patch were wrong.
 */
function distance(target: TimbreTarget, measured: Measured): number {
  const wanted = 200 * math.pow(24, target.brightness);
  const got = Math.max(60, measured.brightnessHz);
  const brightness = Math.abs(math.log(got / wanted)) / math.log(24);
  const attack = Math.abs(measured.attackSeconds / 0.4 - target.attack);
  const sustain = Math.abs(measured.sustainRatio - target.sustain);
  return brightness * 2 + attack + sustain * 1.2;
}

/**
 * The candidate space: a grid rather than a preset bank.
 *
 * Five algorithms that between them cover the useful shapes — a four-operator
 * stack, a split stack, a two-stack, one-into-three and full additive — crossed
 * with modulator depth, feedback, and three envelope shapes. Ninety candidates,
 * each rendering six hundred milliseconds of one voice at sixteen kilohertz;
 * together about a second per part, memoised so a four-candidate arrangement
 * portfolio pays for it once.
 */
function generateCandidates(): FmPatch[] {
  const out: FmPatch[] = [];
  for (const algorithm of [0, 2, 4, 5, 7]) {
    for (const feedback of [0, 4]) {
      for (const depth of [14, 28, 44]) {
        for (const shape of ENVELOPES) {
          out.push(buildPatch(algorithm, feedback, depth, shape));
        }
      }
    }
  }
  return out;
}

/** Envelope shapes, which is what "plucked", "held" and "swelling" mean here. */
const ENVELOPES: readonly {
  attack: number;
  decay: number;
  sustainRate: number;
  sustainLevel: number;
}[] = [
  // Struck: instant, decays away and never holds.
  { attack: 31, decay: 14, sustainRate: 8, sustainLevel: 6 },
  // Held: immediate, settles and stays.
  { attack: 31, decay: 10, sustainRate: 0, sustainLevel: 3 },
  // Swelling: a slow rise into a hold.
  { attack: 14, decay: 6, sustainRate: 0, sustainLevel: 1 },
];

/**
 * Assemble one candidate.
 *
 * Carriers keep total level 0 — the note's own volume is written over it at play
 * time — and modulators take the candidate's depth, which is the one knob that
 * actually moves the timbre. Multiples rise through the operator chain so that a
 * deeper stack is brighter rather than merely louder.
 */
function buildPatch(
  algorithm: number,
  feedback: number,
  depth: number,
  shape: (typeof ENVELOPES)[number],
): FmPatch {
  const carriers = new Set(carriersOf(algorithm));
  const operators = [0, 1, 2, 3].map((slot): FmOperator => {
    const carrier = carriers.has(slot);
    return {
      // A little detune on the modulators is what stops a patch sounding like a
      // ring modulator; carriers stay true or the note goes out of tune.
      detune: carrier ? 0 : (slot % 3) + 1,
      multiple: carrier ? 1 : slot === 0 ? 1 : slot + 1,
      totalLevel: carrier ? 0 : depth,
      keyScale: 1,
      attack: shape.attack,
      decay: carrier ? shape.decay : Math.min(31, shape.decay + 4),
      sustainRate: carrier ? shape.sustainRate : shape.sustainRate,
      sustainLevel: carrier ? shape.sustainLevel : Math.min(15, shape.sustainLevel + 1),
      release: 7,
    };
  }) as unknown as readonly [FmOperator, FmOperator, FmOperator, FmOperator];
  return { algorithm, feedback, operators };
}

/**
 * The bus writes that install a patch on one channel.
 *
 * Address then datum, on the half of the bus the channel lives on — which is the
 * form a driver stores and therefore the form a schedule carries.
 */
export function patchWrites(patch: FmPatch, channel: number): { reg: number; value: number }[] {
  const half = channel < 3 ? 0 : 1;
  const within = channel % 3;
  const out: { reg: number; value: number }[] = [];
  const write = (address: number, value: number): void => {
    out.push({ reg: half * 2, value: address }, { reg: half * 2 + 1, value });
  };
  // Register slot order is S1, S3, S2, S4; the patch is in signal order.
  const REGISTER_SLOT = [0, 2, 1, 3];
  for (let position = 0; position < 4; position += 1) {
    const operator = patch.operators[REGISTER_SLOT[position] as number] as FmOperator;
    const at = position * 4 + within;
    write(0x30 + at, ((operator.detune & 7) << 4) | (operator.multiple & 0x0f));
    write(0x40 + at, operator.totalLevel & 0x7f);
    write(0x50 + at, ((operator.keyScale & 3) << 6) | (operator.attack & 0x1f));
    write(0x60 + at, operator.decay & 0x1f);
    write(0x70 + at, operator.sustainRate & 0x1f);
    write(0x80 + at, ((operator.sustainLevel & 0x0f) << 4) | (operator.release & 0x0f));
    write(0x90 + at, 0x00);
  }
  write(0xb0 + within, ((patch.feedback & 7) << 3) | (patch.algorithm & 7));
  return out;
}

/** The two writes that set a channel's pitch, high half first as the chip wants. */
export function pitchWrites(
  channel: number,
  fnum: number,
  block: number,
): { reg: number; value: number }[] {
  const half = channel < 3 ? 0 : 1;
  const within = channel % 3;
  return [
    { reg: half * 2, value: 0xa4 + within },
    { reg: half * 2 + 1, value: ((block & 7) << 3) | ((fnum >> 8) & 7) },
    { reg: half * 2, value: 0xa0 + within },
    { reg: half * 2 + 1, value: fnum & 0xff },
  ];
}

/** The natural log of ten, for the one decibel conversion below. */
const LN10 = 2.302585092994046;

/**
 * A frequency as an F-number and a block, at a given internal sample rate.
 *
 * The block is chosen so the F-number lands in the top half of its range, which
 * is where the lattice is finest: the same note an octave lower in F-number
 * terms is the same pitch with half the resolution, and on a chip whose steps
 * are already sub-cent at the top that is the difference between exact and
 * merely close.
 *
 * The rate is a parameter because two consoles run this core at different
 * clocks — a Mega Drive's YM2612 at master over seven and a Neo Geo's YM2610 at
 * 8 MHz — and the encoding is otherwise identical, because it is the same core.
 */
export function fnumAt(hz: number, sampleRate: number): { fnum: number; block: number } {
  if (!(hz > 0)) return { fnum: 0, block: 0 };
  // f = fnum * sampleRate * 2^(block-1) / 2^20
  let block = 0;
  let fnum = (hz * (1 << 20)) / sampleRate / 0.5;
  while (fnum >= 2048 && block < 7) {
    fnum /= 2;
    block += 1;
  }
  while (fnum < 1024 && block > 0) {
    fnum *= 2;
    block -= 1;
  }
  const rounded = Math.round(fnum);
  return { fnum: Math.max(0, Math.min(2047, rounded)), block };
}

/**
 * A 0-1 level as total level: seven bits of attenuation, 0.75 dB a step.
 *
 * The finest volume control either of these boards has by a factor of eight,
 * which is what makes an FM part able to swell where a square-wave one can only
 * step. Silence is 127 rather than a key-off, so a fade need not restart the
 * note.
 */
export function totalLevelFor(level: number): number {
  const clamped = level <= 0 ? 0 : level >= 1 ? 1 : level;
  if (clamped <= 0) return 0x7f;
  // 0.75 dB a step: 20*log10(level) / 0.75, floored at full attenuation. The
  // natural log and a constant, because a shared kernel is what makes the
  // register a browser writes the same one a CLI writes (doc 02 §Determinism).
  const db = (20 * math.log(clamped)) / LN10;
  const steps = Math.round(-db / 0.75);
  return steps < 0 ? 0 : steps > 0x7f ? 0x7f : steps;
}

export { YM2612_CLOCK_HZ };
