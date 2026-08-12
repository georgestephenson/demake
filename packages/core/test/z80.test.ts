/**
 * The Z80 assembler and the Sega cartridge wrapper, as encoders.
 *
 * Tested for the reason the other two are: they decide output bytes, so they are
 * tested artifacts rather than conveniences. Hand-computed encodings read off the
 * opcode table, the four ways the assembler is allowed to refuse, and the three
 * header fields nothing else in the build can check — the magic, the region and
 * the checksum's range.
 *
 * The encodings that get the most attention here are the ones the Game Boy's
 * assembler does *not* have, because those are the ones a reader coming from
 * `sm83.test.ts` would assume rather than verify: the `ED` page, the index
 * prefixes, and the eight-condition branches.
 *
 * Sources: Zilog — Z80 CPU User Manual (UM0080) and SMS Power! — ROM Header
 * (https://www.smspower.org/Development/ROMHeader).
 */

import { describe, expect, it } from "vitest";

import { SMS_HEADER_OFFSET, SMS_ROM_SIZE, packSegaRom, segaChecksum } from "../src/asm/sms-cart.js";
import { AsmError, AsmZ80, highByte, label, lowByte } from "../src/asm/z80.js";

describe("the Z80 assembler", () => {
  it("encodes the 8080-inherited core the same way the SM83 does", () => {
    const asm = new AsmZ80();
    asm.ld("a", "b"); // 78
    asm.ldn("c", 0x42); // 0E 42
    asm.ld16("hl", 0x1234); // 21 34 12
    asm.alu("add", "hlp"); // 86
    asm.aluN("cp", 0x10); // FE 10
    asm.inc("d"); // 14
    asm.dec16("bc"); // 0B
    asm.addHL("de"); // 19
    asm.push("af"); // F5
    asm.pop("hl"); // E1
    expect([...asm.assemble()]).toEqual([
      0x78, 0x0e, 0x42, 0x21, 0x34, 0x12, 0x86, 0xfe, 0x10, 0x14, 0x0b, 0x19, 0xf5, 0xe1,
    ]);
  });

  it("loads and stores the accumulator at an absolute address", () => {
    // The pair the SM83 spells $FA/$EA and this CPU spells $3A/$32 — an easy
    // transcription error, and one that would assemble to `ld a,(nn)` on the
    // wrong machine rather than failing.
    const asm = new AsmZ80();
    asm.lda(0xc100);
    asm.sta(0xc102);
    expect([...asm.assemble()]).toEqual([0x3a, 0x00, 0xc1, 0x32, 0x02, 0xc1]);
  });

  it("encodes the ED page the 16.16 arithmetic is built on", () => {
    const asm = new AsmZ80();
    asm.sbcHL("de"); // ED 52
    asm.adcHL("bc"); // ED 4A
    asm.neg(); // ED 44
    asm.ld16From("de", 0xc000); // ED 5B 00 C0
    asm.st16To(0xc004, "bc"); // ED 43 04 C0
    asm.ld16From("hl", 0xc008); // 2A 08 C0 — the 8080's own short form
    asm.st16To(0xc00c, "hl"); // 22 0C C0
    asm.ldir(); // ED B0
    asm.im(1); // ED 56
    expect([...asm.assemble()]).toEqual([
      0xed, 0x52, 0xed, 0x4a, 0xed, 0x44, 0xed, 0x5b, 0x00, 0xc0, 0xed, 0x43, 0x04, 0xc0, 0x2a,
      0x08, 0xc0, 0x22, 0x0c, 0xc0, 0xed, 0xb0, 0xed, 0x56,
    ]);
  });

  it("encodes the index prefixes, displacement and all", () => {
    const asm = new AsmZ80();
    asm.ld16Idx("ix", 0xc200); // DD 21 00 C2
    asm.ldIdx("a", "ix", 4); // DD 7E 04
    asm.stIdx("ix", 5, "b"); // DD 70 05
    asm.stIdxN("iy", -2, 0x7f); // FD 36 FE 7F
    asm.aluIdx("add", "ix", 1); // DD 86 01
    asm.incIdx("iy", 0); // FD 34 00
    expect([...asm.assemble()]).toEqual([
      0xdd, 0x21, 0x00, 0xc2, 0xdd, 0x7e, 0x04, 0xdd, 0x70, 0x05, 0xfd, 0x36, 0xfe, 0x7f, 0xdd,
      0x86, 0x01, 0xfd, 0x34, 0x00,
    ]);
  });

  it("puts the displacement before the opcode in a DD CB instruction", () => {
    // The one instruction layout on this CPU where the opcode is not the second
    // byte of its prefix group. Getting it the obvious way round assembles a
    // valid instruction that shifts the wrong thing.
    const asm = new AsmZ80();
    asm.shiftIdx("sla", "ix", 3); // DD CB 03 26
    asm.bitIdx(7, "iy", -1); // FD CB FF 7E
    expect([...asm.assemble()]).toEqual([0xdd, 0xcb, 0x03, 0x26, 0xfd, 0xcb, 0xff, 0x7e]);
  });

  it("takes the four conditions the SM83 has and the four it does not", () => {
    const asm = new AsmZ80();
    asm.jp(0x0100, "nz"); // C2 00 01
    asm.jp(0x0100, "pe"); // EA 00 01 — signed overflow
    asm.call(0x0200, "m"); // FC 00 02
    asm.ret("po"); // E0
    expect([...asm.assemble()]).toEqual([
      0xc2, 0x00, 0x01, 0xea, 0x00, 0x01, 0xfc, 0x00, 0x02, 0xe0,
    ]);
  });

  it("encodes the port instructions the VDP is driven through", () => {
    const asm = new AsmZ80();
    asm.outN(0xbf); // D3 BF
    asm.inN(0xbe); // DB BE
    asm.outC("a"); // ED 79
    asm.inC("b"); // ED 40
    asm.otir(); // ED B3
    expect([...asm.assemble()]).toEqual([
      0xd3, 0xbf, 0xdb, 0xbe, 0xed, 0x79, 0xed, 0x40, 0xed, 0xb3,
    ]);
  });

  it("resolves forward references, in full and by half", () => {
    const asm = new AsmZ80(0x0000);
    asm.ld16("hl", label("Table")); // 21 lo hi
    asm.ldn("b", lowByte(label("Table"))); // 06 lo
    asm.ldn("c", highByte(label("Table"))); // 0E hi
    asm.jr("Table"); // 18 e
    asm.label("Table");
    asm.db(0xaa);
    const bytes = asm.assemble();
    expect(asm.addressOf("Table")).toBe(9);
    expect([...bytes]).toEqual([0x21, 0x09, 0x00, 0x06, 0x09, 0x0e, 0x00, 0x18, 0x00, 0xaa]);
  });

  it("counts a relative jump from the instruction after its operand", () => {
    // The off-by-one that presents as an infinite loop somewhere unrelated, and
    // the reason the SM83 assembler pins the same property.
    const asm = new AsmZ80(0x0000);
    asm.label("Loop");
    asm.nop();
    asm.djnz("Loop"); // 10 FD — back over the nop and the two-byte djnz
    expect([...asm.assemble()]).toEqual([0x00, 0x10, 0xfd]);
  });

  it("refuses rather than wrapping", () => {
    const far = new AsmZ80(0x0000);
    far.jr("Away");
    far.ds(200);
    far.label("Away");
    expect(() => far.assemble()).toThrow(AsmError);

    const wide = new AsmZ80();
    expect(() => wide.ldIdx("a", "ix", 200)).toThrow(AsmError);

    const halt = new AsmZ80();
    expect(() => halt.ld("hlp", "hlp")).toThrow(AsmError);

    const missing = new AsmZ80();
    missing.jp("Nowhere");
    expect(() => missing.assemble()).toThrow(AsmError);
  });

  it("reports every label it defined", () => {
    const asm = new AsmZ80(0x0000);
    asm.label("Reset");
    asm.nop();
    asm.equate("Vdp", 0xbf);
    expect(asm.symbols().get("Reset")).toBe(0);
    expect(asm.symbols().get("Vdp")).toBe(0xbf);
  });
});

