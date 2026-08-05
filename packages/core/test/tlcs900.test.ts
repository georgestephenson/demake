/**
 * The TLCS-900/H assembler, as an encoder.
 *
 * Tested for the reason every encoder here is: it decides output bytes. What
 * gets the attention is the thing this architecture does that no other CPU in
 * the project does — **the operand comes before the opcode** — because a prefix
 * assembled with the wrong role or the wrong group still decodes as *an*
 * instruction, on a different operand, and a program built from it would run.
 * That is the ARM encoder's argument (`arm.test.ts`) reached by different
 * hardware, and it is why the prefix cases below outnumber the opcode ones.
 *
 * Four properties, in the order they can go wrong:
 *
 *   - A memory operand's prefix says group, role and form in one byte, and the
 *     role is what a *source* and a *destination* differ by. `ld (mem),R` and
 *     `add (mem),R` are the pair that proves it: both write to memory, and only
 *     one of them uses the destination prefix, because only one has a size in
 *     its opcode.
 *   - The shortest encoding of an address is a property of the address. An
 *     operand below `$100` is one byte, one below `$10000` is two, and a label
 *     is three — so the internal I/O page costs what it should and a forward
 *     reference is never short.
 *   - The opcode after the prefix is the one the four code maps give, for each
 *     of the blocks a backend will actually reach.
 *   - What the hardware cannot mean is refused rather than encoded: a load
 *     between registers of different widths, a widening multiply whose
 *     destination is the wrong size, a shift by seventeen, a branch out of
 *     range.
 *
 * Three cases are the manual's own worked examples rather than this file's
 * reading of a table — `jr $2078`, `sla 4,hl` and `bit 5,($100)` — because an
 * example carries its object code and a table has to be interpreted.
 *
 * Sources: Toshiba — TLCS-900 Series User's Manual, Appendix C instruction code
 * maps (four first-byte tables), Appendix A per-instruction encodings, and the
 * `mem`/`cc`/register specify codes in front of Appendix A.
 */

import { describe, expect, it } from "vitest";

import { abs, Asm900, AsmError, at, indexed, invert, postinc, predec } from "../src/asm/tlcs900.js";

/** Assemble one instruction and read its bytes back. */
function bytes(build: (asm: Asm900) => void, origin = 0): number[] {
  const asm = new Asm900(origin);
  build(asm);
  return [...asm.assemble()];
}

