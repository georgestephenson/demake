/**
 * Arrangement: parts onto channels (doc 17 §Stage 2).
 *
 * The constrained assignment problem at the heart of the music demaker, and it
 * is doc 04's Stage 4 with time in place of space — so it is solved the same
 * way, deliberately: score every pairing, assign greedily, then refine by
 * exchange until nothing improves. Deterministic throughout; no seeded restarts
 * are needed at this size because the exchange pass is exhaustive.
 *
 * When there are fewer channels than parts the reductions are ordered, and the
 * order is doc 17's: merge duplicates, then reduce chords, then arpeggiate, then
 * time-share, then drop by salience — and every drop is counted rather than
 * quietly lost.
 */

import { latticeMaxHz, latticeMinHz, type AudioChannelSpec, type AudioSpec } from "@demake/core";

import type { Dropped } from "../chipscript.js";
import { centsToHz } from "../pitch.js";
import type { Part, PartRole, Score } from "../score/types.js";

/** How a part reaches a channel. */
export type Treatment = "direct" | "arpeggiated" | "folded" | "merged";

/** One channel's job for the whole piece. */
export interface ChannelAssignment {
  channel: AudioChannelSpec;
  channelIndex: number;
  /** Parts this channel carries; more than one means they time-share. */
  parts: Part[];
  treatment: Treatment;
  /** Octaves the material was shifted to fit the channel's lattice. */
  octaveShift: number;
}

export interface ArrangementPlan {
  assignments: ChannelAssignment[];
  dropped: Dropped[];
}

export interface PlanOptions {
  /** Cap the channels used; the rest stay silent. */
  channels?: number;
  /** Channel ids held back for sound effects. */
  reserve?: readonly string[];
  /** Whether chords may be spelled out in time on one channel. */
  allowArpeggio: boolean;
  /** Whether percussion gets a channel at all. */
  percussion: boolean;
}

/** Role affinity per channel kind: lower is better. */
function affinity(role: PartRole, channel: AudioChannelSpec): number {
  const kind = channel.kind;
  if (role === "percussion") return kind === "noise" ? 0 : 40;
  if (kind === "noise") return 40;
  switch (role) {
    case "bass":
      // A wavetable or a triangle is a bass voice; a pulse can do it but the
      // tone is thinner and it costs a melodic channel.
      return kind === "wave" || kind === "triangle" ? 0 : 3;
    case "lead":
      // The triangle cannot change volume, so a lead on it is expressionless.
      return kind === "pulse" ? 0 : kind === "wave" ? 2 : 6;
    case "arp":
      return kind === "pulse" ? 1 : 3;
    case "harmony":
      return kind === "pulse" ? 1 : 2;
    case "pad":
      return kind === "pulse" ? 2 : 2;
    default:
      return 5;
  }
}

/** Cost of asking `channel` to carry `part`, in comparable units. */
function cost(part: Part, channel: AudioChannelSpec, options: PlanOptions): number {
  let value = affinity(part.role, channel);
  if (part.role === "percussion") return value;

  if (channel.pitch) {
    const min = latticeMinHz(channel.pitch);
    const max = latticeMaxHz(channel.pitch);
    let outside = 0;
    for (const note of part.notes) {
      const hz = centsToHz(note.pitch);
      if (hz < min || hz > max) outside += 1;
    }
    // Notes outside the lattice can usually be folded an octave, which is a
    // real musical cost but a small one — nothing like losing the part.
    value += (outside / Math.max(part.notes.length, 1)) * 4;
  }

  if (part.polyphony > 1.2) {
    // A polyphonic part on a monophonic channel loses voices unless it can be
    // arpeggiated, and arpeggios are a candidate choice rather than a default.
    value += options.allowArpeggio ? 1.5 : (part.polyphony - 1) * 3;
  }

  // Prefer the channel the ear expects: a lead sitting on the last channel of a
  // chip is fine, but ties should resolve to the conventional layout.
  return value;
}

