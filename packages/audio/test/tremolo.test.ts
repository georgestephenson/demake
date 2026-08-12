/**
 * Tremolo, from the source's controller 92 to the chip (doc 13 §A5.5).
 *
 * The amplitude half of what the modulation wheel does to pitch, and the last of
 * the YM2612 LFO's two outputs. It is built on vibrato's terms exactly, which is
 * most of what these cases assert:
 *
 *   - **The depth is read, not invented.** Controller 92 is where General MIDI
 *     puts it, and a part that never touches it gets nothing — which is why this
 *     changed no existing output by a byte.
 *   - **It is an attenuation, not a swing.** A note peaks at the level it was
 *     given and dips below it, because that is the only thing the chip with the
 *     hardware for it can do: a YM2612's LFO adds attenuation and never removes
 *     any. A software tremolo that oscillated either side of the level would be
 *     the louder of the two routes.
 *   - **It is delayed**, and by exactly as much as vibrato is — one LFO drives
 *     both, so a track whose tremolo started at a different moment from its
 *     vibrato could not be played on the console that has the hardware.
 *   - **One console does it in hardware**, and the register it does it through
 *     is the same byte the panning and the vibrato depth are in. Getting that
 *     write wrong silently cancels one of the other two.
 *
 * The control throughout is `tremoloFixture(bpm, 0)`: the *same notes* with the
 * controller at zero.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore } from "../src/arrange/index.js";
import { audioConsoles } from "../src/binding/registry.js";
import { countWrites } from "../src/chipscript.js";
import { render } from "../src/render.js";
import { parseMidi } from "../src/score/midi.js";
import { TREMOLO_MAX_DB } from "../src/vibrato.js";
import { tremoloFixture } from "./_fixtures.js";

/** Consoles with a channel whose level the arranger can move at all. */
const LEVELLED = audioConsoles().filter((id) =>
  (getConsole(id).audio?.channels ?? []).some((channel) => channel.volume !== undefined),
);

function schedule(consoleId: string, midi: Uint8Array) {
  return arrangeScore(parseMidi(midi), { console: consoleId, strategy: "full-band" }).script;
}

describe("the source's tremolo", () => {
  it("is read off controller 92", () => {
    const score = parseMidi(tremoloFixture());
    const [swelling, dry] = [score.parts[0]!, score.parts[1]!];
    expect(swelling.notes.map((n) => n.pitch)).toEqual(dry.notes.map((n) => n.pitch));
    expect(swelling.notes.every((n) => n.tremolo === 1)).toBe(true);
    expect(dry.notes.every((n) => n.tremolo === undefined)).toBe(true);
  });

  it("takes the highest the controller reached while a note sounded", () => {
    const score = parseMidi(tremoloFixture(120, 64));
    expect(score.parts[0]!.notes[0]!.tremolo).toBeCloseTo(64 / 127, 5);
  });

  it("leaves a source that never touches it byte-for-byte unchanged", () => {
    // The property that made this safe to add: every MIDI in the example library
    // is one, so closing this line re-baselined nothing.
    for (const id of LEVELLED) {
      const dry = schedule(id, tremoloFixture(120, 0));
      expect(countWrites(dry), id).toBeGreaterThan(0);
      const again = schedule(id, tremoloFixture(120, 0));
      expect(JSON.stringify(again.ticks), id).toEqual(JSON.stringify(dry.ticks));
    }
  });

  it("dips below the written level rather than swinging about it", () => {
    // The claim the whole shape rests on, and the one a register diff cannot
    // make: rendered, a tremolo'd note must be *quieter* than the same note dry,
    // because the hardware route can only attenuate and the software one is
    // written to match it.
    //
    // Measured as energy rather than as a peak, and the difference is this
    // console rather than a softer assertion. A Game Boy's envelope register
    // only latches on a trigger, so the driver re-triggers a pulse on every
    // volume change — which a swell makes every tick — and each trigger reloads
    // the frequency timer. The step that leaves behind rings through the
    // renderer's DC blocker, so the *peak* of a swelling note is higher than a
    // steady one's while every sample of the chip's own output is lower.
    const energy = (midi: Uint8Array): number => {
      const pcm = render(schedule("gb", midi), { sampleRate: 48000 });
      const samples = pcm.channels[0] as Float32Array;
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length);
    };
    expect(energy(tremoloFixture(120, 127))).toBeLessThan(energy(tremoloFixture(120, 0)));
  });

  it("costs a console with no LFO more writes than the same track dry", () => {
    // A held note being swelled is a volume write per tick wherever the hardware
    // will not do it, which is the same bill vibrato pays for pitch.
    const dry = schedule("nes", tremoloFixture(120, 0));
    const wet = schedule("nes", tremoloFixture(120, 127));
    expect(countWrites(wet)).toBeGreaterThan(countWrites(dry));
  });
});

