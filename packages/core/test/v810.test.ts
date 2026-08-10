/**
 * The V810 assembler and the Virtual Boy cartridge wrapper, as encoders.
 *
 * Tested for the reason every encoder here is: they decide output bytes. And
 * this one has no second oracle of the kind `arm-gnu.test.ts` gives the ARM —
 * no distribution ships a V810 assembler — so the encodings below are read off
 * the reference's own instruction-format tables and written out as literals.
 * The other half of the proof is one layer up: a cartridge these bytes make is
 * booted in a *third-party* emulator by the pixel-perfect E2E, which is what
 * catches an encoder and a decoder that agree with each other and not with the
 * hardware.
 *
 * What gets the attention is what a reader would otherwise assume:
 *
 *   - Each of the six formats puts its fields where the manual says, including
 *     the one that is easy to get backwards — `reg2` is the *destination* and
 *     sits above `reg1` in the halfword, so `mov src, dst` writes them in the
 *     opposite order to the one it is spelled in.
 *   - A 32-bit constant is built rather than fetched, and the high half carries
 *     the correction `movea`'s sign extension will apply. A constant whose low
 *     half has bit 15 set is the case that separates a right answer from one
 *     that is 64 KiB low.
 *   - A displacement is measured from the branch's *own* address, which is not
 *     what any other machine in this project does.
 *   - The cartridge's header and vectors move with the board size, and the reset
 *     stub jumps absolutely — because the fetch that runs it came through a
 *     mirror the image was not assembled at.
 *
 * Sources: NEC — *V810 Family 32-bit Microprocessor User's Manual* §5; the
 * Virtual Boy *Sacred Tech Scroll* instruction appendix and cartridge header
 * layout.
 */

import { describe, expect, it } from "vitest";

import { Asm810, AsmError, highHalf, invertCond, LP, R0, R1, SR_PSW } from "../src/asm/v810.js";
import {
  packVbRom,
  vbRomSize,
  VB_HEADER_BYTES,
  VB_ROM_SIZES,
  VB_VECTOR_BYTES,
} from "../src/asm/vb-cart.js";
import { VB_ROM } from "../src/asm/vb.js";

/** The halfwords an assembled program is, which is how the manual writes them. */
function halfwords(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    out.push((bytes[index] as number) | ((bytes[index + 1] as number) << 8));
  }
  return out;
}

