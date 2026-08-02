/**
 * A Game Boy Advance game's sound: an ARM player that also has to *compute* half
 * of what it plays.
 *
 * Two halves and two proofs, because this console's two sound devices are not the
 * same kind of thing. Four voices are a Game Boy's APU and reach it as stores, so
 * the shared battery diffs them tick for tick exactly as it does on five other
 * machines. The other six are a **software mixer** whose register file is in work
 * RAM, so nothing about them crosses a bus at all — what the driver owes there is
 * the *samples*, byte for byte, against what `@demake/chip`'s `GbaPcm` renders
 * from the same schedule (doc 16 §The proof, for a mixer console). That is the
 * second test below, and it is a sharper claim than a register diff: the
 * comparison is against the audio rather than against an instruction to make it.
 *
 * **The size sweep is not run here**, and the omission is stated rather than left
 * to be found. It exists to catch a cartridge that no longer fits; this console's
 * is thirty-two megabytes against a game's twenty-odd kilobytes, so there is no
 * budget for it to decide — and a build with art on this machine is the whole
 * `prep` tournament against a *256-colour* palette, which is minutes rather than
 * seconds (AGENTS.md §Testing truths). What the sweep would still have bought is
 * the assertion that the driver's reported sizes are real rather than the zero
 * they hold before `assemble`, and that is made below on a build with no art in
 * it, which costs a second.
 */

import { describe, expect, it } from "vitest";

import { bindingFor, gbaSampleBank, GBA_BLOCK_SAMPLES, type ChipScript } from "@demake/audio";
import { GbaPcm } from "@demake/chip";
import { Gba, ROM_BASE } from "@demake/gba";

import { romReady } from "../src/rom/trace.js";

import { audioBattery, build, MUSIC_ONLY, target } from "./_audio-battery.js";

const gba = target("gba");

audioBattery(gba);

/**
 * A track that actually drives the mixer, which not every track does.
 *
 * The arranger gives each part the channel that serves it best, so a four-part
 * MIDI on a ten-voice machine uses four voices — and on this console the four it
 * picks are usually the Game Boy's, which have envelopes and duties the mixer's
 * do not. `updraft.mid` is the one in the library whose parts fit the sample
 * voices better, and it puts most of its writes there. That is the arranger
 * making a choice rather than a gap: a schedule with nothing on the mixer is a
 * schedule this half of the driver correctly plays silence for, and proving the
 * mixer against *that* would be comparing silence with silence.
 */
const MIXER_MUSIC = `
start play
scene play
create number score in play (value 0, x 1, y 1)
music updraft.mid in play
`;

