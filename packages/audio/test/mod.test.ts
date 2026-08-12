/**
 * Reading a ProTracker module (doc 17 §Stage 0, Tracker modules).
 *
 * Doc 17 calls it "almost a transpile", and these cases are about the half that
 * is not. A module is already channelized and already runs on a tick rate, so
 * what a parser has to get right is the *timeline*: a song is an order list
 * rather than a pattern, a row's duration is state that any row can change, and
 * a note ends when the next one on its channel starts and at no other time.
 *
 * The fixture is built here rather than checked in, on the example library's
 * rule for generators — a `.mod` is a binary and a binary nobody can read in a
 * diff is a fixture nobody can review. Every case therefore states the bytes it
 * is about.
 */

import { describe, expect, it } from "vitest";

import { PPQ } from "../src/score/types.js";
import { isMod, ModParseError, parseMod } from "../src/score/mod.js";

/** One cell, packed the way the format does: period and sample split across it. */
function cell(period: number, sample: number, effect = 0, param = 0): number[] {
  return [
    ((sample & 0xf0) | ((period >> 8) & 0x0f)) & 0xff,
    period & 0xff,
    (((sample & 0x0f) << 4) | (effect & 0x0f)) & 0xff,
    param & 0xff,
  ];
}

/** Periods for a few notes, as ProTracker's own table states them. */
const PERIOD = { C2: 428, D2: 381, E2: 339, C1: 856 } as const;

interface Row {
  /** One entry per channel, or a hole for a cell with nothing in it. */
  cells: (number[] | undefined)[];
}

/**
 * A four-channel module: `patterns` of rows, played in `order`.
 *
 * Sample 1 is named and full volume, which is what a note with no `Cxx` takes.
 */
function moduleOf(patterns: Row[][], order: number[], title = "TEST"): Uint8Array {
  const bytes = new Uint8Array(1084 + patterns.length * 4 * 64 * 4);
  for (let i = 0; i < title.length; i += 1) bytes[i] = title.charCodeAt(i);
  // Sample 1: a name at +0 and the volume byte at +25 of its thirty.
  const name = "lead";
  for (let i = 0; i < name.length; i += 1) bytes[20 + i] = name.charCodeAt(i);
  bytes[20 + 25] = 64;
  const second = "bass";
  for (let i = 0; i < second.length; i += 1) bytes[20 + 30 + i] = second.charCodeAt(i);
  bytes[20 + 30 + 25] = 64;

  bytes[950] = order.length;
  for (let i = 0; i < order.length; i += 1) bytes[952 + i] = order[i] as number;
  for (const [i, code] of [...("M.K." as string)].entries()) {
    bytes[1080 + i] = code.charCodeAt(0);
  }

  for (const [index, rows] of patterns.entries()) {
    const base = 1084 + index * 4 * 64 * 4;
    for (const [row, entry] of rows.entries()) {
      for (let channel = 0; channel < 4; channel += 1) {
        const packed = entry.cells[channel];
        if (!packed) continue;
        bytes.set(packed, base + (row * 4 + channel) * 4);
      }
    }
  }
  return bytes;
}

/** A row with one cell on channel 0 and nothing else. */
const lead = (packed: number[]): Row => ({ cells: [packed, undefined, undefined, undefined] });

