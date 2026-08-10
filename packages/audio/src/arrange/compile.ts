/**
 * Plan → `ChipScript` (doc 17 §Stage 7).
 *
 * Walks the piece one driver tick at a time, decides what each channel is doing
 * on that tick, and hands the result to the console's binding to become register
 * writes. After this point there is no music left in the representation — only a
 * schedule, which is exactly the property that makes the whole domain testable
 * (doc 16 §Two representations).
 */

import { math, type AudioSpec } from "@demake/core";

import type { ChannelFrame, ChannelSpan, ChipScript, TickWrites } from "../chipscript.js";
import { countWrites, peakWritesPerTick } from "../chipscript.js";
import type { ChipBinding } from "../binding/types.js";
import { silentFrames } from "../binding/types.js";
import { centsToHz, foldIntoRange } from "../pitch.js";
import type { DrumClass, Note, Part } from "../score/types.js";
import type { Score } from "../score/types.js";
import type { TimingPlan } from "../timing.js";
import type { ArrangementPlan, ChannelAssignment } from "./plan.js";

export interface CompileOptions {
  /** Ticks between arpeggio steps; 1 is the classic chip shimmer. */
  arpeggioTicks: number;
  /** Whether melodic channels get a per-tick decay shaped by the driver. */
  expression: "flat" | "envelopes";
  /** Duty index for melodic channels that have a choice. */
  duty: number;
}

/**
 * Percussion mapping (doc 17 §Percussion).
 *
 * A console has one noise channel and General MIDI has 47 percussion sounds, so
 * the reduction is a musical decision, not a lookup. `period` indexes the
 * binding's low-to-high noise colours; `envelope` is the chip's own decay rate,
 * which is what keeps a hit ringing without the driver writing every tick.
 *
 * `pitch` and `ticks` are for the other kind of percussion channel. An FM voice
 * can be *struck*, which is why `plan.ts`'s affinity table offers one — and a
 * struck voice needs a pitch, which a drum has no business taking from its
 * General MIDI note number: 36 is a kick because that is where the kick sample
 * sits on a keyboard, not because a kick is a C2. Taking it literally is what
 * played a hi-hat as an F#2 under the melody. So a class states the pitch a
 * pitched voice should strike it at, and how long to hold it for: the tonal
 * classes stay low where a drum lives, and the metallic ones go up where a short
 * bright patch reads as a tick rather than a bass note.
 */
const DRUM_MAP: Record<
  DrumClass,
  { period: number; envelope: number; tonal: boolean; pitch: number; ticks: number }
> = {
  kick: { period: 4, envelope: 2, tonal: true, pitch: 3600, ticks: 8 },
  snare: { period: 26, envelope: 3, tonal: false, pitch: 6200, ticks: 6 },
  "hat-closed": { period: 58, envelope: 1, tonal: false, pitch: 9300, ticks: 2 },
  "hat-open": { period: 56, envelope: 5, tonal: false, pitch: 9300, ticks: 6 },
  tom: { period: 14, envelope: 3, tonal: true, pitch: 4500, ticks: 8 },
  cymbal: { period: 52, envelope: 7, tonal: false, pitch: 8800, ticks: 12 },
  perc: { period: 40, envelope: 2, tonal: false, pitch: 8100, ticks: 4 },
};

/**
 * Which voice of a percussion pool each drum class prefers (doc 17 §Percussion).
 *
 * By **class** rather than by round-robin over hits, which is what a drum
 * machine does and what a kit wants: a kick that is still ringing is never cut
 * off by the hat that lands on the next eighth, because they are not on the
 * same voice. Round-robin would allocate by arrival and put consecutive kicks
 * on different voices, which sounds like two kick drums slightly out of tune
 * with each other — these are *recordings*, so two voices playing one at
 * overlapping offsets is flanging rather than depth.
 *
 * The order is how badly a class wants a voice of its own, and the one
 * deliberate collision is the pair: **an open hat and a closed hat share**,
 * because a closed hat choking a ringing open one is exactly what the pedal on
 * a real kit does. Getting that for free out of the voice allocation is worth
 * more than giving each its own and having them ring through each other.
 */
