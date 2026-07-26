/**
 * The music judge (doc 17 §The judge).
 *
 * Scores an arrangement against the score it came from, in two groups and with
 * the same shape doc 04 settled on for images: relational metrics that measure
 * what a listener actually recognizes, absolute metrics that anchor the result,
 * and a weighted **geometric** aggregate so one catastrophic metric cannot be
 * averaged away.
 *
 * The weights slide with **voice pressure** — the source's simultaneous-voice
 * count against what the console affords. On a chip with one usable melodic
 * channel only contour and rhythm survive and the judge should say so; with
 * eight sampled voices the arrangement is nearly transparent and absolute
 * fidelity dominates. That is doc 04's palette pressure with different units.
 *
 * Everything here is symbolic — it compares notes to notes. The timbral metrics
 * doc 17 lists need the reference synthesizer, which is not built yet; they are
 * absent rather than approximated, because a metric that reports a number it
 * cannot justify is worse than a missing one.
 */

import { math, type AudioSpec } from "@demake/core";

import type { ChipScript } from "./chipscript.js";
import type { ArrangementPlan } from "./arrange/plan.js";
import { centsToHz, hzToCents, snapPitch } from "./pitch.js";
import type { Part, Score } from "./score/types.js";

/** One metric's normalized score, 0–1, with the raw value behind it. */
export interface MetricScore {
  id: string;
  score: number;
  raw: number;
  group: "relational" | "absolute";
}

export interface JudgeResult {
  aggregate: number;
  metrics: MetricScore[];
  /** Source voices per console channel; drives the weighting. */
  voicePressure: number;
}

/** Score an arrangement of `score` for `spec`. */
export function judgeArrangement(
  score: Score,
  spec: AudioSpec,
  plan: ArrangementPlan,
  script: ChipScript,
): JudgeResult {
  const kept = new Set<string>();
  for (const assignment of plan.assignments) {
    for (const part of assignment.parts) kept.add(part.id);
  }

  const pressure = voicePressure(score, spec);
  const metrics: MetricScore[] = [
    contourRetention(score, plan),
    rhythmRetention(score, plan),
    salienceRecall(score, kept),
    voiceSeparation(plan),
    pitchAccuracy(plan),
    tempoAccuracy(script),
    budgetHeadroom(script),
  ];

  // Weights slide with pressure: under pressure the relational group carries
  // the piece, and absolute fidelity becomes a tie-breaker.
  const relationalWeight = 1 + pressure;
  const absoluteWeight = 1 / (1 + pressure);
  let logSum = 0;
  let weightSum = 0;
  for (const metric of metrics) {
    const weight = metric.group === "relational" ? relationalWeight : absoluteWeight;
    // A floor keeps a single zero from making the aggregate meaningless while
    // still costing the candidate almost everything — geometric, as doc 04 has it.
    const value = Math.max(metric.score, 0.02);
    logSum += weight * logOf(value);
    weightSum += weight;
  }
  const aggregate = weightSum === 0 ? 0 : expOf(logSum / weightSum);
  return { aggregate, metrics, voicePressure: pressure };
}

/** Source voices per available channel; 1 means "one voice per channel". */
function voicePressure(score: Score, spec: AudioSpec): number {
  let voices = 0;
  for (const part of score.parts) voices += Math.max(1, part.polyphony);
  const channels = Math.max(spec.channels.length, 1);
  return voices / channels;
}

/**
 * Melodic contour: do the tunes still move the way they moved?
 *
 * Compares the *sign* of each melodic step rather than its size, so it is
 * invariant to transposition and to octave folding by construction — which is
 * the whole point of putting it in the relational group.
 */
function contourRetention(score: Score, plan: ArrangementPlan): MetricScore {
  let matched = 0;
  let total = 0;
  for (const assignment of plan.assignments) {
    for (const part of assignment.parts) {
      const source = score.parts.find((candidate) => candidate.id === part.id);
      if (!source) continue;
      const kept = monophonicLine(part, assignment.parts.length > 1);
      const original = monophonicLine(source, false);
      for (let i = 1; i < Math.min(kept.length, original.length); i += 1) {
        total += 1;
        if (Math.sign(kept[i]! - kept[i - 1]!) === Math.sign(original[i]! - original[i - 1]!)) {
          matched += 1;
        }
      }
    }
  }
  const raw = total === 0 ? 1 : matched / total;
  return { id: "contour", score: raw, raw, group: "relational" };
}

/** Onsets kept, weighted by salience — the rhythm's survival. */
function rhythmRetention(score: Score, plan: ArrangementPlan): MetricScore {
  const keptParts = new Set<string>();
  for (const assignment of plan.assignments) {
    for (const part of assignment.parts) keptParts.add(part.id);
  }
  let kept = 0;
  let total = 0;
  for (const part of score.parts) {
    for (const note of part.notes) {
      const weight = 0.5 + note.salience;
      total += weight;
      if (keptParts.has(part.id)) kept += weight;
    }
  }
  const raw = total === 0 ? 1 : kept / total;
  return { id: "rhythm", score: raw, raw, group: "relational" };
}

