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
  /** Where across the stereo image this channel sits: `-1` left … `+1` right. */
  pan: number;
  /**
   * Which voice of a percussion pool this channel is, where there is one.
   *
   * Absent on every console with a single percussion voice, which is all of
   * them but two — and its absence is what makes those consoles' output
   * unchanged rather than merely unaffected.
   */
  drumVoice?: { index: number; size: number };
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

/**
 * At or above this an affinity is not a reduction but a different instrument.
 *
 * The two pairings that reach it are a melodic part on a noise generator and a
 * drum part on a pitched channel, and neither has a musical reading: a noise
 * channel has no pitch to play a tune with, and a percussion part's "pitch" is
 * General MIDI's *drum numbers* — 36 is a kick, not a C2 — so a pitched channel
 * handed one plays the drum map as a bassline in whatever key it happens to
 * land in. A part that can only reach a channel this way is dropped and counted.
 */
const UNUSABLE = 40;

/** Role affinity per channel kind: lower is better. */
function affinity(role: PartRole, channel: AudioChannelSpec): number {
  const kind = channel.kind;
  // A sample voice plays a *recording* of a drum, which beats every generator on
  // this list at percussion and is the whole reason the Neo Geo's six of them are
  // worth having. Whether it can carry anything else is a question about its
  // pitch: one whose rate is fixed — a YM2610's ADPCM-A — has no register that
  // would change the note, so a melody on it is not a compromise, it is a wrong
  // one. `channel.pitch` is where the hardware already said which it is.
  if (kind === "sample") {
    if (role === "percussion") return 0;
    return channel.pitch ? 1 : UNUSABLE;
  }
  // An FM voice can be struck as well as held, so it is a real percussion
  // option — worse than a noise generator for a snare, far better for a tom.
  if (role === "percussion") return kind === "noise" ? 0 : kind === "fm" ? 6 : UNUSABLE;
  if (kind === "noise") return UNUSABLE;
  // Four operators and a fitted patch beat every fixed timbre on this list at
  // every job, which is why the whole `fm` column is zero: the arranger should
  // spend an FM voice before it spends a square wave, and only the *count* of
  // them should ration it.
  if (kind === "fm") return 0;
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
  // Infinity rather than a large number, so a part with no usable channel left
  // never beats the greedy pass's `Infinity` seed and falls through to the drop
  // list — which is also what stops the exchange pass trading one in later.
  if (value >= UNUSABLE) return Infinity;
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

/**
 * The order parts are offered a channel in: the best of each role first, then
 * everything else by worth.
 *
 * Worth alone is what a *ranking* wants and not what an arrangement wants. Five
 * lead-role parts all outrank a bass and a kit — legitimately, since a lead is
 * the thing you would hum — so a four-channel console handed a full arrangement
 * spent every channel on melodic lines and dropped the bass and the drums. No
 * arranger does that: the first pass is one voice for each *kind* of thing the
 * piece is made of, and only then does the second-best lead get a look.
 *
 * Within a role, and for everything after the first pass, it is worth order
 * unchanged — so a piece with one part per role is assigned exactly as it was
 * before this existed.
 */
function byWorthThenBreadth(parts: readonly Part[]): Part[] {
  const ranked = [...parts].sort((a, b) => worth(b) - worth(a) || a.id.localeCompare(b.id));
  const first: Part[] = [];
  const rest: Part[] = [];
  const seen = new Set<PartRole>();
  for (const part of ranked) {
    if (seen.has(part.role)) rest.push(part);
    else {
      seen.add(part.role);
      first.push(part);
    }
  }
  return [...first, ...rest];
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
  // "No drums" has to mean the *part* and not only the noise generator. Taking
  // the channel away and leaving the part behind is what a console with FM voices
  // reads as "put the kit on one of those" — which is a legitimate arrangement
  // and the opposite of what this candidate is for, so it is `full-band`'s to
  // choose and not this one's.
  const dropping = options.percussion ? [] : parts.filter((part) => part.role === "percussion");
  for (const part of dropping) {
    dropped.push({
      kind: "part",
      partId: part.id,
      count: part.notes.length,
      salience: meanSalience(part),
      reason: "this arrangement spends every channel on pitched material",
    });
  }
  if (!options.percussion) {
    channels = channels.filter(({ channel }) => channel.kind !== "noise");
  }

  const candidates = byWorthThenBreadth(
    options.percussion ? parts : parts.filter((part) => part.role !== "percussion"),
  );

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
  const pools = poolPercussion(assignment, channels);

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
      if (affinity(part.role, channel) >= UNUSABLE) continue;
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
      pan: 0,
      ...(pools.has(channelIndex) ? { drumVoice: pools.get(channelIndex)! } : {}),
    });
  }
  assignments.sort((a, b) => a.channelIndex - b.channelIndex);
  placeStereo(assignments);
  return { assignments, dropped };
}

