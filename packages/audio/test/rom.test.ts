/**
 * The proof: a ROM built from a schedule writes that schedule (doc 16 §The proof).
 *
 * This is the audio counterpart of the image path's pixel-perfect emulator E2E,
 * and of `packages/demotic/test/rom.test.ts` for games — the same relationship,
 * one domain over. Where the image path compares a core's framebuffer against
 * `DAC(compliantImage)`, this compares the register stream an emulated APU
 * actually receives against the `ChipScript` itself. There is no tolerance and
 * no metric in it, because there does not need to be: the artifact *is* a timed
 * register-write schedule, so equality is the whole claim.
 *
 * Both demakers are here. A track and a sound effect stress different halves of
 * the driver — one loops and is thousands of ticks long, the other is a one-shot
 * that has to end in silence rather than repeat — and a suite that ran only the
 * first would pass with the stop path broken.
 */

import { describe, expect, it } from "vitest";

import {
  GB_HEADER_OFFSETS,
  GB_ROM_SIZE,
  NES_CHR_SIZE,
  NES_HEADER_SIZE,
  NES_PRG_SIZES,
  PCE_BANK_SIZE,
  PCE_ROM_SIZES,
} from "@demake/core";

import { arrangeScore } from "../src/arrange/index.js";
import { bindingFor } from "../src/binding/registry.js";
import type { ChipScript } from "../src/chipscript.js";
import { parseMidi } from "../src/score/midi.js";
import { demakeSfx } from "../src/sfx/index.js";
import { encodeWav } from "../src/encode/wav.js";
import { audioRomConsoles, buildAudioRom, packScript } from "../src/rom/index.js";
import { bandFixture, scaleFixture } from "./_fixtures.js";
import {
  AudioRomRunner,
  captureAgainstRom,
  captureRomWrites,
  firstDivergence,
} from "./_rom-harness.js";

/**
 * Ticks each case is proven over.
 *
 * Long enough to cross many block boundaries and every kind of opcode, short
 * enough that the whole suite stays inside `pnpm test`'s budget. The loop test
 * below is what covers the rest of the timeline, since a driver that is right
 * for six hundred ticks and wrong at tick 4000 would have to be wrong about the
 * order walk — which is exactly what looping exercises.
 */
const TICKS = 600;

/** A short decaying blip, as a WAV — the sound demaker's input. */
function blipWav(): Uint8Array {
  const rate = 48000;
  const samples = new Float32Array(Math.floor(rate * 0.25));
  let phase = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const position = i / samples.length;
    phase += (2 * 3.141592653589793 * 880) / rate;
    // A plain triangle from the phase, so no transcendental is needed here.
    const wrapped = phase % (2 * 3.141592653589793);
    const triangle =
      wrapped < 3.141592653589793 ? wrapped / 3.141592653589793 : 2 - wrapped / 3.141592653589793;
    samples[i] = (triangle * 2 - 1) * (1 - position) * (1 - position);
  }
  return encodeWav({ sampleRate: rate, channels: [samples] });
}

function trackFor(consoleId: string): ChipScript {
  return arrangeScore(parseMidi(bandFixture()), { console: consoleId }).script;
}

describe("gb audio cartridge", () => {
  it("is a valid 32 KiB cartridge with correct checksums", () => {
    const { bytes } = buildAudioRom(trackFor("dmg"), { title: "BAND" });
    expect(bytes.length).toBe(GB_ROM_SIZE);
    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1) {
      header = (header - (bytes[at] as number) - 1) & 0xff;
    }
    expect(bytes[GB_HEADER_OFFSETS.headerChecksum]).toBe(header);
    expect(bytes[GB_HEADER_OFFSETS.cartridgeType]).toBe(0x00);
    expect(String.fromCharCode(...bytes.subarray(0x134, 0x138))).toBe("BAND");
    // The entry point is `nop; jp Start`, and the boot logo area stays zero
    // because we ship no copyrighted data.
    expect(bytes[0x0100]).toBe(0x00);
    expect(bytes[0x0101]).toBe(0xc3);
    expect(bytes.subarray(0x0104, 0x0134).every((byte) => byte === 0)).toBe(true);
  });

  it("refuses a console it has no driver for, rather than shipping silence", () => {
    // A Master System has a driver *inside a game* and none of its own, which is
    // the distinction this refusal exists to keep: `demake build -c sms` puts
    // music in a cartridge and `demake gen --format rom` cannot, and a builder
    // that fell back to silence would make the two look the same.
    const script = arrangeScore(parseMidi(bandFixture()), { console: "sms" }).script;
    expect(() => buildAudioRom(script)).toThrow(/no standalone audio driver backend/);
  });

  it("names the consoles it can build for", () => {
    expect(audioRomConsoles()).toEqual(expect.arrayContaining(["dmg", "gbc", "nes"]));
  });
});