describe("a ProTracker module", () => {
  it("is recognised by its tag and refused without one", () => {
    expect(isMod(moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]))).toBe(true);
    // A fifteen-sample original has a different header length, so reading one as
    // a thirty-one-sample module is a song of noise rather than a wrong note —
    // which is why it is refused by name.
    const untagged = moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]);
    untagged[1080] = 0;
    expect(isMod(untagged)).toBe(false);
    expect(() => parseMod(untagged)).toThrow(ModParseError);
  });

  it("reads a note's pitch off its period", () => {
    const { score } = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]));
    const note = score.parts[0]!.notes[0]!;
    // 428 is an octave above the 856 the parser measures against, and an octave
    // is 1200 cents — so this is the logarithm rather than a table lookup.
    expect(note.pitch).toBe(3600 + 1200);
    const lower = parseMod(moduleOf([[lead(cell(PERIOD.C1, 1))]], [0]));
    expect(lower.score.parts[0]!.notes[0]!.pitch).toBe(3600);
  });

  it("holds a note until the next one on its channel", () => {
    // The format's whole note-off: a tracker sustains until told otherwise, so a
    // note that ran to a fixed length would be a different piece of music.
    const rows: Row[] = [
      lead(cell(PERIOD.C2, 1)),
      { cells: [] },
      { cells: [] },
      { cells: [] },
      lead(cell(PERIOD.D2, 1)),
    ];
    const { score } = parseMod(moduleOf([rows], [0]));
    const [first, second] = score.parts[0]!.notes;
    expect(first!.durationTicks).toBe(4 * (PPQ / 4));
    expect(second!.tick).toBe(4 * (PPQ / 4));
  });

  it("plays the order list rather than the patterns", () => {
    // The thing a parser that walked the pattern table would get wrong: a
    // pattern named twice is heard twice, at two different ticks.
    const one = [lead(cell(PERIOD.C2, 1))];
    const { score } = parseMod(moduleOf([one], [0, 0, 0]));
    expect(score.parts[0]!.notes).toHaveLength(3);
    const ticks = score.parts[0]!.notes.map((note) => note.tick);
    expect(ticks).toEqual([0, 64 * (PPQ / 4), 128 * (PPQ / 4)]);
  });

  it("takes its speed and its tempo from the effect column", () => {
    // `Fxx` under `$20` is a speed and at or above it a tempo, and both are
    // state: the row carrying one is already affected by it.
    const rows: Row[] = [
      lead(cell(PERIOD.C2, 1, 0x0f, 3)),
      { cells: [] },
      lead(cell(PERIOD.D2, 1)),
    ];
    const { score } = parseMod(moduleOf([rows], [0]));
    // Three ticks a row against the default six is half the duration.
    expect(score.parts[0]!.notes[0]!.durationTicks).toBe(2 * (PPQ / 8));

    const tempo = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1, 0x0f, 150))]], [0]));
    expect(tempo.score.tempo[0]!.microsecondsPerQuarter).toBe(Math.round(60000000 / 150));
  });

  it("reads a volume effect and a sample's own volume", () => {
    const loud = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]));
    expect(loud.score.parts[0]!.notes[0]!.velocity).toBe(127);
    const quiet = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1, 0x0c, 32))]], [0]));
    expect(quiet.score.parts[0]!.notes[0]!.velocity).toBe(Math.round((32 / 64) * 127));
  });

  it("reads vibrato depth and leaves the rate alone", () => {
    // `4xy` states a speed as well as a depth, and only the depth is the
    // demaker's business: the rate is one constant for the whole piece, so a
    // module asking for a different one per row is asking for something no
    // console here performs per note (`vibrato.ts`).
    const { score } = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1, 0x04, 0x4f))]], [0]));
    expect(score.parts[0]!.notes[0]!.vibrato).toBe(1);
    const dry = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]));
    expect(dry.score.parts[0]!.notes[0]!.vibrato).toBeUndefined();
  });

  it("applies a mid-note effect to what is already sounding", () => {
    // A cell with an effect and no period belongs to the note still ringing,
    // which is how a tracker writes a swell — and a parser that only looked at
    // rows with notes on them would read the piece as flat.
    const rows: Row[] = [lead(cell(PERIOD.C2, 1)), lead(cell(0, 0, 0x04, 0x28))];
    const { score } = parseMod(moduleOf([rows], [0]));
    expect(score.parts[0]!.notes[0]!.vibrato).toBeCloseTo(8 / 15, 5);
  });

  it("counts the effects it does not act on rather than dropping them", () => {
    // The "never lose a part silently" rule at the ingest end: a module leaning
    // on portamento for its melody is one this reads as a series of flat notes,
    // and that is worth saying out loud.
    const rows: Row[] = [
      lead(cell(PERIOD.C2, 1, 0x03, 0x20)),
      lead(cell(0, 0, 0x03, 0x20)),
      lead(cell(0, 0, 0x0a, 0x10)),
    ];
    const { unread } = parseMod(moduleOf([rows], [0]));
    expect(unread).toEqual([
      { effect: "tone portamento", cells: 2 },
      { effect: "volume slide", cells: 1 },
    ]);
  });

  it("does not report an empty cell as an arpeggio", () => {
    // Effect 0 with a zero parameter *is* an empty cell, so counting it would
    // report every silent row in the module — which on a four-channel piece is
    // most of it, and would drown the effects that matter.
    const { unread } = parseMod(moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]));
    expect(unread).toEqual([]);
  });

  it("makes a part per channel, named after the sample it mostly plays", () => {
    const rows: Row[] = [{ cells: [cell(PERIOD.C2, 1), cell(PERIOD.C1, 2), undefined, undefined] }];
    const { score } = parseMod(moduleOf([rows], [0]));
    expect(score.parts).toHaveLength(2);
    expect(score.parts.map((part) => part.name)).toEqual(["lead", "bass"]);
    // No programme means no prior — unlike a MIDI file, nothing in a module says
    // what a part is *for*, so analysis decides from the material alone.
    expect(score.parts.every((part) => part.program === undefined)).toBe(true);
    expect(score.parts.every((part) => part.roleConfidence === 0)).toBe(true);
  });

  it("refuses an order list naming a pattern the file does not hold", () => {
    const bytes = moduleOf([[lead(cell(PERIOD.C2, 1))]], [0]);
    bytes[952] = 4;
    expect(() => parseMod(bytes)).toThrow(/order list names pattern/);
  });
});