const DRUM_VOICE: Record<DrumClass, number> = {
  kick: 0,
  snare: 1,
  "hat-closed": 2,
  "hat-open": 2,
  tom: 3,
  cymbal: 4,
  perc: 5,
};

/**
 * The voice a class lands on in a pool of `size`.
 *
 * Clamped rather than wrapped, so the classes that most want their own voice
 * keep one and the rest crowd onto the last: a pool of three is kick, snare and
 * everything-else, where wrapping would put the toms back on the kick's voice
 * and choke it. **A pool of one sends every class to voice zero**, which is the
 * property that makes every console but two byte-identical.
 */
function drumVoiceFor(drum: DrumClass, size: number): number {
  const wanted = DRUM_VOICE[drum];
  return wanted > size - 1 ? size - 1 : wanted;
}

/** Build the schedule. */
export function compileScript(
  score: Score,
  spec: AudioSpec,
  binding: ChipBinding,
  plan: ArrangementPlan,
  timing: TimingPlan,
  options: CompileOptions,
): ChipScript {
  const totalTicks = timing.totalTicks;
  const ticks: TickWrites[] = [];
  const spans: ChannelSpan[] = [];

  // Pre-resolve each channel's note stream onto driver ticks. Doing it per
  // channel rather than per tick keeps the inner loop free of searching.
  const lanes = plan.assignments.map((assignment) =>
    buildLane(assignment, timing, totalTicks, options),
  );

  for (const assignment of plan.assignments) {
    for (const part of assignment.parts) {
      spans.push({
        channelId: assignment.channel.id,
        partId: part.id,
        startTick: 0,
        endTick: totalTicks,
        treatment: assignment.treatment,
        pan: assignment.pan,
      });
    }
  }

  let previous: ChannelFrame[] | undefined;
  const initWrites = binding.init();
  for (let tick = 0; tick < totalTicks; tick += 1) {
    const frames = silentFrames(spec);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const assignment = plan.assignments[lane]!;
      frames[assignment.channelIndex] = lanes[lane]![tick]!;
    }
    const bound = binding.encode(frames, previous);
    const writes = tick === 0 ? [...initWrites, ...bound] : bound;
    // The chip tag rides along: a Mega Drive tick writes both an FM chip and a
    // PSG, so which device a write addresses is a property of the *write* and
    // not of the tick it happens on.
    ticks.push({
      writes: writes.map(({ reg, value, chip }) =>
        chip === undefined ? { reg, value } : { reg, value, chip },
      ),
    });
    previous = frames;
  }

  const loopTick = score.loop ? timing.tickForScoreTick(score.loop.startTick) : 0;
  const script: ChipScript = {
    console: binding.console,
    chips: binding.chips,
    driver: {
      rate: timing.rate,
      source: timing.report.source,
      ...(timing.report.divisor === undefined ? {} : { divisor: timing.report.divisor }),
    },
    ticks,
    loopTick: Math.min(loopTick, Math.max(totalTicks - 1, 0)),
    channels: spans,
    timing: timing.report,
    budgets: { writes: 0, peakWritesPerTick: 0, writeBudget: spec.driver.writesPerTick },
  };
  script.budgets.writes = countWrites(script);
  script.budgets.peakWritesPerTick = peakWritesPerTick(script);
  return script;
}

