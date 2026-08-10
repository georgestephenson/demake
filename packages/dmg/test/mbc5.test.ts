/**
 * The one memory bank controller this core has, and the ways it can be wrong.
 *
 * A mapper is the hardest kind of thing to test from a trace, because a wrong
 * one does not compute a wrong number — it fetches the *right* instructions from
 * the *wrong* place, which reads as a program that jumped somewhere absurd. So
 * every case here is one where the arithmetic is fine and the address is not.
 *
 * Two of them are the pair that would cancel out. The bank number is nine bits
 * across two registers at two addresses, so a builder and a core that agreed
 * with each other about which register carried the high bit would page perfectly
 * and page nothing anybody else could read — the Mega Duck register map's trap,
 * one header field along (AGENTS.md §Gotchas). They are checked against the
 * published register map rather than against each other: `$2000` is the low
 * eight bits, `$3000` is bit 8 alone, and writing one must not disturb the
 * other.
 */

import { describe, expect, it } from "vitest";

import { Asm, GB_BANK_SIZE, GB_CARTRIDGE_TYPE, GB_HEADER_OFFSETS, MBC5 } from "@demake/core";

import { Gameboy } from "../src/machine.js";

/**
 * A cartridge of `banks` sixteen-kilobyte banks, each with its own signature.
 *
 * Byte zero of every bank's window position holds the bank number, so "which
 * bank is mapped" is a question the running program can answer by reading one
 * address — which is the whole of what these cases ask.
 */
function banked(banks: number, code: Uint8Array, type = GB_CARTRIDGE_TYPE.mbc5): Uint8Array {
  const rom = new Uint8Array(banks * GB_BANK_SIZE);
  rom[0x100] = 0x00;
  rom[0x101] = 0xc3; // jp $0150
  rom[0x102] = 0x50;
  rom[0x103] = 0x01;
  rom.set(code, 0x150);
  rom[GB_HEADER_OFFSETS.cartridgeType] = type;
  for (let bank = 1; bank < banks; bank += 1) {
    // The bank's own number, at the first byte of the window it maps into. Low
    // byte then high, so a bank past 255 is distinguishable from its low eight
    // bits — which is the only way the ninth bit can be seen at all.
    rom[bank * GB_BANK_SIZE] = bank & 0xff;
    rom[bank * GB_BANK_SIZE + 1] = (bank >> 8) & 0xff;
  }
  return rom;
}

/** Run a cartridge to its `halt` and hand back the first bytes of work RAM. */
function run(rom: Uint8Array, length = 4): Uint8Array {
  const machine = new Gameboy(rom);
  for (let step = 0; step < 200_000 && !machine.cpu.halted; step += 1) machine.stepInstruction();
  expect(machine.cpu.halted).toBe(true);
  return machine.readMemory(0xc000, length);
}

/**
 * Select `bank`, copy the two signature bytes to `$C000`, halt.
 *
 * Both registers are written every time, in the controller's own order, because
 * a program that wrote only the one it needed would pass a core that had the two
 * the wrong way round for as long as every bank it wanted was below 256.
 */
function readSignature(bank: number): Uint8Array {
  const asm = new Asm(0x0150);
  asm.ldn("a", bank & 0xff);
  asm.sta(MBC5.romBankLow);
  asm.ldn("a", (bank >> 8) & 1);
  asm.sta(MBC5.romBankHigh);
  asm.ld16("hl", 0x4000);
  asm.ld("a", "hlp");
  asm.sta(0xc000);
  asm.inc16("hl");
  asm.ld("a", "hlp");
  asm.sta(0xc001);
  asm.halt();
  return asm.assemble();
}

describe("MBC5", () => {
  it("maps the bank the low register names into $4000", () => {
    const rom = banked(4, readSignature(3));
    expect([...run(rom, 2)]).toEqual([3, 0]);
  });

  it("keeps bank 0 wired to $0000 whatever the register says", () => {
    // The vectors, the entry point and the header are down there: a controller
    // that paged the bottom half would be one nothing could recover from.
    const asm = new Asm(0x0150);
    asm.ldn("a", 2);
    asm.sta(MBC5.romBankLow);
    asm.ld16("hl", 0x0101);
    asm.ld("a", "hlp");
    asm.sta(0xc000);
    asm.halt();
    const rom = banked(4, asm.assemble());
    expect(run(rom, 1)[0]).toBe(0xc3); // the `jp` at $0101, still there
  });

  it("takes the ninth bit from $3000 and nothing else", () => {
    // Bank 257 is `$01` in the low register and `1` in the high one. A core that
    // took the ninth bit from the low register's own bit 0 — or that let the
    // high write clear the low byte — would map bank 1 and read `1` back, which
    // is exactly the number the right answer's *low* byte is.
    const rom = banked(258, readSignature(257));
    expect([...run(rom, 2)]).toEqual([1, 1]);
  });

  it("lets the low register change banks without the high one being rewritten", () => {
    const asm = new Asm(0x0150);
    asm.ldn("a", 1);
    asm.sta(MBC5.romBankHigh); // bank 256 and up from here on
    asm.ldn("a", 0x02);
    asm.sta(MBC5.romBankLow);
    asm.ld16("hl", 0x4000);
    asm.ld("a", "hlp");
    asm.sta(0xc000);
    asm.inc16("hl");
    asm.ld("a", "hlp");
    asm.sta(0xc001);
    asm.halt();
    expect([...run(banked(260, asm.assemble()), 2)]).toEqual([2, 1]);
  });

  it("maps bank 1 before anything has written the register", () => {
    // The controller's own power-up value. A program that reaches the window
    // before programming it has to find something there, and on this controller
    // it is bank 1 — not bank 0, which MBC1 would translate it to.
    const asm = new Asm(0x0150);
    asm.ld16("hl", 0x4000);
    asm.ld("a", "hlp");
    asm.sta(0xc000);
    asm.halt();
    expect(run(banked(4, asm.assemble()), 1)[0]).toBe(1);
  });

  it("will map bank 0 into the window, which MBC1 will not", () => {
    // $4000 then holds the first byte of the image, which is where the `nop`
    // ahead of the entry jump lives — zero, and distinguishable from bank 1's
    // signature byte.
    const rom = banked(4, readSignature(0));
    expect([...run(rom, 2)]).toEqual([0, 0]);
  });

  it("leaves a ROM-only cartridge exactly the bus it always had", () => {
    // Every cartridge this project builds today is this one. A write below
    // `$8000` reaches nothing, so the second half of the image stays put.
    const asm = new Asm(0x0150);
    asm.ldn("a", 3);
    asm.sta(MBC5.romBankLow);
    asm.ld16("hl", 0x4000);
    asm.ld("a", "hlp");
    asm.sta(0xc000);
    asm.halt();
    const rom = banked(2, asm.assemble(), GB_CARTRIDGE_TYPE.romOnly);
    expect(run(rom, 1)[0]).toBe(1); // bank 1's signature, because it never moved
  });

  it("reads open where the cartridge declares no RAM", () => {
    const asm = new Asm(0x0150);
    asm.ldn("a", 0x55);
    asm.sta(0xa000);
    asm.lda(0xa000);
    asm.sta(0xc000);
    asm.halt();
    expect(run(banked(4, asm.assemble()), 1)[0]).toBe(0xff);
  });
});
