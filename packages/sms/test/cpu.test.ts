/**
 * The Z80 core, driven by the assembler that will generate its input.
 *
 * Written the way `packages/demotic/test/nes-arith.test.ts` is: assemble a short
 * program with `core`'s own encoder, run it, and compare against arithmetic done
 * in TypeScript. Testing the two together is the point — an encoder and a decoder
 * that agree with each other but not with the hardware would pass a test written
 * against either one alone, and the published opcode bytes are what tie them both
 * to the real thing.
 *
 * The cases are chosen for what a generated game depends on and what is easy to
 * get wrong, not for coverage of the instruction set: the flags a comparison
 * branches on, the carry's polarity through a multi-byte subtract, the index
 * displacement's sign, and the two instructions whose operand order is unusual.
 */

import { AsmZ80, label } from "@demake/core";
import { describe, expect, it } from "vitest";

import { FLAG, Z80, type Bus } from "../src/cpu.js";

/** A flat 64 KiB of memory and a port space that records what it was told. */
class Board implements Bus {
  readonly memory = new Uint8Array(0x10000);
  readonly ports = new Map<number, number>();
  readonly written: { port: number; value: number }[] = [];

  read(address: number): number {
    return this.memory[address & 0xffff] as number;
  }
  write(address: number, value: number): void {
    this.memory[address & 0xffff] = value & 0xff;
  }
  in(port: number): number {
    return this.ports.get(port & 0xff) ?? 0xff;
  }
  out(port: number, value: number): void {
    this.written.push({ port: port & 0xff, value: value & 0xff });
  }
}

/**
 * Assemble, load at `$0000`, and run until the program halts.
 *
 * Every program ends in `halt`, which is both how the harness knows it is done
 * and a guard: a program that runs off its own end reaches the zero-filled rest
 * of memory, which is `nop`, and would spin rather than fail.
 */
function run(
  build: (asm: AsmZ80) => void,
  options: { sp?: number } = {},
): { cpu: Z80; board: Board } {
  const asm = new AsmZ80(0);
  build(asm);
  asm.halt();
  const board = new Board();
  board.memory.set(asm.assemble(), 0);
  const cpu = new Z80(board);
  cpu.reset();
  cpu.sp = options.sp ?? 0xdff0;
  for (let steps = 0; steps < 200_000 && !cpu.halted; steps += 1) cpu.step();
  if (!cpu.halted) throw new Error("the program did not halt");
  return { cpu, board };
}

