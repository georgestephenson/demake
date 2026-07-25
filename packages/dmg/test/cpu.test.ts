/**
 * A floor under the processor.
 *
 * The Demotic conformance suite is the real exercise — a runtime that reproduces
 * three hundred ticks of fixed-point state has driven most of the instruction
 * set through its paces. What that cannot do is *localise* a fault: a wrong
 * `sbc` and a wrong rule engine look identical from a diverging trace. So the
 * cases here are the ones whose absence would send someone hunting in the wrong
 * file, and the first of them is the one that actually bit: `jr`'s operand is
 * fetched before the base is read, and reading them the other way round moves
 * every relative jump one byte.
 */

import { describe, expect, it } from "vitest";

import { Gameboy } from "../src/machine.js";

/** Assemble a tiny cartridge that runs `code` from $0150 and then halts. */
function cartridge(code: readonly number[]): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom[0x100] = 0x00;
  rom[0x101] = 0xc3; // jp $0150
  rom[0x102] = 0x50;
  rom[0x103] = 0x01;
  rom.set(code, 0x150);
  rom[0x150 + code.length] = 0x76; // halt
  return rom;
}

/** Run until the processor halts, then read work RAM. */
function runTo(code: readonly number[], address = 0xc000, length = 4): Uint8Array {
  const machine = new Gameboy(cartridge(code));
  for (let step = 0; step < 200_000 && !machine.cpu.halted; step += 1) machine.stepInstruction();
  expect(machine.cpu.halted).toBe(true);
  return machine.readMemory(address, length);
}

describe("SM83", () => {
  it("takes jr relative to the instruction after the operand", () => {
    // jr +2 must skip exactly the two bytes that follow it. Off by one and it
    // lands mid-instruction, which is how a runtime turns into an infinite loop.
    const code = [
      0x18,
      0x02, // jr .skip
      0x3e,
      0x11, // ld a, $11   (skipped)
      0x3e,
      0x22, // ld a, $22
      0xea,
      0x00,
      0xc0, // ld [$C000], a
    ];
    expect(runTo(code)[0]).toBe(0x22);
  });

  it("propagates borrow through a multi-byte subtraction", () => {
    // $0100 - $0001 across two bytes: the low byte borrows into the high one.
    const code = [
      0x3e,
      0x00, // ld a, $00
      0xd6,
      0x01, // sub $01      -> $FF, carry set
      0xea,
      0x00,
      0xc0,
      0x3e,
      0x01, // ld a, $01
      0xde,
      0x00, // sbc a, $00   -> $00
      0xea,
      0x01,
      0xc0,
    ];
    const memory = runTo(code);
    expect([memory[0], memory[1]]).toEqual([0xff, 0x00]);
  });

  it("rotates through carry across a shift chain", () => {
    // sla then rl is how every multi-byte shift in the runtime is built.
    const code = [
      0x3e,
      0x80, // ld a, $80
      0xcb,
      0x27, // sla a        -> $00, carry set
      0xea,
      0x00,
      0xc0,
      0x06,
      0x00, // ld b, $00
      0xcb,
      0x10, // rl b         -> $01
      0x78, // ld a, b
      0xea,
      0x01,
      0xc0,
    ];
    const memory = runTo(code);
    expect([memory[0], memory[1]]).toEqual([0x00, 0x01]);
  });

  it("keeps sra's sign bit and drops srl's", () => {
    const code = [
      0x3e,
      0x80, // ld a, $80
      0xcb,
      0x2f, // sra a -> $C0
      0xea,
      0x00,
      0xc0,
      0x3e,
      0x80,
      0xcb,
      0x3f, // srl a -> $40
      0xea,
      0x01,
      0xc0,
    ];
    const memory = runTo(code);
    expect([memory[0], memory[1]]).toEqual([0xc0, 0x40]);
  });

  it("reads the joypad as active-low, per the selected line", () => {
    const machine = new Gameboy(cartridge([0x00]));
    machine.setButtons(["a", "left"]);
    machine.write(0xff00, 0x20); // select the direction pad
    expect(machine.read(0xff00) & 0x0f).toBe(0x0d); // left is bit 1, held = 0
    machine.write(0xff00, 0x10); // select the face buttons
    expect(machine.read(0xff00) & 0x0f).toBe(0x0e); // a is bit 0
  });

  it("runs a frame and reaches VBlank", () => {
    const machine = new Gameboy(cartridge([0x00]));
    machine.runFrame();
    expect(machine.frames).toBe(1);
    expect(machine.framebuffer.length).toBe(160 * 144 * 4);
  });
});