describe("nes audio cartridge", () => {
  const built = () => buildAudioRom(trackFor("nes"));

  it("is an NROM cartridge on the smallest board that holds the track", () => {
    const { bytes, stats, family, suffix } = built();
    expect(family).toBe("nes");
    expect(suffix).toBe(".nes");
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe("NES");
    expect(bytes[3]).toBe(0x1a);
    // Mapper zero, and the program on one of the two boards NROM shipped as.
    expect(bytes[7]! & 0xf0).toBe(0);
    expect(bytes[6]! & 0xf0).toBe(0);
    const prg = (bytes[4] as number) * 0x4000;
    expect(NES_PRG_SIZES).toContain(prg);
    expect(bytes.length).toBe(NES_HEADER_SIZE + prg + NES_CHR_SIZE);
    expect(stats.free).toBeGreaterThanOrEqual(0);
  });

  it("boots from a vector rather than an entry point", () => {
    // There is no fixed entry address on this CPU, so the last six bytes of the
    // image are what makes the cartridge run at all — and a builder that left
    // them zero would produce something that jumps into the padding.
    const { bytes, symbols } = built();
    const prg = (bytes[4] as number) * 0x4000;
    const at = NES_HEADER_SIZE + prg - 6;
    const read = (index: number) =>
      (bytes[at + index * 2] as number) | ((bytes[at + index * 2 + 1] as number) << 8);
    expect(read(0)).toBe(symbols.get("Nmi"));
    expect(read(1)).toBe(symbols.get("Reset"));
    expect(read(2)).toBe(symbols.get("Irq"));
    // Every vector inside the window the board is mapped at, which is what says
    // the small board's program was assembled at the origin its mirror needs.
    for (const index of [0, 1, 2]) expect(read(index)).toBeGreaterThanOrEqual(0x8000);
  });

  it("refuses a schedule whose clock is not the frame", () => {
    // This CPU has no timer a driver can have without burning the DMC channel,
    // so a schedule fitted to anything else is a bug in the timing fit and is
    // named rather than rounded to something playable.
    const script = trackFor("nes");
    const timed = { ...script, driver: { ...script.driver, source: "timer" as const } };
    expect(() => buildAudioRom(timed)).toThrow(/has no 'timer' clock/);
  });
});

describe("pce audio cartridge", () => {
  const built = () => buildAudioRom(trackFor("pce"));

  it("is a HuCard whose boot bank is the one reset maps", () => {
    const { bytes, family, suffix } = built();
    expect(family).toBe("pce");
    expect(suffix).toBe(".pce");
    expect(PCE_ROM_SIZES).toContain(bytes.length);
    // Reset takes its address from the last two bytes of bank 0, and the boot
    // stub is assembled at `$E000` — so a build that wrote the window's halves
    // in the obvious order would point this into the packed schedule.
    const reset =
      (bytes[PCE_BANK_SIZE - 2] as number) | ((bytes[PCE_BANK_SIZE - 1] as number) << 8);
    expect(reset).toBe(0xe000 + 0); // the first instruction of the boot stub
  });

  it("uploads the waveforms before the clock starts", () => {
    // The failure this exists to catch is a cartridge that is perfect in a
    // register diff and silent on the machine: this chip's wave RAM is only
    // reachable through the register port, so a build that skipped the boot
    // table would play every note through an empty wavetable.
    const script = trackFor("pce");
    const boot = new AudioRomRunner(script).captureBoot();
    expect(boot).toEqual(
      bindingFor("pce")
        .init()
        .map((write) => ({ reg: write.reg, value: write.value })),
    );
    // And the schedule the ROM promises is the one with those writes taken off.
    expect(script.ticks[0]!.writes.length).toBeGreaterThan(boot.length);
  });

  it("refuses a schedule whose clock is not the timer", () => {
    const script = trackFor("pce");
    const framed = { ...script, driver: { ...script.driver, source: "vblank" as const } };
    expect(() => buildAudioRom(framed)).toThrow(/has no 'vblank' clock/);
  });
});

