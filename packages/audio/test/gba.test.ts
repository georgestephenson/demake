/**
 * The Game Boy Advance binding, and the two seams it sits on.
 *
 * The console-wide sweeps in `arrange.test.ts` already say that a schedule for
 * this machine is compliant, keeps its tempo and sounds like what it wrote. What
 * is here is what only this console has:
 *
 *   - **Two chips of different kinds.** Four Game Boy channels that generate a
 *     waveform and a mixer that plays one, encoded by one binding because ten
 *     voices are one instrument. A write has to say which it addresses or a
 *     render would send a mixer's `SRCN` to an APU's sweep register.
 *   - **A bank with two readers.** The binding puts a waveform's index in a
 *     voice's `SRCN` and the driver reads the same table out of ROM, so the
 *     indices are a shared format rather than an internal detail.
 *   - **A balance stated twice.** How loud four Game Boy channels sit against a
 *     six-voice mixer is a fact about the *board*, so neither chip model knows
 *     it — `@demake/audio` says it from one side and `@demake/gba` from the
 *     other, and a test is the only thing that can hold them together.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";
import { GBA_PCM_KON, GBA_PCM_VOICES } from "@demake/chip";
import { PSG_MIX_GAIN } from "@demake/gba";

import { arrangeScore } from "../src/arrange/index.js";
import type { ChipScript } from "../src/chipscript.js";
import { packScript } from "../src/rom/data.js";
import { bindingFor } from "../src/binding/registry.js";
import { GBA_APU_CHANNELS, GBA_PSG_GAIN } from "../src/binding/gba.js";
import { sampleBank, sampleNumber, WAVEFORMS, WAVE_SAMPLES } from "../src/binding/gba-bank.js";
import { artifactFormat } from "../src/encode/spc.js";
import { inspectScript } from "../src/inspect.js";
import { parseMidi } from "../src/score/midi.js";
import { bandFixture } from "./_fixtures.js";

const spec = getConsole("gba").audio!;

describe("the Game Boy Advance binding", () => {
  const binding = bindingFor("gba");

  it("encodes ten voices across two chips, and says which is which", () => {
    expect(spec.channels).toHaveLength(GBA_APU_CHANNELS + GBA_PCM_VOICES);
    const writes = binding.init();
    // Every write names its chip. A schedule for a two-chip console whose writes
    // did not would be routed by position, which is how a mixer's source
    // register ends up in an APU's sweep.
    expect(writes.every((write) => write.chip === 0 || write.chip === 1)).toBe(true);
    expect(writes.some((write) => write.chip === 0)).toBe(true);
    expect(writes.some((write) => write.chip === 1)).toBe(true);
  });

  it("starts a mixer voice with a pulse, after telling it what to play", () => {
    const frames = spec.channels.map(() => ({ on: false, hz: 0, level: 0 }));
    // One sample voice, sounding.
    frames[GBA_APU_CHANNELS] = { on: true, hz: 440, level: 0.5 };
    const writes = binding.encode(frames, undefined).filter((write) => write.chip === 1);
    const kon = writes.findIndex((write) => write.reg === GBA_PCM_KON);
    expect(kon).toBeGreaterThan(0);
    // Last, so everything the voice needs is already there — and it is a pulse,
    // so it names only the voice that started.
    expect(kon).toBe(writes.length - 1);
    expect(writes[kon]!.value).toBe(1);
  });

  it("silences a voice with its level rather than a key-off", () => {
    const on = spec.channels.map(() => ({ on: false, hz: 0, level: 0 }));
    on[GBA_APU_CHANNELS] = { on: true, hz: 440, level: 0.5 };
    const off = spec.channels.map(() => ({ on: false, hz: 0, level: 0 }));
    const writes = binding.encode(off, on).filter((write) => write.chip === 1);
    // Two levels and nothing else: no shared register, and the voice is left
    // ready rather than torn down.
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.value === 0)).toBe(true);
    expect(writes.some((write) => write.reg === GBA_PCM_KON)).toBe(false);
  });

  it("finds a driver rate to within a part in two thousand", () => {
    // Sixteen bits of reload against a four-way prescaler. The bound is what the
    // *coarsest* useful prescaler gives: below about 256 Hz the finest one runs
    // out of reload, so a rate in the driver's range is fitted by counting a
    // 262 kHz clock and the residue is one count of it. Two hundredths of a per
    // cent, against a Game Boy's tenths — and a tempo that does not accumulate
    // (doc 17 §Tempo is a budget) cares about the drift rather than the offset.
    for (const desired of [60, 120, 150, 240]) {
      const fit = binding.fitRate(desired);
      const hz = fit.rate.num / fit.rate.den;
      expect(fit.source).toBe("timer");
      expect(Math.abs(hz - desired) / desired).toBeLessThan(5e-4);
    }
  });
});

describe("the mixer's waveform bank", () => {
  it("is one definition the binding and the driver both index", () => {
    const bank = sampleBank();
    expect(bank).toHaveLength(WAVEFORMS.length);
    for (const [index, waveform] of WAVEFORMS.entries()) {
      expect(sampleNumber(waveform)).toBe(index);
    }
    // Every tone is one cycle; the noise is a recording and is longer.
    for (const [index, sample] of bank.entries()) {
      const expected = WAVEFORMS[index] === "noise" ? sample.data.length : WAVE_SAMPLES;
      expect(sample.data.length).toBe(expected);
      // Everything loops: a voice is silenced by its level, so running off the
      // end would be a second mechanism for something the level already does.
      expect(sample.loop).toBe(0);
    }
  });

  it("is deterministic, including the noise", () => {
    // No host randomness anywhere near a build: the noise is a shift register
    // with a fixed seed, so regenerating the bank cannot change a golden.
    expect([...sampleBank()[5]!.data]).toEqual([...sampleBank()[5]!.data]);
    expect(sampleBank()[5]!.data.some((value) => value !== 0)).toBe(true);
  });
});

describe("what the board decides rather than either chip", () => {
  it("states the same balance on both sides of the seam", () => {
    // The same SN76489 is the whole output on a Master System and sits below six
    // FM voices on a Mega Drive; the same reasoning holds here, so the number
    // belongs to the console and is written down twice by necessity.
    expect(GBA_PSG_GAIN).toBe(PSG_MIX_GAIN);
    expect(bindingFor("gba").chipGains).toEqual([PSG_MIX_GAIN, 1]);
  });
});

describe("the artifact", () => {
  it("is a WAV, because half the schedule addresses a mixer no container knows", () => {
    expect(artifactFormat(spec.chips)).toBe("wav");
  });

  it("arranges a band into a compliant schedule and hands back audio", () => {
    const result = arrangeScore(parseMidi(bandFixture()), { console: "gba" });
    expect(inspectScript(result.script).compliant).toBe(true);
    expect(result.script.chips).toEqual(["gb-apu", "gba-pcm"]);
    // RIFF/WAVE, rather than a VGM with two thirds of the music missing.
    expect(String.fromCharCode(...result.artifact.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...result.artifact.subarray(8, 12))).toBe("WAVE");
  });
});

describe("packing a schedule for a board with two devices", () => {
  /** A tick's worth of writes, as `packScript` takes them. */
  const script = (writes: readonly { reg: number; value: number; chip: number }[]): ChipScript => ({
    console: "gba",
    chips: spec.chips,
    driver: { rate: { num: 128, den: 1 }, source: "timer" },
    ticks: [{ writes: [...writes] }],
    loopTick: 0,
    channels: [],
    timing: {
      source: "timer",
      requestedBpm: 0,
      achievedBpm: 0,
      ppmError: 0,
      rowsPerBeat: 0,
      maxOnsetDeviationMs: 0,
      accumulates: false,
    },
    budgets: { writes: writes.length, peakWritesPerTick: writes.length, writeBudget: 120 },
  });

  it("does not fold a mixer voice's level into the Game Boy's panning byte", () => {
    // `$25` is `NR51` on chip zero and the fifth voice's right level on chip one.
    // Without `mergeChip` the second was packed as a *merge* run, and the driver
    // folded it into `NR51` — the music's stereo image replaced by a volume, at
    // the first tick, on every build with an effect in it. The run header's
    // merge bit is `$40`.
    const data = packScript(script([{ reg: 0x25, value: 0x77, chip: 1 }]), {
      channelOf: () => () => 0,
      mergeRegs: new Set([0x25]),
      mergeChip: 0,
      port: (reg, chip) => (chip === 0 ? reg : 0x40 | reg),
    });
    const block = data.blocks[0] as Uint8Array;
    // count, flags, register, value — and the flags must not claim a merge.
    expect(block[0]).toBe(1);
    expect((block[1] as number) & 0x40).toBe(0);
  });

  it("still merges the register the Game Boy channels really do share", () => {
    const data = packScript(script([{ reg: 0x25, value: 0x77, chip: 0 }]), {
      channelOf: () => () => 0,
      mergeRegs: new Set([0x25]),
      mergeChip: 0,
      port: (reg, chip) => (chip === 0 ? reg : 0x40 | reg),
    });
    const block = data.blocks[0] as Uint8Array;
    expect((block[1] as number) & 0x40).toBe(0x40);
  });
});