/** How much it would cost to lose this part entirely. */
function worth(part: Part): number {
  if (part.notes.length === 0) return 0;
  let sum = 0;
  for (const note of part.notes) sum += note.salience;
  const mean = sum / part.notes.length;
  const roleWeight: Record<PartRole, number> = {
    lead: 1,
    bass: 0.95,
    percussion: 0.8,
    arp: 0.6,
    harmony: 0.55,
    pad: 0.45,
    fx: 0.2,
  };
  return mean * roleWeight[part.role] * Math.min(1, part.notes.length / 8 + 0.25);
}

/** True when two parts never sound at the same time, so they can share. */
function disjoint(a: Part, b: Part): boolean {
  let i = 0;
  let j = 0;
  while (i < a.notes.length && j < b.notes.length) {
    const noteA = a.notes[i]!;
    const noteB = b.notes[j]!;
    const endA = noteA.tick + noteA.durationTicks;
    const endB = noteB.tick + noteB.durationTicks;
    if (endA <= noteB.tick) i += 1;
    else if (endB <= noteA.tick) j += 1;
    else return false;
  }
  return true;
}

/** True when two parts are the same line, in unison or in octaves. */
function duplicates(a: Part, b: Part): boolean {
  if (a.notes.length !== b.notes.length || a.notes.length === 0) return false;
  let offset: number | undefined;
  for (let i = 0; i < a.notes.length; i += 1) {
    const noteA = a.notes[i]!;
    const noteB = b.notes[i]!;
    if (noteA.tick !== noteB.tick) return false;
    const delta = noteB.pitch - noteA.pitch;
    if (delta % 1200 !== 0) return false;
    if (offset === undefined) offset = delta;
    else if (offset !== delta) return false;
  }
  return true;
}

/** Assign parts to channels. */
export function planArrangement(
  score: Score,
  spec: AudioSpec,
  options: PlanOptions,
): ArrangementPlan {
  const dropped: Dropped[] = [];

  // 1. Merge duplicates. Two parts in unison or in octaves are one part, and
  //    collapsing them often reclaims a whole channel for free.
  const parts: Part[] = [];
  for (const part of score.parts) {
    const twin = parts.find((existing) => duplicates(existing, part));
    if (twin) {
      dropped.push({
        kind: "voice",
        partId: part.id,
        count: part.notes.length,
        salience: meanSalience(part),
        reason: `doubles ${twin.id} in unison or octaves`,
      });
      continue;
    }
    parts.push(part);
  }

  // 2. Choose the channels available to music.
  const reserved = new Set(options.reserve ?? []);
  let channels = spec.channels
    .map((channel, channelIndex) => ({ channel, channelIndex }))
    .filter(({ channel }) => !reserved.has(channel.id));
  if (options.channels !== undefined) channels = channels.slice(0, options.channels);
  if (!options.percussion) channels = channels.filter(({ channel }) => channel.kind !== "noise");

  const candidates = [...parts].sort((a, b) => worth(b) - worth(a) || a.id.localeCompare(b.id));

  // 3. Greedy assignment by worth, then refine by exchange.
  const assignment = new Map<number, Part>();
  const unplaced: Part[] = [];
  for (const part of candidates) {
    let bestIndex = -1;
    let bestCost = Infinity;
    for (const { channel, channelIndex } of channels) {
      if (assignment.has(channelIndex)) continue;
      const value = cost(part, channel, options);
      if (value < bestCost) {
        bestCost = value;
        bestIndex = channelIndex;
      }
    }
    if (bestIndex < 0) unplaced.push(part);
    else assignment.set(bestIndex, part);
  }
  refineByExchange(assignment, channels, options);

  // 4. Time-share what is left before dropping it: two parts that never sound
  //    together are one channel's job (doc 17 §When there are fewer channels).
  const shared = new Map<number, Part[]>();
  for (const [index, part] of assignment) shared.set(index, [part]);
  const stillUnplaced: Part[] = [];
  for (const part of unplaced) {
    let placed = false;
    for (const { channel, channelIndex } of channels) {
      const existing = shared.get(channelIndex);
      if (!existing) continue;
      if (affinity(part.role, channel) >= 40) continue;
      if (!existing.every((other) => disjoint(other, part))) continue;
      existing.push(part);
      placed = true;
      break;
    }
    if (!placed) stillUnplaced.push(part);
  }

  // 5. Whatever remains is dropped, by salience, and counted.
  for (const part of stillUnplaced) {
    dropped.push({
      kind: "part",
      partId: part.id,
      count: part.notes.length,
      salience: meanSalience(part),
      reason:
        part.role === "percussion" ? "no percussion channel available" : "more parts than channels",
    });
  }

  const assignments: ChannelAssignment[] = [];
  for (const { channel, channelIndex } of channels) {
    const held = shared.get(channelIndex);
    if (!held || held.length === 0) continue;
    const polyphonic = held.some((part) => part.polyphony > 1.2);
    const octaveShift = channel.pitch ? octaveFor(held, channel) : 0;
    assignments.push({
      channel,
      channelIndex,
      parts: held,
      treatment:
        held.length > 1
          ? "merged"
          : polyphonic && options.allowArpeggio
            ? "arpeggiated"
            : octaveShift !== 0
              ? "folded"
              : "direct",
      octaveShift,
    });
  }
  assignments.sort((a, b) => a.channelIndex - b.channelIndex);
  return { assignments, dropped };
}