describe("Level A — the ROM writes exactly the schedule", async () => {
  it.each(audioRomConsoles())("plays an arranged track tick for tick on %s", (consoleId) => {
    const script = trackFor(consoleId);
    const wanted = Math.min(TICKS, script.ticks.length);
    // Against what the ROM *promises* rather than what it was handed, which is
    // the same distinction every game driver's `performed` makes: a console that
    // uploads its waveforms at boot has a shorter tick 0 than the demaker gave
    // it, and the writes are not missing — they happened before the clock did.
    const { expected, actual } = captureAgainstRom(script, wanted);
    expect(firstDivergence(expected, actual)).toBeNull();
  });

  it("plays a monophonic track tick for tick", () => {
    const script = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" }).script;
    const wanted = Math.min(TICKS, script.ticks.length);
    expect(
      firstDivergence(script.ticks.slice(0, wanted), captureRomWrites(script, wanted)),
    ).toBeNull();
  });

  it.each(audioRomConsoles())(
    "plays a demade sound effect tick for tick on %s, and then stops",
    async (consoleId) => {
      // The other half of the driver, and worth having per console rather than
      // once: a one-shot has to end in silence rather than repeat, and where a
      // stream *ends* is the order walk's business — which is the processor's,
      // so two consoles sharing a player still have their own boot and clock in
      // front of it. A suite that ran only tracks would pass with the stop path
      // broken on any of them.
      const script = (await demakeSfx(blipWav(), { console: consoleId })).script;
      expect(script.loopTick).toBe(-1);
      const runner = new AudioRomRunner(script);
      const captured = runner.capture(runner.performed.ticks.length + 20);
      const total = runner.performed.ticks.length;
      expect(firstDivergence(runner.performed.ticks, captured.slice(0, total))).toBeNull();
      expect(captured.slice(total + 1).flatMap((tick) => tick.writes)).toEqual([]);
    },
  );

  it("returns to the loop point instead of running off the end", () => {
    const script = arrangeScore(parseMidi(scaleFixture()), { console: "dmg" }).script;
    const total = script.ticks.length;
    // Two ticks past the end is enough: the order list runs out exactly there,
    // and where it resumes is the only thing looping can get wrong.
    const captured = captureRomWrites(script, total + 3);
    const after = captured.slice(total);
    const expected = script.ticks.slice(script.loopTick, script.loopTick + after.length);
    expect(firstDivergence(expected, after)).toBeNull();
  });

  it("a one-shot ends in silence and stays there", async () => {
    const script = (await demakeSfx(blipWav(), { console: "dmg" })).script;
    const total = script.ticks.length;
    const captured = captureRomWrites(script, total + 40);
    // The stop block powers every DAC down once, then rests forever. Whatever
    // it writes, nothing may sound again — a note-on after the effect ended
    // would be the failure this exists to catch.
    const trailing = captured.slice(total + 1).flatMap((tick) => tick.writes);
    expect(trailing).toEqual([]);
    const silence = captured[total]!.writes;
    expect(silence.length).toBeGreaterThan(0);
    for (const write of silence) expect(write.value & 0xf8).toBe(0);
  });
});

describe("the packed schedule", () => {
  it("deduplicates repeated blocks and stays inside the cartridge", () => {
    const script = trackFor("dmg");
    const data = packScript(script);
    expect(data.blocks.length).toBeLessThanOrEqual(data.order.length);
    expect(data.ticks).toBe(script.ticks.length);
    const built = buildAudioRom(script);
    expect(built.stats.code + built.stats.data).toBeLessThanOrEqual(GB_ROM_SIZE);
    expect(built.stats.free).toBeGreaterThan(0);
    // Silence is where the format earns its keep: a bar of nothing is two bytes.
    expect(built.stats.data).toBeLessThan(script.budgets.writes * 2 + script.ticks.length);
  });

  it("emits no rest handling for a schedule that never rests", () => {
    const dense: ChipScript = {
      ...trackFor("dmg"),
      ticks: Array.from({ length: 8 }, () => ({ writes: [{ reg: 0x12, value: 0xf0 }] })),
      loopTick: 0,
    };
    const built = buildAudioRom(dense);
    expect(built.stats.helpers).not.toContain("rests");
    expect(built.symbols.has("TickRest")).toBe(false);
    // And it still plays: the pull is an optimisation, not a behaviour change.
    expect(firstDivergence(dense.ticks, captureRomWrites(dense, dense.ticks.length))).toBeNull();
  });

  it("runs the driver on the timer the schedule asked for", () => {
    const script = trackFor("dmg");
    const built = buildAudioRom(script);
    expect(built.stats.ratePpmError).toBe(0);
    expect(built.stats.helpers).toContain(
      script.driver.source === "timer" ? "timer-clock" : "vblank-clock",
    );
  });

  it("keeps ticking after the driver has been running for a while", () => {
    // A regression net for the one thing a short capture cannot see: state that
    // drifts. The runner asserts progress itself by refusing to stop early.
    const script = trackFor("dmg");
    const runner = new AudioRomRunner(script);
    const captured = runner.capture(Math.min(script.ticks.length, 1200));
    expect(captured.length).toBe(Math.min(script.ticks.length, 1200));
  });
});