describe("the TLCS-900/H operand prefix", () => {
  it("names a base register with no displacement in one byte", () => {
    // Register W, WA and XWA are all code 0, so across these six cases the only
    // thing moving is the size — which is the point being made.
    //
    // (XHL) as a byte source is $83: bit 7 set, group 0, role 00, form 3.
    expect(bytes((a) => a.ldm("w", at("xhl")))).toEqual([0x83, 0x20]);
    // The same operand as a word source moves only the role: $93.
    expect(bytes((a) => a.ldm("wa", at("xhl")))).toEqual([0x93, 0x20]);
    // ...and as a long source, $A3.
    expect(bytes((a) => a.ldm("xwa", at("xhl")))).toEqual([0xa3, 0x20]);
    // ...and as a destination, $B3 for all three — which is where the size stops
    // being in the prefix and starts being in the opcode ($40/$50/$60).
    expect(bytes((a) => a.stm(at("xhl"), "w"))).toEqual([0xb3, 0x40]);
    expect(bytes((a) => a.stm(at("xhl"), "wa"))).toEqual([0xb3, 0x50]);
    expect(bytes((a) => a.stm(at("xhl"), "xwa"))).toEqual([0xb3, 0x60]);
  });

  it("puts a small displacement in the low nibble and a byte after it", () => {
    // (XIX+4) as a word source: form 8|4, so $9C, then the displacement.
    expect(bytes((a) => a.ldm("wa", at("xix", 4)))).toEqual([0x9c, 0x04, 0x20]);
    // A negative displacement is the same form with a two's-complement byte.
    expect(bytes((a) => a.aluMem("sub", "wa", at("xiy", -2)))).toEqual([0x9d, 0xfe, 0xa0]);
  });

  it("falls back to the 16-bit displacement form when a byte will not hold it", () => {
    // Group 1 form 3, then the register's file address with its low two bits
    // saying "displacement follows", then the displacement itself.
    expect(bytes((a) => a.ldm("a", at("xhl", 0x1000)))).toEqual([0xc3, 0xed, 0x00, 0x10, 0x21]);
    expect(bytes((a) => a.ldm("a", at("xhl", -1)))).toEqual([0x8b, 0xff, 0x21]);
  });

  it("takes the shortest absolute form the address allows", () => {
    // The internal I/O page is one operand byte.
    expect(bytes((a) => a.ldm("a", abs(0x20)))).toEqual([0xc0, 0x20, 0x21]);
    // Work RAM is two.
    expect(bytes((a) => a.ldm("a", abs(0x4000)))).toEqual([0xc1, 0x00, 0x40, 0x21]);
    // The cartridge is three.
    expect(bytes((a) => a.ldm("a", abs(0x200000)))).toEqual([0xc2, 0x00, 0x00, 0x20, 0x21]);
  });

  it("gives a forward reference the full 24 bits", () => {
    const asm = new Asm900(0x200000);
    asm.ldm("a", abs("Table"));
    asm.label("Table");
    asm.db(0x99);
    // Three address bytes, patched to the label — never the short form, because
    // an unresolved reference has no value to be short about.
    expect([...asm.assemble()]).toEqual([0xc2, 0x05, 0x00, 0x20, 0x21, 0x99]);
  });

  it("encodes the auto-stepping and register-index forms", () => {
    // (-XSP) as a destination: form 4, then the register file address with the
    // step in its low two bits.
    expect(bytes((a) => a.stm(predec("xsp"), "a"))).toEqual([0xf4, 0xfc, 0x41]);
    // (XHL+) stepping by two: form 5, step code 01.
    expect(bytes((a) => a.ldm("wa", postinc("xhl", 2)))).toEqual([0xd5, 0xed, 0x20]);
    // (XIX + A): form 3 with the sub-mode saying "8-bit register index", then
    // the two register file addresses.
    expect(bytes((a) => a.ldm("a", indexed("xix", "a")))).toEqual([0xc3, 0x03, 0xf0, 0xe0, 0x21]);
    // A 16-bit index is the same shape with a different sub-mode.
    expect(bytes((a) => a.ldm("a", indexed("xix", "wa")))).toEqual([0xc3, 0x07, 0xf0, 0xe0, 0x21]);
  });

  it("uses a source prefix for `add (mem),R` and a destination one for `ld (mem),R`", () => {
    // The pair this whole file exists to keep straight. `ld` carries its size in
    // the opcode, so its operand is a destination; `add` does not, so its
    // operand is a *source* prefix even though the memory is written to.
    expect(bytes((a) => a.stm(abs(0x4100), "a"))).toEqual([0xf1, 0x00, 0x41, 0x41]);
    expect(bytes((a) => a.aluToMem("add", abs(0x4100), "a"))).toEqual([0xc1, 0x00, 0x41, 0x89]);
  });
});

