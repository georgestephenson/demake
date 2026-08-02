/**
 * What this core refuses, which is most of what it is.
 *
 * The Nintendo DS is a large machine and a demade game drives a small part of
 * it: one 2D engine, two video RAM banks, one screen, no interrupts, one
 * processor. Everything else is *absent* rather than half-implemented — the
 * stance `@demake/snes` takes on the background layers it omits and `@demake/gba`
 * takes on Thumb — and the whole value of that stance is that reaching for the
 * missing hardware fails loudly. A core that quietly accepted a bank pointed
 * somewhere else, or a byte write to video memory, would let a cartridge work
 * here and do nothing on the console.
 *
 * The other thing pinned here is the **loader**, because on this console it is
 * not a formality: a cartridge is not in the address space at all, so which
 * bytes reach which processor is decided entirely by header fields, and getting
 * that wrong runs the wrong program.
 */

import { describe, expect, it } from "vitest";

import { armAt, armImm, AsmArm, NDS_ARM7_RAM, NDS_ARM9_RAM, packNdsRom } from "@demake/core";

import { MAIN_RAM_SIZE, Nds, NdsError } from "../src/index.js";

/** A cartridge whose ARM9 program is `body`, assembled at the load address. */
function cartridge(body: (asm: AsmArm) => void): Uint8Array {
  const arm9 = new AsmArm(NDS_ARM9_RAM);
  arm9.label("Start");
  body(arm9);
  arm9.label("Park");
  arm9.b("Park");
  arm9.ltorg();
  const arm7 = new AsmArm(NDS_ARM7_RAM);
  arm7.label("Park7");
  arm7.b("Park7");
  return packNdsRom(arm9.assemble(), arm7.assemble());
}

/** Run a cartridge for a while, or report what it raised. */
function run(rom: Uint8Array, steps = 200): Nds | Error {
  const machine = new Nds(rom);
  try {
    for (let step = 0; step < steps; step += 1) machine.stepInstruction();
    return machine;
  } catch (error) {
    return error as Error;
  }
}

/** Store `value` to `address`, as a halfword. */
function poke(asm: AsmArm, address: number, value: number): void {
  asm.movImm32(0, value);
  asm.movImm32(1, address);
  asm.strh(0, armAt(1, 0));
}

describe("loading a cartridge", () => {
  it("copies both programs into main RAM, because neither is on a bus", () => {
    const rom = cartridge((asm) => asm.mov(0, armImm(1)));
    const machine = new Nds(rom);
    // The ARM9's first instruction is at its load address, and the ARM7's binary
    // is where the header says — 3.5 MiB along, in the same 4 MiB.
    expect(machine.readMemory(NDS_ARM9_RAM, 4)).toEqual(rom.subarray(0x4000, 0x4004));
    expect(machine.readMemory(NDS_ARM7_RAM, 4)[0]).not.toBe(0);
    expect(machine.cpu.pc).toBe(NDS_ARM9_RAM);
  });

  it("refuses a binary that would land outside main RAM", () => {
    const rom = cartridge((asm) => asm.mov(0, armImm(0)));
    const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    view.setUint32(0x028, NDS_ARM9_RAM + MAIN_RAM_SIZE, true); // ARM9 load address
    expect(() => new Nds(rom)).toThrow(NdsError);
  });

  it("refuses an entry point direct boot does not reach", () => {
    const rom = cartridge((asm) => asm.mov(0, armImm(0)));
    const view = new DataView(rom.buffer, rom.byteOffset, rom.byteLength);
    view.setUint32(0x024, NDS_ARM9_RAM + 0x40, true); // ARM9 entry
    expect(() => new Nds(rom)).toThrow(NdsError);
  });
});

