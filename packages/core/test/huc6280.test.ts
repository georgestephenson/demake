/**
 * The HuC6280 assembler and the HuCard wrapper, as encoders.
 *
 * Tested for the reason every encoder here is: they decide output bytes. What
 * gets the attention is the part a reader coming from `mos6502.test.ts` would
 * *assume* rather than check — because this assembler is a subclass, and a
 * subclass that quietly inherited a wrong answer would look identical to one that
 * computed a right one.
 *
 * Three properties, in the order they can go wrong:
 *
 *   - The base class still encodes a 6502 exactly as it did, through the
 *     subclass. Making `encode` protected was a change to `mos6502.ts`, and this
 *     is what says the change was a refactor.
 *   - The additions carry the opcodes the reference lists, including the two
 *     shapes no {@link Mode} describes: `tst`'s immediate-then-address and
 *     `bbr`'s zero-page-then-branch.
 *   - The block transfers are seven bytes of three little-endian words, and the
 *     lengths the hardware cannot mean are refused rather than encoded.
 *
 * Sources: Archaic Pixels — HuC6280 instruction set (opcode matrix); WDC — W65C02S
 * datasheet for the shared additions.
 */

import { describe, expect, it } from "vitest";

import { Asm6280 } from "../src/asm/huc6280.js";
import { AsmError, abs, absX, imm, indZp, label, zp, zpX } from "../src/asm/mos6502.js";
import { PCE_BANK_SIZE, PCE_ROM_SIZES, PCE_VECTOR_BYTES, packHuCard } from "../src/asm/pce-cart.js";

describe("the HuC6280 assembler", () => {
  it("still encodes the 6502 it inherits", () => {
    const asm = new Asm6280(0xe000);
    asm.lda(imm(0x42)); // A9 42
    asm.sta(abs(0x2200)); // 8D 00 22
    asm.ldx(zp(0x10)); // A6 10
    asm.adc(absX(0x2300)); // 7D 00 23
    asm.jsr("Somewhere"); // 20 -- --
    asm.equate("Somewhere", 0xe100);
    expect([...asm.assemble()]).toEqual([
      0xa9, 0x42, 0x8d, 0x00, 0x22, 0xa6, 0x10, 0x7d, 0x00, 0x23, 0x20, 0x00, 0xe1,
    ]);
  });

  it("encodes the 65C02 additions", () => {
    const asm = new Asm6280();
    asm.stz(zp(0x20)); // 64 20
    asm.stz(abs(0x2200)); // 9C 00 22
    asm.stz(absX(0x2200)); // 9E 00 22
    asm.ina(); // 1A
    asm.dea(); // 3A
    asm.phx(); // DA
    asm.ply(); // 7A
    asm.tsb(zp(0x30)); // 04 30
    asm.trb(abs(0x2400)); // 1C 00 24
    asm.lda(indZp(0x00)); // B2 00
    asm.sta(indZp(0x02)); // 92 02
    asm.op6280("bit", imm(0x80)); // 89 80
    expect([...asm.assemble()]).toEqual([
      0x64, 0x20, 0x9c, 0x00, 0x22, 0x9e, 0x00, 0x22, 0x1a, 0x3a, 0xda, 0x7a, 0x04, 0x30, 0x1c,
      0x00, 0x24, 0xb2, 0x00, 0x92, 0x02, 0x89, 0x80,
    ]);
  });

  it("encodes the mapper, the clock and the register shortcuts", () => {
    const asm = new Asm6280();
    asm.csh(); // D4
    asm.tam(Asm6280.mprBit(0)); // 53 01
    asm.tam(Asm6280.mprBit(1)); // 53 02
    asm.tma(Asm6280.mprBit(7)); // 43 80
    asm.st0(0x05); // 03 05
    asm.st1(0x80); // 13 80
    asm.st2(0x00); // 23 00
    asm.cla(); // 62
    asm.sxy(); // 02
    expect([...asm.assemble()]).toEqual([
      0xd4, 0x53, 0x01, 0x53, 0x02, 0x43, 0x80, 0x03, 0x05, 0x13, 0x80, 0x23, 0x00, 0x62, 0x02,
    ]);
  });

  it("encodes a block transfer as three little-endian words", () => {
    const asm = new Asm6280();
    asm.tia(0x4000, 0x0002, 0x1000); // E3 00 40 02 00 00 10
    expect([...asm.assemble()]).toEqual([0xe3, 0x00, 0x40, 0x02, 0x00, 0x00, 0x10]);
  });

  it("resolves a label in a block transfer's source", () => {
    const asm = new Asm6280(0xe000);
    asm.tia(label("Tiles"), 0x0002, 64);
    asm.label("Tiles");
    const bytes = asm.assemble();
    // The source word is the address of the label that follows the instruction.
    expect(bytes[1]! | (bytes[2]! << 8)).toBe(0xe007);
  });

  it("refuses the two block lengths the hardware does not mean", () => {
    expect(() => new Asm6280().tii(0, 0x0002, 0)).toThrow(AsmError);
    expect(() => new Asm6280().tii(0, 0x0002, 0x10000)).toThrow(AsmError);
  });

  it("puts `tst`'s mask before its address", () => {
    const asm = new Asm6280();
    asm.tst(0x40, zp(0x12)); // 83 40 12
    asm.tst(0x01, abs(0x2200)); // 93 01 00 22
    asm.tst(0x02, zpX(0x12)); // A3 02 12
    expect([...asm.assemble()]).toEqual([
      0x83, 0x40, 0x12, 0x93, 0x01, 0x00, 0x22, 0xa3, 0x02, 0x12,
    ]);
  });

  it("measures a bit branch's offset from the byte after it", () => {
    const asm = new Asm6280(0xe000);
    asm.bbr(3, 0x20, "Ahead"); // 3F 20 rel
    asm.nop();
    asm.label("Ahead");
    // Three bytes of instruction, then one `nop` to skip.
    expect([...asm.assemble()]).toEqual([0x3f, 0x20, 0x01, 0xea]);
  });

  it("encodes the bit set and clear instructions", () => {
    const asm = new Asm6280();
    asm.smb(0, 0x10); // 87 10
    asm.smb(7, 0x10); // F7 10
    asm.rmb(0, 0x11); // 07 11
    asm.rmb(7, 0x11); // 77 11
    expect([...asm.assemble()]).toEqual([0x87, 0x10, 0xf7, 0x10, 0x07, 0x11, 0x77, 0x11]);
  });

  it("refuses a mapper mask that maps nothing, or two registers at once for a read", () => {
    expect(() => new Asm6280().tam(0)).toThrow(AsmError);
    expect(() => new Asm6280().tma(0x03)).toThrow(AsmError);
    expect(() => Asm6280.mprBit(8)).toThrow(AsmError);
  });

  it("refuses a mode the HuC6280 does not have either", () => {
    // `stz` has no indirect form on any chip in this family.
    expect(() => new Asm6280().stz(indZp(0x10))).toThrow(AsmError);
  });

  it("takes `bra` as a two-byte unconditional branch", () => {
    const asm = new Asm6280(0xe000);
    asm.label("Loop");
    asm.bra("Loop");
    expect([...asm.assemble()]).toEqual([0x80, 0xfe]);
  });
});

