/**
 * ProTracker modules (`.mod`) → `Score` (doc 17 §Stage 0, Tracker modules).
 *
 * Doc 17 calls this "almost a transpile", and the reason is that a module is
 * already most of what the arranger wants: it is **channelized**, it runs on a
 * tick rate, and its effect column states things a chip driver does natively.
 * What it is not is *timed* the way a Standard MIDI File is — a module has no
 * tempo map, it has a **speed** in ticks per row and a **tempo** in beats a
 * minute, and either can be changed by an effect on any row of any pattern. So
 * the interesting work here is turning a pattern grid into a tick timeline.
 *
 * Four things about the format decide the shape of this file.
 *
 *   - **The order list is the song and the patterns are its vocabulary.** A
 *     pattern can appear in the order more than once, so a note's tick is a
 *     function of where in the *order* it was reached, and the same pattern data
 *     produces different notes at different times. The walk is therefore over
 *     the order rather than over the patterns.
 *   - **A row's duration is state, not arithmetic.** `Fxx` under `$20` sets the
 *     speed and at or above it sets the tempo, so a row takes
 *     `2.5 / tempo × speed` seconds *as of that row*. Both are carried across
 *     patterns, which is why the walk keeps them rather than recomputing.
 *   - **A channel is monophonic and a note has no end.** A new note on a channel
 *     ends the one before it and nothing else does, so every note runs to its
 *     successor or to the end of the song. That is the format rather than a
 *     simplification: a tracker sustains until told otherwise.
 *   - **There is no General MIDI programme.** A module names its *samples*, so
 *     the role prior `analysis.ts` takes from a programme number is simply
 *     absent here and roles come from the material alone (doc 17 §Stage 1). The
 *     sample's name is carried as the part's name where one channel plays mostly
 *     one sample, because that is the only hint the format offers.
 *
 * **A module has no drum channel, and nothing here invents one.** A MIDI file
 * states percussion outright — channel 10 is the General MIDI kit, which is why
 * `midi.ts` is the only place a role arrives with full confidence — and a module
 * says nothing at all: a kick is a sample like any other. So a module's kit
 * arrives as an ordinary pitched part and `analysis.ts` classifies it from the
 * material, which today usually means it does not reach the noise channel. That
 * is inference this ingest deliberately does not make (doc 17 §Stage 0 is about
 * exactly the line between what a format *states* and what has to be guessed);
 * a sample named "kick" is a hint and not a statement, and acting on one would
 * put a bassline on the drums the first time somebody named a sample badly.
 *
 * **What is read and what is refused.** Notes, volumes, the order list, both
 * timing effects and vibrato are read. Every other effect is *counted* and
 * reported in {@link ModParseResult.unread} rather than dropped quietly, on the
 * "never lose a part silently" rule (doc 16) — a module leaning on portamento
 * for its melody is one whose demake will be wrong in a way the demaker should
 * say out loud rather than one the arranger can fix.
 *
 * Sources:
 * - The ProTracker 2.3A file-format description (the "MOD format" reference)
 * - ProTracker 2.3D playback behaviour for `Fxx`'s speed/tempo split
 */

import { math } from "@demake/core";

import {
  PPQ,
  type MeterPoint,
  type Note,
  type Part,
  type Score,
  type TempoPoint,
} from "./types.js";

/** Thrown when the bytes are not a module this parser can read. */
export class ModParseError extends Error {
  override readonly name = "ModParseError";
}

/** Bytes of the header before the pattern data: name, samples, order, tag. */
const HEADER_BYTES = 1084;
/** Samples a 31-sample module declares; the 15-sample originals are refused. */
const SAMPLES = 31;
/** Rows in a pattern, which the format fixes. */
const ROWS = 64;
/** Bytes one cell takes: period and sample high, sample low and effect. */
const CELL_BYTES = 4;

/**
 * The four-character tags this parser accepts, and how many channels each means.
 *
 * `M.K.` is ProTracker's own and is four channels; the rest are the widely used
 * extensions. A module with no recognised tag is a 15-sample original, whose
 * header is a different length — refused by name rather than misread, because
 * reading one as a 31-sample module produces a song of noise.
 */
