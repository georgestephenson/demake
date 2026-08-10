/**
 * The V810 interpreter, driven by `@demake/core`'s own encoder.
 *
 * The two-oracle arrangement every core in this project has: the encoder is
 * pinned against the published format tables in `packages/core/test/v810.test.ts`
 * and the decoder is written from the instruction set, so an encoder and a
 * decoder that agreed with each other and not with the hardware would fail one
 * of the two. What is checked here is what a demade cartridge's arithmetic
 * actually rests on:
 *
 *   - The four flags, and the two conditions that are only right when `OV` is —
 *     a signed comparison across the sign boundary is what a game's every
 *     coordinate test is.
 *   - The 64-bit product, because a 16.16 multiply *reads the high half*: a
 *     model that computed only the low one is right for small numbers and
 *     silently wrong for the ones a fixed-point multiply is made of.
 *   - That `mul` and `div` write `r30` whether or not anyone asked, which is the
 *     one thing about this processor a backend can lose a live value to.
 *   - That a displacement is measured from the instruction's own address, which
 *     no other machine in this project does.
 */

import { describe, expect, it } from "vitest";

import { Asm810, packVbRom, SR_PSW, V810_LP, V810_R0, VB_ROM, VB_WRAM } from "@demake/core";

import { PSW_CY, PSW_OV, PSW_S, PSW_Z, R30, V810, type Bus } from "../src/cpu.js";

/** A flat 64 KiB of memory with the program at zero — the simplest bus there is. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x10000);
  read(address: number): number {
    return this.memory[address & 0xffff] as number;
  }
  write(address: number, value: number): void {
    this.memory[address & 0xffff] = value & 0xff;
  }
}

/** Assemble at zero, run `steps` instructions, and hand back the processor. */
function run(build: (asm: Asm810) => void, steps = 64): V810 {
  const asm = new Asm810(0);
  build(asm);
  const bus = new Flat();
  bus.memory.set(asm.assemble(), 0);
  const cpu = new V810(bus);
  cpu.reset(0);
  for (let index = 0; index < steps; index += 1) cpu.step();
  return cpu;
}