/**
 * Salience-weighted note recall — the counterpart of highlight retention.
 *
 * Losing a three-note hook must cost more than losing a long quiet pad, which a
 * plain note count gets exactly backwards.
 */
function salienceRecall(score: Score, kept: ReadonlySet<string>): MetricScore {
  let keptSalience = 0;
  let total = 0;
  for (const part of score.parts) {
    for (const note of part.notes) {
      const weight = note.salience * note.salience;
      total += weight;
      if (kept.has(part.id)) keptSalience += weight;
    }
  }
  const raw = total === 0 ? 1 : keptSalience / total;
  return { id: "salience-recall", score: raw, raw, group: "relational" };
}

/**
 * Voice separability: can the parts still be told apart?
 *
 * Two melodic parts crammed into the same register on adjacent channels read as
 * mud however accurate each is, so register spread is scored directly.
 */
function voiceSeparation(plan: ArrangementPlan): MetricScore {
  const centres: number[] = [];
  for (const assignment of plan.assignments) {
    if (assignment.channel.kind === "noise") continue;
    let sum = 0;
    let count = 0;
    for (const part of assignment.parts) {
      for (const note of part.notes) {
        sum += note.pitch + assignment.octaveShift * 1200;
        count += 1;
      }
    }
    if (count > 0) centres.push(sum / count);
  }
  if (centres.length < 2) return { id: "separation", score: 1, raw: 1, group: "relational" };
  centres.sort((a, b) => a - b);
  let worst = Infinity;
  for (let i = 1; i < centres.length; i += 1)
    worst = Math.min(worst, centres[i]! - centres[i - 1]!);
  // A perfect fifth of separation between voice centres is plenty; unison is nil.
  const raw = clamp01(worst / 700);
  return { id: "separation", score: raw, raw, group: "relational" };
}

/**
 * Pitch accuracy after the allowed global transpose.
 *
 * Scored in cents against what the hardware will really produce. The grade is
 * fitted, not assumed: a track moved bodily by an octave to fit a channel keeps
 * full marks, and only the *residual* — the per-note detune the lattice forces —
 * costs anything (doc 17 §The objective).
 */
function pitchAccuracy(plan: ArrangementPlan): MetricScore {
  const errors: number[] = [];
  for (const assignment of plan.assignments) {
    const lattice = assignment.channel.pitch;
    if (!lattice) continue;
    for (const part of assignment.parts) {
      for (const note of part.notes) {
        const wanted = note.pitch + assignment.octaveShift * 1200;
        const snapped = snapPitch(lattice, centsToHz(wanted));
        errors.push(hzToCents(snapped.hz) - wanted);
      }
    }
  }
  if (errors.length === 0) return { id: "pitch", score: 1, raw: 0, group: "absolute" };
  // Fit the single allowed global transpose: the median residual.
  const sorted = [...errors].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  let sum = 0;
  for (const error of errors) sum += Math.abs(error - median);
  const mean = sum / errors.length;
  // 25 cents of residual detune is where a chord starts to sound wrong.
  return { id: "pitch", score: clamp01(1 - mean / 25), raw: mean, group: "absolute" };
}

/** Tempo error, in parts per million; anything under 1000 ppm is inaudible. */
function tempoAccuracy(script: ChipScript): MetricScore {
  const ppm = Math.abs(script.timing.ppmError);
  return { id: "tempo", score: clamp01(1 - ppm / 20000), raw: ppm, group: "absolute" };
}

/** How comfortably the schedule fits inside the console's per-tick allowance. */
function budgetHeadroom(script: ChipScript): MetricScore {
  const used = script.budgets.peakWritesPerTick;
  const budget = Math.max(script.budgets.writeBudget, 1);
  const raw = used / budget;
  return { id: "budget", score: clamp01(1.2 - raw), raw, group: "absolute" };
}

/** A part's line, as one pitch per onset. */
function monophonicLine(part: Part, merged: boolean): number[] {
  const line: number[] = [];
  let lastTick = -1;
  for (const note of part.notes) {
    if (note.tick === lastTick) {
      // Simultaneous notes collapse to the one a monophonic channel would keep.
      if (!merged && note.pitch > line[line.length - 1]!) line[line.length - 1] = note.pitch;
      continue;
    }
    line.push(note.pitch);
    lastTick = note.tick;
  }
  return line;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** The deterministic kernels, never `Math.log`/`Math.exp` (doc 16 §Determinism). */
function logOf(value: number): number {
  return math.log(value);
}

function expOf(value: number): number {
  return math.exp(value);
}

/** Notes a plan keeps, for callers that want the count rather than the score. */
export function keptNoteCount(plan: ArrangementPlan): number {
  let total = 0;
  for (const assignment of plan.assignments) {
    for (const part of assignment.parts) total += part.notes.length;
  }
  return total;
}