describe("a Game Boy Advance game's sample voices", () => {
  it("delivers exactly the samples the mixer model renders", async () => {
    const { built, bound } = await build(gba, MIXER_MUSIC, "runner");
    const script = bound.driver?.performed.tracks[0] as ChipScript;
    const tick = built.symbols.get("AudioTick") as number;
    expect(tick).toBeDefined();

    // What the converters actually received, in order. `fifoTap` observes the
    // bytes crossing into the queue and adds nothing to the cartridge to make
    // them observable, which is the same discipline the register tap runs under.
    const machine = new Gba(built.bytes);
    // Both sides, because they are two transfers rather than one signal split —
    // and because the only way the driver could get them out of step is by
    // re-pointing one at a block boundary the other has not reached, which is
    // exactly what a one-sided test would miss.
    const heard: [number[], number[]] = [[], []];
    machine.fifoTap = (channel, byte) => {
      (heard[channel] as number[]).push(byte);
    };
    // Long enough to cover the model below with the driver's own lead in front of
    // it: the ring is six blocks, so the first real block is played five blocks
    // after the transfer starts.
    for (let frame = 0; frame < 150; frame += 1) machine.runFrame();

    // And what the model says they should be. The boot writes are performed once
    // by the ROM rather than at the head of the stream, so they go in first —
    // `performed` is the schedule with them taken off (doc 16 §The proof).
    const model = new GbaPcm({ bank: gbaSampleBank() });
    for (const write of bindingFor("gba").init()) {
      if ((write.chip ?? 0) === 1) model.write(write.reg, write.value);
    }
    const want: [number[], number[]] = [[], []];
    const blocks = 200;
    for (let index = 0; index < blocks; index += 1) {
      for (const write of script.ticks[index]?.writes ?? []) {
        if ((write.chip ?? 0) === 1) model.write(write.reg, write.value);
      }
      // The converter takes a signed byte and the queue reports what crossed it,
      // which is the same byte read unsigned.
      for (let sample = 0; sample < GBA_BLOCK_SAMPLES; sample += 1) {
        const { left, right } = model.mix();
        want[0].push(left & 0xff);
        want[1].push(right & 0xff);
      }
    }

    // Where the driver's own first block landed. A whole number of blocks in by
    // construction — a transfer is re-pointed on a block boundary and nowhere
    // else — so finding it is a search over blocks rather than over samples, and
    // that it *is* one is part of what this asserts. The same offset has to serve
    // both sides, which is the other half of it.
    const left = heard[0];
    let offset = -1;
    for (
      let block = 0;
      (block + 1) * GBA_BLOCK_SAMPLES <= left.length - want[0].length;
      block += 1
    ) {
      const at = block * GBA_BLOCK_SAMPLES;
      if (left.slice(at, at + GBA_BLOCK_SAMPLES * 4).every((value, i) => value === want[0][i])) {
        offset = at;
        break;
      }
    }
    expect(offset, "the mixer's output never reached the converters").toBeGreaterThanOrEqual(0);
    for (const side of [0, 1] as const) {
      const got = heard[side];
      const expected = want[side];
      for (let index = 0; index < expected.length; index += 1) {
        expect(got[offset + index], `${side === 0 ? "left" : "right"} sample ${index}`).toBe(
          expected[index],
        );
      }
    }
  }, 300_000);

  it("plays something rather than a block of silence", async () => {
    // The diff above would pass on a cartridge that mixed silence and a model that
    // rendered silence, which is exactly the failure a schedule for six voices is
    // most likely to have. So: the samples are not all the same byte.
    const { built } = await build(gba, MIXER_MUSIC, "runner");
    const machine = new Gba(built.bytes);
    const left: number[] = [];
    machine.fifoTap = (channel, byte) => {
      if (channel === 0) left.push(byte);
    };
    for (let frame = 0; frame < 150; frame += 1) machine.runFrame();
    expect(new Set(left).size, "the mixer produced one value forever").toBeGreaterThan(8);
  }, 300_000);

  it("reports the driver's real size, not the zero it held before assembly", async () => {
    // What `audioSweep` asserts everywhere else, on the one console that does not
    // run it (see the file header). A driver is emitted lazily — `@demake/audio`
    // hands back closures and only learns their sizes once the assembler has run
    // them — so a backend that copied the numbers out at bind time reports zero
    // (`backend.ts` §BoundAudioShape).
    const { built } = await build(gba, MUSIC_ONLY);
    const audio = built.stats.audio;
    expect(audio?.code ?? 0).toBeGreaterThan(512);
    expect(audio?.data ?? 0).toBeGreaterThan(1024);
    expect(audio?.rateHz).toBe(128);
    // The mixer and its clock are always pulled, because they are the console's
    // sound hardware rather than a feature a schedule asks for; the key-off path
    // is not, because a level of zero already says what it says.
    expect(audio?.helpers ?? []).toContain("mixer");
    expect(audio?.helpers ?? []).toContain("transfer-clock");
    expect(audio?.helpers ?? []).not.toContain("mixer-key-off");
  }, 300_000);

  it("still fits a game tick inside a frame with the mixer running", async () => {
    // The one thing a software mixer could plausibly break, and the one console
    // whose `rom.test.ts` speed case cannot see it — that suite builds with the
    // assets left out, so it measures a cartridge with no driver in it. Six
    // voices over a block of 256 samples, a hundred and twenty-eight times a
    // second, is a real share of this processor, and doc 14 publishes the figure
    // rather than hiding it behind a speed multiplier.
    const { built } = await build(gba, MIXER_MUSIC, "runner");
    const machine = new Gba(built.bytes);
    const layout = built.layout;
    const read = (address: number, length: number): Uint8Array =>
      machine.readMemory(address, length);
    // Past the title screen, then settle: the figure has to be the cost of a
    // running tick rather than of a still picture.
    for (let frame = 0; frame < 20; frame += 1) machine.runFrame();
    machine.setButtons(["a"]);
    for (let frame = 0; frame < 10; frame += 1) machine.runFrame();
    machine.setButtons([]);
    for (let frame = 0; frame < 120; frame += 1) machine.runFrame();
    machine.setButtons(["right", "a"]);

    let ticks = 0;
    let last = romReady(layout, read);
    const frames = 300;
    for (let frame = 0; frame < frames; frame += 1) {
      machine.runFrame();
      const now = romReady(layout, read);
      if (now !== last) {
        last = now;
        ticks += 1;
      }
    }
    expect(ticks).toBeGreaterThan(0);
    expect(frames / ticks).toBeLessThan(1.2);
  }, 300_000);

  it("boots from the cartridge, which is where a real tick arrives from", () => {
    // The one number `_audio-battery.ts`'s step filter rests on, pinned here so a
    // change to the memory map is a failing test rather than a phantom tick.
    expect(ROM_BASE).toBe(0x08000000);
  });
});
