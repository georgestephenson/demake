/**
 * The 65816 assembler, against the published opcode bytes.
 *
 * An encoder and a decoder written by one person agree with each other before
 * they agree with the hardware, which is why `@demake/snes`'s CPU is driven by
 * *this* assembler in its own tests and this file pins the assembler against the
 * datasheet's matrix rather than against that CPU. The two together are what make
 * "the cartridge runs" mean something.
 *
 * The cases are chosen for the places this CPU differs from the 6502, because
 * those are the ones a table copied from a 6502 reference gets wrong.
 */

import { describe, expect, it } from "vitest";

import {
  Asm65816,
  AsmError,
  absIndLong,
  acc65816,
  at65816,
  dp,
  dpInd,
  dpIndLong,
  dpIndLongY,
  dpIndX,
  dpIndY,
  dpX,
  dpY,
  imm16,
  imm8,
  immBank,
  label,
  long,
  longX,
  snesAbs as abs,
  snesAbsX as absX,
  snesAbsY as absY,
  snesImmHigh as immHigh,
  snesImmLow as immLow,
  sr,
  srY,
} from "../src/index.js";

/** Assemble one instruction and return its bytes. */
function one(build: (asm: Asm65816) => void): number[] {
  const asm = new Asm65816(0x8000);
  build(asm);
  return [...asm.assemble()];
}

