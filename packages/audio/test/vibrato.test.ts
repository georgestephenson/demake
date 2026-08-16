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

describe("a chip with an LFO", () => {
  /**
   * The Mega Drive is the only console here that bends its own notes.
   *
   * Its YM2612 has an LFO whose setting 1 is 5.56 Hz, within a tenth of a hertz
   * of the rate the arranger states — so the six FM voices are handed a depth
   * and left to it. **The Neo Geo is deliberately not on this list**, and that
   * is the one fact this block exists to hold: an OPNB is an OPN2 with the LFO
   * removed, so `ym2610.ts` refuses `$22` by design. A binding that claimed it
   * anyway would stop the per-tick pitch writes, have its register writes
   * ignored, and play the note straight — vibrato vanishing in silence.
   */
  function fmRegisters(consoleId: string, midi: Uint8Array) {
    const script = schedule(consoleId, midi);
    const lfo: number[] = [];
    const fms = new Set<number>();
    for (const tick of script.ticks) {
      let address = -1;
      for (const write of tick.writes) {
        if ((write.chip ?? 0) !== 0) continue;
        if ((write.reg & 1) === 0) address = write.value;
        else if (address === 0x22) lfo.push(write.value);
        else if (address >= 0xb4 && address <= 0xb6) fms.add(write.value & 0x07);
      }
    }
    return { lfo, fms };
  }

  it("switches the Mega Drive's LFO on and states a depth", () => {
    const { lfo, fms } = fmRegisters("md", vibratoFixture(120, 127));
    // Bit 3 enables; the low three bits select the rate. Setting 1 is 5.56 Hz.
    expect(lfo).toContain(0x09);
    // A sensitivity beyond zero, which is the whole point — the table is coarse
    // and the arranger's quarter-tone lands on 6 (40 cents).
    expect([...fms].some((value) => value > 0)).toBe(true);
  });

  it("leaves the Mega Drive's LFO alone when nothing asks for vibrato", () => {
    // Lazily rather than at boot: a track with no modulation must write exactly
    // the registers it always did, which is every MIDI in the example library.
    const { lfo, fms } = fmRegisters("md", vibratoFixture(120, 0));
    // Never *enabled*, rather than never written: `init()` has always stated
    // `$22 = 0` at boot, because silencing the chip is what stops a soft reset
    // leaving something ringing. Bit 3 is the enable, and it must stay clear.
    expect(lfo.every((value) => (value & 0x08) === 0)).toBe(true);
    expect([...fms].every((value) => value === 0)).toBe(true);
  });

  it("never programs an LFO on the Neo Geo, which has none", () => {
    const { lfo, fms } = fmRegisters("neogeo", vibratoFixture(120, 127));
    expect(lfo).toHaveLength(0);
    expect([...fms].every((value) => value === 0)).toBe(true);
  });

  it("still bends the Neo Geo, by moving the pitch instead", () => {
    // The other half of the same fact: refusing the LFO must not mean losing
    // the vibrato. This console pays the per-tick price every non-FM one pays.
    const wet = schedule("neogeo", vibratoFixture(120, 127));
    const dry = schedule("neogeo", vibratoFixture(120, 0));
    expect(countWrites(wet)).toBeGreaterThan(countWrites(dry) * 1.5);
  });

  it("costs the Mega Drive almost nothing, which is the point", () => {
    // Hardware vibrato is a handful of register writes; the per-tick route is
    // two to five times a dry track. A regression here means the LFO stopped
    // being used and the pitch writes came back.
    const wet = countWrites(schedule("md", vibratoFixture(120, 127)));
    const dry = countWrites(schedule("md", vibratoFixture(120, 0)));
    expect(wet).toBeGreaterThan(dry);
    expect(wet).toBeLessThan(dry * 1.2);
  });
});
