/**
 * The music demaker, end to end (docs 16, 17).
 *
 * The load-bearing assertions are the ones that would let a wrong arrangement
 * ship quietly: that the schedule is compliant, that the tempo is preserved and
 * does not drift, that nothing is lost without being counted, and that the audio
 * a listener hears is the audio the register schedule produces.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore, candidates } from "../src/arrange/index.js";
import { audioConsoles, bindingFor } from "../src/binding/registry.js";
import { fitPatch } from "../src/binding/fm-patch.js";
import { encodeWav } from "../src/encode/wav.js";
import { inspectScript } from "../src/inspect.js";
import { parseMidi } from "../src/score/midi.js";
import { dominantBpm } from "../src/score/types.js";
import { planTiming, verifyNonAccumulating } from "../src/timing.js";
import { render } from "../src/render.js";
import {
  bandFixture,
  deepBassFixture,
  longBandFixture,
  octetFixture,
  scaleFixture,
} from "./_fixtures.js";

// `megaduck` is here because its sound hardware *is* the Game Boy's — the whole
// chip, the same clock, the same lattices — so the demakers work on it for free.
// Where the console's registers live is a fact about the cartridge, applied when
// a register number becomes an address, and never reaches a schedule.
const CONSOLES = ["dmg", "gbc", "megaduck", "nes", "sms", "gg", "sg1000", "snes", "md"];

describe("ingest", () => {
  it("reads a Standard MIDI File into a score", () => {
    const score = parseMidi(scaleFixture(120));
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0]!.notes).toHaveLength(8);
    expect(dominantBpm(score)).toBeCloseTo(120, 6);
    // Pitch is cents: middle C is MIDI 60, so 6000.
    expect(score.parts[0]!.notes[0]!.pitch).toBe(6000);
  });

  it("separates a band into its parts and finds the drums", () => {
    const score = parseMidi(bandFixture());
    expect(score.parts.length).toBe(4);
    const percussion = score.parts.filter((part) => part.role === "percussion");
    expect(percussion).toHaveLength(1);
    expect(percussion[0]!.notes.every((note) => note.drum !== undefined)).toBe(true);
  });

  it("rejects what it cannot read, by name", () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a Standard MIDI File/);
  });
});

describe("arrangement", () => {
  it.each(CONSOLES)("produces a compliant schedule for %s", (consoleId) => {
    const result = arrangeScore(parseMidi(bandFixture()), { console: consoleId });
    const inspection = inspectScript(result.script);
    expect(inspection.violations).toEqual([]);
    expect(inspection.compliant).toBe(true);
    expect(result.script.ticks.length).toBeGreaterThan(0);
    expect(result.script.budgets.peakWritesPerTick).toBeLessThanOrEqual(
      inspection.stats.writeBudget,
    );
  });

  it("assigns the parts to the channels their roles want", () => {
    const result = arrangeScore(parseMidi(bandFixture()), { console: "dmg" });
    const byChannel = new Map(
      result.plan.assignments.map((assignment) => [
        assignment.channel.id,
        assignment.parts.map((part) => part.role),
      ]),
    );
    // Drums can only go to the noise channel; the wave channel is the bass
    // voice on a Game Boy. Both are hardware facts, not preferences.
    expect(byChannel.get("noise")).toContain("percussion");
    expect(byChannel.get("wave")).toContain("bass");
  });

  it("keeps the melody when channels run out, and counts what it dropped", () => {
    // One melodic channel for three melodic parts: something has to go, and the
    // one thing that must not is the tune.
    const result = arrangeScore(parseMidi(bandFixture()), { console: "dmg", channels: 2 });
    const kept = result.plan.assignments.flatMap((assignment) =>
      assignment.parts.map((part) => part.role),
    );
    expect(kept).toContain("lead");
    expect(result.dropped.length).toBeGreaterThan(0);
    for (const dropped of result.dropped) {
      expect(dropped.reason).toBeTruthy();
      expect(dropped.count).toBeGreaterThan(0);
    }
  });

  it("refuses to degrade under --strict", () => {
    expect(() =>
      arrangeScore(parseMidi(bandFixture()), { console: "dmg", channels: 2, strict: true }),
    ).toThrow(/could not be kept/);
  });

  it("folds a bassline that lives below the chip's pitch floor", () => {
    // The SN76489 stops at ~109 Hz. E1 is 41 Hz, so the part is unplayable as
    // written and has to move — the arranger says so rather than emitting a
    // silent channel.
    const result = arrangeScore(parseMidi(deepBassFixture()), { console: "sms" });
    const folded = result.plan.assignments.find((assignment) => assignment.octaveShift !== 0);
    expect(folded).toBeDefined();
    expect(result.diagnostics.some((entry) => entry.code === "octave-folded")).toBe(true);
  });

  it("runs a tournament and reports every candidate", () => {
    const result = arrangeScore(parseMidi(bandFixture()), { console: "dmg" });
    const spec = getConsole("dmg").audio!;
    expect(result.tournament.candidates).toHaveLength(candidates(spec).length);
    expect(result.tournament.candidates.map((entry) => entry.id)).toContain(
      result.tournament.winner,
    );
    for (const entry of result.tournament.candidates) {
      if (entry.disqualified) continue;
      expect(entry.aggregate).toBeGreaterThan(0);
      expect(entry.aggregate).toBeLessThanOrEqual(1);
    }
  });

  it("reproduces the tournament's bytes when the winner is pinned", () => {
    const auto = arrangeScore(parseMidi(bandFixture()), { console: "dmg" });
    const pinned = arrangeScore(parseMidi(bandFixture()), {
      console: "dmg",
      strategy: auto.tournament.winner,
    });
    expect(pinned.artifact).toEqual(auto.artifact);
  });

  it("is deterministic", () => {
    const a = arrangeScore(parseMidi(bandFixture()), { console: "nes" });
    const b = arrangeScore(parseMidi(bandFixture()), { console: "nes" });
    expect(a.artifact).toEqual(b.artifact);
  });
});

describe("timing", () => {
  it.each(CONSOLES)("holds the tempo on %s without accumulating error", (consoleId) => {
    const score = parseMidi(bandFixture(140));
    const result = arrangeScore(score, { console: consoleId });
    expect(result.timing.accumulates).toBe(false);
    // Absolute placement preserves the tempo outright; what varies per console
    // is onset *resolution*, not speed. The residual is one rounding of the
    // piece's final onset, which on this four-bar fixture is a tenth of a
    // percent — and the next test shows it shrinking rather than compounding.
    expect(Math.abs(result.timing.ppmError)).toBeLessThan(2000);
    expect(result.timing.achievedBpm).toBeCloseTo(140, 0);
    expect(result.timing.maxOnsetDeviationMs).toBeLessThan(12);
  });

  it("gets *more* accurate as the piece gets longer — error does not accumulate", () => {
    // The property doc 17 makes a hard requirement. Accumulating error grows
    // with length; bounded rounding error is a fixed number of milliseconds
    // spread over more and more music, so it shrinks. Nothing else distinguishes
    // the two, and the difference is inaudible until it is ruinous.
    const short = arrangeScore(parseMidi(bandFixture(140)), { console: "nes" });
    const long = arrangeScore(parseMidi(longBandFixture(140)), { console: "nes" });
    expect(Math.abs(long.timing.ppmError)).toBeLessThan(Math.abs(short.timing.ppmError));
  });

  it("places rows from their absolute position, so error stays bounded", () => {
    const binding = bindingFor("dmg");
    const plan = planTiming(binding, { bpm: 137, ppq: 960, durationScoreTicks: 960 * 4 * 200 });
    expect(verifyNonAccumulating(plan, 960 * 4 * 200)).toBe(true);
  });

  it("finds a Game Boy timer divisor that beats vblank", () => {
    const binding = bindingFor("dmg");
    const fit = binding.fitRate(150); // 150 Hz: 25 rows/beat at 360 BPM, or 6 at 1500
    expect(fit.source).toBe("timer");
    const hz = fit.rate.num / fit.rate.den;
    expect(Math.abs(hz - 150) / 150).toBeLessThan(0.02);
  });
});

describe("the render contract", () => {
  it("makes audible sound from the schedule alone", () => {
    const result = arrangeScore(parseMidi(bandFixture()), { console: "dmg" });
    const pcm = render(result.script, { sampleRate: 48000 });
    let peak = 0;
    for (const sample of pcm.channels[0]!) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.05);
    expect(pcm.sampleRate).toBe(48000);
  });

  it("renders byte-identically every time", () => {
    const result = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" });
    const a = encodeWav(render(result.script));
    const b = encodeWav(render(result.script));
    expect(a).toEqual(b);
  });

  it("writes a WAV a player can open", () => {
    const result = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" });
    const wav = encodeWav(render(result.script));
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(2);
    // RIFF's size field counts everything after it, so eight less than the file.
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
  });

  it("plays the scale it was given, in the right direction", () => {
    // The cheapest possible check that the pipeline is connected: an ascending
    // scale must come out ascending. It catches inverted period registers,
    // which sound plausible and are completely wrong.
    const result = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" });
    const pcm = render(result.script);
    const first = dominantFrequency(pcm.channels[0]!, pcm.sampleRate, 0.15, 0.35);
    const last = dominantFrequency(pcm.channels[0]!, pcm.sampleRate, 3.6, 3.8);
    expect(last).toBeGreaterThan(first * 1.8);
  });
});

describe("spending the whole machine", () => {
  // AGENTS.md §Iron rules: a demaker constrains only as far as the hardware
  // forces it. These are the assertions that would fail if a console's spec
  // quietly declared less hardware than the machine has.
  it("gives a Mega Drive all ten of its voices", () => {
    const spec = getConsole("md").audio!;
    expect(spec.chips).toEqual(["ym2612", "sn76489"]);
    expect(spec.channels).toHaveLength(10);
    expect(spec.channels.filter((channel) => channel.kind === "fm")).toHaveLength(6);
  });

  it("carries eight parts a four-voice console has to shed", () => {
    const source = parseMidi(octetFixture());
    const md = arrangeScore(source, { console: "md" });
    const gb = arrangeScore(source, { console: "dmg" });
    const voices = (result: ReturnType<typeof arrangeScore>): number =>
      new Set(result.script.channels.map((span) => span.channelId)).size;
    // The Game Boy has four voices for eight parts, so something has to give and
    // the report says what. The Mega Drive has ten, so nothing does.
    expect(voices(gb)).toBeLessThanOrEqual(4);
    expect(voices(md)).toBeGreaterThan(voices(gb));
    expect(voices(md)).toBeGreaterThanOrEqual(7);
    const droppedParts = md.dropped.filter((one) => one.kind === "part");
    expect(droppedParts).toEqual([]);
  });

  it("fits a different timbre to a bass part than to a lead", () => {
    // Timbre on this chip is searched rather than selected (doc 17 §Stage 3), so
    // the thing worth asserting is that the search *discriminates*: a patch
    // fitted for something dark must measure darker than one fitted for
    // something brilliant, or the tournament is decorative.
    const dark = fitPatch({ brightness: 0.1, attack: 0.05, sustain: 0.5 });
    const bright = fitPatch({ brightness: 0.95, attack: 0.05, sustain: 0.5 });
    expect(bright.brightnessHz).toBeGreaterThan(dark.brightnessHz * 1.5);
    expect(dark.candidates).toBeGreaterThan(20);
  });

  it("holds a patch that was asked to hold and drops one that was not", () => {
    const held = fitPatch({ brightness: 0.5, attack: 0.05, sustain: 0.95 });
    const plucked = fitPatch({ brightness: 0.5, attack: 0.05, sustain: 0.05 });
    expect(held.sustainRatio).toBeGreaterThan(plucked.sustainRatio + 0.2);
  });
});

describe("the console registry", () => {
  it("lists exactly the consoles that have both a spec and a binding", () => {
    expect(audioConsoles().sort()).toEqual([...CONSOLES].sort());
  });

  // The Game Boy Advance, because both sides of this merge had reached for the
  // other's console here and neither is true any more. It wants a console with a
  // spec in `@demake/core` and no audio in it, which is what a chip model has not
  // been written for yet — the handhelds, from here on.
  it("explains a console it cannot demake", () => {
    expect(() => bindingFor("gba")).toThrow(/no audio spec yet/);
  });
});

/** Dominant frequency in a window, by zero crossings. */
function dominantFrequency(
  samples: Float32Array,
  sampleRate: number,
  fromSeconds: number,
  toSeconds: number,
): number {
  const from = Math.floor(fromSeconds * sampleRate);
  const to = Math.min(Math.floor(toSeconds * sampleRate), samples.length);
  let crossings = 0;
  let previous = samples[from] ?? 0;
  for (let i = from + 1; i < to; i += 1) {
    const current = samples[i]!;
    if (previous <= 0 && current > 0) crossings += 1;
    previous = current;
  }
  return (crossings * sampleRate) / Math.max(to - from, 1);
}
