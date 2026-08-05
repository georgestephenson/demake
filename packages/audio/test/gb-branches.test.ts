/**
 * The Game Boy driver's long branches.
 *
 * The stream player is emitted *for a schedule* — a recording body per
 * borrowable channel, a merge loop, a preemption test, each present only if that
 * schedule needs it — so the distance a branch over the run walk has to reach is
 * data, not a constant. On the SM83 a relative branch reaches ±128 bytes and the
 * assembler refuses rather than wrapping, which is exactly right and exactly
 * why `jr` is the wrong instruction there: the widest shape assembled to a
 * branch 128 bytes out of range, and `demake build <quest> -c gb` died with
 * "the code generator produced invalid code" instead of the size refusal it
 * owed (that game wants 107 KiB of a 32 KiB board).
 *
 * `packages/demotic/test/_audio-battery.ts` cannot reach this. It builds the
 * example library, and the library's Game Boy games place one or two effects —
 * so the widest driver in it is two recording bodies short of the one that
 * breaks. This file builds the shape directly: four effects, one per channel,
 * every channel therefore borrowable, with rests and a panning merge in the
 * music. That is the most a Game Boy can ask for, and it is the case a fixture
 * would only reach by accident.
 */

import { describe, expect, it } from "vitest";

import { Asm } from "@demake/core";

import type { ChipScript, TickWrites } from "../src/chipscript.js";
import { bindingFor } from "../src/binding/registry.js";
import { gameDriverRate } from "../src/rom/index.js";
import { buildGameAudio, type GameEffect } from "../src/rom/gb-game.js";

/**
 * The clock a Game Boy game really runs on: the timer, fitted by the binding.
 *
 * Asked for rather than written down, because the driver checks the reload
 * against the rate and a pair invented here would fail that rather than the
 * thing this file is about.
 */
const CLOCK = bindingFor("gb").fitRate(gameDriverRate("gb"));

/** The registers each channel is driven through, and its panning bit. */
const CHANNELS = [
  { volume: 0x12, pitch: 0x13, trigger: 0x14 },
  { volume: 0x17, pitch: 0x18, trigger: 0x19 },
  { volume: 0x1a, pitch: 0x1d, trigger: 0x1e },
  { volume: 0x21, pitch: 0x22, trigger: 0x23 },
] as const;

function scriptOf(ticks: readonly TickWrites[]): ChipScript {
  const writes = ticks.reduce((sum, tick) => sum + tick.writes.length, 0);
  return {
    console: "gb",
    chips: ["gb-apu"],
    driver: { rate: CLOCK.rate, source: CLOCK.source, divisor: CLOCK.divisor },
    ticks: ticks.map((tick) => ({ writes: [...tick.writes] })),
    loopTick: 0,
    channels: [],
    timing: {
      source: CLOCK.source,
      requestedBpm: 120,
      achievedBpm: 120,
      ppmError: 0,
      rowsPerBeat: 6,
      maxOnsetDeviationMs: 0,
      accumulates: false,
    },
    budgets: { writes, peakWritesPerTick: writes, writeBudget: 32 },
  };
}

/**
 * The chip's power-up, which every schedule has to open with.
 *
 * The binding's own, because the driver performs it once at boot and takes it
 * back off the streams (`shared.ts` §stripBoot) — a hand-written prefix would be
 * refused for not being the one the ROM performs.
 */
const BOOT: TickWrites = { writes: [...bindingFor("gb").init()] };

/**
 * Music on every channel, with a rest and a panning write.
 *
 * The rest pulls in the rest handling, the `NR51` write pulls in the merge loop,
 * and touching all four channels is what makes all four borrowable once effects
 * are placed on them — which is the recording body per channel.
 */
const MUSIC = scriptOf([
  BOOT,
  {
    writes: CHANNELS.flatMap((channel, index) => [
      { reg: channel.volume, value: 0xf0 },
      { reg: channel.pitch, value: 0x40 + index },
      { reg: channel.trigger, value: 0x87 },
    ]),
  },
  { writes: [] },
  { writes: [{ reg: 0x25, value: 0x33 }] },
  { writes: CHANNELS.map((channel) => ({ reg: channel.volume, value: 0x80 })) },
]);

/** One effect per channel: what makes every channel one the music can lose. */
const EFFECTS: readonly GameEffect[] = CHANNELS.map((channel, index) => ({
  script: scriptOf([
    BOOT,
    {
      writes: [
        { reg: channel.volume, value: 0xf7 },
        { reg: channel.pitch, value: 0x70 },
        { reg: channel.trigger, value: 0x87 },
      ],
    },
    { writes: [] },
    { writes: [{ reg: channel.volume, value: 0x00 }] },
  ]),
  channel: index,
  priority: index,
}));

describe("the widest Game Boy driver a game can ask for", () => {
  const audio = buildGameAudio({ tracks: [MUSIC], effects: EFFECTS, hram: 0x80 });
  // Emitted here rather than in a case, because a driver's size and its helper
  // list are a *query*: both are empty until the emitter has been run
  // (`backend.ts` §BoundAudioShape), so the assertion below would read an empty
  // list and pass on a driver that pulled in nothing at all.
  const asm = new Asm(0);
  audio.emitCode(asm);
  audio.emitData(asm);
  const outcome = ((): { bytes?: Uint8Array; error?: unknown } => {
    try {
      return { bytes: asm.assemble() };
    } catch (error) {
      return { error };
    }
  })();

  it("pulls in a recording body for every channel an effect can take", () => {
    // The precondition for the case below: without the shadow this is the same
    // driver the example library already builds, and it would prove nothing.
    expect(audio.stats.helpers).toContain("music-borrowed-channel-shadow");
    expect(audio.stats.helpers).toContain("music-preemptible-runs");
    expect(audio.stats.helpers).toContain("music-rests");
    expect(audio.stats.helpers).toContain("music-panning-merge");
  });

  it("assembles, which means every branch over the run walk reaches", () => {
    expect(outcome.error).toBeUndefined();
    expect(outcome.bytes?.length ?? 0).toBeGreaterThan(0);
  });
});