describe("the Z80 core", () => {
  it("adds and subtracts bytes, with the carry the manual describes", () => {
    const { cpu } = run((asm) => {
      asm.ldn("a", 0xf0);
      asm.ldn("b", 0x20);
      asm.alu("add", "b"); // $110 → $10, carry out
    });
    expect(cpu.a).toBe(0x10);
    expect(cpu.f & FLAG.c).toBe(FLAG.c);
    expect(cpu.f & FLAG.n).toBe(0);

    const sub = run((asm) => {
      asm.ldn("a", 0x10);
      asm.ldn("b", 0x20);
      asm.alu("sub", "b"); // borrows
    });
    expect(sub.cpu.a).toBe(0xf0);
    expect(sub.cpu.f & FLAG.c).toBe(FLAG.c);
    expect(sub.cpu.f & FLAG.n).toBe(FLAG.n);
  });

  it("sets P/V to signed overflow after arithmetic, not to parity", () => {
    // The distinction a comparison compiled to `jp pe` rests on. $50 + $50 is
    // $A0, which is a positive plus a positive giving a negative.
    const overflow = run((asm) => {
      asm.ldn("a", 0x50);
      asm.aluN("add", 0x50);
    });
    expect(overflow.cpu.a).toBe(0xa0);
    expect(overflow.cpu.f & FLAG.pv).toBe(FLAG.pv);

    // The same byte value out of a logical operation reports its parity instead:
    // $A0 has two bits set, so parity is even.
    const parity = run((asm) => {
      asm.ldn("a", 0xa0);
      asm.aluN("or", 0x00);
    });
    expect(parity.cpu.a).toBe(0xa0);
    expect(parity.cpu.f & FLAG.pv).toBe(FLAG.pv);

    const odd = run((asm) => {
      asm.ldn("a", 0xa1);
      asm.aluN("or", 0x00);
    });
    expect(odd.cpu.f & FLAG.pv).toBe(0);
  });

  it("compares signed values through sign-exclusive-or-overflow", () => {
    // How the backend's `<` is built: after `cp`, the value is less than the
    // accumulator exactly when S differs from P/V. Checked here on the pair that
    // makes a naive unsigned comparison give the wrong answer.
    const cases: [number, number, boolean][] = [
      [0x01, 0x02, true], // 1 < 2
      [0x02, 0x01, false],
      [0xff, 0x01, true], // -1 < 1
      [0x01, 0xff, false], // 1 > -1
      [0x80, 0x7f, true], // -128 < 127
    ];
    for (const [left, right, expected] of cases) {
      const { cpu } = run((asm) => {
        asm.ldn("a", left);
        asm.aluN("cp", right);
      });
      const sign = (cpu.f & FLAG.s) !== 0;
      const overflow = (cpu.f & FLAG.pv) !== 0;
      expect(sign !== overflow).toBe(expected);
    }
  });

  it("carries a 32-bit subtract through two sbc hl instructions", () => {
    // What a 16.16 subtraction compiles to. $0001_0000 − $0000_8000 = $0000_8000,
    // which only comes out right if the carry survives between the halves.
    const { cpu, board } = run((asm) => {
      asm.ld16("hl", 0x0000);
      asm.ld16("de", 0x8000);
      asm.aluN("or", 0x00); // clear the carry without touching a register
      asm.sbcHL("de");
      asm.st16To(0xc000, "hl");
      asm.ld16("hl", 0x0001);
      asm.ld16("de", 0x0000);
      asm.sbcHL("de");
      asm.st16To(0xc002, "hl");
    });
    expect(cpu.halted).toBe(true);
    const low = (board.memory[0xc000] as number) | ((board.memory[0xc001] as number) << 8);
    const high = (board.memory[0xc002] as number) | ((board.memory[0xc003] as number) << 8);
    expect(low).toBe(0x8000);
    expect(high).toBe(0x0000);
  });

  it("addresses an entity record through a signed index displacement", () => {
    const { board } = run((asm) => {
      asm.ld16Idx("ix", 0xc010);
      asm.ldn("a", 0x5a);
      asm.stIdx("ix", 4, "a");
      asm.stIdx("ix", -8, "a");
      asm.ldIdx("b", "ix", 4);
      asm.ld("a", "b");
      asm.stIdx("ix", 0, "a");
    });
    expect(board.memory[0xc014]).toBe(0x5a);
    expect(board.memory[0xc008]).toBe(0x5a);
    expect(board.memory[0xc010]).toBe(0x5a);
  });

  it("runs a block copy the way a tile upload does", () => {
    const { board } = run((asm) => {
      asm.ld16("hl", label("Source"));
      asm.ld16("de", 0xc100);
      asm.ld16("bc", 4);
      asm.ldir();
      asm.jp("Done");
      asm.label("Source");
      asm.db(0x11, 0x22, 0x33, 0x44);
      asm.label("Done");
    });
    expect([...board.memory.subarray(0xc100, 0xc104)]).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it("decrements b before the port write in an otir loop", () => {
    // The order matters because the port address carries `b` in its high half,
    // which is how a VDP upload loop is written — and getting it backwards
    // writes one byte too many on the last iteration.
    const { board } = run((asm) => {
      asm.ld16("hl", label("Bytes"));
      asm.ldn("b", 3);
      asm.ldn("c", 0xbe);
      asm.otir();
      asm.jp("Done");
      asm.label("Bytes");
      asm.db(0xaa, 0xbb, 0xcc);
      asm.label("Done");
    });
    expect(board.written.map((entry) => entry.value)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(board.written.every((entry) => entry.port === 0xbe)).toBe(true);
  });

  it("calls and returns through the stack", () => {
    const { cpu, board } = run((asm) => {
      asm.ld16("sp", 0xdff0);
      asm.call("Twice");
      asm.sta(0xc200);
      asm.jp("Done");
      asm.label("Twice");
      asm.ldn("a", 21);
      asm.alu("add", "a");
      asm.ret();
      asm.label("Done");
    });
    expect(board.memory[0xc200]).toBe(42);
    expect(cpu.sp).toBe(0xdff0);
  });

  it("takes a conditional return on the parity flag", () => {
    const { board } = run((asm) => {
      asm.ld16("sp", 0xdff0);
      asm.ldn("a", 0x50);
      asm.aluN("add", 0x50); // sets P/V: signed overflow
      asm.call("Maybe");
      asm.jp("Done");
      asm.label("Maybe");
      asm.ret("pe"); // taken, so the store below never runs
      asm.ldn("a", 0);
      asm.sta(0xc300);
      asm.ret();
      asm.label("Done");
      asm.sta(0xc301);
    });
    expect(board.memory[0xc300]).toBe(0);
    expect(board.memory[0xc301]).toBe(0xa0);
  });

  it("loops with djnz until b runs out", () => {
    const { board } = run((asm) => {
      asm.ldn("b", 5);
      asm.ldn("a", 0);
      asm.label("Loop");
      asm.aluN("add", 3);
      asm.djnz("Loop");
      asm.sta(0xc400);
    });
    expect(board.memory[0xc400]).toBe(15);
  });

  it("swaps the register file with exx and ex af,af'", () => {
    const { cpu } = run((asm) => {
      asm.ld16("bc", 0x1234);
      asm.exx();
      asm.ld16("bc", 0x5678);
      asm.exx();
    });
    expect(cpu.bc).toBe(0x1234);
    expect(cpu.b2).toBe(0x56);
  });

  it("dispatches an interrupt in mode 1 and comes back", () => {
    const asm = new AsmZ80(0);
    asm.jp("Main");
    asm.padTo(0x0038);
    asm.ldn("a", 0x99);
    asm.sta(0xc500);
    asm.ei();
    asm.reti();
    asm.label("Main");
    asm.ld16("sp", 0xdff0);
    asm.im(1);
    asm.ei();
    asm.label("Spin");
    asm.nop();
    asm.jp("Spin");

    const board = new Board();
    board.memory.set(asm.assemble(), 0);
    const cpu = new Z80(board);
    cpu.reset();
    // Run far enough for `ei` to have taken effect, then assert the line.
    for (let steps = 0; steps < 20; steps += 1) cpu.step();
    expect(cpu.iff1).toBe(true);
    expect(cpu.interrupt()).toBe(13);
    for (let steps = 0; steps < 10; steps += 1) cpu.step();
    expect(board.memory[0xc500]).toBe(0x99);
    // `ei` re-enabled them, and `reti` returned to the spin loop.
    expect(cpu.iff1).toBe(true);
    expect(cpu.pc).toBeGreaterThan(0x0038);
  });

  it("does not accept an interrupt in the shadow of ei", () => {
    // The window that makes `ei` / `ret` at the end of a handler safe.
    const asm = new AsmZ80(0);
    asm.ld16("sp", 0xdff0);
    asm.im(1);
    asm.di();
    asm.ei();
    asm.nop();
    asm.halt();
    const board = new Board();
    board.memory.set(asm.assemble(), 0);
    const cpu = new Z80(board);
    cpu.reset();
    cpu.step(); // ld sp
    cpu.step(); // im 1
    cpu.step(); // di
    cpu.step(); // ei — interrupts are on, but not until after the next instruction
    expect(cpu.iff1).toBe(true);
    expect(cpu.interrupt()).toBe(0);
    cpu.step(); // nop
    expect(cpu.interrupt()).toBe(13);
  });

  it("takes a non-maskable interrupt whether or not interrupts are enabled", () => {
    const board = new Board();
    const cpu = new Z80(board);
    cpu.reset();
    cpu.sp = 0xdff0;
    cpu.iff1 = false;
    expect(cpu.nmi()).toBe(11);
    expect(cpu.pc).toBe(0x0066);
  });
});
