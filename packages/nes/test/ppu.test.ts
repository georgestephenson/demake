/**
 * The picture: the master palette, the 16×16 attribute cell, and eight sprites.
 *
 * The master palette is pinned against `@demake/core`'s `nes` spec for the reason
 * `@demake/dmg`'s green ramp is: a DAC model decides what a pixel-perfect
 * emulator comparison means (doc 10), so this core, the CLI's PNG and the
 * libretro capture have to be showing one palette rather than three that look
 * alike.
 *
 * The other two are the constraints the art path and the compiler's budget
 * warnings are written against. If the attribute table were per tile here, a
 * conversion that ignored the 16×16 cell would look right; if the ninth sprite on
 * a line drew, doc 14 §Budgets' warning would be unfalsifiable.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "@demake/core";

import { NES_MASTER, Nes, SCREEN_WIDTH } from "../src/index.js";

/** A minimal NROM cartridge: a program that spins, and a character bank. */
function cartridge(program: readonly number[], chr: Uint8Array): Uint8Array {
  const prg = new Uint8Array(0x8000);
  prg.set(program, 0);
  // The reset vector points at the start of the program window.
  prg[0x7ffc] = 0x00;
  prg[0x7ffd] = 0x80;
  const rom = new Uint8Array(16 + prg.length + chr.length);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 0], 0);
  rom.set(prg, 16);
  rom.set(chr, 16 + prg.length);
  return rom;
}

/** A character bank whose tile 1 is solid colour 3 and tile 2 solid colour 1. */
function characters(): Uint8Array {
  const chr = new Uint8Array(0x2000);
  for (let row = 0; row < 8; row += 1) {
    chr[1 * 16 + row] = 0xff; // plane 0
    chr[1 * 16 + 8 + row] = 0xff; // plane 1 → index 3
    chr[2 * 16 + row] = 0xff; // index 1
  }
  return chr;
}

/** `jmp $8000` — the CPU spins while the test drives the PPU itself. */
const SPIN = [0x4c, 0x00, 0x80];

/** Boot a machine with rendering enabled and the palettes filled in. */
function booted(): Nes {
  const machine = new Nes(cartridge(SPIN, characters()));
  machine.ppu.writeRegister(0, 0x00); // patterns at $0000, no NMI
  machine.ppu.writeRegister(1, 0x1e); // background and sprites on
  machine.ppu.palette.set([0x0f, 0x01, 0x02, 0x03], 0x00); // backdrop + palette 0
  machine.ppu.palette.set([0x0f, 0x11, 0x12, 0x13], 0x04); // palette 1
  machine.ppu.palette.set([0x0f, 0x21, 0x22, 0x23], 0x10); // sprite palette 0
  return machine;
}

/** The master-palette index shown at a pixel. */
function pixel(machine: Nes, x: number, y: number): number {
  return machine.ppu.indices[y * SCREEN_WIDTH + x] as number;
}

describe("the NES palette", () => {
  it("is the one the console spec calls the hardware's", () => {
    const spec = getConsole("nes");
    expect(spec.color.model).toBe("fixed-master");
    const master = spec.color.model === "fixed-master" ? spec.color.masterPalette : [];
    expect(NES_MASTER.length).toBe(master.length);
    expect(NES_MASTER.map(([r, g, b]) => ({ r, g, b }))).toEqual(
      master.map((colour) => ({ r: colour.r, g: colour.g, b: colour.b })),
    );
  });

  it("mirrors every fourth sprite entry onto the universal backdrop", () => {
    const machine = booted();
    machine.ppu.writeRegister(6, 0x3f);
    machine.ppu.writeRegister(6, 0x10); // $3F10 is $3F00
    machine.ppu.writeRegister(7, 0x2a);
    expect(machine.ppu.palette[0]).toBe(0x2a);
  });
});

