import { describe, expect, it } from "vitest";

import {
  A,
  Asm700,
  AsmError,
  C,
  PSW,
  SP,
  X,
  Y,
  YA,
  spcAbs,
  spcAbsX,
  spcAbsY,
  spcDp,
  spcDpX,
  spcDpY,
  spcIdxIndY,
  spcImm,
  spcIndIdxX,
  spcIndX,
  spcIndXInc,
  spcIndY,
} from "@demake/core";

/**
 * Opcodes are pinned against the published SPC700 matrix, not against the
 * emulator in `@demake/snes` — an encoder and a decoder that agreed with each
 * other and not with the hardware would still be wrong, and a driver that
 * assembles and does not play is the failure this file exists to catch. Same
 * reasoning as `z80.test.ts` and `wdc65816.test.ts`.
 */
describe("Asm700", () => {
  function bytes(build: (asm: Asm700) => void): number[] {
    const asm = new Asm700(0x0200);
    build(asm);
    return [...asm.assemble()];
  }

  it("encodes the mov forms the driver is written in", () => {
    expect(bytes((a) => a.mov(A, spcImm(0x42)))).toEqual([0xe8, 0x42]);
    expect(bytes((a) => a.mov(A, spcDp(0x10)))).toEqual([0xe4, 0x10]);
    expect(bytes((a) => a.mov(A, spcDpX(0x10)))).toEqual([0xf4, 0x10]);
    expect(bytes((a) => a.mov(A, spcAbs(0x1234)))).toEqual([0xe5, 0x34, 0x12]);
    expect(bytes((a) => a.mov(A, spcAbsX(0x1234)))).toEqual([0xf5, 0x34, 0x12]);
    expect(bytes((a) => a.mov(A, spcAbsY(0x1234)))).toEqual([0xf6, 0x34, 0x12]);
    expect(bytes((a) => a.mov(A, spcIndX))).toEqual([0xe6]);
    expect(bytes((a) => a.mov(A, spcIndXInc))).toEqual([0xbf]);
    expect(bytes((a) => a.mov(A, spcIndIdxX(0x08)))).toEqual([0xe7, 0x08]);
    expect(bytes((a) => a.mov(A, spcIdxIndY(0x08)))).toEqual([0xf7, 0x08]);
    expect(bytes((a) => a.mov(spcDp(0x10), A))).toEqual([0xc4, 0x10]);
    expect(bytes((a) => a.mov(spcAbs(0xf200), A))).toEqual([0xc5, 0x00, 0xf2]);
    expect(bytes((a) => a.mov(spcIndXInc, A))).toEqual([0xaf]);
    expect(bytes((a) => a.mov(spcIdxIndY(0x00), A))).toEqual([0xd7, 0x00]);
    expect(bytes((a) => a.mov(X, spcImm(0xef)))).toEqual([0xcd, 0xef]);
    expect(bytes((a) => a.mov(X, spcDpY(0x10)))).toEqual([0xf9, 0x10]);
    expect(bytes((a) => a.mov(Y, spcDp(0xf4)))).toEqual([0xeb, 0xf4]);
    expect(bytes((a) => a.mov(spcDp(0xf4), Y))).toEqual([0xcb, 0xf4]);
  });

  it("encodes the register-to-register moves", () => {
    expect(bytes((a) => a.mov(A, X))).toEqual([0x7d]);
    expect(bytes((a) => a.mov(X, A))).toEqual([0x5d]);
    expect(bytes((a) => a.mov(A, Y))).toEqual([0xdd]);
    expect(bytes((a) => a.mov(Y, A))).toEqual([0xfd]);
    expect(bytes((a) => a.mov(X, SP))).toEqual([0x9d]);
    expect(bytes((a) => a.mov(SP, X))).toEqual([0xbd]);
  });

  it("writes the two-byte operand forms backwards", () => {
    // `mov $10,#$aa` stores the immediate first; `mov $10,$20` stores the
    // *source* offset first. Written order and encoded order differ for exactly
    // these two shapes, on every ALU mnemonic as well as on mov.
    expect(bytes((a) => a.mov(spcDp(0x10), spcImm(0xaa)))).toEqual([0x8f, 0xaa, 0x10]);
    expect(bytes((a) => a.mov(spcDp(0x10), spcDp(0x20)))).toEqual([0xfa, 0x20, 0x10]);
    expect(bytes((a) => a.or(spcDp(0x10), spcImm(0x03)))).toEqual([0x18, 0x03, 0x10]);
    expect(bytes((a) => a.cmp(spcDp(0x30), spcImm(0xcc)))).toEqual([0x78, 0xcc, 0x30]);
  });

  it("encodes the ALU column", () => {
    expect(bytes((a) => a.or(A, spcDp(0x10)))).toEqual([0x04, 0x10]);
    expect(bytes((a) => a.and(A, spcDp(0x10)))).toEqual([0x24, 0x10]);
    expect(bytes((a) => a.eor(A, spcDp(0x10)))).toEqual([0x44, 0x10]);
    expect(bytes((a) => a.cmp(A, spcDp(0x10)))).toEqual([0x64, 0x10]);
    expect(bytes((a) => a.adc(A, spcDp(0x10)))).toEqual([0x84, 0x10]);
    expect(bytes((a) => a.sbc(A, spcDp(0x10)))).toEqual([0xa4, 0x10]);
    expect(bytes((a) => a.adc(A, spcImm(0x01)))).toEqual([0x88, 0x01]);
    expect(bytes((a) => a.cmp(A, spcAbs(0x0500)))).toEqual([0x65, 0x00, 0x05]);
    expect(bytes((a) => a.cmp(X, spcImm(0x08)))).toEqual([0xc8, 0x08]);
    expect(bytes((a) => a.cmp(Y, spcDp(0xf4)))).toEqual([0x7e, 0xf4]);
    expect(bytes((a) => a.cmp(Y, spcImm(0x02)))).toEqual([0xad, 0x02]);
    expect(bytes((a) => a.or(spcIndX, spcIndY))).toEqual([0x19]);
  });

  it("encodes shifts, increments and the word operations", () => {
    expect(bytes((a) => a.asl())).toEqual([0x1c]);
    expect(bytes((a) => a.lsr())).toEqual([0x5c]);
    expect(bytes((a) => a.rol(spcDp(0x10)))).toEqual([0x2b, 0x10]);
    expect(bytes((a) => a.ror(spcAbs(0x0300)))).toEqual([0x6c, 0x00, 0x03]);
    expect(bytes((a) => a.inc(X))).toEqual([0x3d]);
    expect(bytes((a) => a.dec(Y))).toEqual([0xdc]);
    expect(bytes((a) => a.inc(spcDp(0x01)))).toEqual([0xab, 0x01]);
    expect(bytes((a) => a.movw(YA, spcDp(0xf4)))).toEqual([0xba, 0xf4]);
    expect(bytes((a) => a.movw(spcDp(0x00), YA))).toEqual([0xda, 0x00]);
    expect(bytes((a) => a.incw(spcDp(0x02)))).toEqual([0x3a, 0x02]);
    expect(bytes((a) => a.addw(YA, spcDp(0x04)))).toEqual([0x7a, 0x04]);
    expect(bytes((a) => a.mul())).toEqual([0xcf]);
    expect(bytes((a) => a.div())).toEqual([0x9e]);
  });

  it("encodes branches, calls and the bit instructions", () => {
    expect(bytes((a) => a.bra(0x0200))).toEqual([0x2f, 0xfe]);
    expect(bytes((a) => a.bne(0x0204))).toEqual([0xd0, 0x02]);
    expect(bytes((a) => a.bpl(0x0202))).toEqual([0x10, 0x00]);
    expect(bytes((a) => a.jmp(0x0400))).toEqual([0x5f, 0x00, 0x04]);
    expect(bytes((a) => a.jmpIndX(0x0000))).toEqual([0x1f, 0x00, 0x00]);
    expect(bytes((a) => a.call(0x0400))).toEqual([0x3f, 0x00, 0x04]);
    expect(bytes((a) => a.ret())).toEqual([0x6f]);
    expect(bytes((a) => a.dbnzY(0x0200))).toEqual([0xfe, 0xfe]);
    expect(bytes((a) => a.dbnzDp(0x10, 0x0200))).toEqual([0x6e, 0x10, 0xfd]);
    expect(bytes((a) => a.cbneDp(0x10, 0x0200))).toEqual([0x2e, 0x10, 0xfd]);
    // The bit number lives in the opcode, $20 apart, not in the operand.
    expect(bytes((a) => a.set1(0x10, 0))).toEqual([0x02, 0x10]);
    expect(bytes((a) => a.set1(0x10, 3))).toEqual([0x62, 0x10]);
    expect(bytes((a) => a.clr1(0x10, 7))).toEqual([0xf2, 0x10]);
    expect(bytes((a) => a.bbs(0x10, 1, 0x0200))).toEqual([0x23, 0x10, 0xfd]);
    expect(bytes((a) => a.bbc(0x10, 6, 0x0200))).toEqual([0xd3, 0x10, 0xfd]);
  });

  it("packs a bit address and bit number into one word", () => {
    // 13 bits of address, 3 of bit index: `mov1 C,$0123.5` is $AA with $A123.
    expect(bytes((a) => a.bitOp("mov1From", 0x0123, 5))).toEqual([0xaa, 0x23, 0xa1]);
    expect(bytes((a) => a.bitOp("mov1To", 0x0010, 0))).toEqual([0xca, 0x10, 0x00]);
    expect(() => bytes((a) => a.bitOp("not1", 0x4000, 0))).toThrow(AsmError);
  });

  it("encodes the flag and stack instructions", () => {
    expect(bytes((a) => a.clrp())).toEqual([0x20]);
    expect(bytes((a) => a.setp())).toEqual([0x40]);
    expect(bytes((a) => a.clrc())).toEqual([0x60]);
    expect(bytes((a) => a.setc())).toEqual([0x80]);
    expect(bytes((a) => a.ei())).toEqual([0xa0]);
    expect(bytes((a) => a.di())).toEqual([0xc0]);
    expect(bytes((a) => a.push(A))).toEqual([0x2d]);
    expect(bytes((a) => a.pop(Y))).toEqual([0xee]);
    expect(bytes((a) => a.op("push", PSW))).toEqual([0x0d]);
    expect(bytes((a) => a.stop())).toEqual([0xff]);
  });

  it("resolves forward references and rejects a branch that cannot reach", () => {
    const asm = new Asm700(0x0200);
    asm.bra("done");
    asm.ds(4, 0xff);
    asm.label("done");
    asm.mov(A, spcImm(1));
    expect([...asm.assemble()]).toEqual([0x2f, 0x04, 0xff, 0xff, 0xff, 0xff, 0xe8, 0x01]);

    const far = new Asm700(0x0200);
    far.bra("away");
    far.ds(200);
    far.label("away");
    expect(() => far.assemble()).toThrow(AsmError);
  });

  it("refuses a form the CPU does not have", () => {
    // `mov x,!$nnnn+y` is not an instruction; encoding the neighbouring `mov
    // a,!$nnnn+y` would read the right address into the wrong register.
    expect(() => new Asm700().mov(X, spcAbsY(0x1000))).toThrow(AsmError);
    expect(() => new Asm700().mov(Y, C)).toThrow(AsmError);
  });
});
