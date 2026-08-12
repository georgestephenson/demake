/**
 * MMC1: the controller a demade game reaches for when NROM runs out.
 *
 * The counterpart of `@demake/dmg`'s `mbc5.test.ts`, and it is pointed at the
 * same class of failure — a mapper that is *wrong and consistent*. This one is
 * driven by a cartridge demake writes and read by a core demake writes, so the
 * only way to keep the pair honest is to state the hardware's own rules here and
 * check against those rather than against either side's idea of them.
 *
 * Three of those rules have no counterpart on any other board in the project.
 * The register is written **a bit at a time** and the *fifth* store is what
 * lands it, so a value is built with shifts and the destination is decided by the
 * address of the last store rather than by anything in the value. A store with
 * **bit 7 set** abandons the sequence and forces the PRG mode that fixes the last
 * bank, which is what a reset does and what a driver does when it is unsure. And
 * the board answers at **`$6000`**, which is the only reason a game with four
 * levels has anywhere to keep its state.
 *
 * Source: NESdev Wiki — MMC1 (https://www.nesdev.org/wiki/MMC1).
 */

import { describe, expect, it } from "vitest";

import { NES_CHR_SIZE, NES_MAPPER_MMC1, packInesRom } from "@demake/core";

import { Nes } from "../src/machine.js";

/**
 * A cartridge of `banks` sixteen-kilobyte banks, each filled with its own number.
 *
 * Every byte of bank `n` reads `n`, so "which bank is in the window" is one read
 * rather than an address computation — which is the point: a test that computed
 * the offset the same way the machine does would agree with a machine that had it
 * wrong.
 */
function cartridge(banks: number): Uint8Array {
  const prg = new Uint8Array(banks * 0x4000);
  for (let bank = 0; bank < banks; bank += 1) {
    prg.fill(bank & 0xff, bank * 0x4000, (bank + 1) * 0x4000);
  }
  // The reset vector lives in the last bank, which is the half MMC1 comes up
  // holding fixed — so a machine can be constructed without any register having
  // been written. It points nowhere in particular; nothing here runs code.
  const last = prg.length - 6;
  prg[last + 2] = 0x00;
  prg[last + 3] = 0xc0;
  return packInesRom(prg, new Uint8Array(NES_CHR_SIZE), {
    mapper: NES_MAPPER_MMC1,
    mirroring: "vertical",
  });
}

/** Write one five-bit value into the register the last store's address selects. */
function serial(nes: Nes, address: number, value: number): void {
  for (let bit = 0; bit < 5; bit += 1) nes.write(address, (value >> bit) & 1);
}

describe("MMC1", () => {
  it("comes up with the last bank fixed at $C000", () => {
    // Without this a cartridge is unbootable whatever else is right: the reset
    // vector is at the top of the image, and the console reads it before a single
    // instruction — so a controller that powered on in any other PRG mode would
    // fetch the vector out of a bank the builder never put one in.
    const nes = new Nes(cartridge(8));
    expect(nes.read(0xc000)).toBe(7);
    expect(nes.read(0xffff - 6)).toBe(7);
  });

  it("switches the $8000 half and leaves the $C000 half alone", () => {
    const nes = new Nes(cartridge(8));
    for (const bank of [0, 1, 5, 6, 3]) {
      serial(nes, 0xe000, bank);
      expect(nes.read(0x8000)).toBe(bank);
      expect(nes.read(0xbfff)).toBe(bank);
      expect(nes.read(0xc000)).toBe(7);
    }
  });

  it("lands the value on the fifth write and not before", () => {
    const nes = new Nes(cartridge(8));
    // Four bits of bank 3 (`00011`) is not a bank change at all.
    for (let bit = 0; bit < 4; bit += 1) nes.write(0xe000, (3 >> bit) & 1);
    expect(nes.read(0x8000)).toBe(0);
    nes.write(0xe000, 0);
    expect(nes.read(0x8000)).toBe(3);
  });

  it("takes the destination from the last store's address, not from the value", () => {
    // The whole hazard in one case: the same five bits, sent to two different
    // quarters of the window, mean two entirely different things.
    const nes = new Nes(cartridge(8));
    serial(nes, 0xe000, 5);
    expect(nes.read(0x8000)).toBe(5);
    // The same value into the control register instead, which is a PRG mode and a
    // mirroring rather than a bank: `00101` is mode 1 with horizontal mirroring.
    serial(nes, 0x8000, 0b00111);
    expect(nes.ppu.mirroring).toBe("horizontal");
    expect(nes.read(0x8000)).toBe(4); // the aligned pair holding bank 5
    expect(nes.read(0xc000)).toBe(5);
  });

  it("abandons a part-written sequence when bit 7 is set", () => {
    const nes = new Nes(cartridge(8));
    serial(nes, 0xe000, 5);
    // Three bits in, then a reset: the four that follow must not complete the
    // first sequence, and the register must still hold what it held.
    for (let bit = 0; bit < 3; bit += 1) nes.write(0xe000, (2 >> bit) & 1);
    nes.write(0xe000, 0x80);
    for (let bit = 0; bit < 4; bit += 1) nes.write(0xe000, 0);
    expect(nes.read(0x8000)).toBe(5);
    // And the fifth write of the *new* sequence is what lands.
    nes.write(0xe000, 0);
    expect(nes.read(0x8000)).toBe(0);
  });

  it("answers at $6000 with eight kilobytes of cartridge RAM", () => {
    const nes = new Nes(cartridge(8));
    nes.write(0x6000, 0x5a);
    nes.write(0x7fff, 0xa5);
    expect(nes.read(0x6000)).toBe(0x5a);
    expect(nes.read(0x7fff)).toBe(0xa5);
    // And it survives a bank switch, which is the point of putting state there.
    serial(nes, 0xe000, 4);
    expect(nes.read(0x6000)).toBe(0x5a);
  });

  it("stops answering there when the board's RAM enable is cleared", () => {
    const nes = new Nes(cartridge(8));
    nes.write(0x6000, 0x5a);
    serial(nes, 0xa000, 0x10);
    expect(nes.read(0x6000)).toBe(0);
    serial(nes, 0xa000, 0x00);
    expect(nes.read(0x6000)).toBe(0x5a);
  });

  it("refuses a one-screen mirroring rather than picking a nametable", () => {
    // Absent rather than half-implemented: nothing this project builds selects
    // one, and a renderer that quietly answered "horizontal" would draw a
    // plausible screen for a cartridge doing something else entirely.
    const nes = new Nes(cartridge(8));
    expect(() => serial(nes, 0x8000, 0b01100)).toThrow(/one-screen/);
  });

  it("leaves an NROM cartridge with no cartridge RAM and no mapper writes", () => {
    const prg = new Uint8Array(0x8000);
    prg.fill(0x42);
    const nes = new Nes(packInesRom(prg, new Uint8Array(NES_CHR_SIZE), { mirroring: "vertical" }));
    nes.write(0x6000, 0x5a);
    expect(nes.read(0x6000)).toBe(0);
    // A store into the window is a no-op on this board, so the program is still
    // there afterwards — the property every cartridge built before MMC1 rests on.
    nes.write(0xe000, 0x80);
    expect(nes.read(0x8000)).toBe(0x42);
  });
});
