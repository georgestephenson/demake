/**
 * Vibrato, from the source's modulation wheel to the chip (doc 17 §Vibrato).
 *
 * Nothing in `@demake/audio` produced vibrato at all — not through a chip LFO
 * and not through pitch writes — which doc 13 §A5.5 records as the biggest of
 * the lines where the hardware runs ahead of the demaker, and as the arranger's
 * before it is any binding's. Four things are asserted, and each is one that
 * would let a wrong answer ship quietly:
 *
 *   - **The depth is read, not invented.** Controller 1 is where General MIDI
 *     puts it, and a part that does not touch the wheel gets nothing.
 *   - **A source with no modulation is untouched.** Every MIDI in the example
 *     library is one, which is what makes this zero output bytes for existing
 *     projects rather than a small diff everywhere.
 *   - **It is a modulation rather than a drift.** The pitch goes both above and
 *     below what was written and comes back — a wrong sign, a runaway
 *     accumulator or a one-way bend would all still "change the pitch".
 *   - **It is delayed**, so a note starts in tune. That is also what keeps it
 *     off short notes, which would pay for it in schedule bytes and get nothing.
 *
 * The control throughout is `vibratoFixture(bpm, 0)`: the *same notes* with the
 * wheel at zero, so a comparison is about the modulation and nothing else.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore } from "../src/arrange/index.js";
import { audioConsoles } from "../src/binding/registry.js";
import { countWrites } from "../src/chipscript.js";
import { parseMidi } from "../src/score/midi.js";
import { bandFixture, vibratoFixture } from "./_fixtures.js";

/** Consoles with a pitched channel — the ones that can bend anything at all. */
const PITCHED = audioConsoles().filter((id) =>
  (getConsole(id).audio?.channels ?? []).some((channel) => channel.pitch !== undefined),
);

function schedule(consoleId: string, midi: Uint8Array) {
  return arrangeScore(parseMidi(midi), { console: consoleId, strategy: "full-band" }).script;
}

describe("the source's modulation", () => {
  it("is read off controller 1", () => {
    const score = parseMidi(vibratoFixture());
    const [modulated, dry] = [score.parts[0]!, score.parts[1]!];
    // Same notes on both, and the wheel was only ever set on the first.
    expect(modulated.notes.map((n) => n.pitch)).toEqual(dry.notes.map((n) => n.pitch));
    expect(modulated.notes.every((n) => n.vibrato === 1)).toBe(true);
    expect(dry.notes.every((n) => n.vibrato === undefined)).toBe(true);
  });

  it("takes the highest the wheel reached while a note sounded", () => {
    // A swell into a held note is the common way the wheel is written, and a
    // parser that sampled only the onset would read that note as dry.
    const score = parseMidi(vibratoFixture(120, 64));
    expect(score.parts[0]!.notes[0]!.vibrato).toBeCloseTo(64 / 127, 5);
  });

  it("is absent, not zero, when nothing touched the wheel", () => {
    // `undefined` rather than 0, so a score from an unmodulated source is the
    // score it was before this was read at all.
    for (const part of parseMidi(bandFixture()).parts) {
      for (const note of part.notes) expect(note.vibrato).toBeUndefined();
    }
    for (const part of parseMidi(vibratoFixture(120, 0)).parts) {
      for (const note of part.notes) expect(note.vibrato).toBeUndefined();
    }
  });
});

describe("an arrangement", () => {
  it.each(PITCHED)("spends pitch writes on it on %s, and none without it", (consoleId) => {
    const wet = schedule(consoleId, vibratoFixture(120, 127));
    const dry = schedule(consoleId, vibratoFixture(120, 0));
    // Identical notes, so every extra write is the modulation. Strictly more
    // rather than "different", because a change that merely *moved* writes
    // around would satisfy an inequality on the count either way.
    expect(countWrites(wet)).toBeGreaterThan(countWrites(dry));
  });

  it.each(audioConsoles())("leaves an unmodulated source alone on %s", (consoleId) => {
    // The property the whole change rests on: nothing in the example library
    // touches the wheel, so every existing project must be byte-identical. Two
    // schedules from the same unmodulated fixture are compared write for write.
    const a = schedule(consoleId, vibratoFixture(120, 0));
    const b = schedule(consoleId, vibratoFixture(120, 0));
    expect(serialise(b)).toBe(serialise(a));
    // And the dry fixture must not be paying for vibrato it did not ask for:
    // its schedule is the one a build produced before any of this existed.
    expect(countWrites(a)).toBeGreaterThan(0);
  });
});

describe("the shape of it", () => {
  /**
   * The pitch register through the first note, on a console fine enough to show
   * it.
   *
   * The Super Nintendo, because its pitch is a fourteen-bit multiplier — a
   * quarter-tone is tens of steps there, where a Game Boy's eleven-bit divider
   * at the top of its range would swallow it and make the assertion about the
   * lattice rather than about the vibrato.
   */
  function firstNotePitches(): number[] {
    const script = schedule("snes", vibratoFixture(120, 127));
    // Whichever voice the modulated part landed on: the one whose pitch moves.
    const perVoice = new Map<number, number[]>();
    for (const tick of script.ticks) {
      let low: number | undefined;
      for (const write of tick.writes) {
        const voice = write.reg >> 4;
        const within = write.reg & 0x0f;
        if (within === 0x02) low = write.value;
        else if (within === 0x03 && low !== undefined) {
          const list = perVoice.get(voice) ?? [];
          list.push(((write.value & 0x3f) << 8) | low);
          perVoice.set(voice, list);
          low = undefined;
        }
      }
    }
    let best: number[] = [];
    for (const list of perVoice.values()) {
      if (new Set(list).size > new Set(best).size) best = list;
    }
    return best;
  }

  it("goes both above and below the written pitch, and comes back", () => {
    const values = firstNotePitches();
    expect(values.length).toBeGreaterThan(4);
    // The note is placed in tune and leaned into, so the first value written is
    // the written pitch — and the modulation has to reach both sides of it. A
    // one-way bend, an inverted sign or an accumulator that never returned
    // would each satisfy "the pitch changes" and fail here.
    const written = values[0]!;
    expect(Math.max(...values)).toBeGreaterThan(written);
    expect(Math.min(...values)).toBeLessThan(written);
  });

  it("starts in tune rather than mid-cycle", () => {
    // A player places the note and then leans into it; an oscillator started at
    // a non-zero phase would put every note's attack off pitch, which is the
    // one thing a listener would call out of tune rather than expressive.
    const values = firstNotePitches();
    const written = values[0]!;
    const spread = Math.max(...values) - Math.min(...values);
    // The second distinct value is still near the written pitch, because the
    // delay and the sine's own zero crossing both hold it there.
    expect(Math.abs(values[1]! - written)).toBeLessThan(spread);
  });
});

/** A schedule as a comparable string: every write, in order, with its chip. */
function serialise(script: {
  ticks: readonly { writes: readonly { reg: number; value: number; chip?: number }[] }[];
}): string {
  return script.ticks
    .map((tick) => tick.writes.map((w) => `${w.chip ?? 0}:${w.reg}=${w.value}`).join(","))
    .join("|");
}
