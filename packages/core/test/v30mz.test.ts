/**
 * The V30MZ encoder, hand-read — and the cartridge it goes in.
 *
 * `v30mz-nasm.test.ts` compares a large battery against NASM, which is the
 * sharper oracle for the *encodings*. This file is for what a differential
 * cannot check: that the fixup discipline resolves a forward reference, that an
 * out-of-range short branch is refused rather than wrapped, and that the
 * cartridge wrapper puts the reset jump where the processor fetches it. It also
 * pins a handful of encodings read out of the opcode map directly, so that an
 * error in *both* our assembler and our reading of NASM's output would still
 * have to be an error in a third place to survive.
 */

import { describe, expect, it } from "vitest";

import { abs, at, Asm30, AsmError, romAt } from "../src/asm/v30mz.js";
import {
  packWsRom,
  wsChecksum,
  WS_CODE_SEGMENT,
  WS_CODE_SIZE,
  WS_ENTRY_OFFSET,
  WS_FOOTER_OFFSET,
  WS_ROM_SIZE,
} from "../src/asm/ws-cart.js";

const hex = (bytes: Uint8Array): number[] => Array.from(bytes);

describe("the V30MZ encoder", () => {
  it("encodes the mod/reg/rm byte's three fields where the opcode map puts them", () => {
    const asm = new Asm30();
    // `mov [bx+si+5], dx`: opcode 89, mod=01 reg=010 rm=000, disp8 05.
    asm.movmr(at("bx+si", 5), "dx");
    expect(hex(asm.assemble())).toEqual([0x89, 0x50, 0x05]);
  });

  it("puts `[bp]` in the displacement form, because the direct form lives there", () => {
    // mod=00 rm=110 is `[disp16]`, so a bare `[bp]` has to be mod=01 with a zero.
    const asm = new Asm30();
    asm.movm("dx", at("bp"));
    expect(hex(asm.assemble())).toEqual([0x8b, 0x56, 0x00]);
  });

  it("puts a segment override in front of everything", () => {
    const asm = new Asm30();
    asm.movm8("al", romAt("bx"));
    expect(hex(asm.assemble())).toEqual([0x2e, 0x8a, 0x07]);
  });

  it("takes the accumulator's own opcode for a direct address", () => {
    const asm = new Asm30();
    asm.movm("ax", abs(0x1234)).movm("bx", abs(0x1234));
    expect(hex(asm.assemble())).toEqual([0xa1, 0x34, 0x12, 0x8b, 0x1e, 0x34, 0x12]);
  });

  it("takes the sign-extended immediate where the value fits in a byte", () => {
    const asm = new Asm30();
    asm.aluI("add", "bx", 4).aluI("add", "bx", 0x1234);
    expect(hex(asm.assemble())).toEqual([0x83, 0xc3, 0x04, 0x81, 0xc3, 0x34, 0x12]);
  });

  it("resolves a forward reference", () => {
    const asm = new Asm30();
    asm.jmp("later").nop().label("later").ret();
    // `jmp near` is E9 + rel16 from the instruction after it: one NOP away.
    expect(hex(asm.assemble())).toEqual([0xe9, 0x01, 0x00, 0x90, 0xc3]);
  });

  it("resolves a backward conditional branch", () => {
    const asm = new Asm30();
    asm.label("top").nop().jcc("nz", "top");
    expect(hex(asm.assemble())).toEqual([0x90, 0x75, 0xfd]);
  });

  it("refuses a short branch that does not reach, rather than wrapping it", () => {
    const asm = new Asm30();
    asm.jcc("z", "far");
    asm.ds(200, 0x90);
    asm.label("far").ret();
    expect(() => asm.assemble()).toThrow(AsmError);
  });

  it("resolves a word of data to a label", () => {
    const asm = new Asm30();
    asm.dw("table").label("table").db(0xaa);
    expect(hex(asm.assemble())).toEqual([0x02, 0x00, 0xaa]);
  });

  it("reports a label that was never defined", () => {
    const asm = new Asm30();
    asm.call("nowhere");
    expect(() => asm.assemble()).toThrow(/undefined label 'nowhere'/);
  });

  it("refuses the two moves that are not instructions", () => {
    expect(() => new Asm30().movsr("cs", "ax")).toThrow(AsmError);
    expect(() => new Asm30().popSeg("cs")).toThrow(AsmError);
  });
});