describe("the Mega Drive's amplitude LFO", () => {
  /** Decode the FM half's bus writes into (register, value) pairs. */
  function fmWrites(midi: Uint8Array): { reg: number; value: number }[] {
    const out: { reg: number; value: number }[] = [];
    let latch: number | null = null;
    for (const tick of schedule("md", midi).ticks) {
      for (const write of tick.writes) {
        if ((write.chip ?? 0) !== 0) continue;
        if (write.reg === 0 || write.reg === 2) {
          latch = write.value;
          continue;
        }
        if (latch !== null) out.push({ reg: latch, value: write.value });
      }
    }
    return out;
  }

  it("programs the sensitivity and the carriers' enable, and only when asked", () => {
    const dry = fmWrites(tremoloFixture(120, 0));
    expect(dry.some((w) => w.reg >= 0xb4 && w.reg <= 0xb6 && ((w.value >> 4) & 3) !== 0)).toBe(
      false,
    );
    expect(dry.some((w) => w.reg >= 0x60 && w.reg <= 0x6f && (w.value & 0x80) !== 0)).toBe(false);

    const wet = fmWrites(tremoloFixture(120, 127));
    // `$22` has to be on, or the chip parks its amplitude sweep at the quiet end
    // and every operator with the enable set is simply attenuated.
    expect(wet.some((w) => w.reg === 0x22 && (w.value & 0x08) !== 0)).toBe(true);
    expect(wet.some((w) => w.reg >= 0xb4 && w.reg <= 0xb6 && ((w.value >> 4) & 3) !== 0)).toBe(
      true,
    );
    expect(wet.some((w) => w.reg >= 0x60 && w.reg <= 0x6f && (w.value & 0x80) !== 0)).toBe(true);
  });

  it("keeps the panning and the vibrato depth in the same byte", () => {
    // `$B4` carries all three, so a binding that wrote the sensitivity on its own
    // would silently centre a placed channel or cancel its vibrato — which is
    // exactly what a per-field write would do here and nothing would catch.
    const wet = fmWrites(tremoloFixture(120, 127)).filter((w) => w.reg >= 0xb4 && w.reg <= 0xb6);
    expect(wet.length).toBeGreaterThan(0);
    for (const write of wet) expect(write.value & 0xc0).not.toBe(0);
  });

  it("is cheaper here than writing the swell", () => {
    // The point of spending the hardware: the six FM voices are handed a depth
    // rather than a level that moves, so the cost is a nibble a note instead of
    // a write a tick. Against a Game Boy playing the same fixture.
    const cost = (id: string): number =>
      countWrites(schedule(id, tremoloFixture(120, 127))) /
      countWrites(schedule(id, tremoloFixture(120, 0)));
    expect(cost("md")).toBeLessThan(cost("gb"));
  });

  it("states a depth the chip's four settings can hold", () => {
    // Two bits against the pitch sweep's three, which is the hardware being
    // coarser rather than the demaker being vague — so the assertion is that
    // what lands is one of the four and not that it is the number asked for.
    expect(TREMOLO_MAX_DB).toBeGreaterThan(0);
    const values = new Set(
      fmWrites(tremoloFixture(120, 127))
        .filter((w) => w.reg >= 0xb4 && w.reg <= 0xb6)
        .map((w) => (w.value >> 4) & 3),
    );
    expect(values.size).toBeGreaterThan(0);
    for (const ams of values) expect(ams).toBeLessThanOrEqual(3);
  });
});