/** Resolve one channel's whole timeline into per-tick frames. */
function buildLane(
  assignment: ChannelAssignment,
  timing: TimingPlan,
  totalTicks: number,
  options: CompileOptions,
): ChannelFrame[] {
  const channel = assignment.channel;
  const frames: ChannelFrame[] = new Array<ChannelFrame>(totalTicks);
  // The placement is stamped at construction rather than on each of the three
  // paths below, and onto the silent frames as well as the sounding ones. Both
  // halves of that are deliberate: it is the one property of this lane that
  // does not depend on what is playing, so a path that forgot it would be a
  // channel that drifts back to centre for one kind of material — and stating
  // it while silent is what puts the pan register in the first tick's writes,
  // beside the rest of what the channel is about to need.
  for (let i = 0; i < totalTicks; i += 1) {
    frames[i] = { on: false, hz: 0, level: 0, pan: assignment.pan };
  }

  // Every note the channel is responsible for, on the driver's grid.
  interface Placed {
    start: number;
    end: number;
    note: Note;
    part: Part;
  }
  const placed: Placed[] = [];
  for (const part of assignment.parts) {
    for (const note of part.notes) {
      const start = timing.tickForScoreTick(note.tick);
      const end = Math.max(start + 1, timing.tickForScoreTick(note.tick + note.durationTicks));
      if (start >= totalTicks) continue;
      placed.push({ start, end: Math.min(end, totalTicks), note, part });
    }
  }
  placed.sort((a, b) => a.start - b.start || b.note.salience - a.note.salience);

  // Where the console gave the kit more than one voice, this channel plays only
  // the classes that landed on it. A pool of one keeps every class, so the
  // filter is the identity on every console but the two with spare percussion
  // hardware — which is what leaves their schedules untouched.
  const pool = assignment.drumVoice;
  const mine =
    pool === undefined || pool.size < 2
      ? placed
      : placed.filter((entry) => drumVoiceFor(entry.note.drum ?? "perc", pool.size) === pool.index);

  // A percussion part on a channel that has no noise generator. The gesture is
  // the noise path's — struck, and left to decay — and only the voicing differs,
  // because there is a pitch to choose instead of a colour.
  if (assignment.parts.some((part) => part.role === "percussion")) {
    if (channel.kind !== "noise") {
      for (const entry of mine) {
        // Two hits on one tick are one hit *on this voice*. `placed` is in
        // salience order within a tick, so the first is the one to keep: a snare
        // and a hat land together on every backbeat, and the hat is not the one
        // you would hear a drummer play there. Where the console has voices to
        // spare they are not on the same one and both are heard, which is the
        // whole point of the pool — this line stops being reached rather than
        // stops being true.
        if (frames[entry.start]!.retrigger) continue;
        const drum = DRUM_MAP[entry.note.drum ?? "perc"];
        const hz = centsToHz(drum.pitch + assignment.octaveShift * 1200);
        const folded = channel.pitch ? foldIntoRange(channel.pitch, hz) : { hz, octaves: 0 };
        const base = entry.note.velocity / 127;
        const end = Math.min(entry.start + drum.ticks, entry.end, totalTicks);
        for (let tick = entry.start; tick < end; tick += 1) {
          const frame = frames[tick]!;
          if (tick > entry.start && frame.retrigger) break;
          frame.on = true;
          frame.retrigger = tick === entry.start;
          frame.hz = folded.hz;
          frame.duty = options.duty;
          // A struck voice decays to nothing rather than to a tail: this channel
          // has no envelope generator of its own to hand the note off to.
          frame.level = base * (1 - (tick - entry.start) / drum.ticks);
        }
      }
      return frames;
    }
  }

  if (channel.kind === "noise") {
    for (const entry of mine) {
      const drum = DRUM_MAP[entry.note.drum ?? "perc"];
      const frame = frames[entry.start]!;
      frame.on = true;
      frame.retrigger = true;
      frame.level = entry.note.velocity / 127;
      frame.noisePeriod = drum.period;
      frame.noiseTonal = drum.tonal;
      frame.envelopePeriod = drum.envelope;
      // A struck sound rings on its own envelope; the channel simply stays
      // enabled until the next hit rather than being re-written every tick.
      for (let tick = entry.start + 1; tick < entry.end; tick += 1) {
        const held = frames[tick]!;
        if (held.retrigger) break;
        held.on = true;
        held.level = frame.level;
        held.noisePeriod = frame.noisePeriod;
        held.noiseTonal = frame.noiseTonal;
        held.envelopePeriod = frame.envelopePeriod;
      }
    }
    return frames;
  }

  const shift = assignment.octaveShift * 1200;
  // A sweep rather than a filter per tick: the piece is walked once and the
  // active set is maintained, so cost is notes + ticks rather than their
  // product. A three-minute track has tens of thousands of ticks.
  const active: Placed[] = [];
  let cursor = 0;
  for (let tick = 0; tick < totalTicks; tick += 1) {
    while (cursor < placed.length && placed[cursor]!.start <= tick) {
      active.push(placed[cursor]!);
      cursor += 1;
    }
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i]!.end <= tick) active.splice(i, 1);
    }
    if (active.length === 0) continue;

    let chosen: Placed;
    if (active.length === 1 || assignment.treatment !== "arpeggiated") {
      chosen = reduceChord(active, assignment);
    } else {
      // Arpeggio: cycle the chord's tones faster than the ear separates them —
      // the dither of the music pipeline (doc 17 §When there are fewer channels).
      const ordered = [...active].sort((a, b) => a.note.pitch - b.note.pitch);
      const step = Math.floor(tick / Math.max(1, options.arpeggioTicks)) % ordered.length;
      chosen = ordered[step]!;
    }

    const frame = frames[tick]!;
    const cents = chosen.note.pitch + shift + vibratoCents(chosen, tick, timing);
    const hz = centsToHz(cents);
    const folded = channel.pitch ? foldIntoRange(channel.pitch, hz) : { hz, octaves: 0 };
    frame.on = true;
    frame.hz = folded.hz;
    frame.duty = options.duty;
    frame.retrigger = tick === chosen.start;
    frame.level = levelFor(chosen, tick, options);
  }
  return frames;
}