describe("the TLCS-900/H assembler", () => {
  it("encodes register-to-register loads and the short immediate forms", () => {
    expect(bytes((a) => a.ld("xwa", "xhl"))).toEqual([0xeb, 0x88]);
    expect(bytes((a) => a.ld("a", "b"))).toEqual([0xca, 0x89]);
    expect(bytes((a) => a.ldn("a", 0x42))).toEqual([0x21, 0x42]);
    expect(bytes((a) => a.ldn("hl", 0x1234))).toEqual([0x33, 0x34, 0x12]);
    expect(bytes((a) => a.ldn("xwa", 0x00012345))).toEqual([0x40, 0x45, 0x23, 0x01, 0x00]);
  });

  it("encodes an immediate into memory, byte and word", () => {
    expect(bytes((a) => a.stmi(abs(0x20), "b", 0xff))).toEqual([0xf0, 0x20, 0x00, 0xff]);
    expect(bytes((a) => a.stmi(abs(0x4000), "w", 0x1234))).toEqual([
      0xf1, 0x00, 0x40, 0x02, 0x34, 0x12,
    ]);
  });

  it("encodes `lda`, which writes the address rather than the contents", () => {
    expect(bytes((a) => a.lda("xix", at("xhl", 8)))).toEqual([0xbb, 0x08, 0x34]);
    expect(bytes((a) => a.lda("hl", abs(0x4000)))).toEqual([0xf1, 0x00, 0x40, 0x23]);
  });

  it("encodes the stack forms", () => {
    expect(bytes((a) => a.push("xwa"))).toEqual([0x38]);
    expect(bytes((a) => a.push("hl"))).toEqual([0x2b]);
    expect(bytes((a) => a.pop("xhl"))).toEqual([0x5b]);
    expect(bytes((a) => a.pop("bc"))).toEqual([0x49]);
    // A byte register has no short form and goes through the general one.
    expect(bytes((a) => a.pushReg("a"))).toEqual([0xc9, 0x04]);
    expect(bytes((a) => a.popReg("a"))).toEqual([0xc9, 0x05]);
    expect(bytes((a) => a.pushA())).toEqual([0x14]);
    expect(bytes((a) => a.popF())).toEqual([0x19]);
  });

  it("lays the eight ALU operations out as one block of opcodes", () => {
    // add, adc, sub, sbc, and, xor, or, cp — sixteen apart, in that order.
    expect(bytes((a) => a.alu("add", "xwa", "xbc"))).toEqual([0xe9, 0x80]);
    expect(bytes((a) => a.alu("adc", "xwa", "xbc"))).toEqual([0xe9, 0x90]);
    expect(bytes((a) => a.alu("sub", "xwa", "xbc"))).toEqual([0xe9, 0xa0]);
    expect(bytes((a) => a.alu("cp", "a", "b"))).toEqual([0xca, 0xf1]);
    expect(bytes((a) => a.aluImm("add", "xwa", 0x10000))).toEqual([
      0xe8, 0xc8, 0x00, 0x00, 0x01, 0x00,
    ]);
    expect(bytes((a) => a.aluImm("cp", "a", 7))).toEqual([0xc9, 0xcf, 0x07]);
    expect(bytes((a) => a.aluMemImm("and", at("xhl"), "b", 0x0f))).toEqual([0x83, 0x3c, 0x0f]);
  });

  it("encodes increments, decrements and the unary operations", () => {
    expect(bytes((a) => a.inc(1, "a"))).toEqual([0xc9, 0x61]);
    // Eight is spelled zero, which is the hardware's arrangement.
    expect(bytes((a) => a.inc(8, "xhl"))).toEqual([0xeb, 0x60]);
    expect(bytes((a) => a.dec(2, "wa"))).toEqual([0xd8, 0x6a]);
    expect(bytes((a) => a.incMem(1, abs(0x30), "b"))).toEqual([0xc0, 0x30, 0x61]);
    expect(bytes((a) => a.neg("xwa"))).toEqual([0xe8, 0x07]);
    expect(bytes((a) => a.cpl("a"))).toEqual([0xc9, 0x06]);
    expect(bytes((a) => a.exts("xhl"))).toEqual([0xeb, 0x13]);
    expect(bytes((a) => a.extz("xhl"))).toEqual([0xeb, 0x12]);
  });

  it("encodes the multiply and divide, whose operands are different widths", () => {
    expect(bytes((a) => a.mul("xwa", "wa"))).toEqual([0xd8, 0x40]);
    expect(bytes((a) => a.muls("xwa", "bc"))).toEqual([0xd9, 0x48]);
    expect(bytes((a) => a.div("xwa", "bc"))).toEqual([0xd9, 0x50]);
    expect(bytes((a) => a.divs("wa", "c"))).toEqual([0xcb, 0x58]);
    // The memory forms need no size argument: a widening operation has one
    // shape, so the operand's size follows from the destination's.
    expect(bytes((a) => a.mulMem("wa", at("xhl")))).toEqual([0x83, 0x40]);
    expect(bytes((a) => a.divMem("xwa", at("xhl")))).toEqual([0x93, 0x50]);
  });

  it("encodes the shifts, including the manual's own `sla 4,hl`", () => {
    expect(bytes((a) => a.shift("sla", 4, "hl"))).toEqual([0xdb, 0xec, 0x04]);
    expect(bytes((a) => a.shift("rlc", 1, "a"))).toEqual([0xc9, 0xe8, 0x01]);
    // Sixteen is spelled zero, the same trick the increment plays with eight.
    expect(bytes((a) => a.shift("srl", 16, "a"))).toEqual([0xc9, 0xef, 0x00]);
    expect(bytes((a) => a.shiftA("sra", "xwa"))).toEqual([0xe8, 0xfd]);
    // Memory shifts by exactly one, and there is no long form.
    expect(bytes((a) => a.shiftMem("sla", abs(0x100), "w"))).toEqual([0xd1, 0x00, 0x01, 0x7c]);
  });

  it("encodes the bit operations, including the manual's own `bit 5,($100)`", () => {
    expect(bytes((a) => a.bitMem(5, abs(0x100)))).toEqual([0xf1, 0x00, 0x01, 0xcd]);
    expect(bytes((a) => a.bit(5, "a"))).toEqual([0xc9, 0x33, 0x05]);
    expect(bytes((a) => a.res(0, "a"))).toEqual([0xc9, 0x30, 0x00]);
    expect(bytes((a) => a.set(7, "a"))).toEqual([0xc9, 0x31, 0x07]);
    expect(bytes((a) => a.resMem(0, at("xhl")))).toEqual([0xb3, 0xb0]);
    expect(bytes((a) => a.setMem(3, at("xhl")))).toEqual([0xb3, 0xbb]);
    expect(bytes((a) => a.tsetMem(1, at("xhl")))).toEqual([0xb3, 0xa9]);
    expect(bytes((a) => a.rcf())).toEqual([0x10]);
    expect(bytes((a) => a.scf())).toEqual([0x11]);
  });

  it("encodes jumps and calls, short and long", () => {
    expect(bytes((a) => a.jp(0x2000))).toEqual([0x1a, 0x00, 0x20]);
    expect(bytes((a) => a.jp(0x202000))).toEqual([0x1b, 0x00, 0x20, 0x20]);
    // The conditional jump puts its address in the operand prefix, ahead of the
    // opcode that says which condition it is taken on.
    expect(bytes((a) => a.jpc("nz", 0x202000))).toEqual([0xf2, 0x00, 0x20, 0x20, 0xde]);
    expect(bytes((a) => a.jpm("t", at("xhl")))).toEqual([0xb3, 0xd8]);
    expect(bytes((a) => a.call(0x203000))).toEqual([0x1d, 0x00, 0x30, 0x20]);
    expect(bytes((a) => a.callc("z", 0x4000))).toEqual([0xf1, 0x00, 0x40, 0xe6]);
    expect(bytes((a) => a.ret())).toEqual([0x0e]);
    // `ret cc` opens with $B0, which is otherwise a destination prefix naming
    // (XWA); the operand is never used.
    expect(bytes((a) => a.retc("nz"))).toEqual([0xb0, 0xfe]);
    expect(bytes((a) => a.reti())).toEqual([0x07]);
    expect(bytes((a) => a.retd(4))).toEqual([0x0f, 0x04, 0x00]);
  });

  it("measures a relative branch from the instruction after it", () => {
    // The manual's worked example: JR 2078H assembled at 2000H is 68H 76H.
    const asm = new Asm900(0x2000);
    asm.jr("t", 0x2078);
    expect([...asm.assemble()]).toEqual([0x68, 0x76]);
  });

  it("resolves a relative branch to a forward label", () => {
    const asm = new Asm900(0x200000);
    asm.jr("nz", "Skip"); // 2 bytes
    asm.nop(); // 1 byte
    asm.label("Skip");
    asm.halt();
    expect([...asm.assemble()]).toEqual([0x6e, 0x01, 0x00, 0x05]);
  });

  it("encodes the long relative branch and the counted loop", () => {
    const asm = new Asm900(0x200000);
    asm.jrl("z", "Far");
    asm.ds(300);
    asm.label("Far");
    asm.nop();
    const image = [...asm.assemble()];
    expect(image.slice(0, 3)).toEqual([0x76, 0x2c, 0x01]);
    const asm2 = new Asm900(0x200000);
    asm2.label("Top");
    asm2.nop();
    asm2.djnz("b", "Top");
    // The prefix names B, then $1C, then a displacement back over four bytes.
    expect([...asm2.assemble()]).toEqual([0x00, 0xca, 0x1c, 0xfc]);
  });

  it("encodes the block operations, which name their destination", () => {
    expect(bytes((a) => a.ldir(at("xde"), "b"))).toEqual([0x82, 0x11]);
    expect(bytes((a) => a.ldir(at("xde"), "w"))).toEqual([0x92, 0x11]);
    expect(bytes((a) => a.ldi(at("xde"), "b"))).toEqual([0x82, 0x10]);
    expect(bytes((a) => a.lddr(at("xde"), "b"))).toEqual([0x82, 0x13]);
    expect(bytes((a) => a.cpir(at("xhl"), "b"))).toEqual([0x83, 0x15]);
  });

  it("encodes the odds and ends a runtime needs", () => {
    expect(bytes((a) => a.nop())).toEqual([0x00]);
    expect(bytes((a) => a.halt())).toEqual([0x05]);
    expect(bytes((a) => a.ei(0))).toEqual([0x06, 0x00]);
    // `di` is `ei 7` — the hardware has no separate opcode for it.
    expect(bytes((a) => a.di())).toEqual([0x06, 0x07]);
    expect(bytes((a) => a.swi(3))).toEqual([0xfb]);
    expect(bytes((a) => a.scc("z", "a"))).toEqual([0xc9, 0x76]);
    expect(bytes((a) => a.ex("wa", "hl"))).toEqual([0xdb, 0xb8]);
  });

  it("takes a label as a full-width immediate", () => {
    // What a table walk needs: the table's address loaded into a register, which
    // is a four-byte immediate with a forward reference in it.
    const asm = new Asm900(0x200000);
    asm.ldn("xhl", "Table");
    asm.label("Table");
    asm.db(0x11, 0x22);
    expect([...asm.assemble()]).toEqual([0x43, 0x05, 0x00, 0x20, 0x00, 0x11, 0x22]);
  });

  it("emits three-byte pointers, because that is what an address is here", () => {
    const asm = new Asm900(0x200000);
    asm.d24("Target");
    asm.label("Target");
    expect([...asm.assemble()]).toEqual([0x03, 0x00, 0x20]);
  });
});

