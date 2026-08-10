/**
 * `Score` — the source side of the music demaker (doc 16 §Two representations).
 *
 * The musical content, with no notion of a console. Every ingest path produces
 * one of these and the arranger reads only these, which is what keeps "what the
 * music is" separate from "what this machine can play" — the same split the
 * image path draws between a source image and a `CompliantImage`.
 *
 * Two choices here are load-bearing:
 *
 * - **Pitch is integer cents**, not a MIDI note number. Everything interesting
 *   downstream is a pitch *error*: how far a note moved when it snapped to a
 *   period register, how far the whole track was transposed to fit. Cents is the
 *   unit those errors are measured in and 1 cent is far below the ~5-cent
 *   discrimination threshold, so nothing is lost and no stage has to invent a
 *   floating-point pitch.
 * - **Time is musical**, not absolute: ticks against a tempo map. Preserving BPM
 *   is a product requirement, and a score stored in milliseconds has already
 *   thrown away the grid its onsets need to be quantized against.
 */

/** Pulses per quarter note. Fixed, and divisible by 2^6 · 3 · 5. */
export const PPQ = 960;

/** What a part is *for*, which decides which channels can carry it. */
export type PartRole = "percussion" | "bass" | "lead" | "harmony" | "pad" | "arp" | "fx";

/** Percussion carries a class rather than a pitch. */
export type DrumClass = "kick" | "snare" | "hat-closed" | "hat-open" | "tom" | "cymbal" | "perc";

/** One note. `pitch` is cents above MIDI note 0; 6000 is middle C. */
export interface Note {
  tick: number;
  durationTicks: number;
  pitch: number;
  /** 0–127, as MIDI delivers it. */
  velocity: number;
  drum?: DrumClass;
  /**
   * How much this note matters, 0–1 (doc 17 §Stage 1).
   *
   * The counterpart of the image path's insistence that frequency is not
   * importance: the loudest thing in a mix is usually the drums and the thing
   * you would hum usually is not. Filled in by analysis, spent by the arranger.
   */
  salience: number;
  /**
   * How much vibrato the source asked for on this note, 0–1 (doc 17 §Vibrato).
   *
   * **Read, never invented.** General MIDI puts vibrato depth on the modulation
   * wheel — controller 1 — so a source that wants it says so, and this is that
   * statement carried through to the arranger rather than a guess made from the
   * instrument's programme. A part with no modulation in it gets none, which is
   * why adding this changed no existing output by a byte: nothing in the example
   * library touches CC1.
   *
   * Per *note* rather than per part, because that is the resolution the source
   * has: a controller can swell across a phrase, and the depth a note is played
   * with is the highest the wheel reached while it sounded.
   */
  vibrato?: number;
}

/** A tempo-map point: microseconds per quarter note from `tick` onward. */
export interface TempoPoint {
  tick: number;
  microsecondsPerQuarter: number;
}

/** A time-signature change. */
export interface MeterPoint {
  tick: number;
  numerator: number;
  denominator: number;
}

/** A musically meaningful span, used for loop choice and budget spending. */
export interface Section {
  startTick: number;
  endTick: number;
  label: string;
}

/** One voice of the source material. */
export interface Part {
  id: string;
  name: string;
  role: PartRole;
  /** 0–1; reported, and low values are worth surfacing rather than hiding. */
  roleConfidence: number;
  notes: Note[];
  /** Mean simultaneous notes across the part's sounding time. */
  polyphony: number;
  /** Source hint: a General MIDI program number, where the input had one. */
  program?: number;
}

/** A complete piece, hardware-free. */
export interface Score {
  ppq: number;
  tempo: TempoPoint[];
  meter: MeterPoint[];
  parts: Part[];
  sections: Section[];
  loop?: { startTick: number; endTick: number };
  /** Total length in ticks. */
  durationTicks: number;
  provenance: { format: string; confidence?: number };
}

/** Microseconds per quarter at `tick`, honouring the tempo map. */
export function tempoAt(score: Score, tick: number): number {
  let value = 500000; // MIDI's default 120 BPM
  for (const point of score.tempo) {
    if (point.tick > tick) break;
    value = point.microsecondsPerQuarter;
  }
  return value;
}

/** Seconds elapsed at `tick`, integrating the tempo map exactly. */
export function secondsAt(score: Score, tick: number): number {
  let seconds = 0;
  let cursor = 0;
  let usPerQuarter = 500000;
  for (const point of score.tempo) {
    if (point.tick >= tick) break;
    if (point.tick > cursor) {
      seconds += ((point.tick - cursor) * usPerQuarter) / (score.ppq * 1e6);
      cursor = point.tick;
    }
    usPerQuarter = point.microsecondsPerQuarter;
  }
  seconds += ((tick - cursor) * usPerQuarter) / (score.ppq * 1e6);
  return seconds;
}

/** The score's headline tempo: the one in force for the most ticks. */
export function dominantBpm(score: Score): number {
  if (score.tempo.length === 0) return 120;
  const held = new Map<number, number>();
  for (let i = 0; i < score.tempo.length; i += 1) {
    const point = score.tempo[i]!;
    const next = score.tempo[i + 1]?.tick ?? score.durationTicks;
    const span = Math.max(next - point.tick, 0);
    held.set(point.microsecondsPerQuarter, (held.get(point.microsecondsPerQuarter) ?? 0) + span);
  }
  let best = score.tempo[0]!.microsecondsPerQuarter;
  let bestSpan = -1;
  for (const [value, span] of held) {
    // Ties break toward the lower register value, so the result is stable.
    if (span > bestSpan || (span === bestSpan && value < best)) {
      best = value;
      bestSpan = span;
    }
  }
  return 60000000 / best;
}

/** All notes of a score, in a deterministic order. */
export function allNotes(score: Score): { part: Part; note: Note }[] {
  const out: { part: Part; note: Note }[] = [];
  for (const part of score.parts) {
    for (const note of part.notes) out.push({ part, note });
  }
  out.sort((a, b) => a.note.tick - b.note.tick || a.part.id.localeCompare(b.part.id));
  return out;
}
