/**
 * A percussion part across a pool of voices (doc 17 §Percussion, doc 13 §A5.5).
 *
 * A General MIDI drum track is one part, and one part took one channel — so a
 * Neo Geo played its whole kit on one of six ADPCM-A voices and dropped every
 * hit that landed on a tick another was already using. Three things are worth
 * asserting and none of them is visible in a register diff, which compares a
 * schedule against itself:
 *
 *   - **A console with one percussion voice is byte-identical.** That is what
 *     makes this reviewable, and it is the same property the stereo placement
 *     rests on: only the machines with hardware to spend may move.
 *   - **Every hit survives** where the hardware has room. The count is the
 *     assertion — the kit lost a third of itself on this console and nothing
 *     said so, because a hit dropped for a collision is not counted anywhere
 *     (§the honesty gap, below).
 *   - **A class keeps its own voice.** A kick that is still ringing must not be
 *     cut off by the hat on the next eighth, which is the whole reason the
 *     allocation is by drum class rather than round-robin over arrivals.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore } from "../src/arrange/index.js";
import { planArrangement } from "../src/arrange/plan.js";
import { audioConsoles } from "../src/binding/registry.js";
import { analyze } from "../src/analysis.js";
import { parseMidi } from "../src/score/midi.js";
import { octetFixture } from "./_fixtures.js";

/** How many percussion-capable voices a console's spec declares. */
function drumVoices(consoleId: string): number {
  const spec = getConsole(consoleId).audio;
  if (spec === undefined) return 0;
  return spec.channels.filter(
    (channel) =>
      channel.kind === "noise" || (channel.kind === "sample" && channel.pitch === undefined),
  ).length;
}

/** The consoles that gain anything — derived, so a new console joins by itself. */
const POOLED = audioConsoles().filter((id) => drumVoices(id) > 1);

/** And the ones that must not move, which is every other. */
const SINGLE = audioConsoles().filter((id) => drumVoices(id) <= 1);

/**
 * Two forms of the same fixture, because the two entry points differ.
 *
 * `planArrangement` takes an *analysed* score — it reads roles, which is
 * `analyze`'s output — while `arrangeScore` analyses whatever it is handed.
 * Passing the analysed one to both runs the classifier twice, which is not a
 * no-op: it reclassifies from material that has already been shaped, and the
 * kit came back as something other than percussion.
 */
const source = parseMidi(octetFixture());
const score = analyze(source);

describe("the pool", () => {
  it("is more than one voice on exactly the consoles whose hardware has them", () => {
    // Stated rather than assumed, because the rest of this file is only
    // meaningful if the split is what the hardware says. A YM2610 has six
    // fixed-rate sample voices; a Nintendo DS has two noise generators; a Game
    // Boy Advance has its APU's and the mixer's recording of one.
    expect(POOLED).toContain("neogeo");
    expect(POOLED).toContain("nds");
    expect(SINGLE).toContain("dmg");
    expect(SINGLE).toContain("snes");
  });

  it.each(SINGLE)("gives %s exactly one drum voice, so its schedule cannot move", (consoleId) => {
    const plan = planArrangement(score, getConsole(consoleId).audio!, {
      allowArpeggio: true,
      percussion: true,
    });
    const pooled = plan.assignments.filter((a) => a.drumVoice !== undefined);
    // Absent rather than a pool of one: the field never appears, so nothing in
    // `compile.ts` takes the filtering path at all.
    expect(pooled).toHaveLength(0);
  });

  it.each(POOLED)("spreads %s's kit across the voices it has", (consoleId) => {
    const plan = planArrangement(score, getConsole(consoleId).audio!, {
      allowArpeggio: true,
      percussion: true,
    });
    const pooled = plan.assignments.filter((a) => a.drumVoice !== undefined);
    expect(pooled.length).toBeGreaterThan(1);

    // Every seat in the pool is filled once, and they agree about how big it is.
    const size = pooled[0]!.drumVoice!.size;
    expect(pooled).toHaveLength(size);
    const seats = pooled.map((a) => a.drumVoice!.index).sort((a, b) => a - b);
    expect(seats).toEqual([...Array(size).keys()]);

    // And they all carry the same part, because a pool is one kit rather than
    // several — a kit split across two *parts* would be two instruments.
    const parts = new Set(pooled.flatMap((a) => a.parts.map((p) => p.id)));
    expect(parts.size).toBe(1);
  });
});

describe("the Neo Geo's kit", () => {
  /** ADPCM-A key-ons per voice, read off the bus the way the chip sees them. */
  function keyOns(consoleId: string): number[] {
    // `full-band` rather than the tournament, because the tournament is free to
    // win with `no-drums` — it does on this fixture — and a kit that was never
    // arranged says nothing about how a kit is spread. Pinning the candidate is
    // what makes this a test of the pool rather than of the judge.
    const script = arrangeScore(source, { console: consoleId, strategy: "full-band" }).script;
    const hits = [0, 0, 0, 0, 0, 0];
    for (const tick of script.ticks) {
      let address = -1;
      for (const write of tick.writes) {
        // The register *is* the port on this chip, and the address is the value
        // an even-port write latches — so a reader that took `reg` for a
        // register number would see nothing at all here.
        if (write.reg === 2) address = write.value;
        else if (write.reg === 3 && address === 0x00 && (write.value & 0x80) === 0) {
          for (let voice = 0; voice < 6; voice += 1) {
            if (write.value & (1 << voice)) hits[voice]! += 1;
          }
        }
      }
    }
    return hits;
  }

  it("plays every hit the source wrote", () => {
    const drums = score.parts.filter((part) => part.role === "percussion");
    const wrote = drums.reduce((sum, part) => sum + part.notes.length, 0);
    expect(wrote).toBeGreaterThan(0);

    const played = keyOns("neogeo").reduce((a, b) => a + b, 0);
    // One voice lost every hit that collided with a ringing one — a third of
    // this kit — and counted none of them.
    expect(played).toBe(wrote);
  });

  it("puts each class on the voice its class asks for", () => {
    // Counted per class off the *source*, so this checks the allocation rather
    // than restating it: a kick that landed on the hats' voice would still add
    // up to the right total and still sound on more than one voice.
    const wrote = new Map<string, number>();
    for (const part of score.parts) {
      if (part.role !== "percussion") continue;
      for (const note of part.notes) {
        const drum = note.drum ?? "perc";
        wrote.set(drum, (wrote.get(drum) ?? 0) + 1);
      }
    }

    const hits = keyOns("neogeo");
    expect(hits[0]).toBe(wrote.get("kick") ?? 0);
    expect(hits[1]).toBe(wrote.get("snare") ?? 0);
    // The two hats share a voice, which is the pedal on a real kit rather than
    // a shortage of hardware — there are three voices spare here.
    expect(hits[2]).toBe((wrote.get("hat-closed") ?? 0) + (wrote.get("hat-open") ?? 0));
    expect(hits[0]).toBeGreaterThan(0);
    expect(hits[1]).toBeGreaterThan(0);
    expect(hits[2]).toBeGreaterThan(0);
  });
});
