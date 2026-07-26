/**
 * The picture: the green LCD, and the colour hardware behind the CGB flag.
 *
 * Two things worth pinning. The DMG's four shades are not grey — they are the
 * green ramp the `dmg` console spec carries as its DAC model, and a DAC model
 * is a tested artifact here because it decides what a pixel-perfect emulator
 * comparison means (doc 10). The cross-check against `@demake/core` is what
 * keeps this core, the CLI's PNG and the SameBoy capturer showing one colour.
 *
 * And a cartridge that asks for Game Boy Color hardware has to get it: two VRAM
 * banks, per-cell attributes, and RGB555 palettes read out of palette RAM. The
 * tests below drive the PPU directly rather than through a built ROM, so a
 * failure names the register rather than the game.
 */

import { describe, expect, it } from "vitest";

import { getConsole, stampGbHeader } from "@demake/core";

import { DMG_SHADES, Gameboy, SCREEN_WIDTH } from "../src/index.js";

/** A 32 KiB cartridge whose only job is to exist and carry a header. */
function cartridge(color: boolean): Uint8Array {
  const rom = new Uint8Array(0x8000);
  // `halt` forever: the tests clock the PPU themselves.
  rom[0x0100] = 0x00;
  rom[0x0101] = 0xc3;
  rom[0x0102] = 0x00;
  rom[0x0103] = 0x01;
  stampGbHeader(rom, "TEST", { cgb: color });
  return rom;
}

/** Write a solid 8×8 tile of one colour index into VRAM bank `bank`. */
function solidTile(machine: Gameboy, bank: number, index: number, color: number): void {
  const base = bank * 0x2000 + index * 16;
  for (let row = 0; row < 8; row += 1) {
    machine.vram[base + row * 2] = color & 1 ? 0xff : 0x00;
    machine.vram[base + row * 2 + 1] = color & 2 ? 0xff : 0x00;
  }
}

/** Put a BGR555 colour into one of the palette-RAM blocks. */
function setColor(ram: Uint8Array, palette: number, index: number, word: number): void {
  ram[palette * 8 + index * 2] = word & 0xff;
  ram[palette * 8 + index * 2 + 1] = (word >> 8) & 0xff;
}

/** Run one whole frame's worth of dots so the PPU renders and presents. */
function frame(machine: Gameboy): void {
  machine.runFrame();
}

describe("the Game Boy's screen", () => {
  it("shows the green ramp the console spec calls the hardware's", () => {
    const spec = getConsole("dmg");
    const dac = spec.color.dac;
    expect(dac.kind).toBe("mono-ramp");
    const shades = dac.kind === "mono-ramp" ? dac.shades : [];
    expect(DMG_SHADES.map((shade) => ({ r: shade[0], g: shade[1], b: shade[2] }))).toEqual(
      shades.map((shade) => ({ r: shade.r, g: shade.g, b: shade.b })),
    );
  });

  it("paints a monochrome frame in those shades and nothing else", () => {
    const machine = new Gameboy(cartridge(false));
    expect(machine.cgb).toBe(false);
    // Tile 1 is colour 3; fill the map with it and leave BGP as the identity.
    solidTile(machine, 0, 1, 3);
    machine.vram.fill(1, 0x1800, 0x1c00);
    machine.write(0xff47, 0b11100100);
    machine.write(0xff40, 0x91);
    frame(machine);
    const at = (100 * SCREEN_WIDTH + 80) * 4;
    expect([
      machine.framebuffer[at],
      machine.framebuffer[at + 1],
      machine.framebuffer[at + 2],
    ]).toEqual([...(DMG_SHADES[3] as readonly number[])]);
  });
});