describe("the NES background", () => {
  it("takes a cell's palette from a 16×16 attribute cell, not from the tile", () => {
    const machine = booted();
    // Two cells side by side in the same attribute cell, then two in the next.
    machine.ppu.nametables.fill(1, 0, 32 * 30);
    // Attribute byte 0 covers cells (0,0)–(3,3): top-left quadrant palette 0,
    // top-right quadrant palette 1.
    machine.ppu.nametables[0x03c0] = 0b00000100;
    machine.runFrame();
    // Cells 0 and 1 are the top-left quadrant → palette 0, colour 3 → $03.
    expect(pixel(machine, 0, 0)).toBe(0x03);
    expect(pixel(machine, 15, 0)).toBe(0x03);
    // Cells 2 and 3 are the top-right quadrant → palette 1, colour 3 → $13.
    expect(pixel(machine, 16, 0)).toBe(0x13);
    expect(pixel(machine, 31, 0)).toBe(0x13);
  });

  it("shows the universal backdrop where a tile's colour is zero", () => {
    const machine = booted();
    machine.ppu.nametables.fill(0, 0, 32 * 30); // tile 0 is blank
    machine.runFrame();
    expect(pixel(machine, 8, 8)).toBe(0x0f);
  });

  it("scrolls into the second nametable and wraps", () => {
    const machine = new Nes(cartridge(SPIN, characters()));
    machine.ppu.writeRegister(1, 0x1e);
    machine.ppu.palette.set([0x0f, 0x01, 0x02, 0x03], 0x00);
    // Vertical mirroring is off in this header, so the second table is the one
    // below: scroll down instead, which exercises the same wrap.
    machine.ppu.nametables.fill(1, 0, 32 * 30);
    machine.ppu.writeRegister(5, 0); // scroll X
    machine.ppu.writeRegister(5, 16); // scroll Y: two rows down
    machine.runFrame();
    machine.runFrame();
    expect(pixel(machine, 0, 0)).toBe(0x03);
  });
});

describe("the NES sprites", () => {
  it("draws eight on a line and sets the overflow flag on the ninth", () => {
    const machine = booted();
    machine.ppu.nametables.fill(0, 0, 32 * 30);
    for (let entry = 0; entry < 9; entry += 1) {
      machine.ppu.oam[entry * 4] = 100; // same line
      machine.ppu.oam[entry * 4 + 1] = 1; // solid tile
      machine.ppu.oam[entry * 4 + 2] = 0;
      machine.ppu.oam[entry * 4 + 3] = entry * 8;
    }
    machine.runFrame();
    machine.runFrame();
    // The first eight drew, in sprite palette 0, colour 3 → $23.
    expect(pixel(machine, 0, 100)).toBe(0x23);
    expect(pixel(machine, 63, 100)).toBe(0x23);
    // The ninth did not; it shows the backdrop.
    expect(pixel(machine, 64, 100)).toBe(0x0f);
    expect(machine.ppu.readRegister(2) & 0x20).toBe(0x20);
  });

  it("puts a sprite behind opaque background when its attribute says so", () => {
    const machine = booted();
    machine.ppu.nametables.fill(1, 0, 32 * 30); // opaque everywhere
    machine.ppu.nametables[0x03c0] = 0;
    machine.ppu.oam[0] = 100;
    machine.ppu.oam[1] = 1;
    machine.ppu.oam[2] = 0x20; // behind the background
    machine.ppu.oam[3] = 0;
    machine.runFrame();
    machine.runFrame();
    expect(pixel(machine, 0, 100)).toBe(0x03); // the background won
  });

  it("flips a sprite horizontally, which is why art needs one facing only", () => {
    const chr = characters();
    // Tile 3: the left half opaque, the right half clear.
    for (let row = 0; row < 8; row += 1) chr[3 * 16 + row] = 0xf0;
    const machine = new Nes(cartridge(SPIN, chr));
    machine.ppu.writeRegister(1, 0x1e);
    machine.ppu.palette.set([0x0f, 0x01, 0x02, 0x03], 0x00);
    machine.ppu.palette.set([0x0f, 0x21, 0x22, 0x23], 0x10);
    machine.ppu.oam.set([100, 3, 0x40, 0], 0); // flipped
    machine.runFrame();
    machine.runFrame();
    expect(pixel(machine, 0, 100)).toBe(0x0f); // clear on the left now
    expect(pixel(machine, 7, 100)).toBe(0x21); // opaque on the right
  });
});

describe("the console around them", () => {
  it("copies a page into OAM on a $4014 write, and charges for it", () => {
    const machine = new Nes(cartridge(SPIN, characters()));
    for (let index = 0; index < 256; index += 1) machine.ram[0x0200 + index] = index;
    machine.write(0x4014, 0x02);
    expect([...machine.ppu.oam.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    // The transfer stalls the CPU, which the next step charges for.
    expect(machine.stepInstruction()).toBeGreaterThan(500);
  });

  it("reports the controller one bit at a time, low bit first", () => {
    const machine = new Nes(cartridge(SPIN, characters()));
    machine.setButtons(["b", "start"]); // bits 1 and 3
    machine.write(0x4016, 1);
    machine.write(0x4016, 0);
    const bits = [0, 0, 0, 0, 0, 0, 0, 0].map(() => machine.read(0x4016) & 1);
    expect(bits).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
    // And ones for ever after, as the shift register clocks in.
    expect(machine.read(0x4016) & 1).toBe(1);
  });

  it("refuses a cartridge with a mapper it does not have", () => {
    const rom = cartridge(SPIN, characters());
    rom[6] = 0x10; // mapper 1
    expect(() => new Nes(rom)).toThrow(/NROM/);
  });
});
