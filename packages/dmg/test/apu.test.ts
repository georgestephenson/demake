/**
 * The APU's place in the machine, not the APU itself.
 *
 * `@demake/chip` owns the chip's behaviour and tests it there; what is checked
 * here is the wiring that makes it *the same chip* the audio pipeline renders
 * with (doc 16 §Packages) — that `$FF10`–`$FF3F` reaches it, that reads come
 * back from it rather than from a shadow copy of the register file, and that the
 * write tap the audio conformance oracle depends on sees every write without
 * changing what the hardware saw.
 */

import { describe, expect, it } from "vitest";

import { GB_ROM_SIZE, stampGbHeader } from "@demake/core";

import { Gameboy } from "../src/machine.js";

/** A cartridge whose code is `bytes`, starting at the entry point. */
function cartridge(bytes: number[]): Uint8Array {
  const rom = new Uint8Array(GB_ROM_SIZE);
  rom[0x0100] = 0x00;
  rom[0x0101] = 0xc3; // jp $0150
  rom[0x0102] = 0x50;
  rom[0x0103] = 0x01;
  rom.set(bytes, 0x0150);
  stampGbHeader(rom, "APU");
  return rom;
}

/** Run `count` instructions from a cold boot. */
function boot(rom: Uint8Array, count: number): Gameboy {
  const machine = new Gameboy(rom);
  for (let step = 0; step < count; step += 1) machine.stepInstruction();
  return machine;
}

describe("sound registers", () => {
  it("routes writes to the chip model and reports them to the tap", () => {
    // ld a,$80 / ldh [$26],a   — NR52: power the APU on
    // ld a,$AB / ldh [$30],a   — wave RAM byte 0
    const machine = new Gameboy(
      cartridge([0x3e, 0x80, 0xe0, 0x26, 0x3e, 0xab, 0xe0, 0x30, 0x18, 0xfe]),
    );
    const seen: { reg: number; value: number }[] = [];
    machine.apuTap = (reg, value) => seen.push({ reg, value });
    for (let step = 0; step < 8; step += 1) machine.stepInstruction();

    expect(seen).toEqual([
      { reg: 0x26, value: 0x80 },
      { reg: 0x30, value: 0xab },
    ]);
    // The tap observes; it does not intercept. The chip really took the write.
    expect(machine.apu.read(0x30)).toBe(0xab);
    expect(machine.apu.read(0x26) & 0x80).toBe(0x80);
  });

  it("reads wave RAM back through the chip, not through a register shadow", () => {
    const machine = boot(
      // ld a,$80 / ldh [$26],a / ld a,$5C / ldh [$3F],a / ldh a,[$3F] / ld b,a
      cartridge([0x3e, 0x80, 0xe0, 0x26, 0x3e, 0x5c, 0xe0, 0x3f, 0xf0, 0x3f, 0x47, 0x18, 0xfe]),
      7,
    );
    expect(machine.read(0xff3f)).toBe(0x5c);
  });

  it("costs nothing to run when nothing is listening", () => {
    // With no sink attached the chip still takes every write and keeps its
    // state; it is only *rendered* on demand, which is what lets the game
    // conformance suite ignore hardware it never listens to.
    const machine = boot(cartridge([0x3e, 0x80, 0xe0, 0x26, 0x18, 0xfe]), 4);
    expect(machine.audioSink).toBeUndefined();
    expect(machine.apu.read(0x26) & 0x80).toBe(0x80);
  });
});
