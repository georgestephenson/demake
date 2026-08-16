/**
 * The machine around the processor: the boot, the bus, the frame and the pads.
 *
 * Every case here is one a cartridge can fail while being perfectly assembled:
 *
 *   - The reset fetch comes from a *mirror*, so a program that jumped relatively
 *     out of its vector would land in the middle of itself.
 *   - The character mirror and the four blocks are the same bytes, so an upload
 *     through the wrong one of them writes into a framebuffer.
 *   - The video processor's interrupt lands in the cartridge and only when the
 *     program has both enabled it *and* cleared the `NP` bit reset leaves set —
 *     which is the one line of boot ceremony this processor insists on, and a
 *     cartridge without it waits for a frame that never arrives.
 */

import { describe, expect, it } from "vitest";

import {
  Asm810,
  packVbRom,
  SR_PSW,
  V810_R0,
  VB_CHR_MIRROR,
  VB_INTCLR,
  VB_INTENB,
  VB_INT_GAMESTART,
  VB_ROM,
  VB_SCR,
  VB_SCR_HW_READ,
  VB_SDLR,
  VB_VSU,
  VB_WRAM,
} from "@demake/core";

import {
  VSU_CHANNEL_BASE,
  VSU_MOD_BASE,
  VSU_REG,
  VSU_WAVE_BASE,
  VSU_WAVE_SAMPLES,
} from "@demake/chip";

import { CYCLES_PER_FRAME, FRAME_HZ, Vb } from "../src/machine.js";

/** A register the program can reach without building its address twice. */
const BASE = 10;
const VALUE = 11;

describe("the Virtual Boy", () => {
  it("boots through the reset stub at the top of the cartridge", () => {
    const asm = new Asm810(VB_ROM);
    asm.movImm32(VB_WRAM, BASE);
    asm.movImm32(0x0badf00d, VALUE);
    asm.stw(VALUE, 0, BASE);
    asm.label("Stop");
    asm.br("Stop");
    const machine = new Vb(packVbRom(asm.assemble(), { title: "BOOT" }));
    for (let index = 0; index < 32; index += 1) machine.step();
    expect([...machine.readMemory(VB_WRAM, 4)]).toEqual([0x0d, 0xf0, 0xad, 0x0b]);
  });

  it("refuses a cartridge that is not a power of two", () => {
    expect(() => new Vb(new Uint8Array(1000))).toThrow();
  });

  it("mirrors character memory into the four blocks the drawing processor reads", () => {
    const asm = new Asm810(VB_ROM);
    asm.movImm32(VB_CHR_MIRROR, BASE);
    asm.movImm32(0x1234, VALUE);
    asm.sth(VALUE, 0, BASE);
    // The second block, 8 KiB along the mirror and $8000 apart in the real map.
    asm.sth(VALUE, 0x2000, BASE);
    asm.label("Stop");
    asm.br("Stop");
    const machine = new Vb(packVbRom(asm.assemble()));
    for (let index = 0; index < 32; index += 1) machine.step();
    expect(machine.vip.vram[0x6000]).toBe(0x34);
    expect(machine.vip.vram[0x6001]).toBe(0x12);
    expect(machine.vip.vram[0xe000]).toBe(0x34);
    // ...and reading it back through the mirror agrees.
    expect(machine.vip.read(VB_CHR_MIRROR + 0x2000)).toBe(0x34);
  });

  it("delivers the video processor's interrupt into the cartridge", () => {
    const asm = new Asm810(VB_ROM);
    asm.ldsr(V810_R0, SR_PSW); // reset leaves NP set, which masks everything
    asm.movImm32(VB_INTENB, BASE);
    asm.movImm32(VB_INT_GAMESTART, VALUE);
    asm.sth(VALUE, 0, BASE);
    asm.movImm32(VB_WRAM, BASE);
    asm.movImm5(0, VALUE);
    asm.stw(VALUE, 0, BASE);
    asm.label("Stop");
    asm.br("Stop");

    asm.label("Handler");
    // Count the frame, acknowledge, and go back to whatever was interrupted.
    asm.movImm32(VB_WRAM, 12);
    asm.ldw(0, 12, 13);
    asm.addImm5(1, 13);
    asm.stw(13, 0, 12);
    asm.movImm32(VB_INTCLR, 12);
    asm.movImm32(VB_INT_GAMESTART, 13);
    asm.sth(13, 0, 12);
    asm.reti();

    const code = asm.assemble();
    const rom = packVbRom(code, { vipHandler: asm.addressOf("Handler") });
    const machine = new Vb(rom);
    for (let frame = 0; frame < 5; frame += 1) machine.runFrame();
    // The fifth frame's interrupt has been *raised* and not yet run — the
    // handler executes out of the next frame's cycle budget, which is what
    // happens on the hardware too.
    for (let index = 0; index < 16; index += 1) machine.step();
    expect(machine.readMemory(VB_WRAM, 1)[0]).toBe(5);
  });

  it("leaves the interrupt undelivered while the reset PSW still masks it", () => {
    // The same program without the one `ldsr` — a cartridge that skips it is
    // perfect and frozen, which is worth a case of its own.
    const asm = new Asm810(VB_ROM);
    asm.movImm32(VB_INTENB, BASE);
    asm.movImm32(VB_INT_GAMESTART, VALUE);
    asm.sth(VALUE, 0, BASE);
    asm.movImm32(VB_WRAM, BASE);
    asm.movImm5(0, VALUE);
    asm.stw(VALUE, 0, BASE);
    asm.label("Stop");
    asm.br("Stop");
    asm.label("Handler");
    asm.movImm32(VB_WRAM, 12);
    asm.movImm5(9, 13);
    asm.stw(13, 0, 12);
    asm.reti();
    const rom = packVbRom(asm.assemble(), { vipHandler: asm.addressOf("Handler") });
    const machine = new Vb(rom);
    for (let frame = 0; frame < 3; frame += 1) machine.runFrame();
    expect(machine.readMemory(VB_WRAM, 1)[0]).toBe(0);
  });

  it("latches the pads when the cartridge asks for a read", () => {
    const asm = new Asm810(VB_ROM);
    asm.movImm32(VB_SCR, BASE);
    asm.movImm5(VB_SCR_HW_READ, VALUE);
    asm.stb(VALUE, 0, BASE);
    asm.movImm32(VB_SDLR, BASE);
    asm.inb(0, BASE, 12);
    asm.movImm32(VB_WRAM, BASE);
    asm.stb(12, 0, BASE);
    asm.label("Stop");
    asm.br("Stop");
    const machine = new Vb(packVbRom(asm.assemble()));
    machine.setButtons(["a", "right"]);
    for (let index = 0; index < 32; index += 1) machine.step();
    // `A` is bit 2 and right-on-the-left-pad is bit 8, and bit 1 is the hardware
    // saying it is there — so the low byte carries A, the signature, and nothing
    // else.
    expect(machine.readMemory(VB_WRAM, 1)[0]).toBe(0x06);
  });

  it("runs at the slowest frame rate in the matrix", () => {
    // 50.2 Hz — a fifth slower than a Game Boy and a third slower than a
    // WonderSwan, which is exactly why a rule that adds a constant every tick
    // has to be written against `fps` (AGENTS.md §Working on Demotic).
    expect(FRAME_HZ).toBeLessThan(60);
    expect(CYCLES_PER_FRAME).toBe(Math.round(20_000_000 / FRAME_HZ));
  });
});