const TAGS: Readonly<Record<string, number>> = {
  "M.K.": 4,
  "M!K!": 4,
  FLT4: 4,
  "4CHN": 4,
  "6CHN": 6,
  "8CHN": 8,
  FLT8: 8,
  CD81: 8,
  OKTA: 8,
};

/**
 * Amiga periods for the middle octave, which is what a period is measured
 * against.
 *
 * A module states a **period** — the Amiga's sample-rate divisor — rather than a
 * note, so a pitch is `log2` of the ratio between the reference period and this
 * one. Period 428 is C-2 in ProTracker's own naming and 856 is the octave below
 * it, so one number and the logarithm cover every octave without a table of
 * every note the format can state.
 */
const REFERENCE_PERIOD = 856;
/** The MIDI note the reference period sounds, in cents: C-1 at note 36. */
const REFERENCE_PITCH = 3600;

/** What a walk of the order list produced, beside the score itself. */
export interface ModParseResult {
  score: Score;
  /**
   * Effects the parser understood the *presence* of and not the meaning, with
   * how many cells carried each.
   *
   * Reported rather than dropped, because a module whose melody is carried by
   * portamento is one this ingest reads as a series of flat notes — which is a
   * demake that is wrong about the tune rather than merely coarser than it.
   */
  unread: { effect: string; cells: number }[];
}

/** True when the bytes carry a tag this parser recognises. */
export function isMod(bytes: Uint8Array): boolean {
  return bytes.length > HEADER_BYTES && tagOf(bytes) !== undefined;
}

/** The four-character tag at offset 1080, if it is one we accept. */
function tagOf(bytes: Uint8Array): string | undefined {
  let tag = "";
  for (let index = 0; index < 4; index += 1) tag += String.fromCharCode(bytes[1080 + index] ?? 0);
  return tag in TAGS ? tag : undefined;
}

/** A NUL-padded fixed-width name, trimmed of padding and unprintable bytes. */
function nameAt(bytes: Uint8Array, at: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const code = bytes[at + index] ?? 0;
    if (code === 0) break;
    out += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : " ";
  }
  return out.trim();
}

/** One cell of a pattern, as the four bytes decode. */
interface Cell {
  period: number;
  sample: number;
  effect: number;
  param: number;
}

function cellAt(bytes: Uint8Array, at: number): Cell {
  const a = bytes[at] ?? 0;
  const b = bytes[at + 1] ?? 0;
  const c = bytes[at + 2] ?? 0;
  const d = bytes[at + 3] ?? 0;
  return {
    period: ((a & 0x0f) << 8) | b,
    sample: (a & 0xf0) | (c >> 4),
    effect: c & 0x0f,
    param: d,
  };
}

/** A note being held on one channel, waiting for whatever ends it. */
interface Open {
  tick: number;
  pitch: number;
  velocity: number;
  vibrato: number;
  sample: number;
}

/**
 * Parse a ProTracker module into a {@link Score}.
 *
 * The walk is over the **order list**, because that is the song: a pattern
 * reached twice produces its notes twice, at two different ticks.
 */