describe("the video RAM banks", () => {
  it("answers nothing at all until a bank is pointed somewhere", () => {
    // The hardware's own answer, and the reason a build maps a bank before it
    // uploads anything: a write into an unmapped window is swallowed, so a
    // cartridge that forgot would upload a whole picture into nowhere.
    const machine = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x1234);
        asm.movImm32(1, 0x06000000);
        asm.strh(0, armAt(1, 0));
      }),
    );
    expect(machine).toBeInstanceOf(Nds);
    if (!(machine instanceof Nds)) return;
    expect(machine.readMemory(0x06000000, 2)).toEqual(new Uint8Array([0, 0]));
    expect(machine.bankA[0]).toBe(0);
  });

  it("takes the two arrangements a build programs, and stores through them", () => {
    const machine = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x81);
        asm.movImm32(1, 0x04000240);
        asm.strb(0, armAt(1, 0));
        asm.movImm32(0, 0x82);
        asm.strb(0, armAt(1, 1));
        poke(asm, 0x06000000, 0x1234);
        poke(asm, 0x06400000, 0x5678);
      }),
    );
    expect(machine).toBeInstanceOf(Nds);
    if (!(machine instanceof Nds)) return;
    // Two banks, and the two windows really do reach different memory — which is
    // the one thing about this engine's memory that is not the Game Boy
    // Advance's, where the objects are the top of the same array.
    expect(machine.bankA[0]).toBe(0x34);
    expect(machine.bankA[1]).toBe(0x12);
    expect(machine.bankB[0]).toBe(0x78);
    expect(machine.bankB[1]).toBe(0x56);
  });

  it("refuses a bank pointed anywhere else, rather than swallowing it", () => {
    const failed = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x84); // bank A to texture memory, which this core has not
        asm.movImm32(1, 0x04000240);
        asm.strb(0, armAt(1, 0));
      }),
    );
    expect(failed).toBeInstanceOf(NdsError);
  });
});

describe("what this core does not model", () => {
  it("refuses a byte write to video memory, which does nothing on the hardware", () => {
    // Unlike a Game Boy Advance, where a byte write to palette or attribute
    // memory writes *both* halves. Nothing demake emits does it; refusing is
    // what makes that a fact rather than a hope.
    const failed = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x12);
        asm.movImm32(1, 0x05000000);
        asm.strb(0, armAt(1, 0));
      }),
    );
    expect(failed).toBeInstanceOf(NdsError);
  });

  it("refuses an interrupt, because the backend waits on the beam", () => {
    // A wait loop nothing ever releases is the failure this prevents: it presents
    // as a game that boots and then does nothing, with no instruction to blame.
    const failed = run(
      cartridge((asm) => {
        asm.movImm32(0, 1);
        asm.movImm32(1, 0x04000208); // IME
        asm.strh(0, armAt(1, 0));
      }),
    );
    expect(failed).toBeInstanceOf(NdsError);
  });

  it("refuses 2D engine B, because a game draws one screen", () => {
    const failed = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x0100);
        asm.movImm32(1, 0x04001000); // engine B's DISPCNT
        asm.strh(0, armAt(1, 0));
      }),
    );
    expect(failed).toBeInstanceOf(NdsError);
  });

  it("refuses a display mode whose output it does not draw", () => {
    const failed = run(
      cartridge((asm) => {
        asm.movImm32(0, 0x00020000); // mode 2: a video RAM bank shown as a bitmap
        asm.movImm32(1, 0x04000000);
        asm.str(0, armAt(1, 0));
      }),
    );
    expect(failed).toBeInstanceOf(NdsError);
  });
});

describe("the raster", () => {
  it("advances VCOUNT through the visible lines and back", () => {
    // What the backend's beam wait reads, and the only clock anything on this
    // console has while interrupts are absent.
    const machine = new Nds(cartridge((asm) => asm.mov(0, armImm(0))));
    const seen = new Set<number>();
    for (let step = 0; step < 400_000; step += 1) {
      machine.stepInstruction();
      seen.add(machine.ppu.vcount);
    }
    expect(seen.has(0)).toBe(true);
    expect(seen.has(191)).toBe(true);
    expect(seen.has(192)).toBe(true);
    expect(Math.max(...seen)).toBeLessThan(263);
    expect(machine.frames).toBeGreaterThan(0);
  });
});
