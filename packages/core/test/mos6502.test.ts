/**
 * The 6502 assembler, as an encoder.
 *
 * Tested for the reason the SM83 one is: it decides output bytes, so it is a
 * tested artifact rather than a convenience. Hand-computed encodings read off
 * the instruction reference, plus the three ways it is allowed to refuse —
 * an addressing mode a mnemonic does not have, a zero-page operand that is not
 * in zero page, and a branch too far to reach.
 *
 * Source: NESdev Wiki — Instruction reference
 * (https://www.nesdev.org/wiki/Instruction_reference).
 */

import { describe, expect, it } from "vitest";

import {
  Asm6502,
  AsmError,
  abs,
  absX,
  absY,
  acc,
  at,
  imm,
  immHigh,
  immLow,
  indY,
  label,
  zp,
} from "../src/asm/mos6502.js";
import {
  NES_CHR_OFFSET,
  NES_CHR_SIZE,
  NES_PRG_OFFSET,
  NES_PRG_SIZE,
  packInesRom,
} from "../src/asm/nes-cart.js";

describe("the 6502 assembler", () => {
  it("encodes the addressing forms the backend relies on", () => {
    const asm = new Asm6502(0x8000);
    asm.lda(imm(0x12)); // A9 12
    asm.lda(zp(0x10)); // A5 10
    asm.lda(abs(0x0300)); // AD 00 03
    asm.lda(absX(0x0300)); // BD 00 03
    asm.lda(absY(0x0300)); // B9 00 03
    asm.lda(indY(0x10)); // B1 10
    asm.sta(abs(0x2007)); // 8D 07 20
    asm.adc(zp(0x11)); // 65 11
    asm.lsr(acc); // 4A
    asm.rol(zp(0x12)); // 26 12
    asm.ldx(imm(4)); // A2 04
    asm.iny(); // C8
    expect([...asm.assemble()]).toEqual([
      0xa9, 0x12, 0xa5, 0x10, 0xad, 0x00, 0x03, 0xbd, 0x00, 0x03, 0xb9, 0x00, 0x03, 0xb1, 0x10,
      0x8d, 0x07, 0x20, 0x65, 0x11, 0x4a, 0x26, 0x12, 0xa2, 0x04, 0xc8,
    ]);
  });

  it("picks zero page for a low address and absolute for a high one", () => {
    const asm = new Asm6502(0x8000);
    asm.lda(at(0x0042));
    asm.lda(at(0x0342));
    expect([...asm.assemble()]).toEqual([0xa5, 0x42, 0xad, 0x42, 0x03]);
  });

  it("resolves forward references, relative and absolute", () => {
    const asm = new Asm6502(0x8000);
    asm.bne("ahead"); // D0 01
    asm.nop(); // EA
    asm.label("ahead");
    asm.jmp("ahead"); // 4C 03 80
    asm.dw(label("ahead", 3));
    const bytes = asm.assemble();
    // The offset is relative to the instruction after the operand, so it skips
    // exactly the nop.
    expect(bytes[1]).toBe(1);
    expect([bytes[4], bytes[5]]).toEqual([0x03, 0x80]);
    expect([bytes[6], bytes[7]]).toEqual([0x06, 0x80]);
  });

  it("splits an unresolved address into its low and high halves", () => {
    const asm = new Asm6502(0x8000);
    asm.lda(immLow("table"));
    asm.lda(immHigh("table"));
    asm.padTo(0x8123);
    asm.label("table");
    const bytes = asm.assemble();
    expect([bytes[1], bytes[3]]).toEqual([0x23, 0x81]);
  });

  it("refuses an addressing mode the mnemonic does not have", () => {
    const asm = new Asm6502(0);
    expect(() => asm.stx(absX(0x0300))).toThrow(AsmError);
    expect(() => asm.jsr(0x1234) && asm.op("jsr", zp(0x10))).toThrow(AsmError);
  });

  it("refuses a zero-page operand that is not in zero page", () => {
    const asm = new Asm6502(0);
    expect(() => asm.lda(zp(0x0300))).toThrow(AsmError);
    const late = new Asm6502(0x8000);
    late.lda(zp("elsewhere"));
    late.label("elsewhere");
    expect(() => late.assemble()).toThrow(AsmError);
  });

  it("refuses a relative branch it cannot encode", () => {
    const asm = new Asm6502(0);
    asm.beq("far");
    asm.ds(200);
    asm.label("far");
    expect(() => asm.assemble()).toThrow(AsmError);
  });
});

describe("the NES cartridge wrapper", () => {
  it("packs an iNES file whose header describes NROM", () => {
    const prg = new Uint8Array(NES_PRG_SIZE).fill(0xea);
    const chr = new Uint8Array(NES_CHR_SIZE).fill(0x5a);
    const rom = packInesRom(prg, chr, { mirroring: "vertical" });
    expect(rom.length).toBe(16 + NES_PRG_SIZE + NES_CHR_SIZE);
    expect([...rom.subarray(0, 4)]).toEqual([0x4e, 0x45, 0x53, 0x1a]);
    expect(rom[4]).toBe(2); // two 16 KiB program banks
    expect(rom[5]).toBe(1); // one 8 KiB character bank
    expect(rom[6]).toBe(0x01); // mapper 0, vertical mirroring
    expect(rom[7]).toBe(0x00);
    expect(rom[NES_PRG_OFFSET]).toBe(0xea);
    expect(rom[NES_CHR_OFFSET]).toBe(0x5a);
  });

  it("refuses a program that is not exactly a mapper-less cartridge", () => {
    expect(() => packInesRom(new Uint8Array(1024), new Uint8Array(NES_CHR_SIZE))).toThrow();
    expect(() => packInesRom(new Uint8Array(NES_PRG_SIZE), new Uint8Array(16))).toThrow();
  });
});
