/**
 * The SM83 assembler, as an encoder.
 *
 * It lives in `core` because two backends emit Game Boy machine code — the
 * Demotic game backend and the audio driver — and it is tested here for the
 * reason doc 10 gives about the DAC models: it decides output bytes, so it is a
 * tested artifact rather than a convenience. Hand-computed encodings, checked
 * against the opcode tables, in the spirit of the color-space tests.
 *
 * Source: the SM83 opcode tables — https://gbdev.io/gb-opcodes/optables/
 */

import { describe, expect, it } from "vitest";

import { Asm, AsmError, label } from "../src/asm/sm83.js";
import { GB_HEADER_OFFSETS, GB_ROM_SIZE, stampGbHeader } from "../src/asm/gb-cart.js";

describe("the SM83 assembler", () => {
  it("encodes the addressing forms the backend relies on", () => {
    const asm = new Asm(0);
    asm.ld("b", "a"); // 0x47
    asm.ldn("a", 0x12); // 0x3E 0x12
    asm.lda(0xc123); // 0xFA 0x23 0xC1
    asm.sta(0xc123); // 0xEA 0x23 0xC1
    asm.alu("adc", "hlp"); // 0x8E
    asm.aluN("cp", 4); // 0xFE 0x04
    asm.shift("sra", "hlp"); // 0xCB 0x2E
    asm.bit(7, "a"); // 0xCB 0x7F
    expect([...asm.assemble()]).toEqual([
      0x47, 0x3e, 0x12, 0xfa, 0x23, 0xc1, 0xea, 0x23, 0xc1, 0x8e, 0xfe, 0x04, 0xcb, 0x2e, 0xcb,
      0x7f,
    ]);
  });

  it("resolves forward references, relative and absolute", () => {
    const asm = new Asm(0x100);
    asm.jr("ahead");
    asm.nop();
    asm.label("ahead");
    asm.jp("ahead");
    asm.dw(label("ahead", 3));
    const bytes = asm.assemble();
    // jr skips the nop: the operand is relative to the instruction after it.
    expect(bytes[1]).toBe(1);
    expect([bytes[4], bytes[5]]).toEqual([0x03, 0x01]);
    expect([bytes[6], bytes[7]]).toEqual([0x06, 0x01]);
  });

  it("refuses a relative branch it cannot encode", () => {
    const asm = new Asm(0);
    asm.jr("far");
    asm.ds(200);
    asm.label("far");
    expect(() => asm.assemble()).toThrow(AsmError);
  });
});

describe("the cartridge wrapper", () => {
  it("stamps a header whose checksums verify", () => {
    const rom = new Uint8Array(GB_ROM_SIZE);
    rom[0x0100] = 0x00;
    rom[0x0101] = 0xc3;
    stampGbHeader(rom, "demake test title");

    let header = 0;
    for (let at = 0x0134; at <= 0x014c; at += 1) header = (header - (rom[at] as number) - 1) & 0xff;
    expect(rom[GB_HEADER_OFFSETS.headerChecksum]).toBe(header);

    let global = 0;
    for (let at = 0; at < rom.length; at += 1) {
      if (at === GB_HEADER_OFFSETS.globalChecksum || at === GB_HEADER_OFFSETS.globalChecksum + 1) {
        continue;
      }
      global = (global + (rom[at] as number)) & 0xffff;
    }
    expect(rom[GB_HEADER_OFFSETS.globalChecksum]).toBe((global >> 8) & 0xff);
    expect(rom[GB_HEADER_OFFSETS.globalChecksum + 1]).toBe(global & 0xff);
  });

  it("upper-cases and truncates the title to the sixteen bytes it has", () => {
    const rom = new Uint8Array(GB_ROM_SIZE);
    stampGbHeader(rom, "a very long cartridge name");
    expect(String.fromCharCode(...rom.subarray(0x0134, 0x0143))).toBe("A VERY LONG CAR");
  });

  it("leaves the boot logo area zero, because we ship no copyrighted data", () => {
    const rom = new Uint8Array(GB_ROM_SIZE);
    stampGbHeader(rom, "DEMAKE");
    expect(rom.subarray(GB_HEADER_OFFSETS.logo, 0x0134).every((byte) => byte === 0)).toBe(true);
  });
});