describe("the sound processor", () => {
  /** Program the first channel to play a table, and park. */
  function noteRom(): Uint8Array {
    const asm = new Asm810(VB_ROM);
    asm.movImm32(VB_VSU, BASE);
    // One waveform table: a square, six bits a sample, one sample every four
    // bytes. Anything constant would be silence whatever the chip did.
    for (let index = 0; index < VSU_WAVE_SAMPLES; index += 1) {
      asm.movImm32(index < VSU_WAVE_SAMPLES / 2 ? 0x3f : 0x00, VALUE);
      asm.stb(VALUE, VSU_WAVE_BASE + index * 4, BASE);
    }
    const channel = VSU_CHANNEL_BASE;
    const write = (offset: number, value: number): void => {
      asm.movImm32(value, VALUE);
      asm.stb(VALUE, channel + offset, BASE);
    };
    write(VSU_REG.RAM, 0); // table zero
    write(VSU_REG.FQL, 0x00); // a divider of $600: about 400 Hz
    write(VSU_REG.FQH, 0x06);
    write(VSU_REG.LRV, 0xff); // both ears, full
    write(VSU_REG.EV0, 0xf0); // full envelope, no decay
    write(VSU_REG.EV1, 0x00);
    write(VSU_REG.INT, 0x80); // and go
    asm.label("Stop");
    asm.br("Stop");
    return packVbRom(asm.assemble(), { title: "NOTE" });
  }

  it("is the chip model, and a cartridge's writes reach it", () => {
    // The whole of what makes doc 16's Level A possible on this console: the
    // tap observes rather than intercepts, and what it reports is the byte
    // offset from the chip's base, which is what a schedule's register number
    // is here.
    const machine = new Vb(noteRom());
    const seen: [number, number][] = [];
    machine.vsuTap = (reg, value) => seen.push([reg, value]);
    for (let index = 0; index < 400; index += 1) machine.step();
    expect(seen).toContainEqual([VSU_CHANNEL_BASE + VSU_REG.INT, 0x80]);
    expect(seen).toContainEqual([VSU_CHANNEL_BASE + VSU_REG.FQH, 0x06]);
    expect(seen.filter(([reg]) => reg < VSU_MOD_BASE)).toHaveLength(VSU_WAVE_SAMPLES);
  });

  it("makes a sound, rather than storing the bytes somewhere", () => {
    // The failure this replaces: a register page that accepted every write and
    // generated nothing, which no register diff could tell from a chip.
    const machine = new Vb(noteRom());
    // A sink of the test's own rather than the renderer's, because what is
    // being checked is that the chip *runs* — every clock accounted for, and
    // the levels it reports changing over a note.
    const left: number[] = [];
    const right: number[] = [];
    let clocks = 0;
    machine.audioSink = {
      clocksUntilSampleBoundary: () => 64,
      add(l, r, count) {
        left.push(l);
        right.push(r);
        clocks += count;
      },
    };
    for (let index = 0; index < 200_000; index += 1) machine.step();
    // The chip was handed a quarter of the master cycles the processor spent,
    // to within the remainder one step can carry.
    expect(clocks).toBeGreaterThan(1000);
    expect(left.some((value) => value !== left[0])).toBe(true);
    // Both ears, because `LRV` said both — and a chip that dropped one side
    // would still pass the line above.
    expect(right.some((value) => value !== right[0])).toBe(true);
  });

  it("answers nothing when read, because nothing on it reads back", () => {
    const machine = new Vb(noteRom());
    for (let index = 0; index < 400; index += 1) machine.step();
    // A shadow kept to read back would be a second model of the chip, and the
    // one thing worse than an absent peripheral is one that agrees with itself.
    expect(machine.read(VB_VSU + VSU_CHANNEL_BASE + VSU_REG.INT)).toBe(0);
  });
});
