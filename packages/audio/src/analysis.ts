/**
 * Source analysis (doc 17 §Stage 1).
 *
 * Everything the arranger needs to know about the music before it knows anything
 * about the console: what each part is *for*, which notes matter, where the piece
 * repeats, and whether its tempo is something a driver can hold.
 *
 * Every decision here is reported and overridable. The classifier will be wrong
 * sometimes, and a wrong role is a wrong arrangement — so `--role` exists, and
 * `roleConfidence` travels with the answer rather than being thrown away.
 */

import { math } from "@demake/core";

import type { Note, Part, PartRole, Score, Section } from "./score/types.js";
import { PPQ } from "./score/types.js";

/** Options that let a user overrule what analysis concluded. */
export interface AnalyzeOptions {
  /** Force a part's role, keyed by part id or by its 1-based index. */
  roles?: Record<string, PartRole>;
  /** Drop parts outright, by id or 1-based index. */
  drop?: readonly string[];
}

/** Analysis fills in roles, salience and structure; the score is returned anew. */
export function analyze(score: Score, options: AnalyzeOptions = {}): Score {
  const kept = score.parts.filter((part, index) => !isDropped(part, index, options.drop));
  const parts = kept.map((part, index) => classify(part, index, score, options));
  const withSalience = parts.map((part) => ({ ...part, notes: scoreSalience(part, parts) }));
  const sections = findSections(score);
  const loop = chooseLoop(sections, score);
  return { ...score, parts: withSalience, sections, loop };
}

function isDropped(part: Part, index: number, drop: readonly string[] | undefined): boolean {
  if (!drop) return false;
  return drop.includes(part.id) || drop.includes(String(index + 1));
}

/**
 * General MIDI program families, as a role prior.
 *
 * A prior rather than an answer: plenty of MIDI files leave every program at 0,
 * and plenty put a bassline on a piano patch. The pitch and rhythm statistics
 * below outvote it when they disagree strongly.
 */
function programPrior(program: number | undefined): PartRole | undefined {
  if (program === undefined) return undefined;
  if (program >= 32 && program <= 39) return "bass";
  if (program >= 88 && program <= 103) return "pad";
  if (program >= 48 && program <= 55) return "pad";
  if (program >= 56 && program <= 79) return "lead";
  if (program >= 80 && program <= 87) return "lead";
  return undefined;
}

function classify(part: Part, index: number, score: Score, options: AnalyzeOptions): Part {
  const forced = options.roles?.[part.id] ?? options.roles?.[String(index + 1)];
  if (forced) return { ...part, role: forced, roleConfidence: 1 };
  if (part.role === "percussion" && part.roleConfidence === 1) return part;
  if (part.notes.length === 0) return { ...part, role: "fx", roleConfidence: 1 };

  const stats = statistics(part, score);
  const prior = programPrior(part.program);

  // Scores rather than a decision tree, so a part that is bass-like *and*
  // lead-like resolves by weight instead of by the order of the branches.
  const scores: Record<PartRole, number> = {
    percussion: 0,
    bass: 0,
    lead: 0,
    harmony: 0,
    pad: 0,
    arp: 0,
    fx: 0,
  };

  // Bass: low, near-monophonic, onsets on strong beats.
  scores.bass += clamp01((5200 - stats.meanPitch) / 1500) * 2;
  scores.bass += clamp01(2 - stats.polyphony);
  scores.bass += stats.onBeatFraction;

  // Lead: mid-to-high, monophonic, and moving — contour entropy is what
  // separates a tune from a held drone in the same register.
  scores.lead += clamp01((stats.meanPitch - 5500) / 2000) * 1.5;
  scores.lead += clamp01(2 - stats.polyphony) * 1.5;
  scores.lead += stats.contourEntropy * 1.5;

  // Pad: polyphonic and slow-moving.
  scores.pad += clamp01((stats.polyphony - 1.5) / 2) * 2;
  scores.pad += clamp01(stats.meanDurationBeats / 2) * 1.5;
  scores.pad += 1 - stats.contourEntropy;

  // Harmony: polyphonic but rhythmically active — comping rather than sustain.
  scores.harmony += clamp01((stats.polyphony - 1.3) / 2) * 1.5;
  scores.harmony += clamp01(1 - stats.meanDurationBeats);
  scores.harmony += 0.5;

  // Arp: monophonic, fast, repetitive — chordal content spelled out in time.
  scores.arp += clamp01(2 - stats.polyphony);
  scores.arp += clamp01((0.5 - stats.meanDurationBeats) * 2) * 1.5;
  scores.arp += stats.repetition * 1.5;

  if (prior) scores[prior] += 1.25;

  let role: PartRole = "harmony";
  let best = -Infinity;
  let runnerUp = -Infinity;
  for (const key of Object.keys(scores) as PartRole[]) {
    const value = scores[key];
    if (value > best) {
      runnerUp = best;
      best = value;
      role = key;
    } else if (value > runnerUp) {
      runnerUp = value;
    }
  }
  // Confidence is the margin, not the winning score: a part that scores 3.0 as
  // a lead and 2.9 as an arp is a coin toss and should say so.
  const confidence = best <= 0 ? 0 : clamp01((best - runnerUp) / Math.max(best, 1));
  return { ...part, role, roleConfidence: confidence };
}