describe("the V810 assembler", () => {
  it("encodes register-to-register operations (format I)", () => {
    const asm = new Asm810();
    asm.mov(5, 6); // reg1=5, reg2=6
    asm.add(1, 2);
    asm.sub(3, 4);
    asm.cmp(7, 8);
    asm.shl(9, 10);
    asm.shr(11, 12);
    asm.sar(13, 14);
    asm.mul(15, 16);
    asm.div(17, 18);
    asm.mulu(19, 20);
    asm.divu(21, 22);
    asm.or(23, 24);
    asm.and(25, 26);
    asm.xor(27, 28);
    asm.not(29, 30);
    asm.jmp(LP);
    expect(halfwords(asm.assemble())).toEqual([
      (0x00 << 10) | (6 << 5) | 5,
      (0x01 << 10) | (2 << 5) | 1,
      (0x02 << 10) | (4 << 5) | 3,
      (0x03 << 10) | (8 << 5) | 7,
      (0x04 << 10) | (10 << 5) | 9,
      (0x05 << 10) | (12 << 5) | 11,
      (0x07 << 10) | (14 << 5) | 13,
      (0x08 << 10) | (16 << 5) | 15,
      (0x09 << 10) | (18 << 5) | 17,
      (0x0a << 10) | (20 << 5) | 19,
      (0x0b << 10) | (22 << 5) | 21,
      (0x0c << 10) | (24 << 5) | 23,
      (0x0d << 10) | (26 << 5) | 25,
      (0x0e << 10) | (28 << 5) | 27,
      (0x0f << 10) | (30 << 5) | 29,
      (0x06 << 10) | 31,
    ]);
  });

  it("puts the destination above the source, not beside it", () => {
    // The one field order a reader coming from every other encoder here would
    // guess wrong: `mov src, dst` is spelled source-first and encoded
    // destination-first.
    expect(halfwords(new Asm810().mov(1, 2).assemble())).toEqual([(2 << 5) | 1]);
    expect(halfwords(new Asm810().mov(2, 1).assemble())).toEqual([(1 << 5) | 2]);
  });

  it("encodes the short immediate forms (format II)", () => {
    const asm = new Asm810();
    asm.movImm5(-1, 7);
    asm.movImm5(15, 7);
    asm.addImm5(-16, 8);
    asm.cmpImm5(3, 9);
    asm.shlImm5(31, 10);
    asm.shrImm5(1, 10);
    asm.sarImm5(16, 10);
    asm.setf("lt", 5);
    asm.ldsr(5, SR_PSW);
    asm.stsr(SR_PSW, 6);
    asm.reti();
    asm.halt();
    asm.sei();
    asm.cli();
    asm.trap(3);
    expect(halfwords(asm.assemble())).toEqual([
      (0x10 << 10) | (7 << 5) | 0x1f,
      (0x10 << 10) | (7 << 5) | 0x0f,
      (0x11 << 10) | (8 << 5) | 0x10,
      (0x13 << 10) | (9 << 5) | 3,
      (0x14 << 10) | (10 << 5) | 31,
      (0x15 << 10) | (10 << 5) | 1,
      (0x17 << 10) | (10 << 5) | 16,
      (0x12 << 10) | (5 << 5) | 6,
      (0x1c << 10) | (5 << 5) | 5,
      (0x1d << 10) | (6 << 5) | 5,
      0x19 << 10,
      0x1a << 10,
      0x1e << 10,
      0x16 << 10,
      (0x18 << 10) | 3,
    ]);
  });

  it("encodes the 16-bit immediate forms (format V)", () => {
    const asm = new Asm810();
    asm.movea(0x1234, R0, 8);
    asm.addi(-2, 3, 4);
    asm.ori(0xff00, 5, 6);
    asm.andi(0x00ff, 7, 8);
    asm.xori(0xaaaa, 9, 10);
    asm.movhi(0x0700, R0, 11);
    expect(halfwords(asm.assemble())).toEqual([
      (0x28 << 10) | (8 << 5),
      0x1234,
      (0x29 << 10) | (4 << 5) | 3,
      0xfffe,
      (0x2c << 10) | (6 << 5) | 5,
      0xff00,
      (0x2d << 10) | (8 << 5) | 7,
      0x00ff,
      (0x2e << 10) | (10 << 5) | 9,
      0xaaaa,
      (0x2f << 10) | (11 << 5),
      0x0700,
    ]);
  });

  it("encodes loads and stores (format VI)", () => {
    const asm = new Asm810();
    asm.ldb(4, 3, 10);
    asm.ldh(-2, 3, 10);
    asm.ldw(0x100, 3, 10);
    asm.stb(10, 4, 3);
    asm.sth(10, 4, 3);
    asm.stw(10, 4, 3);
    asm.inb(0, 5, 6);
    asm.inh(0, 5, 6);
    asm.inw(0, 5, 6);
    asm.outb(6, 0, 5);
    asm.outh(6, 0, 5);
    asm.outw(6, 0, 5);
    expect(halfwords(asm.assemble())).toEqual([
      (0x30 << 10) | (10 << 5) | 3,
      4,
      (0x31 << 10) | (10 << 5) | 3,
      0xfffe,
      (0x33 << 10) | (10 << 5) | 3,
      0x100,
      (0x34 << 10) | (10 << 5) | 3,
      4,
      (0x35 << 10) | (10 << 5) | 3,
      4,
      (0x37 << 10) | (10 << 5) | 3,
      4,
      (0x38 << 10) | (6 << 5) | 5,
      0,
      (0x39 << 10) | (6 << 5) | 5,
      0,
      (0x3b << 10) | (6 << 5) | 5,
      0,
      (0x3c << 10) | (6 << 5) | 5,
      0,
      (0x3d << 10) | (6 << 5) | 5,
      0,
      (0x3f << 10) | (6 << 5) | 5,
      0,
    ]);
  });

  it("measures a conditional branch from its own address", () => {
    // Not from the instruction after it, which is what every other machine in
    // this project does — a `br` to the halfword after itself is +2, not 0.
    const asm = new Asm810(0x07000000);
    asm.br("After");
    asm.label("After");
    asm.bcond("ne", "Back");
    asm.equate("Back", 0x07000000);
    expect(halfwords(asm.assemble())).toEqual([
      0x8000 | (0x5 << 9) | 2,
      0x8000 | (0xa << 9) | (-2 & 0x1ff),
    ]);
  });

  it("refuses a conditional branch that does not reach", () => {
    const asm = new Asm810(0);
    asm.bcond("e", "Far");
    asm.ds(0x200);
    asm.label("Far");
    expect(() => asm.assemble()).toThrow(AsmError);
  });

  it("encodes the long jumps (format IV)", () => {
    const asm = new Asm810(0x07000000);
    asm.jr("Target");
    asm.jal("Target");
    asm.equate("Target", 0x07001000);
    expect(halfwords(asm.assemble())).toEqual([(0x2a << 10) | 0, 0x1000, (0x2b << 10) | 0, 0x0ffc]);
  });

  it("encodes a backwards long jump across a megabyte", () => {
    const asm = new Asm810(0x07100000);
    asm.jr("Back");
    asm.equate("Back", 0x07000000);
    const delta = -0x100000;
    expect(halfwords(asm.assemble())).toEqual([
      (0x2a << 10) | ((delta >> 16) & 0x3ff),
      delta & 0xffff,
    ]);
  });

  it("spells nop as the never-taken branch", () => {
    expect(halfwords(new Asm810().nop().assemble())).toEqual([0x8000 | (0xd << 9)]);
  });

  it("builds a 32-bit constant in as few instructions as it takes", () => {
    // One instruction where five bits will do, one where sixteen will, two
    // otherwise.
    expect(halfwords(new Asm810().movImm32(-1, 6).assemble())).toEqual([
      (0x10 << 10) | (6 << 5) | 0x1f,
    ]);
    expect(halfwords(new Asm810().movImm32(0x1234, 6).assemble())).toEqual([
      (0x28 << 10) | (6 << 5),
      0x1234,
    ]);
    expect(halfwords(new Asm810().movImm32(0x05000000, 6).assemble())).toEqual([
      (0x2f << 10) | (6 << 5),
      0x0500,
      (0x28 << 10) | (6 << 5) | 6,
      0x0000,
    ]);
  });

  it("corrects the high half for movea's sign extension", () => {
    // `$0005F800`'s low half has bit 15 set, so `movea` will subtract $800 from
    // whatever `movhi` left — the high half has to be one greater than the
    // constant's own. An encoder that dropped this is 64 KiB low on every
    // address above `$xxxx8000`, which on this console is the whole VIP register
    // page.
    expect(highHalf(0x0005f800)).toBe(0x0006);
    expect(highHalf(0x00057800)).toBe(0x0005);
    const built = halfwords(new Asm810().movImm32(0x0005f800, 6).assemble());
    expect(built).toEqual([(0x2f << 10) | (6 << 5), 0x0006, (0x28 << 10) | (6 << 5) | 6, 0xf800]);
    // And the pair really does reconstruct it.
    expect((((built[1] as number) << 16) + (((built[3] as number) << 16) >> 16)) >>> 0).toBe(
      0x0005f800,
    );
  });

  it("resolves a label through the same correction", () => {
    const asm = new Asm810(0);
    asm.movImm32("Table", 7);
    asm.equate("Table", 0x0500f800);
    expect(halfwords(asm.assemble())).toEqual([
      (0x2f << 10) | (7 << 5),
      0x0501,
      (0x28 << 10) | (7 << 5) | 7,
      0xf800,
    ]);
  });

  it("inverts every condition", () => {
    for (const cond of ["v", "c", "e", "nh", "n", "r", "lt", "le", "h", "p", "ge", "gt"] as const) {
      expect(invertCond(invertCond(cond))).toBe(cond === "c" ? "c" : cond);
    }
    expect(invertCond("lt")).toBe("ge");
    expect(invertCond("le")).toBe("gt");
    expect(invertCond("e")).toBe("ne");
  });

  it("refuses registers and immediates the encoding cannot hold", () => {
    expect(() => new Asm810().mov(0, 32)).toThrow(AsmError);
    expect(() => new Asm810().movImm5(16, 1)).toThrow(AsmError);
    expect(() => new Asm810().shlImm5(32, 1)).toThrow(AsmError);
    expect(() => new Asm810().ldw(0x10000, 1, 2)).toThrow(AsmError);
    expect(() => new Asm810(1)).toThrow(AsmError);
  });
});

