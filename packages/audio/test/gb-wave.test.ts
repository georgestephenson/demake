/**
 * The Game Boy's wave channel: a bend is not a new note.
 *
 * `NR34`'s bit 7 is a trigger, and on this channel a trigger does something the
 * other three do not — it resets the **wave position** to zero
 * (`WaveChannel.trigger` in `@demake/chip`). So carrying it on a pitch write
 * restarts the waveform, which is audible as a click rather than as a wrong
 * note: the schedule is performed exactly, doc 16's Level A stays green on every
 * console, and the cartridge sounds wrong.
 *
 * `encodeNoise` in the same file already guards the identical hazard one channel
 * along — "writing every tick would restart the shift register and turn a
 * ringing snare into a buzz" — and this is that rule stated for the wave
 * channel, where the state being restarted is a position rather than a shift
 * register.
 *
 * Two things reach it, and one of them was live in the example library before
 * vibrato existed:
 *
 *   - **A chord the arranger reduces.** The wave channel plays whichever note of
 *     a sustained chord is chosen, and the choice can change while the chord is
 *     still sounding. `keep.mid` restarted the waveform 47 times that way and
 *     `vault.mid` 11.
 *   - **A vibrato**, which is several bends a second for as long as the note is
 *     held.
 *
 * The mutation below is what makes this a test rather than a restatement: it
 * puts the bit back and asserts the audio gets *worse* by a measure taken from
 * the samples themselves, so a fix that only changed the byte would not pass.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { bindingFor } from "../src/binding/registry.js";
import type { ChannelFrame, ChipScript, Rational, TickWrites } from "../src/chipscript.js";
import { render } from "../src/render.js";

/** `NR34` — the wave channel's frequency-high and trigger register. */
const NR34 = 0x1e;
/** `NR30` — its DAC switch, written only when the channel is started. */
const NR30 = 0x1a;

const binding = bindingFor("gb", getConsole("gb").audio!);

/** Four silent channels with one of them saying whatever the caller wants. */
function frames(wave: Partial<ChannelFrame>): ChannelFrame[] {
  const silent: ChannelFrame = { on: false, hz: 0, level: 0 };
  return [silent, silent, { on: true, hz: 220, level: 1, ...wave }, silent];
}

describe("the wave channel's trigger", () => {
  it("is carried when the note starts", () => {
    const writes = binding.encode(frames({ retrigger: true }), undefined);
    expect(writes.some((w) => w.reg === NR30 && w.value === 0x80)).toBe(true);
    const high = writes.filter((w) => w.reg === NR34);
    expect(high).toHaveLength(1);
    expect(high[0]!.value & 0x80).toBe(0x80);
  });

  it("is not carried when only the pitch moved", () => {
    // The same note, bent — which is what one tick of a vibrato is, and what a
    // chord whose chosen note changed is.
    const before = frames({ retrigger: true });
    const writes = binding.encode(frames({ hz: 233 }), before);
    const high = writes.filter((w) => w.reg === NR34);
    expect(high).toHaveLength(1);
    expect(high[0]!.value & 0x80).toBe(0);
    // And the low byte moved with it, or the bend did not happen at all.
    expect(writes.some((w) => w.reg === 0x1d)).toBe(true);
    // Nothing restarted the DAC either: that byte belongs to starting a note.
    expect(writes.some((w) => w.reg === NR30)).toBe(false);
  });

  it("comes back when the channel starts a note again", () => {
    // Silence and then a note is a note start, however long the channel had
    // been on before — the trigger is what makes the waveform play from its
    // beginning, which is exactly what a new note wants.
    const off: ChannelFrame[] = [
      { on: false, hz: 0, level: 0 },
      { on: false, hz: 0, level: 0 },
      { on: false, hz: 0, level: 0 },
      { on: false, hz: 0, level: 0 },
    ];
    const writes = binding.encode(frames({ hz: 233 }), off);
    expect(writes.some((w) => w.reg === NR30 && w.value === 0x80)).toBe(true);
    const high = writes.filter((w) => w.reg === NR34);
    expect(high).toHaveLength(1);
    expect(high[0]!.value & 0x80).toBe(0x80);
  });
});

/**
 * One held note, bent the way a vibrato bends it, encoded by the binding.
 *
 * Hand-driven rather than arranged, for the reason `sms-latch.test.ts` gives:
 * which channel a fixture's parts land on is the *arranger's* decision, and a
 * fixture that happened not to reach the wave channel would compare silence
 * with silence and pass on any binding at all. Here the note is on that channel
 * by construction.
 */
function bentNote(ticks: number, rate: Rational): ChipScript {
  const out: TickWrites[] = [];
  let prev: ChannelFrame[] | undefined;
  const hzOf = (tick: number): number =>
    // A little under a semitone either way at about five cycles a second: the
    // shape `compile.ts` produces, at a width the Game Boy's lattice resolves.
    220 * 2 ** ((Math.sin((2 * Math.PI * 5.5 * tick) / 120) * 40) / 1200);
  for (let tick = 0; tick < ticks; tick += 1) {
    const next = frames({ hz: hzOf(tick), ...(tick === 0 ? { retrigger: true } : {}) });
    // The chip's power-up and its wave RAM: without them the table is all
    // zeroes and both renders are silence, which any binding would pass.
    const boot = tick === 0 ? binding.init() : [];
    out.push({ writes: [...boot, ...binding.encode(next, prev)] });
    prev = next;
  }
  const writes = out.reduce((sum, tick) => sum + tick.writes.length, 0);
  return {
    console: "gb",
    chips: ["gb-apu"],
    driver: { rate, source: "timer" },
    ticks: out,
    loopTick: -1,
    channels: [],
    timing: { source: "timer", requestedHz: 120, achievedHz: 120, ppmError: 0, worstOnsetMs: 0 },
    budgets: { writes, peakWritesPerTick: 8, writeBudget: 32 },
  };
}

/**
 * The audible half: the samples, with the bit put back.
 *
 * A schedule whose `NR34` writes are all triggers is precisely the schedule this
 * binding produced before, so mutating one into the other compares the two
 * answers through the same renderer.
 */
function withTriggers(script: ChipScript): ChipScript {
  return {
    ...script,
    ticks: script.ticks.map((tick) => ({
      ...tick,
      writes: tick.writes.map((w) => (w.reg === NR34 ? { ...w, value: w.value | 0x80 } : w)),
    })),
  };
}

/** How many sample-to-sample steps are big enough to hear as a click. */
function clicks(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (Math.abs((samples[i] as number) - (samples[i - 1] as number)) > 0.05) count += 1;
  }
  return count;
}

describe("a bent wave note", () => {
  it("has fewer discontinuities than the same note retriggered", () => {
    const script = bentNote(240, { num: 4194304, den: 34953 });
    // The note has to actually bend, or this compares one waveform with itself.
    const bends = script.ticks.reduce(
      (n, tick) => n + tick.writes.filter((w) => w.reg === NR34).length,
      0,
    );
    expect(bends).toBeGreaterThan(8);

    const bent = render(script, { sampleRate: 48000 });
    const struck = render(withTriggers(script), { sampleRate: 48000 });
    expect(clicks(bent.channels[0] as Float32Array)).toBeLessThan(
      clicks(struck.channels[0] as Float32Array),
    );
  });
});