interface PartStatistics {
  meanPitch: number;
  polyphony: number;
  meanDurationBeats: number;
  contourEntropy: number;
  onBeatFraction: number;
  repetition: number;
}

function statistics(part: Part, score: Score): PartStatistics {
  const notes = part.notes;
  let pitchSum = 0;
  let durationSum = 0;
  let onBeat = 0;
  for (const note of notes) {
    pitchSum += note.pitch;
    durationSum += note.durationTicks;
    if (note.tick % score.ppq === 0) onBeat += 1;
  }
  const count = notes.length;

  // Contour entropy: how varied the melodic steps are, normalized. A drone
  // scores 0, a tune scores high, a random spray also scores high — which is
  // why it is one input among several rather than the decision.
  const steps = new Map<number, number>();
  for (let i = 1; i < count; i += 1) {
    const delta = Math.round((notes[i]!.pitch - notes[i - 1]!.pitch) / 100);
    steps.set(delta, (steps.get(delta) ?? 0) + 1);
  }
  let entropy = 0;
  const total = Math.max(count - 1, 1);
  for (const occurrences of steps.values()) {
    const p = occurrences / total;
    entropy -= p * log2(p);
  }
  const maxEntropy = log2(Math.max(steps.size, 2));

  // Repetition: how often the same 4-note pitch shape recurs.
  const shapes = new Map<string, number>();
  for (let i = 0; i + 3 < count; i += 1) {
    const key = [1, 2, 3]
      .map((k) => Math.round((notes[i + k]!.pitch - notes[i + k - 1]!.pitch) / 100))
      .join(",");
    shapes.set(key, (shapes.get(key) ?? 0) + 1);
  }
  let repeated = 0;
  for (const occurrences of shapes.values()) if (occurrences > 1) repeated += occurrences;

  return {
    meanPitch: count === 0 ? 6000 : pitchSum / count,
    polyphony: part.polyphony,
    meanDurationBeats: count === 0 ? 1 : durationSum / count / score.ppq,
    contourEntropy: maxEntropy === 0 ? 0 : clamp01(entropy / maxEntropy),
    onBeatFraction: count === 0 ? 0 : onBeat / count,
    repetition: count < 4 ? 0 : clamp01(repeated / Math.max(count - 3, 1)),
  };
}

/**
 * Salience, per note (doc 17 §Stage 1).
 *
 * What the arranger spends its channels on and what the judge weights its recall
 * metric by. Combines metric position, duration, melodic prominence, register
 * isolation and repetition across the piece — so a quiet three-note hook that
 * recurs eleven times outranks a loud sustained pad, which is exactly the
 * inversion a loudness-driven arranger gets wrong.
 */