export function parseMod(bytes: Uint8Array): ModParseResult {
  const tag = tagOf(bytes);
  if (tag === undefined) {
    throw new ModParseError(
      bytes.length > 1084
        ? "not a module this parser reads (no M.K. or n-channel tag at offset 1080)"
        : "not a module: the file is shorter than a ProTracker header",
    );
  }
  const channels = TAGS[tag] as number;

  // The module's own name, which is the only thing here a `Score` has nowhere to
  // put — `provenance` carries a format and a confidence and no title. It is
  // read anyway because a part with no sample name falls back to it below.
  const title = nameAt(bytes, 0, 20);
  /** Sample names and volumes, which are the only instrument data a note uses. */
  const sampleNames: string[] = [];
  const sampleVolumes: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const at = 20 + index * 30;
    sampleNames.push(nameAt(bytes, at, 22));
    sampleVolumes.push(Math.min(64, bytes[at + 25] ?? 64));
  }

  const orderLength = bytes[950] ?? 0;
  const order: number[] = [];
  for (let index = 0; index < orderLength; index += 1) order.push(bytes[952 + index] ?? 0);
  if (order.length === 0) throw new ModParseError("the order list is empty");

  const patternBytes = channels * ROWS * CELL_BYTES;
  const patternCount = Math.max(...order) + 1;
  if (bytes.length < HEADER_BYTES + patternCount * patternBytes) {
    throw new ModParseError(
      `the order list names pattern ${patternCount - 1} and the file holds ${Math.floor(
        (bytes.length - HEADER_BYTES) / patternBytes,
      )}`,
    );
  }

  // ProTracker's own defaults, and both are state the walk carries: an `Fxx`
  // anywhere changes them for everything after it, patterns included.
  let speed = 6;
  let tempo = 125;

  const notes: Note[][] = Array.from({ length: channels }, () => []);
  const open: (Open | undefined)[] = new Array(channels).fill(undefined) as undefined[];
  const sampleUse: Map<number, number>[] = Array.from({ length: channels }, () => new Map());
  const unread = new Map<string, number>();
  const tempoPoints: TempoPoint[] = [];

  let tick = 0;
  let lastTempo = -1;

  for (const pattern of order) {
    const base = HEADER_BYTES + pattern * patternBytes;
    for (let row = 0; row < ROWS; row += 1) {
      // The row's timing effects are read *first*, because `Fxx` applies to the
      // row it is on rather than to the one after it.
      for (let channel = 0; channel < channels; channel += 1) {
        const cell = cellAt(bytes, base + (row * channels + channel) * CELL_BYTES);
        if (cell.effect === 0x0f) {
          if (cell.param === 0) continue;
          if (cell.param < 0x20) speed = cell.param;
          else tempo = cell.param;
        }
      }
      const microsecondsPerQuarter = Math.round(60000000 / tempo);
      if (microsecondsPerQuarter !== lastTempo) {
        tempoPoints.push({ tick, microsecondsPerQuarter });
        lastTempo = microsecondsPerQuarter;
      }

      for (let channel = 0; channel < channels; channel += 1) {
        const cell = cellAt(bytes, base + (row * channels + channel) * CELL_BYTES);
        const held = open[channel];

        // Volume and vibrato apply to whatever is sounding, exactly as a MIDI
        // controller does — including a note that started on an earlier row.
        if (cell.effect === 0x0c && held) held.velocity = volumeOf(cell.param);
        if (cell.effect === 0x04 && held) {
          // `4xy`: x is the speed and y the depth, and only the depth is the
          // demaker's business — the rate is stated once for the whole piece
          // (`vibrato.ts`), so a module asking for a different one per row is
          // asking for something no console here performs per note.
          const depth = cell.param & 0x0f;
          if (depth > 0) held.vibrato = Math.max(held.vibrato, depth / 15);
        }
        if (UNREAD[cell.effect] !== undefined && (cell.effect !== 0 || cell.param !== 0)) {
          const name = UNREAD[cell.effect] as string;
          unread.set(name, (unread.get(name) ?? 0) + 1);
        }

        if (cell.period === 0) continue;
        // A new note ends whatever the channel was holding, which is the whole
        // of this format's note-off.
        if (held) closeNote(notes[channel] as Note[], held, tick);
        const sample = cell.sample > 0 ? cell.sample : (held?.sample ?? 1);
        const velocity =
          cell.effect === 0x0c ? volumeOf(cell.param) : volumeOf(sampleVolumes[sample - 1] ?? 64);
        open[channel] = {
          tick,
          pitch: pitchOf(cell.period),
          velocity,
          vibrato: cell.effect === 0x04 ? (cell.param & 0x0f) / 15 : 0,
          sample,
        };
        const used = sampleUse[channel] as Map<number, number>;
        used.set(sample, (used.get(sample) ?? 0) + 1);
      }

      // One row is `speed` ticks of `2.5 / tempo` seconds each, and a quarter
      // note is four rows at the default speed — so a row is `PPQ / 4` ticks
      // scaled by how far the speed is from that default. Rounding once here
      // rather than accumulating a float is what keeps a bar boundary a bar
      // boundary ninety seconds in (doc 16 §Tempo is a budget).
      tick += Math.round((PPQ / 4) * (speed / 6));
    }
  }

  for (let channel = 0; channel < channels; channel += 1) {
    const held = open[channel];
    if (held) closeNote(notes[channel] as Note[], held, Math.max(tick, held.tick + PPQ / 4));
  }

  const parts: Part[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const list = notes[channel] as Note[];
    if (list.length === 0) continue;
    parts.push({
      id: `t${channel}c${channel}`,
      name: dominantSample(sampleUse[channel] as Map<number, number>, sampleNames, channel, title),
      // No programme means no prior: unlike a MIDI file, nothing here says what
      // a part is *for*, so every one of them arrives unclassified and analysis
      // decides from the material alone.
      role: "harmony",
      roleConfidence: 0,
      notes: list,
      polyphony: 1,
    });
  }

  if (tempoPoints.length === 0) tempoPoints.push({ tick: 0, microsecondsPerQuarter: 480000 });
  const meter: MeterPoint[] = [{ tick: 0, numerator: 4, denominator: 4 }];

  return {
    score: {
      ppq: PPQ,
      tempo: tempoPoints,
      meter,
      parts,
      sections: [],
      durationTicks: tick,
      provenance: { format: "mod" },
    },
    unread: [...unread]
      .map(([effect, cells]) => ({ effect, cells }))
      .sort((a, b) => b.cells - a.cells || a.effect.localeCompare(b.effect)),
  };
}

