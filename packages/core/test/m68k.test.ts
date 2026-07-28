/**
 * The 68000 encoder, against the published opcode bytes.
 *
 * The counterpart of `z80.test.ts`, and it exists for the reason that one does:
 * `@demake/md` is driven by *this* assembler, so an encoder and a decoder that
 * agreed with each other and not with Motorola would pass every conformance
 * test in the project. These bytes come from the M68000 Family Programmer's
 * Reference Manual's instruction-format tables, not from running the code.
 */

import { describe, expect, it } from "vitest";

import {
  Asm68k,
  eaA,
  eaAbs,
  eaD,
  eaDisp,
  eaIdx,
  eaImm,
  eaInd,
  eaPost,
  eaPre,
  fitsAbsWord,
} from "../src/index.js";
import { AsmError, label } from "../src/asm/m68k.js";

/** Assemble one instruction and return it as hex bytes. */
function encode(build: (asm: Asm68k) => void): string {
  const asm = new Asm68k(0);
  build(asm);
  return [...asm.assemble()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("moves", () => {
  it("encodes register-to-register moves at all three sizes", () => {
    expect(encode((a) => a.move("b", eaD(0), eaD(1)))).toBe("1200");
    expect(encode((a) => a.move("w", eaD(0), eaD(1)))).toBe("3200");
    expect(encode((a) => a.move("l", eaD(0), eaD(1)))).toBe("2200");
  });

  it("picks the short absolute form only where the address sign-extends to it", () => {
    // The top half of work RAM is reachable in two bytes; a ROM address past
    // $7FFF is not, and neither is a label whose address is not known yet.
    expect(fitsAbsWord(0xff8000)).toBe(true);
    expect(fitsAbsWord(0x00a000)).toBe(false);
    expect(encode((a) => a.move("l", eaAbs(0xff8000), eaD(0)))).toBe("20388000");
    expect(encode((a) => a.move("l", eaAbs(0x00a000), eaD(0)))).toBe("2039" + "0000a000");
    expect(encode((a) => a.move("l", eaD(0), eaAbs(0xff8000)))).toBe("21c08000");
  });

  it("encodes immediates, moveq and movea", () => {
    expect(encode((a) => a.move("l", eaImm(0x12345678), eaD(0)))).toBe("203c12345678");
    expect(encode((a) => a.moveq(1, 0))).toBe("7001");
    expect(encode((a) => a.moveq(-1, 3))).toBe("76ff");
    // `move` to an address register is `movea`, which the method picks for itself.
    expect(encode((a) => a.move("l", eaAbs(0xff8000), eaA(0)))).toBe("20788000");
    expect(encode((a) => a.movea("l", eaImm(0xff8000), 1))).toBe("227c00ff8000");
  });

  it("encodes the indirect modes", () => {
    expect(encode((a) => a.move("l", eaInd(0), eaD(0)))).toBe("2010");
    expect(encode((a) => a.move("l", eaPost(0), eaD(0)))).toBe("2018");
    expect(encode((a) => a.move("l", eaD(0), eaPre(1)))).toBe("2300");
    expect(encode((a) => a.move("l", eaDisp(0, 4), eaD(0)))).toBe("20280004");
    expect(encode((a) => a.move("l", eaIdx(0, 2, 1), eaD(0)))).toBe("20301802");
  });
});

describe("arithmetic and logic", () => {
  it("encodes the register and memory directions apart", () => {
    expect(encode((a) => a.add("l", eaD(1), 0))).toBe("d081");
    expect(encode((a) => a.addTo("l", 0, eaInd(0)))).toBe("d190");
    expect(encode((a) => a.sub("l", eaD(1), 0))).toBe("9081");
    expect(encode((a) => a.and("l", eaD(1), 0))).toBe("c081");
    expect(encode((a) => a.or("l", eaD(1), 0))).toBe("8081");
    expect(encode((a) => a.cmp("l", eaD(1), 0))).toBe("b081");
    // `eor` has no to-register direction at all, which is why it has one method.
    expect(encode((a) => a.eorTo("l", 0, eaD(1)))).toBe("b181");
  });

  it("encodes the immediate and quick forms", () => {
    expect(encode((a) => a.cmpi("l", 1, eaD(0)))).toBe("0c8000000001");
    expect(encode((a) => a.andi("b", 0x0f, eaD(0)))).toBe("0200000f");
    expect(encode((a) => a.ori("w", 1, eaD(0)))).toBe("00400001");
    expect(encode((a) => a.addq("l", 1, eaD(0)))).toBe("5280");
    expect(encode((a) => a.subq("w", 8, eaA(0)))).toBe("5148");
  });

  it("encodes the unary operations and the multiplies", () => {
    expect(encode((a) => a.clr("l", eaD(0)))).toBe("4280");
    expect(encode((a) => a.neg("l", eaD(0)))).toBe("4480");
    expect(encode((a) => a.not("l", eaD(0)))).toBe("4680");
    expect(encode((a) => a.tst("l", eaD(0)))).toBe("4a80");
    expect(encode((a) => a.ext("w", 0))).toBe("4880");
    expect(encode((a) => a.ext("l", 0))).toBe("48c0");
    expect(encode((a) => a.swap(0))).toBe("4840");
    expect(encode((a) => a.muls(eaD(1), 0))).toBe("c1c1");
    expect(encode((a) => a.mulu(eaD(1), 0))).toBe("c0c1");
    expect(encode((a) => a.divu(eaD(1), 0))).toBe("80c1");
  });

  it("encodes shifts by a constant and by a register", () => {
    expect(encode((a) => a.asr("l", 1, 0))).toBe("e280");
    expect(encode((a) => a.asl("l", 1, 0))).toBe("e380");
    expect(encode((a) => a.lsr("l", 8, 0))).toBe("e088");
    expect(encode((a) => a.lsl("w", 3, 2))).toBe("e74a");
    expect(encode((a) => a.lsrReg("l", 1, 0))).toBe("e2a8");
    expect(encode((a) => a.roxl("l", 1, 0))).toBe("e390");
  });

  it("encodes the bit operations, whose bit number is its own word", () => {
    expect(encode((a) => a.btst(0, eaD(0)))).toBe("08000000");
    expect(encode((a) => a.bset(3, eaAbs(0xff9000)))).toBe("08f800039000");
    expect(encode((a) => a.bclr(7, eaInd(0)))).toBe("08900007");
  });
});

describe("control flow", () => {
  it("always takes the word form of a branch, and measures it from the operand", () => {
    // Both branches jump forward over one `nop`: the displacement is relative to
    // the extension word, so it is 4 and not 6.
    expect(
      encode((a) => {
        a.bra(label("here"));
        a.nop();
        a.label("here");
      }),
    ).toBe("600000044e71");
    expect(
      encode((a) => {
        a.bcc("eq", label("here"));
        a.nop();
        a.label("here");
      }),
    ).toBe("670000044e71");
  });

  it("refuses a branch it cannot reach rather than wrapping it", () => {
    const asm = new Asm68k(0);
    asm.bra(label("far"));
    asm.ds(0x8000);
    asm.label("far");
    expect(() => asm.assemble()).toThrow(AsmError);
  });

  it("encodes absolute jumps, subroutine calls and returns", () => {
    expect(encode((a) => a.jmp(0x1234))).toBe("4ef81234");
    expect(encode((a) => a.jmp(label("x")).label("x"))).toBe("4ef900000006");
    expect(encode((a) => a.jsr(0x1234))).toBe("4eb81234");
    expect(encode((a) => a.rts())).toBe("4e75");
    expect(encode((a) => a.rte())).toBe("4e73");
    expect(encode((a) => a.nop())).toBe("4e71");
    expect(encode((a) => a.dbra(0, label("l")).label("l"))).toBe("51c80002");
    expect(encode((a) => a.moveToSr(eaImm(0x2700)))).toBe("46fc2700");
  });

  it("encodes lea and pea", () => {
    expect(encode((a) => a.lea(eaAbs(0xff8000), 0))).toBe("41f88000");
    expect(encode((a) => a.lea(eaDisp(1, 8), 2))).toBe("45e90008");
    expect(encode((a) => a.pea(eaAbs(0xff8000)))).toBe("48788000");
  });
});

describe("data", () => {
  it("writes words and longs big-endian, which is what the pool depends on", () => {
    expect(encode((a) => a.dw(0x1234))).toBe("1234");
    expect(encode((a) => a.dl(0x12345678))).toBe("12345678");
    // `dd` is the name every backend's constant pool uses, and on this console it
    // has to be the same four bytes a `move.l` reads back.
    expect(encode((a) => a.dd(-1))).toBe("ffffffff");
  });

  it("pads an odd byte run, because a word access to an odd address faults", () => {
    expect(encode((a) => a.db(1, 2, 3).align().dw(0x4444))).toBe("010203004444");
  });
});
