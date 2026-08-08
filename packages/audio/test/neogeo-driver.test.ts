/**
 * The Neo Geo's sound program, held to doc 16's Level A proof on its own.
 *
 * `packages/demotic/test/audio-neogeo.test.ts` runs the whole example library
 * through this driver inside a game; this file is the layer below it, and it
 * exists for `spc.test.ts`'s reason: a failure one level up could be the driver,
 * the container, or the 68000's request path, and this can only be the first.
 *
 * What it proves that no other driver's test does is that a **separate computer
 * with its own ROM** keeps the schedule. Nothing here is uploaded and nothing is
 * shared: the program boots itself, programmes the chip's timer, and the only
 * thing the other processor does is send one byte.
 */

import { Sound } from "@demake/neogeo";
import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { arrangeScore, demakeSfx, encodeWav, parseMidi, type ChipScript } from "../src/index.js";
import { buildNeogeoGameAudio, SFX_BASE, STOP } from "../src/rom/neogeo-game.js";
import { bandFixture } from "./_fixtures.js";

/** A short arrangement for this console, at the rate a game's driver runs. */
function track(): ReturnType<typeof arrangeScore> {
  return arrangeScore(parseMidi(bandFixture()), { console: "neogeo", driverHz: 120 });
}

/** A quarter of a second of decaying triangle, which is a blip. */
function blipWav(): Uint8Array {
  const rate = 48000;
  const samples = new Float32Array(Math.floor(rate * 0.25));
  let phase = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const position = index / samples.length;
    phase += (2 * 3.141592653589793 * 880) / rate;
    const wrapped = phase % (2 * 3.141592653589793);
    const triangle =
      wrapped < 3.141592653589793 ? wrapped / 3.141592653589793 : 2 - wrapped / 3.141592653589793;
    samples[index] = (triangle * 2 - 1) * (1 - position) * (1 - position);
  }
  return encodeWav({ sampleRate: rate, channels: [samples] });
}

/** The effect, and which of the console's channels it asked for. */
async function effectFor(): Promise<{ script: ChipScript; channel: number }> {
  const result = await demakeSfx(blipWav(), { console: "neogeo", rateHz: 120 });
  const spec = getConsole("neogeo").audio!;
  const channel = spec.channels.findIndex((one) => one.id === result.placement.channelId);
  return { script: result.script, channel };
}

/** Boot a built program and run it for `ticks` driver ticks. */
function run(
  built: ReturnType<typeof buildNeogeoGameAudio>,
  ticks: number,
  command?: number,
): { groups: { reg: number; value: number }[][] } {
  const sound = new Sound(built.rom, built.samplesA, built.samplesB);
  const groups: { reg: number; value: number }[][] = [];
  let current: { reg: number; value: number }[] | undefined;
  const original = sound.out.bind(sound);
  sound.out = (port: number, value: number): void => {
    // Masked, because `out (c), a` puts `b` on A8-A15 and `b` is the run counter
    // — the same fact the Sega driver's write loop relies on, seen from the other
    // side. A harness that compared the whole word would see no writes at all.
    const at = port & 0xff;
    if (current && at >= 0x04 && at <= 0x07) current.push({ reg: at - 0x04, value });
    original(port, value);
  };

  // Send the request as soon as the driver has said it will listen, which is the
  // moment its boot reads the enable port. Waiting for its *first tick* instead
  // would put the request one tick late and make the first group the empty tick
  // that was already owed — which reads as a driver that plays nothing.
  for (let step = 0; step < 200_000 && !sound.nmiEnabled; step += 1) sound.run(3);
  if (command !== undefined) sound.send(command);

  // One group more than the caller asked for, and the extra is dropped: a group
  // is opened when the tick is *entered*, so stopping on the count would return a
  // last one whose writes had not happened yet.
  let previous = -1;
  for (let step = 0; step < 60_000_000 && groups.length <= ticks; step += 1) {
    sound.run(3);
    const pc = sound.cpu.pc;
    if (pc === built.symbols.tick && previous !== built.symbols.tick) {
      current = [];
      groups.push(current);
    } else if (pc === built.symbols.tickEnd && current) {
      current = undefined;
    }
    previous = pc;
  }
  return { groups: groups.slice(0, ticks) };
}