/**
 * Give a percussion part every spare voice its channel's hardware has
 * (doc 17 §Percussion, doc 13 §A5.5).
 *
 * A General MIDI drum track is **one part**, and one part took one channel — so
 * a Neo Geo, whose YM2610 has six ADPCM-A voices playing real recordings of
 * drums, played its whole kit on one of them and left five idle. Nothing before
 * that console had more than one percussion voice, so the question had never
 * come up: on every other machine in the set the pool is the single noise
 * generator and this changes nothing at all.
 *
 * A pool is only ever built from channels that are **free**, and free is a
 * strong statement here rather than a hopeful one: the greedy pass assigns each
 * part to its best remaining channel, so a channel still unassigned afterwards
 * is one that every unplaced part scored `UNUSABLE` on. Taking it for the kit
 * therefore cannot starve a part that could have used it — which is why this
 * runs after the exchange refinement and before time-sharing.
 *
 * Interchangeable voices only — see {@link interchangeable}. A kit spread across
 * a noise generator *and* an FM voice would be two different instruments playing
 * one part, and which drum landed on which would be decided by a table rather
 * than by anything musical.
 */
function poolPercussion(
  assignment: Map<number, Part>,
  channels: readonly { channel: AudioChannelSpec; channelIndex: number }[],
): Map<number, { index: number; size: number }> {
  const pools = new Map<number, { index: number; size: number }>();
  // Snapshot first: the loop claims channels into the same map it is walking.
  for (const [channelIndex, part] of [...assignment].sort((a, b) => a[0] - b[0])) {
    if (part.role !== "percussion") continue;
    const seat = channels.find((entry) => entry.channelIndex === channelIndex);
    if (seat === undefined) continue;
    // Only ever over *dedicated* drum hardware. An FM voice will host a kit —
    // it is struck rather than held, which is why `affinity` offers it at 6 —
    // but it is a fallback, and handing the kit every spare one would take six
    // four-operator voices, six fitted patches and six voices' worth of
    // schedule for material that a single noise generator serves. That is
    // spending the machine downwards on the very consoles this pool exists to
    // spend it upwards on, so a kit that landed on a compromise host keeps the
    // one channel it was given.
    if (affinity("percussion", seat.channel) !== 0) continue;
    const spare = channels.filter(
      (entry) =>
        !assignment.has(entry.channelIndex) &&
        interchangeable(entry.channel, seat.channel) &&
        affinity("percussion", entry.channel) === 0,
    );
    if (spare.length === 0) continue;
    const pool = [seat, ...spare].sort((a, b) => a.channelIndex - b.channelIndex);
    for (let index = 0; index < pool.length; index += 1) {
      const entry = pool[index]!;
      assignment.set(entry.channelIndex, part);
      pools.set(entry.channelIndex, { index, size: pool.length });
    }
  }
  return pools;
}

/**
 * Whether two channels are the same instrument for the kit's purposes.
 *
 * The kind, and then **whether the voice has a pitch at all** — which on the
 * one console this matters for is the difference between two pieces of
 * hardware that share a `kind`. A YM2610's six ADPCM-A voices are fixed-rate
 * and play recordings; its single ADPCM-B voice has a phase increment and is
 * the only sample voice on the chip that can carry a tune. Matching on `kind`
 * alone swallowed it into the drum pool, where it took a class that fires on
 * nothing and denied the arrangement its one pitched sample voice — spending
 * the machine downwards, on hardware the whole point of this pool is to spend
 * upwards.
 */
function interchangeable(a: AudioChannelSpec, b: AudioChannelSpec): boolean {
  return a.kind === b.kind && (a.pitch === undefined) === (b.pitch === undefined);
}

/**
 * How far off centre a role is placed, where it is placed at all (doc 17 §Stereo placement).
 *
 * The three that are absent are absent on purpose, and it is the same reason
 * every time: a part that carries the piece belongs where both speakers are. A
 * **bass** placed off centre gives up half its power on hardware whose whole
 * output is a four-bit attenuator, and mono-compatible low end is near-universal
 * practice besides. **Percussion** anchors the middle, and on a four-channel
 * console it is the noise channel, which is the one voice a listener localises
 * instantly. A **lead** is the thing being listened to.
 *
 * What is left is accompaniment, and the widths run with how far from the tune
 * a part is: harmony sits just off centre, a pad opens further, an arpeggio —
 * the one figure that is texture rather than statement — goes widest of the
 * musical parts, and an effects part goes wider still because nothing depends
 * on hearing it in both ears.
 *
 * These are deliberately short of hard: a chip that pans by switch drops a whole
 * side past `panSides`' halfway mark, so a width is also a decision about which
 * consoles hear the placement at all. Harmony stays inside it and is heard
 * centred on a Game Boy and placed on a Neo Geo Pocket; everything above it is
 * placed on both.
 */
const PAN_WIDTH: Partial<Record<PartRole, number>> = {
  harmony: 0.45,
  pad: 0.6,
  arp: 0.7,
  fx: 0.8,
};