describe("Asm65816", () => {
  it("encodes the addressing modes the 6502 does not have", () => {
    expect(one((a) => a.lda(dpInd(0x12)))).toEqual([0xb2, 0x12]);
    expect(one((a) => a.lda(dpIndLong(0x12)))).toEqual([0xa7, 0x12]);
    expect(one((a) => a.lda(dpIndLongY(0x12)))).toEqual([0xb7, 0x12]);
    expect(one((a) => a.lda(long(0x018000)))).toEqual([0xaf, 0x00, 0x80, 0x01]);
    expect(one((a) => a.lda(longX(0x7e1234)))).toEqual([0xbf, 0x34, 0x12, 0x7e]);
    expect(one((a) => a.lda(sr(3)))).toEqual([0xa3, 0x03]);
    expect(one((a) => a.lda(srY(3)))).toEqual([0xb3, 0x03]);
    expect(one((a) => a.stz(abs(0x2100)))).toEqual([0x9c, 0x00, 0x21]);
    expect(one((a) => a.tsb(abs(0x0040)))).toEqual([0x0c, 0x40, 0x00]);
    expect(one((a) => a.trb(dp(0x40)))).toEqual([0x14, 0x40]);
    expect(one((a) => a.xba())).toEqual([0xeb]);
    expect(one((a) => a.xce())).toEqual([0xfb]);
    expect(one((a) => a.tcd())).toEqual([0x5b]);
    expect(one((a) => a.phb())).toEqual([0x8b]);
    expect(one((a) => a.phk())).toEqual([0x4b]);
    expect(one((a) => a.rtl())).toEqual([0x6b]);
  });

  it("keeps the 6502's own encodings, because they are the same instructions", () => {
    expect(one((a) => a.lda(imm8(0x12)))).toEqual([0xa9, 0x12]);
    expect(one((a) => a.lda(dp(0x12)))).toEqual([0xa5, 0x12]);
    expect(one((a) => a.lda(dpX(0x12)))).toEqual([0xb5, 0x12]);
    expect(one((a) => a.lda(dpIndX(0x12)))).toEqual([0xa1, 0x12]);
    expect(one((a) => a.lda(dpIndY(0x12)))).toEqual([0xb1, 0x12]);
    expect(one((a) => a.lda(abs(0x1234)))).toEqual([0xad, 0x34, 0x12]);
    expect(one((a) => a.lda(absX(0x1234)))).toEqual([0xbd, 0x34, 0x12]);
    expect(one((a) => a.lda(absY(0x1234)))).toEqual([0xb9, 0x34, 0x12]);
    expect(one((a) => a.ldx(dpY(0x12)))).toEqual([0xb6, 0x12]);
    expect(one((a) => a.asl(acc65816))).toEqual([0x0a]);
    expect(one((a) => a.jmp(0x1234))).toEqual([0x4c, 0x34, 0x12]);
    expect(one((a) => a.jsr(0x1234))).toEqual([0x20, 0x34, 0x12]);
    expect(one((a) => a.rts())).toEqual([0x60]);
  });

  it("makes an immediate's width the caller's, because the opcode does not carry it", () => {
    // The same opcode, one operand byte or two. An assembler that inferred this
    // would desynchronise the instruction stream rather than produce a wrong
    // number, because the extra byte is executed.
    expect(one((a) => a.lda(imm8(0x34)))).toEqual([0xa9, 0x34]);
    expect(one((a) => a.lda(imm16(0x1234)))).toEqual([0xa9, 0x34, 0x12]);
    expect(one((a) => a.ldx(imm8(0x34)))).toEqual([0xa2, 0x34]);
    expect(one((a) => a.ldx(imm16(0x1234)))).toEqual([0xa2, 0x34, 0x12]);
    expect(one((a) => a.sep(0x30))).toEqual([0xe2, 0x30]);
    expect(one((a) => a.rep(0x30))).toEqual([0xc2, 0x30]);
  });

  it("encodes the jumps that carry a bank, and the block move's reversed banks", () => {
    expect(one((a) => a.op("jml", long(0x028000)))).toEqual([0x5c, 0x00, 0x80, 0x02]);
    expect(one((a) => a.op("jsl", long(0x018000)))).toEqual([0x22, 0x00, 0x80, 0x01]);
    expect(one((a) => a.jmpInd(0x1234))).toEqual([0x6c, 0x34, 0x12]);
    expect(one((a) => a.jmpIndX(0x1234))).toEqual([0x7c, 0x34, 0x12]);
    expect(one((a) => a.op("jml", absIndLong(0x1234)))).toEqual([0xdc, 0x34, 0x12]);
    // `mvn dst, src` assembles destination-first, which is the reverse of how
    // every syntax writes it.
    expect(one((a) => a.mvn(0x7e, 0x01))).toEqual([0x54, 0x7e, 0x01]);
  });

  it("resolves labels, forward and back, in every width a reference can take", () => {
    const asm = new Asm65816(0x8000);
    asm.lda(imm16(label("Table")));
    asm.lda(immLow(label("Table")));
    asm.lda(immHigh(label("Table")));
    asm.lda(immBank(label("Table")));
    asm.jmp("Table");
    asm.label("Table");
    asm.db(0xaa);
    const bytes = [...asm.assemble()];
    // The label lands at $800C: a three-byte immediate, three two-byte ones, and
    // a three-byte jump.
    expect(bytes).toEqual([
      0xa9, 0x0c, 0x80, 0xa9, 0x0c, 0xa9, 0x80, 0xa9, 0x00, 0x4c, 0x0c, 0x80, 0xaa,
    ]);
  });

  it("takes a long branch where a short one cannot reach", () => {
    const asm = new Asm65816(0x8000);
    asm.brl("Far");
    asm.ds(400);
    asm.label("Far");
    const bytes = asm.assemble();
    expect(bytes[0]).toBe(0x82);
    expect(bytes[1]! | (bytes[2]! << 8)).toBe(400);
  });

  it("refuses rather than wrapping, on both the branch and the mode", () => {
    const far = new Asm65816(0);
    far.beq("Far");
    far.ds(200);
    far.label("Far");
    expect(() => far.assemble()).toThrow(AsmError);

    const asm = new Asm65816(0);
    expect(() => asm.stx(absX(0x1234))).toThrow(AsmError);
    expect(() => asm.lda(imm8(label("Table")))).toThrow(AsmError);
    expect(() => asm.lda(dp(0x1234))).toThrow(AsmError);
  });

  it("chooses the direct page only when the address is in it", () => {
    expect(one((a) => a.lda(at65816(0x0040)))).toEqual([0xa5, 0x40]);
    expect(one((a) => a.lda(at65816(0x0140)))).toEqual([0xad, 0x40, 0x01]);
  });

  it("reports every label it defined, which is what a harness reads", () => {
    const asm = new Asm65816(0x8000);
    asm.label("Reset");
    asm.nop();
    asm.label("Nmi");
    asm.rti();
    asm.equate("Ram", 0x0100);
    expect([...asm.symbols()]).toEqual([
      ["Reset", 0x8000],
      ["Nmi", 0x8001],
      ["Ram", 0x0100],
    ]);
  });
});