function scoreSalience(part: Part, parts: readonly Part[]): Note[] {
  const roleWeight: Record<PartRole, number> = {
    lead: 1,
    bass: 0.85,
    percussion: 0.7,
    arp: 0.6,
    harmony: 0.5,
    pad: 0.4,
    fx: 0.2,
  };
  const base = roleWeight[part.role];

  // Motif counts: how often each 3-interval shape recurs in this part.
  const motif = new Map<string, number>();
  const shapeAt = (index: number): string | undefined => {
    if (index < 1 || index + 1 >= part.notes.length) return undefined;
    const a = Math.round((part.notes[index]!.pitch - part.notes[index - 1]!.pitch) / 100);
    const b = Math.round((part.notes[index + 1]!.pitch - part.notes[index]!.pitch) / 100);
    return `${a},${b}`;
  };
  for (let i = 0; i < part.notes.length; i += 1) {
    const shape = shapeAt(i);
    if (shape) motif.set(shape, (motif.get(shape) ?? 0) + 1);
  }

  const others = parts.filter((other) => other.id !== part.id);
  const meanOtherPitch =
    others.length === 0
      ? 6000
      : others.reduce((sum, other) => sum + meanPitchOf(other), 0) / others.length;

  return part.notes.map((note, index) => {
    let value = base;
    // Downbeats and beat onsets carry structure.
    if (note.tick % (PPQ * 4) === 0) value += 0.2;
    else if (note.tick % PPQ === 0) value += 0.1;
    // Longer notes are heard more.
    value += clamp01(note.durationTicks / (PPQ * 2)) * 0.15;
    // Velocity contributes, but only as a minor term — see the doc comment.
    value += (note.velocity / 127) * 0.15;
    // Register isolation: a part sitting away from everything else is exposed.
    value += clamp01(Math.abs(note.pitch - meanOtherPitch) / 2400) * 0.1;
    // Repetition across the piece.
    const shape = shapeAt(index);
    if (shape) value += clamp01(((motif.get(shape) ?? 1) - 1) / 8) * 0.25;
    return { ...note, salience: clamp01(value) };
  });
}

function meanPitchOf(part: Part): number {
  if (part.notes.length === 0) return 6000;
  let sum = 0;
  for (const note of part.notes) sum += note.pitch;
  return sum / part.notes.length;
}

/**
 * Sections, from a bar-level self-similarity of pitch-class content.
 *
 * Deliberately coarse. Two things depend on it and neither needs precision: loop
 * choice, and knowing that a section recurring six times deserves detail because
 * pattern dedup will collapse it anyway (doc 17 §Stage 6).
 */
function findSections(score: Score): Section[] {
  const barTicks = barLength(score);
  if (barTicks <= 0 || score.durationTicks <= 0) return [];
  const bars = Math.max(1, Math.ceil(score.durationTicks / barTicks));
  if (bars < 4) {
    return [{ startTick: 0, endTick: score.durationTicks, label: "A" }];
  }

  const signatures: string[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const classes = new Array<number>(12).fill(0);
    for (const part of score.parts) {
      if (part.role === "percussion") continue;
      for (const note of part.notes) {
        if (note.tick < bar * barTicks || note.tick >= (bar + 1) * barTicks) continue;
        classes[Math.round(note.pitch / 100) % 12]! += note.durationTicks;
      }
    }
    const total = classes.reduce((sum, value) => sum + value, 0);
    signatures.push(
      total === 0 ? "-" : classes.map((value) => (value / total > 0.08 ? "1" : "0")).join(""),
    );
  }

  // Group runs of bars that share a signature into labelled sections, reusing a
  // label when the content comes back — that recurrence is what a loop wants.
  const labels = new Map<string, string>();
  const sections: Section[] = [];
  let start = 0;
  for (let bar = 1; bar <= bars; bar += 1) {
    if (bar < bars && signatures[bar] === signatures[bar - 1]) continue;
    const signature = signatures[start]!;
    let label = labels.get(signature);
    if (!label) {
      label = String.fromCharCode(65 + (labels.size % 26));
      labels.set(signature, label);
    }
    sections.push({
      startTick: start * barTicks,
      endTick: Math.min(bar * barTicks, score.durationTicks),
      label,
    });
    start = bar;
  }
  return sections;
}

/**
 * Where playback returns (doc 17 §Stage 1).
 *
 * Not optional: game music loops, and a loop that restates the intro every time
 * is the most audible way a demade track can be wrong. The choice is the start
 * of the first section whose label recurs later — which is the first material
 * the piece itself treats as a refrain — falling back to the top.
 */
function chooseLoop(
  sections: readonly Section[],
  score: Score,
): { startTick: number; endTick: number } {
  const end = score.durationTicks;
  for (let i = 0; i < sections.length; i += 1) {
    const label = sections[i]!.label;
    for (let j = i + 1; j < sections.length; j += 1) {
      if (sections[j]!.label === label) return { startTick: sections[i]!.startTick, endTick: end };
    }
  }
  return { startTick: 0, endTick: end };
}

/** Ticks in a bar under the score's first time signature. */
export function barLength(score: Score): number {
  const meter = score.meter[0] ?? { tick: 0, numerator: 4, denominator: 4 };
  return (score.ppq * 4 * meter.numerator) / meter.denominator;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Base-2 logarithm through the deterministic kernel, never `Math.log2`. */
function log2(value: number): number {
  return math.log(value) / 0.6931471805599453;
}