describe("the HuCard wrapper", () => {
  it("pads to the smallest board that holds the image", () => {
    const rom = packHuCard(new Uint8Array(PCE_BANK_SIZE), { vectors: { reset: 0xe000 } });
    expect(rom.length).toBe(PCE_ROM_SIZES[0]);
  });

  it("grows to the next board rather than truncating", () => {
    const big = packHuCard(new Uint8Array((PCE_ROM_SIZES[0] as number) + 1), { vectors: {} });
    expect(big.length).toBe(PCE_ROM_SIZES[1]);
  });

  it("writes the reset vector where the CPU reads it", () => {
    const rom = packHuCard(new Uint8Array(PCE_BANK_SIZE), {
      vectors: { reset: 0xe123, irq1: 0xe456 },
    });
    // `$FFFE` is the last word of bank 0, which reset maps at `$E000`.
    const reset = PCE_BANK_SIZE - 2;
    expect(rom[reset]! | (rom[reset + 1]! << 8)).toBe(0xe123);
    // IRQ1 is the second vector, at `$FFF8`.
    const irq1 = PCE_BANK_SIZE - PCE_VECTOR_BYTES + 2;
    expect(rom[irq1]! | (rom[irq1 + 1]! << 8)).toBe(0xe456);
  });

  it("pads with $FF, which is what an unprogrammed mask ROM reads as", () => {
    const rom = packHuCard(new Uint8Array(16), { vectors: {} });
    expect(rom[0x1000]).toBe(0xff);
  });

  it("refuses an image bigger than any HuCard", () => {
    expect(() => packHuCard(new Uint8Array(0x100001), { vectors: {} })).toThrow();
  });
});