describe("the V810 interpreter", () => {
  it("adds and subtracts with all four flags", () => {
    const cpu = run((asm) => {
      asm.movImm32(0x7fffffff, 10);
      asm.movImm5(1, 11);
      asm.add(11, 10); // overflows into the negative
    }, 4);
    expect(cpu.r[10]).toBe(-0x80000000);
    expect(cpu.psw & PSW_OV).toBeTruthy();
    expect(cpu.psw & PSW_S).toBeTruthy();
    expect(cpu.psw & PSW_Z).toBeFalsy();

    const borrow = run((asm) => {
      asm.movImm5(1, 10);
      asm.movImm5(2, 11);
      asm.sub(11, 10); // 1 - 2 borrows
    }, 3);
    expect(borrow.r[10]).toBe(-1);
    expect(borrow.psw & PSW_CY).toBeTruthy();
  });

  it("compares signed values across the sign boundary", () => {
    // `lt` is S xor OV, which is the whole reason the flag exists: a plain sign
    // test says -1 < 1 correctly and $80000000 < 1 wrongly.
    const cpu = run((asm) => {
      asm.movImm32(-0x80000000, 10);
      asm.movImm5(1, 11);
      asm.cmp(11, 10);
      asm.setf("lt", 12);
      asm.setf("gt", 13);
    }, 6);
    expect(cpu.r[12]).toBe(1);
    expect(cpu.r[13]).toBe(0);
  });

  it("multiplies into two registers", () => {
    const cpu = run((asm) => {
      asm.movImm32(0x00010000, 10); // 1.0 in 16.16
      asm.movImm32(0x00018000, 11); // 1.5
      asm.mul(11, 10);
    }, 5);
    // The product is $0001_8000_0000, whose middle 32 bits are 1.5 in 16.16 —
    // and it only exists because the high half went to r30.
    expect(cpu.r[10] as number).toBe(0x80000000 | 0);
    expect(cpu.r[R30]).toBe(1);
    const combined = ((cpu.r[R30] as number) * 0x10000 + ((cpu.r[10] as number) >>> 16)) | 0;
    expect(combined).toBe(0x00018000);
  });

  it("keeps a signed product signed", () => {
    const cpu = run((asm) => {
      asm.movImm32(-3, 10);
      asm.movImm32(0x10000, 11);
      asm.mul(11, 10);
    }, 5);
    expect(cpu.r[10]).toBe(-3 * 0x10000);
    expect(cpu.r[R30]).toBe(-1); // the sign, all the way into the high half
  });

  it("divides into a quotient and a remainder", () => {
    const cpu = run((asm) => {
      asm.movImm32(-7, 10);
      asm.movImm5(2, 11);
      asm.div(11, 10);
    }, 4);
    // Truncating toward zero, which is what the hardware does and what the
    // fixed-point layer above it is written against.
    expect(cpu.r[10]).toBe(-3);
    expect(cpu.r[R30]).toBe(-1);
  });

  it("takes an exception on a divide by zero rather than producing a number", () => {
    const cpu = run((asm) => {
      asm.movImm5(1, 10);
      asm.movImm5(0, 11);
      asm.div(11, 10);
    }, 3);
    expect(cpu.pc).toBe(0xffffff80);
  });

  it("shifts, with the last bit out in the carry", () => {
    const cpu = run((asm) => {
      asm.movImm32(-1, 10);
      asm.shrImm5(31, 10);
      asm.movImm32(-1, 11);
      asm.sarImm5(31, 11);
      asm.movImm5(1, 12);
      asm.shlImm5(31, 12);
    }, 6);
    expect(cpu.r[10]).toBe(1);
    expect(cpu.r[11]).toBe(-1);
    expect(cpu.r[12]).toBe(-0x80000000);
  });

  it("loads and stores each width, sign-extending where the opcode says", () => {
    const asm = new Asm810(0);
    asm.movImm32(0x1000, 10);
    asm.movImm32(-2, 11);
    asm.stb(11, 0, 10);
    asm.sth(11, 2, 10);
    asm.stw(11, 4, 10);
    asm.ldb(0, 10, 12); // sign-extends
    asm.inb(0, 10, 13); // zero-extends — the whole difference between the two
    asm.ldh(2, 10, 14);
    asm.ldw(4, 10, 15);
    const bus = new Flat();
    bus.memory.set(asm.assemble(), 0);
    const cpu = new V810(bus);
    cpu.reset(0);
    for (let index = 0; index < 9; index += 1) cpu.step();
    expect(cpu.r[12]).toBe(-2);
    expect(cpu.r[13]).toBe(0xfe);
    expect(cpu.r[14]).toBe(-2);
    expect(cpu.r[15]).toBe(-2);
    expect(bus.memory[0x1000]).toBe(0xfe);
    expect(bus.memory[0x1005]).toBe(0xff);
  });

  it("measures a branch from the instruction's own address", () => {
    // Not from the one after it. A `br` to itself is a two-instruction infinite
    // loop everywhere else and a one-instruction one here.
    const asm = new Asm810(0);
    asm.movImm5(7, 10);
    asm.label("Here");
    asm.br("Here");
    const bus = new Flat();
    bus.memory.set(asm.assemble(), 0);
    const cpu = new V810(bus);
    cpu.reset(0);
    cpu.step();
    const at = cpu.pc;
    cpu.step();
    expect(cpu.pc).toBe(at);
  });

  it("calls and returns through the link register", () => {
    const cpu = run((asm) => {
      asm.movImm5(0, 10);
      asm.jal("Add");
      asm.addImm5(1, 10);
      asm.label("Stop");
      asm.br("Stop");
      asm.label("Add");
      asm.addImm5(4, 10);
      asm.jmp(V810_LP);
    }, 6);
    expect(cpu.r[10]).toBe(5);
  });

  it("builds a 32-bit constant whose low half has bit 15 set", () => {
    // The correction `movea`'s sign extension needs, executed rather than
    // asserted about — this is the address of this console's whole register page.
    const cpu = run((asm) => {
      asm.movImm32(0x0005f800, 10);
      asm.movImm32(0x05000000 + 0xf800, 11);
    }, 4);
    expect(cpu.r[10]).toBe(0x0005f800);
    expect(cpu.r[11]).toBe(0x0500f800);
  });

  it("saves and restores through an interrupt", () => {
    const asm = new Asm810(0);
    // Reset leaves `PSW.NP` set, so a cartridge clears the whole word before
    // anything it enables can be delivered — the one line of boot ceremony this
    // processor insists on.
    asm.ldsr(V810_R0, SR_PSW);
    asm.movImm5(1, 10);
    asm.label("Loop");
    asm.br("Loop");
    asm.padTo(0x100);
    asm.label("Handler");
    asm.movImm5(2, 11);
    asm.reti();
    const bus = new Flat();
    bus.memory.set(asm.assemble(), 0);
    const cpu = new V810(bus);
    cpu.reset(0);
    cpu.step();
    cpu.step();
    const before = cpu.pc;
    expect(cpu.interrupt(0xfe40, 0x100)).toBe(true);
    cpu.step();
    cpu.step();
    expect(cpu.r[11]).toBe(2);
    expect(cpu.pc).toBe(before);
    // ...and a second interrupt is refused while the first is being handled,
    // because taking one would clobber the return address.
    cpu.interrupt(0xfe40, 0x100);
    expect(cpu.interrupt(0xfe40, 0x100)).toBe(false);
  });

  it("refuses interrupts while they are masked", () => {
    const cpu = run((asm) => {
      asm.ldsr(V810_R0, SR_PSW);
      asm.sei();
    }, 2);
    expect(cpu.interrupt(0xfe40, 0x100)).toBe(false);
  });

  it("runs a cartridge from the reset vector at the top of the address space", () => {
    // The whole boot: a 27-bit address bus puts `$FFFFFFF0` inside the
    // cartridge's own last sixteen bytes, so the stub there is what jumps to the
    // program — from a mirror the image was not assembled at.
    const asm = new Asm810(VB_ROM);
    asm.movImm32(0x1234, 10);
    asm.movImm32(VB_WRAM, 11);
    asm.stw(10, 0, 11);
    asm.label("Stop");
    asm.br("Stop");
    const rom = packVbRom(asm.assemble(), { title: "BOOT" });

    const wram = new Uint8Array(0x10000);
    const bus: Bus = {
      read: (address) => {
        const at = address >>> 0;
        if ((at & 0x07000000) === 0x05000000) return wram[at & 0xffff] as number;
        return rom[at & (rom.length - 1)] as number;
      },
      write: (address, value) => {
        const at = address >>> 0;
        if ((at & 0x07000000) === 0x05000000) wram[at & 0xffff] = value & 0xff;
      },
    };
    const cpu = new V810(bus);
    cpu.reset(0xfffffff0);
    for (let index = 0; index < 16; index += 1) cpu.step();
    expect(wram[0] as number).toBe(0x34);
    expect(wram[1] as number).toBe(0x12);
  });

  it("discards writes to r0", () => {
    const cpu = run((asm) => {
      asm.movImm5(9, V810_R0);
      asm.mov(V810_R0, 10);
    }, 2);
    expect(cpu.r[0]).toBe(0);
    expect(cpu.r[10]).toBe(0);
  });
});