/**
 * The effects this parser sees and does not act on.
 *
 * Named rather than numbered so a report reads as music: "portamento" is
 * something a listener would miss, and `3xx` is not. `0` is arpeggio *only*
 * when it has a parameter — a zero cell is an empty cell, and counting those
 * would report every silent row in the module.
 */
const UNREAD: Readonly<Record<number, string>> = {
  0x0: "arpeggio",
  0x1: "portamento up",
  0x2: "portamento down",
  0x3: "tone portamento",
  0x5: "tone portamento + volume slide",
  0x6: "vibrato + volume slide",
  0x7: "tremolo",
  0x8: "panning",
  0x9: "sample offset",
  0xa: "volume slide",
  0xb: "position jump",
  0xd: "pattern break",
  0xe: "extended",
};

/** A module's 0–64 volume as MIDI's 0–127, which is what `Note.velocity` is. */
function volumeOf(volume: number): number {
  const clamped = volume < 0 ? 0 : volume > 64 ? 64 : volume;
  return Math.round((clamped / 64) * 127);
}

/**
 * An Amiga period as cents above MIDI note 0.
 *
 * A period is a *divisor*, so halving it is an octave up — which makes this one
 * logarithm rather than the table of 36 periods the format's own documentation
 * prints. Finetune is deliberately ignored: it is an eighth of a semitone, and
 * every console in this set snaps a pitch to a lattice coarser than that.
 *
 * Through the deterministic kernel rather than `Math.log2`, because this package
 * is under the determinism rule and a pitch that differed in its low bits
 * between two engines is a different demake (doc 16 §Determinism engineering).
 */
function pitchOf(period: number): number {
  if (period <= 0) return REFERENCE_PITCH;
  const octaves = math.log(REFERENCE_PERIOD / period) / LN2;
  return Math.round(REFERENCE_PITCH + 1200 * octaves);
}

/** The natural logarithm of two, which is what turns `log` into `log2`. */
const LN2 = 0.6931471805599453;

function closeNote(list: Note[], held: Open, endTick: number): void {
  list.push({
    tick: held.tick,
    durationTicks: Math.max(endTick - held.tick, 1),
    pitch: held.pitch,
    velocity: held.velocity,
    ...(held.vibrato > 0 ? { vibrato: held.vibrato } : {}),
    salience: 0,
  });
}

/** The name of the sample a channel plays most, which is all the format offers. */
function dominantSample(
  used: Map<number, number>,
  names: readonly string[],
  channel: number,
  title: string,
): string {
  let best = 0;
  let bestCount = 0;
  for (const [sample, count] of used) {
    if (count > bestCount) {
      bestCount = count;
      best = sample;
    }
  }
  const name = names[best - 1] ?? "";
  if (name !== "") return name;
  return title === "" ? `channel ${channel + 1}` : `${title} ${channel + 1}`;
}