/**
 * How far a *second* lead is placed — because only one of them is the tune.
 *
 * The classifier routinely returns four or five `lead` parts for one piece: a
 * melody, its harmony line, a counter-line and an echo all carry a lead patch,
 * and AGENTS.md §Writing music already records that a counter-line under a lead
 * patch is classified as one. Reading that literally and centring every one of
 * them is what a *mono* arrangement does, and on a four-channel console it
 * leaves the placement machinery with nothing to place at all — the arrangement
 * there is bass, two leads and the kit, and every one of those centres.
 *
 * So the most salient lead keeps the centre and the rest are treated as what
 * they musically are: accompaniment. This is a placement decision rather than a
 * reclassification — the part is still a lead everywhere else, still competes
 * for the channel a lead wants, and is still reported as one.
 *
 * Past `panSides`' halfway mark on purpose, so the consoles that pan by switch
 * hear it too: a Game Boy's melody on pulse 1 and its counter-line placed on
 * pulse 2 is how music for that machine has always been written.
 */
const SECONDARY_LEAD_WIDTH = 0.55;

/**
 * Place each channel across the stereo image.
 *
 * Per **channel** rather than per note, and constant for the piece. That is
 * what makes the placement nearly free: a pan register is written once, at the
 * first tick, and never again — which matters because a track is already a few
 * kilobytes of schedule on a machine with 32 KiB and no mapper (AGENTS.md
 * §Audio costs cartridge). Moving a channel's placement when a time-shared
 * voice changes part would also draw attention to exactly the seam that
 * time-sharing exists to hide.
 *
 * The sign alternates so the image stays balanced, and it is taken from the
 * order the channels are placed in rather than from anything about the music,
 * because the alternative is a rule that reads the notes and is therefore one
 * more thing that can disagree between two runs. Left first, which is arbitrary
 * but has to be *some* fixed answer: an arrangement with an odd number of
 * placed channels leans one way, and it leans the same way every time.
 *
 * A single placeable channel is still placed, which it did not used to be. The
 * thing that makes a lone placement tolerable is that everything holding the
 * piece up — bass, tune and kit — is centred by the rules above, so there are
 * three anchors against the one voice that moves. On a four-channel console
 * that is the *usual* outcome rather than an edge case, and declining it there
 * meant the narrow machines spent none of this hardware at all, which is the
 * iron rule pointing the wrong way.
 */
function placeStereo(assignments: ChannelAssignment[]): void {
  const lead = primaryLead(assignments);
  const widths = new Map(assignments.map((a) => [a, widthOf(a, lead)]));
  const spread = assignments.filter((a) => widths.get(a)! > 0);
  for (let i = 0; i < spread.length; i += 1) {
    spread[i]!.pan = (i % 2 === 0 ? -1 : 1) * widths.get(spread[i]!)!;
  }
}

/**
 * The lead channel that keeps the centre: the most salient one.
 *
 * Ties break on channel index so the answer cannot depend on the order the
 * assignments happen to have been built in — this runs on every arrangement in
 * a four-candidate tournament, and two runs that placed the image differently
 * would be an output-byte change with no cause.
 */
function primaryLead(assignments: readonly ChannelAssignment[]): ChannelAssignment | undefined {
  let best: ChannelAssignment | undefined;
  let bestSalience = -1;
  for (const assignment of assignments) {
    if (!assignment.parts.some((part) => part.role === "lead")) continue;
    let salience = 0;
    for (const part of assignment.parts) {
      if (part.role === "lead") salience = Math.max(salience, meanSalience(part));
    }
    if (salience > bestSalience) {
      best = assignment;
      bestSalience = salience;
    }
  }
  return best;
}

/**
 * The width a channel's material asks for: the widest of the parts it carries.
 *
 * The widest rather than the first, because a channel that time-shares is
 * carrying a reduction — and a reduction that put a pad and an arpeggio on one
 * voice should sit where the more peripheral of the two wants to be, not where
 * whichever happened to sort first does.
 */
function widthOf(assignment: ChannelAssignment, primary: ChannelAssignment | undefined): number {
  // A channel whose hardware has no stereo at all is never placed, so what the
  // span reports is what the chip does. Leaving the position on and letting the
  // binding ignore it would encode identically and *say* something false — an
  // NES arrangement claiming a stereo image in `--json` and the piano roll.
  if (assignment.channel.panning === "none") return 0;
  let width = 0;
  for (const part of assignment.parts) {
    const role =
      part.role === "lead"
        ? assignment === primary
          ? 0
          : SECONDARY_LEAD_WIDTH
        : (PAN_WIDTH[part.role] ?? 0);
    if (role > width) width = role;
  }
  return width;
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
  // Candidates are ordered by distance from home, so a tie keeps the music
  // where it was. Iterating -3…3 instead would silently transpose everything
  // down three octaves the moment a channel's range is generous enough to fit
  // every shift — which is most of them.
  for (const shift of [0, -1, 1, -2, 2, -3, 3]) {
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