describe("the Virtual Boy cartridge", () => {
  it("takes the smallest board that holds the program", () => {
    expect(vbRomSize(16)).toBe(VB_ROM_SIZES[0]);
    expect(vbRomSize(0x80000 - VB_VECTOR_BYTES - VB_HEADER_BYTES)).toBe(VB_ROM_SIZES[0]);
    expect(vbRomSize(0x80000)).toBe(VB_ROM_SIZES[1]);
    expect(() => vbRomSize(0x200000)).toThrow();
  });

  it("puts the header and the vectors at the top of the image, wherever that is", () => {
    for (const size of VB_ROM_SIZES) {
      const rom = packVbRom(new Uint8Array(16), { title: "DEMAKE", code: "DMKE", size });
      expect(rom.length).toBe(size);
      const headerAt = size - VB_VECTOR_BYTES - VB_HEADER_BYTES;
      expect(String.fromCharCode(...rom.slice(headerAt, headerAt + 20))).toBe(
        "DEMAKE".padEnd(20, " "),
      );
      expect(String.fromCharCode(...rom.slice(headerAt + 27, headerAt + 31))).toBe("DMKE");
      // The five reserved bytes are written as zero rather than left erased.
      expect([...rom.slice(headerAt + 20, headerAt + 25)]).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it("jumps to the entry point absolutely, from the last sixteen bytes", () => {
    const rom = packVbRom(new Uint8Array(16), { size: 0x80000 });
    const reset = halfwords(rom.slice(0x80000 - 0x10, 0x80000 - 0x10 + 10));
    // movhi $0700, r0, r1 / movea 0, r1, r1 / jmp [r1] — the entry is built into
    // a register because the fetch that runs this came through a mirror the
    // image was not assembled at.
    expect(reset).toEqual([
      (0x2f << 10) | (1 << 5),
      0x0700,
      (0x28 << 10) | (1 << 5) | 1,
      0x0000,
      (0x06 << 10) | 1,
    ]);
    expect(VB_ROM).toBe(0x07000000);
  });

  it("leaves a vector nothing asked for as a return, not as zeroes", () => {
    // Zeroes decode as `mov r0, r0` and run on into the next slot, so an
    // interrupt enabled by accident would execute the vector table.
    const rom = packVbRom(new Uint8Array(16), { size: 0x80000 });
    const vip = 0x80000 - 0x1c0;
    expect(halfwords(rom.slice(vip, vip + 2))).toEqual([0x19 << 10]);
  });

  it("installs a video-processor handler when the program takes one", () => {
    const rom = packVbRom(new Uint8Array(16), { size: 0x80000, vipHandler: 0x07000100 });
    const vip = 0x80000 - 0x1c0;
    expect(halfwords(rom.slice(vip, vip + 10))).toEqual([
      (0x2f << 10) | (1 << 5),
      0x0700,
      (0x28 << 10) | (1 << 5) | 1,
      0x0100,
      (0x06 << 10) | 1,
    ]);
  });

  it("refuses a program that would run into its own header", () => {
    expect(() =>
      packVbRom(new Uint8Array(0x80000 - VB_VECTOR_BYTES - VB_HEADER_BYTES + 1), { size: 0x80000 }),
    ).toThrow();
  });

  it("pads with the erased state, not with zero", () => {
    const rom = packVbRom(new Uint8Array([1, 2, 3, 4]), { size: 0x80000 });
    expect(rom[4]).toBe(0xff);
    expect(rom[0x1000]).toBe(0xff);
  });

  it("assembles a reachable program at the cartridge base", () => {
    // The whole point of `jr`'s reach on this console: a cartridge is at most
    // 2 MiB and the jump reaches ±32 MiB, so a backend's long jump always lands.
    const asm = new Asm810(VB_ROM);
    asm.jr("End");
    asm.ds(0x1000);
    asm.label("End");
    asm.movImm32(0, R1);
    asm.jmp(R1);
    expect(() => packVbRom(asm.assemble())).not.toThrow();
  });
});