describe("inverting a condition", () => {
  it("is one bit, because the sense is bit 3 of the field", () => {
    expect(invert("z")).toBe("nz");
    expect(invert("nz")).toBe("z");
    expect(invert("c")).toBe("nc");
    expect(invert("lt")).toBe("ge");
    expect(invert("le")).toBe("gt");
    expect(invert("ule")).toBe("ugt");
    expect(invert("ov")).toBe("nov");
    expect(invert("mi")).toBe("pl");
    // Including the two that are not comparisons at all.
    expect(invert("t")).toBe("f");
    expect(invert("f")).toBe("t");
  });
});

describe("what the assembler refuses", () => {
  it("refuses a load between registers of different widths", () => {
    expect(() => bytes((a) => a.ld("xwa", "hl" as never))).toThrow(AsmError);
    expect(() => bytes((a) => a.alu("add", "a", "wa" as never))).toThrow(AsmError);
  });

  it("refuses a widening operation whose destination is the wrong size", () => {
    expect(() => bytes((a) => a.mul("wa", "wa"))).toThrow(/twice the source/);
    expect(() => bytes((a) => a.div("xwa", "xhl" as never))).toThrow(/no wider destination/);
  });

  it("refuses counts the encoding cannot hold", () => {
    expect(() => bytes((a) => a.shift("sla", 17, "a"))).toThrow(/1\.\.16/);
    expect(() => bytes((a) => a.shift("sla", 0, "a"))).toThrow(/1\.\.16/);
    expect(() => bytes((a) => a.inc(9, "a"))).toThrow(/1\.\.8/);
    expect(() => bytes((a) => a.inc(0, "a"))).toThrow(/1\.\.8/);
  });

  it("refuses a label where a register displacement is wanted", () => {
    // The encoding's *length* depends on the displacement, so a value the
    // assembler has not seen cannot be one.
    expect(() => bytes((a) => a.ldm("a", at("xhl", "Somewhere" as never)))).toThrow(
      /must be a number/,
    );
  });

  it("refuses a branch that does not reach", () => {
    expect(() =>
      bytes((a) => {
        a.jr("t", 0x200400);
      }, 0x200000),
    ).toThrow(/out of range/);
    const asm = new Asm900(0x200000);
    asm.jr("nz", "Far");
    asm.ds(300);
    asm.label("Far");
    expect(() => asm.assemble()).toThrow(/use jrl or jp/);
  });

  it("refuses an undefined label", () => {
    const asm = new Asm900();
    asm.jp("Nowhere");
    expect(() => asm.assemble()).toThrow(/undefined label/);
  });
});