/**
 * Vibrato (doc 17 §Vibrato).
 *
 * **Depth is the source's; rate and shape are the demaker's.** General MIDI
 * puts vibrato depth on the modulation wheel and says nothing about how fast it
 * should be — controller 76 exists for the rate and almost nothing writes it —
 * so the depth is read off the score and the rest is decided once, here.
 *
 * A little over five cycles a second is where instrumental vibrato sits, and a
 * quarter-tone at the top of the wheel is about as wide as a chip channel goes
 * before it stops reading as one note. It **starts late**, because a player's
 * does: a note is placed in tune and leaned into. That is worth more here than
 * it looks — the delay costs no pitch writes at all, so a schedule pays for
 * vibrato only on notes long enough to have any, and a sixteenth-note line
 * carries none however hard the wheel was pushed.
 */
const VIBRATO_HZ = 5.5;
const VIBRATO_MAX_CENTS = 50;
const VIBRATO_DELAY_SECONDS = 0.15;

/** How far off its written pitch a note sits on this tick, in cents. */
function vibratoCents(
  entry: { note: Note; start: number },
  tick: number,
  timing: TimingPlan,
): number {
  const depth = entry.note.vibrato;
  if (depth === undefined || depth <= 0) return 0;
  const seconds = (tick - entry.start) * timing.secondsPerTick - VIBRATO_DELAY_SECONDS;
  if (seconds <= 0) return 0;
  // `math.sin` rather than `Math.sin`: this package runs under the determinism
  // rule, and an oscillator seeded from the host's transcendentals is a track
  // that renders differently in two browsers (doc 16 §Determinism engineering).
  return depth * VIBRATO_MAX_CENTS * math.sin(2 * Math.PI * VIBRATO_HZ * seconds);
}

/**
 * Reduce a chord to the one note a monophonic channel will play.
 *
 * Root and third carry a chord's function, so the lowest note wins for a bass
 * and the most salient (then highest) for anything melodic — the fifth is the
 * first thing a human arranger drops, and this is that rule in code.
 */
function reduceChord(
  sounding: readonly { note: Note; part: Part; start: number; end: number }[],
  assignment: ChannelAssignment,
): (typeof sounding)[number] {
  const bass = assignment.parts.some((part) => part.role === "bass");
  let best = sounding[0]!;
  for (const entry of sounding) {
    if (bass) {
      if (entry.note.pitch < best.note.pitch) best = entry;
      continue;
    }
    if (
      entry.note.salience > best.note.salience ||
      (entry.note.salience === best.note.salience && entry.note.pitch > best.note.pitch)
    ) {
      best = entry;
    }
  }
  return best;
}

/** The level a note holds on a tick, including the driver-shaped decay. */
function levelFor(
  entry: { note: Note; start: number; end: number },
  tick: number,
  options: CompileOptions,
): number {
  const base = entry.note.velocity / 127;
  if (options.expression === "flat") return base;
  // A gentle decay across the note: enough to stop long notes sounding like an
  // organ, shallow enough not to swallow their tails.
  const span = Math.max(entry.end - entry.start, 1);
  const position = (tick - entry.start) / span;
  return base * (1 - 0.35 * position);
}