describe("the Sega cartridge header", () => {
  const image = (): Uint8Array => {
    const bytes = new Uint8Array(SMS_ROM_SIZE);
    bytes[0] = 0xc3; // jp
    bytes[1] = 0x00;
    bytes[2] = 0x02;
    return bytes;
  };

  it("stamps the magic in place rather than appending it", () => {
    const rom = packSegaRom(image());
    expect(rom.length).toBe(SMS_ROM_SIZE);
    const magic = String.fromCharCode(...rom.subarray(SMS_HEADER_OFFSET, SMS_HEADER_OFFSET + 8));
    expect(magic).toBe("TMR SEGA");
    // The code before it is untouched.
    expect([...rom.subarray(0, 3)]).toEqual([0xc3, 0x00, 0x02]);
  });

  it("declares the machine in the region nibble and the size in the other", () => {
    const sms = packSegaRom(image(), { region: "sms-export" });
    expect(sms[SMS_HEADER_OFFSET + 15]).toBe(0x4c);
    const gg = packSegaRom(image(), { region: "gg-international" });
    expect(gg[SMS_HEADER_OFFSET + 15]).toBe(0x7c);
  });

  it("checksums everything before the header and nothing after it", () => {
    const rom = packSegaRom(image());
    const stored =
      (rom[SMS_HEADER_OFFSET + 10] as number) | ((rom[SMS_HEADER_OFFSET + 11] as number) << 8);
    expect(stored).toBe(0xc3 + 0x02);
    // Recomputing over the finished cartridge agrees, which is only true because
    // the range stops short of the bytes the stamp wrote.
    expect(segaChecksum(rom)).toBe(stored);
  });

  it("writes the product code as BCD across two and a half bytes", () => {
    const rom = packSegaRom(image(), { product: 12345, version: 2 });
    expect(rom[SMS_HEADER_OFFSET + 12]).toBe(0x45);
    expect(rom[SMS_HEADER_OFFSET + 13]).toBe(0x23);
    expect(rom[SMS_HEADER_OFFSET + 14]).toBe(0x12);
  });

  it("takes every board's size, and takes the size nibble from the image", () => {
    // The nibble follows the length rather than being a caller's option, so a
    // 48 KiB cartridge cannot describe itself as a 32 KiB one — which a real BIOS
    // would checksum-fail. And the codes *wrap*: $F is 128 KiB and $0 is 256, so
    // the two paged sizes above 128 sit below the flat ones numerically. A
    // builder that computed the nibble instead of looking it up would get those
    // two exactly backwards.
    for (const [bytes, nibble] of [
      [0x8000, 0x0c],
      [0xc000, 0x0d],
      [0x10000, 0x0e],
      [0x20000, 0x0f],
      [0x40000, 0x00],
      [0x80000, 0x01],
    ] as const) {
      const rom = packSegaRom(new Uint8Array(bytes));
      expect(rom.length).toBe(bytes);
      expect((rom[SMS_HEADER_OFFSET + 15] as number) & 0x0f).toBe(nibble);
    }
  });

  it("refuses an image that is no board's size", () => {
    // Not a policy: 16 KiB is half a bank short of what slots 0 and 1 cover, and
    // 96 is a bank and a half past the board below it — the mapper pages whole
    // banks and a mask ROM was a power of two, so there is nothing in between.
    expect(() => packSegaRom(new Uint8Array(0x4000))).toThrow(/not 16384 bytes/);
    expect(() => packSegaRom(new Uint8Array(0x18000))).toThrow(/not 98304 bytes/);
  });

  it("sums only the fixed half, whatever the board", () => {
    // The checksum range stops at the header, which is why one function can stamp
    // a paged cartridge as well as a flat one: the region it covers is slots 0
    // and 1, and the banks that page are outside it by construction.
    const image = new Uint8Array(0x20000);
    image.fill(0x5a, 0x8000, 0x20000); // everything above the fixed half
    const rom = packSegaRom(image);
    const sum =
      (rom[SMS_HEADER_OFFSET + 10] as number) | ((rom[SMS_HEADER_OFFSET + 11] as number) << 8);
    expect(sum).toBe(segaChecksum(rom));
    // And filling the paged half did not move it, because it is not summed.
    expect(sum).toBe(segaChecksum(new Uint8Array(0x20000).fill(0, 0, 0x8000)));
  });
});