describe("the Game Boy Color's screen", () => {
  /** A machine with the LCD on, one solid tile, and a full attribute map. */
  function colorMachine(): Gameboy {
    const machine = new Gameboy(cartridge(true));
    expect(machine.cgb).toBe(true);
    solidTile(machine, 0, 1, 1);
    machine.vram.fill(1, 0x1800, 0x1c00);
    machine.write(0xff40, 0x91);
    return machine;
  }

  it("gives the cartridge the boot register a CGB leaves behind", () => {
    expect(new Gameboy(cartridge(true)).cpu.a).toBe(0x11);
    expect(new Gameboy(cartridge(false)).cpu.a).toBe(0x01);
  });

  it("routes VRAM through the bank register, and only in colour mode", () => {
    const machine = colorMachine();
    machine.write(0xff4f, 1);
    machine.write(0x8000, 0xab);
    expect(machine.vram[0x2000]).toBe(0xab);
    expect(machine.vram[0x0000]).not.toBe(0xab);
    expect(machine.read(0x8000)).toBe(0xab);
    machine.write(0xff4f, 0);
    expect(machine.read(0x8000)).not.toBe(0xab);

    const mono = new Gameboy(cartridge(false));
    mono.write(0xff4f, 1);
    mono.write(0x8000, 0xcd);
    expect(mono.vram[0x0000]).toBe(0xcd);
  });

  it("fills palette RAM through the auto-incrementing data port", () => {
    const machine = colorMachine();
    machine.write(0xff68, 0x80);
    for (let byte = 0; byte < 64; byte += 1) machine.write(0xff69, byte);
    expect([...machine.bgPaletteRam]).toEqual([...Array(64).keys()]);
    // Without the auto-increment bit every write lands in the same slot.
    machine.write(0xff6a, 0x04);
    machine.write(0xff6b, 0x11);
    machine.write(0xff6b, 0x22);
    expect(machine.objPaletteRam[4]).toBe(0x22);
    expect(machine.objPaletteRam[5]).toBe(0x00);
  });

  it("draws a background cell in the palette its attribute names", () => {
    const machine = colorMachine();
    // Palette 3, colour 1 is pure red in BGR555 — five bits expand by
    // replication, so it reaches the framebuffer as $FF.
    setColor(machine.bgPaletteRam, 3, 1, 31);
    machine.vram.fill(3, 0x2000 + 0x1800, 0x2000 + 0x1c00);
    frame(machine);
    const at = (100 * SCREEN_WIDTH + 80) * 4;
    expect([
      machine.framebuffer[at],
      machine.framebuffer[at + 1],
      machine.framebuffer[at + 2],
    ]).toEqual([0xff, 0x00, 0x00]);
  });

  it("reads a cell's tiles from the bank its attribute names", () => {
    const machine = colorMachine();
    // The same tile number, different bank: colour 2 rather than colour 1.
    solidTile(machine, 1, 1, 2);
    setColor(machine.bgPaletteRam, 0, 1, 31);
    setColor(machine.bgPaletteRam, 0, 2, 31 << 5);
    machine.vram.fill(0x08, 0x2000 + 0x1800, 0x2000 + 0x1c00);
    frame(machine);
    const at = (100 * SCREEN_WIDTH + 80) * 4;
    expect([
      machine.framebuffer[at],
      machine.framebuffer[at + 1],
      machine.framebuffer[at + 2],
    ]).toEqual([0x00, 0xff, 0x00]);
  });

  it("draws an object in an object palette, over the background", () => {
    const machine = colorMachine();
    setColor(machine.bgPaletteRam, 0, 1, 0);
    setColor(machine.objPaletteRam, 5, 3, 31 << 10);
    solidTile(machine, 0, 2, 3);
    machine.write(0xff40, 0x93); // objects on as well as the background
    machine.oam[0] = 16 + 40; // top of the sprite at screen line 40
    machine.oam[1] = 8 + 40;
    machine.oam[2] = 2;
    machine.oam[3] = 5; // colour palette 5, bank 0, in front
    frame(machine);
    const at = (44 * SCREEN_WIDTH + 44) * 4;
    expect([
      machine.framebuffer[at],
      machine.framebuffer[at + 1],
      machine.framebuffer[at + 2],
    ]).toEqual([0x00, 0x00, 0xff]);
  });

  it("lets a background cell claim priority over an object", () => {
    const machine = colorMachine();
    setColor(machine.bgPaletteRam, 0, 1, 31); // red background
    setColor(machine.objPaletteRam, 0, 3, 31 << 10); // blue sprite
    solidTile(machine, 0, 2, 3);
    // Attribute bit 7: this cell sits above objects that do not override it.
    machine.vram.fill(0x80, 0x2000 + 0x1800, 0x2000 + 0x1c00);
    machine.write(0xff40, 0x93);
    machine.oam[0] = 16 + 40;
    machine.oam[1] = 8 + 40;
    machine.oam[2] = 2;
    machine.oam[3] = 0;
    frame(machine);
    const at = (44 * SCREEN_WIDTH + 44) * 4;
    expect(machine.framebuffer[at]).toBe(0xff);

    // …and LCDC bit 0 clear takes that priority away, on a CGB only.
    machine.write(0xff40, 0x92);
    frame(machine);
    expect(machine.framebuffer[at + 2]).toBe(0xff);
  });

  it("switches the upper half of work RAM through SVBK", () => {
    const machine = colorMachine();
    machine.write(0xd000, 0x11);
    machine.write(0xff70, 2);
    machine.write(0xd000, 0x22);
    expect(machine.read(0xd000)).toBe(0x22);
    machine.write(0xff70, 1);
    expect(machine.read(0xd000)).toBe(0x11);
    // Bank 0 selected there means bank 1, which is why a game that never
    // touches the register sees the flat 8 KiB a DMG has.
    machine.write(0xff70, 0);
    expect(machine.read(0xd000)).toBe(0x11);
  });
});