/**
 * Exchange refinement: swap two channels' parts while it lowers total cost.
 *
 * The counterpart of the image fitter's alternating refinement — greedy
 * assignment is a decent seed and a poor answer, because the best channel for
 * the most valuable part is often the only good channel for a later one.
 */
function refineByExchange(
  assignment: Map<number, Part>,
  channels: readonly { channel: AudioChannelSpec; channelIndex: number }[],
  options: PlanOptions,
): void {
  const byIndex = new Map(channels.map((entry) => [entry.channelIndex, entry.channel]));
  for (let pass = 0; pass < 8; pass += 1) {
    let improved = false;
    const indices = [...assignment.keys()].sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const indexA = indices[i]!;
        const indexB = indices[j]!;
        const partA = assignment.get(indexA)!;
        const partB = assignment.get(indexB)!;
        const channelA = byIndex.get(indexA)!;
        const channelB = byIndex.get(indexB)!;
        const before = cost(partA, channelA, options) + cost(partB, channelB, options);
        const after = cost(partA, channelB, options) + cost(partB, channelA, options);
        if (after < before - 1e-9) {
          assignment.set(indexA, partB);
          assignment.set(indexB, partA);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
}

/** The octave shift that brings the most notes inside a channel's lattice. */
function octaveFor(parts: readonly Part[], channel: AudioChannelSpec): number {
  if (!channel.pitch) return 0;
  const min = latticeMinHz(channel.pitch);
  const max = latticeMaxHz(channel.pitch);
  let best = 0;
  let bestInside = -1;
  for (let shift = -3; shift <= 3; shift += 1) {
    let inside = 0;
    let total = 0;
    for (const part of parts) {
      for (const note of part.notes) {
        total += 1;
        const hz = centsToHz(note.pitch + shift * 1200);
        if (hz >= min && hz <= max) inside += 1;
      }
    }
    if (total === 0) return 0;
    // Ties prefer no shift: moving material is a cost even when it is free to fit.
    if (inside > bestInside) {
      bestInside = inside;
      best = shift;
    }
  }
  return best;
}

function meanSalience(part: Part): number {
  if (part.notes.length === 0) return 0;
  let sum = 0;
  for (const note of part.notes) sum += note.salience;
  return sum / part.notes.length;
}