describe("the program a cartridge carries", () => {
  it("fits the fixed window and says what it cost", () => {
    const built = buildNeogeoGameAudio({ tracks: [track().script], effects: [] });
    expect(built.rom.length).toBe(0x8000);
    // Real numbers rather than the zeroes a builder reports before assembling —
    // the trap `BoundAudioShape` states and `demake build` fell into once.
    expect(built.stats.code).toBeGreaterThan(0);
    expect(built.stats.data).toBeGreaterThan(0);
    expect(built.stats.helpers.length).toBeGreaterThan(0);
  });

  it("rides timer A at the rate the schedule was fitted to", () => {
    const script = track().script;
    const built = buildNeogeoGameAudio({ tracks: [script], effects: [] });
    expect(built.clock.rate).toEqual(script.driver.rate);
    // Ten bits across two registers, and the reload is the schedule's own: a
    // driver that chose its own would play music written for one tick at another.
    expect(built.clock.divisor).toBe(script.driver.divisor);
    expect(1024 - built.clock.divisor!).toBeGreaterThan(0);
  });

  it("performs each tick's writes, in order, once asked for the track", () => {
    const result = track();
    const built = buildNeogeoGameAudio({ tracks: [result.script], effects: [] });
    const { groups } = run(built, 24, built.command.music(0));
    expect(groups.length).toBe(24);
    // Tick 0 of the *performed* schedule, which is the schedule with the chip's
    // initialisation taken off — the ROM does that once at boot.
    for (const [index, group] of groups.entries()) {
      const expected = built.performed.tracks[0]!.ticks[index]!.writes;
      expect(group.map((w) => [w.reg, w.value])).toEqual(expected.map((w) => [w.reg, w.value]));
    }
  });

  it("plays nothing until the 68000 asks", () => {
    const built = buildNeogeoGameAudio({ tracks: [track().script], effects: [] });
    const { groups } = run(built, 8);
    expect(groups.every((group) => group.length === 0)).toBe(true);
  });

  it("stops on the stop command rather than on a track number", () => {
    const built = buildNeogeoGameAudio({ tracks: [track().script], effects: [] });
    const sound = new Sound(built.rom, built.samplesA, built.samplesB);
    for (let step = 0; step < 200_000 && !sound.nmiEnabled; step += 1) sound.run(3);
    sound.send(built.command.music(0));
    for (let step = 0; step < 400_000; step += 1) sound.run(3);
    sound.send(STOP);
    // The stop writes the quiet table, of which the last entry is ADPCM-B's reset
    // — so the chip is left silent rather than holding whatever note was playing.
    const seen: number[] = [];
    const original = sound.out.bind(sound);
    sound.out = (port: number, value: number): void => {
      if ((port & 0xff) === 0x05) seen.push(value);
      original(port, value);
    };
    for (let step = 0; step < 200_000; step += 1) sound.run(3);
    expect(seen.length).toBeGreaterThan(0);
    expect(built.command.stop).toBe(STOP);
  });
});

describe("an effect beside the music", () => {
  it("takes a square, and the music keeps everything else", async () => {
    const effect = await effectFor();
    // `neogeoAudio` lists the squares first so this lands on one rather than on an
    // FM voice, which is what keeps the key-on byte off the preemption path.
    expect(effect.channel).toBeLessThan(3);

    const built = buildNeogeoGameAudio({
      tracks: [track().script],
      effects: [{ ...effect, priority: 0 }],
    });
    expect(built.command.sfx(0)).toBe(SFX_BASE);
    expect(built.stats.effects).toBe(1);
    // An effect's schedule opens by stating the whole chip, which is right for a
    // cartridge that owns it and wrong for one borrowing one channel. What was
    // dropped is counted rather than quietly discarded.
    expect(built.stats.writesRestricted).toBeGreaterThan(0);
  });

  it("performs the effect's own writes when it is asked for", async () => {
    const built = buildNeogeoGameAudio({
      tracks: [],
      effects: [{ ...(await effectFor()), priority: 0 }],
    });
    const { groups } = run(built, 12, built.command.sfx(0));
    for (const [index, group] of groups.entries()) {
      const expected = built.performed.effects[0]!.ticks[index]!.writes;
      expect(group.map((w) => [w.reg, w.value])).toEqual(expected.map((w) => [w.reg, w.value]));
    }
  });
});
