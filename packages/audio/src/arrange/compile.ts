/**
 * Plan → `ChipScript` (doc 17 §Stage 7).
 *
 * Walks the piece one driver tick at a time, decides what each channel is doing
 * on that tick, and hands the result to the console's binding to become register
 * writes. After this point there is no music left in the representation — only a
 * schedule, which is exactly the property that makes the whole domain testable
 * (doc 16 §Two representations).
 */

import type { AudioSpec } from "@demake/core";

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
 */
const DRUM_MAP: Record<DrumClass, { period: number; envelope: number; tonal: boolean }> = {
  kick: { period: 4, envelope: 2, tonal: true },
  snare: { period: 26, envelope: 3, tonal: false },
  "hat-closed": { period: 58, envelope: 1, tonal: false },
  "hat-open": { period: 56, envelope: 5, tonal: false },
  tom: { period: 14, envelope: 3, tonal: true },
  cymbal: { period: 52, envelope: 7, tonal: false },
  perc: { period: 40, envelope: 2, tonal: false },
};

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
  for (let i = 0; i < totalTicks; i += 1) frames[i] = { on: false, hz: 0, level: 0 };

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

  if (channel.kind === "noise") {
    for (const entry of placed) {
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
    const hz = centsToHz(chosen.note.pitch + shift);
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