describe("crossing a segment", () => {
  /**
   * The pair a program bigger than one segment is reached through.
   *
   * Read off the encoding tables rather than round-tripped: `call far` pushes
   * the segment as well as the offset and `retf` pops both, so a routine that
   * ended with the near `ret` would leave the caller's segment on the stack and
   * return into whatever offset that word happened to be.
   */
  it("encodes the far call and the return that matches it", () => {
    const asm = new Asm30();
    asm.callFar(0xe000, 0x1234);
    asm.retf();
    expect(Array.from(asm.assemble())).toEqual([
      0x9a,
      0x34,
      0x12,
      0x00,
      0xe0, // call 0xe000:0x1234
      0xcb, // retf
    ]);
  });

  /**
   * A far call that names the routine, which is what a backend actually emits.
   *
   * The offset is the label's own and the segment is *where it was defined* —
   * the only place that knows, and the reason this cannot be spelled with the
   * segment at the call site. `section` moves no bytes: it says what the offsets
   * after it mean, so a routine in a section of its own starts at zero again.
   */
  it("resolves a far call's segment from where the label was defined", () => {
    const asm = new Asm30();
    asm.callFarLabel("Scene", 0xf000);
    asm.retf();
    asm.section(0xe000);
    asm.label("Scene");
    asm.ret();
    const out = Array.from(asm.assemble());
    // Offset zero — the label is the first byte of its own segment — and $E000.
    expect(out.slice(0, 6)).toEqual([0x9a, 0x00, 0x00, 0x00, 0xe0, 0xcb]);
  });

  it("gives a label in no section the caller's own segment", () => {
    // Which is what keeps an unbanked program working: nothing calls `section`,
    // so every label is in the one segment the cartridge is mapped at.
    const asm = new Asm30();
    asm.callFarLabel("Helper", 0xf000);
    asm.label("Helper");
    asm.retf();
    expect(Array.from(asm.assemble())).toEqual([0x9a, 0x05, 0x00, 0x00, 0xf0, 0xcb]);
  });
});

describe("the WonderSwan cartridge", () => {
  it("puts the reset far jump where the processor starts fetching", () => {
    const rom = packWsRom(new Uint8Array([0x90, 0xc3]));
    expect(rom.length).toBe(WS_ROM_SIZE);
    // The processor resets to FFFF:0000 — physical $FFFF0 — and the cartridge's
    // last bank is what answers that end of the address space, so the jump is at
    // that bank's own $FFF0 rather than at a fixed offset in the file.
    const entry = WS_ROM_SIZE - 64 * 1024 + WS_ENTRY_OFFSET;
    expect(entry).toBe(WS_ROM_SIZE - 16);
    expect(Array.from(rom.subarray(entry, entry + 5))).toEqual([
      0xea,
      0x00,
      0x00,
      WS_CODE_SEGMENT & 0xff,
      (WS_CODE_SEGMENT >> 8) & 0xff,
    ]);
  });

  it("puts the program at the base of the bank the code segment answers", () => {
    const rom = packWsRom(new Uint8Array([0x12, 0x34, 0x56]));
    const bank = WS_ROM_SIZE - 64 * 1024;
    expect(Array.from(rom.subarray(bank, bank + 3))).toEqual([0x12, 0x34, 0x56]);
    // Everything a program did not write is the erased state of a mask ROM.
    expect(rom[bank + 3]).toBe(0xff);
    expect(rom[0]).toBe(0xff);
  });

  it("stamps the footer and a checksum over every byte but its own two", () => {
    const rom = packWsRom(new Uint8Array([0x90]), { minimumSystem: 1, orientation: 0x05 });
    const footer = WS_ROM_SIZE - 64 * 1024 + WS_FOOTER_OFFSET;
    expect(rom[footer + 1]).toBe(0x01); // needs a Color
    expect(rom[footer + 4]).toBe(0x02); // 4 Mbit
    expect(rom[footer + 6]).toBe(0x05); // landscape
    const stored = (rom[WS_ROM_SIZE - 1] as number) * 256 + (rom[WS_ROM_SIZE - 2] as number);
    expect(stored).toBe(wsChecksum(rom));
  });

  it("refuses a program that would run into the reset jump", () => {
    expect(() => packWsRom(new Uint8Array(WS_CODE_SIZE + 1))).toThrow(/the bank holds/);
  });
});
