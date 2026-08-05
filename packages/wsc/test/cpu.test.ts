/**
 * The V30MZ interpreter, driven by `core`'s own encoder.
 *
 * The arrangement every owned core here uses: the test writes assembly, the
 * encoder under `packages/core/src/asm/` turns it into bytes, and this core runs
 * them. An encoder and a decoder that agreed with each other and not with the
 * hardware would still have to get past `packages/core/test/v30mz-nasm.test.ts`,
 * which compares the same encodings against NASM — so the two files together are
 * a three-way agreement rather than a circle.
 *
 * What is checked here is what a value layer will stand on: the flags after
 * arithmetic (a signed comparison is `SF ^ OF`, and getting it backwards makes a
 * game that plays correctly until something moves left), the 32-bit product and
 * quotient a 16.16 multiply and divide are made of, and the string operations a
 * block copy is.
 */

import {
  Asm30,
  x86Abs as abs,
  x86At as at,
  x86RomAbs as romAbs,
  x86RomAt as romAt,
} from "@demake/core";
import { describe, expect, it } from "vitest";

import { AX, BX, CX, CS, Cpu, CpuError, DI, DS, DX, ES, SI, SP, SS, type Bus } from "../src/cpu.js";

/** A flat megabyte with ports, which is all a CPU test needs of a console. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x100000);
  readonly ports = new Uint8Array(0x100);
  readonly written: { port: number; value: number }[] = [];

  read(address: number): number {
    return this.memory[address & 0xfffff] as number;
  }

  write(address: number, value: number): void {
    this.memory[address & 0xfffff] = value & 0xff;
  }

  readPort(port: number): number {
    return this.ports[port & 0xff] as number;
  }

  writePort(port: number, value: number): void {
    this.ports[port & 0xff] = value & 0xff;
    this.written.push({ port: port & 0xff, value: value & 0xff });
  }
}

/** Assemble, load at `0000:0100`, and run until `hlt`. */
function run(build: (asm: Asm30) => void, prepare?: (bus: Flat) => void): { cpu: Cpu; bus: Flat } {
  const asm = new Asm30(0x100);
  build(asm);
  asm.hlt();
  const code = asm.assemble();
  const bus = new Flat();
  bus.memory.set(code, 0x100);
  prepare?.(bus);
  const cpu = new Cpu(bus);
  cpu.reset();
  cpu.segs[CS] = 0;
  cpu.segs[DS] = 0;
  cpu.segs[ES] = 0;
  cpu.segs[SS] = 0;
  cpu.regs[SP] = 0xfffe;
  cpu.ip = 0x100;
  for (let step = 0; step < 200_000 && !cpu.halted; step += 1) cpu.step();
  if (!cpu.halted) throw new Error("cpu test did not reach hlt");
  return { cpu, bus };
}

describe("the V30MZ", () => {
  it("moves a word through every addressing form", () => {
    const { bus } = run(
      (a) => {
        a.movi("bx", 0x2000);
        a.movm("ax", at("bx", 4)); // [$2004]
        a.movmr(abs(0x3000), "ax");
        a.movi("si", 2);
        a.movm("dx", at("bx+si", 0x10)); // [$2012]
        a.movmr(at("bx", 0x20), "dx");
      },
      (bus) => {
        bus.memory[0x2004] = 0x34;
        bus.memory[0x2005] = 0x12;
        bus.memory[0x2012] = 0x78;
        bus.memory[0x2013] = 0x56;
      },
    );
    expect(bus.memory[0x3000]).toBe(0x34);
    expect(bus.memory[0x3001]).toBe(0x12);
    expect(bus.memory[0x2020]).toBe(0x78);
    expect(bus.memory[0x2021]).toBe(0x56);
  });

  it("reads a table through the code segment without disturbing the data one", () => {
    // The one case that needs the program somewhere other than segment zero:
    // what is being checked is that `cs:` reaches the cartridge while an
    // unprefixed access still reaches RAM, which is the whole arrangement a
    // demade cartridge runs under.
    const asm = new Asm30(0);
    asm.movi("bx", "first");
    asm.movm("ax", romAt("bx"));
    asm.movm("cx", romAbs("second"));
    asm.movm("dx", abs(0x0100)); // no prefix: this one has to reach RAM
    asm.hlt();
    asm.label("first").dw(0xddcc);
    asm.label("second").dw(0xbbaa);
    const bus = new Flat();
    bus.memory.set(asm.assemble(), 0x10000);
    bus.memory[0x0100] = 0x21;
    bus.memory[0x0101] = 0x43;
    const cpu2 = new Cpu(bus);
    cpu2.reset();
    cpu2.segs[CS] = 0x1000;
    cpu2.segs[DS] = 0;
    cpu2.ip = 0;
    while (!cpu2.halted) cpu2.step();
    expect(cpu2.regs[AX]).toBe(0xddcc);
    expect(cpu2.regs[CX]).toBe(0xbbaa);
    expect(cpu2.regs[DX]).toBe(0x4321);
  });

  it("adds thirty-two bits as two instructions, carry and all", () => {
    // $0001_8000 + $0000_C000 = $0002_4000 — the shape of a 16.16 add.
    const { cpu } = run((a) => {
      a.movi("ax", 0x8000);
      a.movi("dx", 0x0001);
      a.aluI("add", "ax", 0xc000);
      a.aluI("adc", "dx", 0);
    });
    expect(cpu.regs[AX]).toBe(0x4000);
    expect(cpu.regs[DX]).toBe(0x0002);
  });

  it("subtracts thirty-two bits, borrow and all", () => {
    const { cpu } = run((a) => {
      a.movi("ax", 0x4000);
      a.movi("dx", 0x0002);
      a.aluI("sub", "ax", 0xc000);
      a.aluI("sbb", "dx", 0);
    });
    expect(cpu.regs[AX]).toBe(0x8000);
    expect(cpu.regs[DX]).toBe(0x0001);
  });

  it("sets the signed condition a comparison of negatives needs", () => {
    // -3 < -1: `jl` has to take it, which means SF and OF differ.
    const { cpu } = run((a) => {
      a.movi("cx", 0);
      a.movi("ax", 0xfffd);
      a.aluI("cmp", "ax", 0xffff);
      a.jcc("ge", "no");
      a.movi("cx", 1);
      a.label("no");
    });
    expect(cpu.regs[CX]).toBe(1);
  });

  it("distinguishes a signed comparison from an unsigned one", () => {
    // $FFFF against $0001: below as a signed number, above as an unsigned one.
    const { cpu } = run((a) => {
      a.movi("ax", 0xffff);
      a.aluI("cmp", "ax", 1);
      a.movi("bx", 0);
      a.movi("dx", 0);
      a.jcc("ge", "notLess");
      a.movi("bx", 1);
      a.label("notLess");
      a.jcc("be", "notAbove");
      a.movi("dx", 1);
      a.label("notAbove");
    });
    expect(cpu.regs[BX]).toBe(1); // signed: less
    expect(cpu.regs[DX]).toBe(1); // unsigned: above
  });

  it("leaves the carry alone across inc and dec, which an adc chain relies on", () => {
    const { cpu } = run((a) => {
      a.stc();
      a.inc("bx");
      a.movi("ax", 0);
      a.aluI("adc", "ax", 0);
    });
    expect(cpu.regs[AX]).toBe(1);
  });

  it("produces a thirty-two-bit product in dx:ax", () => {
    const { cpu } = run((a) => {
      a.movi("ax", 0x1234);
      a.movi("bx", 0x1000);
      a.unary("mul", "bx");
    });
    expect(cpu.regs[DX]).toBe(0x0123);
    expect(cpu.regs[AX]).toBe(0x4000);
  });

  it("divides thirty-two bits by sixteen, quotient and remainder", () => {
    const { cpu } = run((a) => {
      a.movi("dx", 0x0001);
      a.movi("ax", 0x0007);
      a.movi("bx", 0x0003);
      a.unary("div", "bx");
    });
    // $10007 / 3 = $5557 remainder 2.
    expect(cpu.regs[AX]).toBe(0x5557);
    expect(cpu.regs[DX]).toBe(2);
  });

  it("shifts arithmetically, which is how a negative value is halved", () => {
    const { cpu } = run((a) => {
      a.movi("ax", 0xfff0);
      a.shift("sar", "ax", 4);
      a.movi("bx", 0xfff0);
      a.shift("shr", "bx", 4);
    });
    expect(cpu.regs[AX]).toBe(0xffff);
    expect(cpu.regs[BX]).toBe(0x0fff);
  });

  it("negates, and reports the borrow that makes it a subtraction from zero", () => {
    const { cpu } = run((a) => {
      a.movi("ax", 0x0001);
      a.unary("neg", "ax");
    });
    expect(cpu.regs[AX]).toBe(0xffff);
  });

  it("copies a block with rep movsw, one iteration at a time", () => {
    const { bus, cpu } = run(
      (a) => {
        a.movi("si", 0x2000);
        a.movi("di", 0x3000);
        a.movi("cx", 4);
        a.cld();
        a.rep().movsw();
      },
      (bus) => {
        for (let index = 0; index < 8; index += 1) bus.memory[0x2000 + index] = index + 1;
      },
    );
    expect(Array.from(bus.memory.subarray(0x3000, 0x3008))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cpu.regs[CX]).toBe(0);
    expect(cpu.regs[SI]).toBe(0x2008);
    expect(cpu.regs[DI]).toBe(0x3008);
  });

  it("fills a block with rep stosw", () => {
    const { bus } = run((a) => {
      a.movi("ax", 0xbeef);
      a.movi("di", 0x4000);
      a.movi("cx", 3);
      a.cld();
      a.rep().stosw();
    });
    expect(Array.from(bus.memory.subarray(0x4000, 0x4006))).toEqual([
      0xef, 0xbe, 0xef, 0xbe, 0xef, 0xbe,
    ]);
  });

  it("calls and returns through the stack", () => {
    const { cpu } = run((a) => {
      a.call("helper");
      a.jmp("done");
      a.label("helper");
      a.movi("ax", 0x1234);
      a.ret();
      a.label("done");
      a.aluI("add", "ax", 1);
    });
    expect(cpu.regs[AX]).toBe(0x1235);
  });

  it("dispatches through a register, which is what a scene table does", () => {
    const { cpu } = run((a) => {
      a.movi("bx", 0);
      a.movm("bx", romAbs("table"));
      a.jmpr("bx");
      a.label("table");
      a.dw("target");
      a.label("target");
      a.movi("cx", 0x0042);
    });
    expect(cpu.regs[CX]).toBe(0x42);
  });

  it("writes a port, and reads one back", () => {
    const { bus, cpu } = run(
      (a) => {
        a.movi8("al", 0xe0);
        a.out8(0x60);
        a.in8(0xb5);
      },
      (bus) => {
        bus.ports[0xb5] = 0x2f;
      },
    );
    expect(bus.written).toContainEqual({ port: 0x60, value: 0xe0 });
    expect(cpu.reg8(0)).toBe(0x2f);
  });

  it("counts a loop down through cx", () => {
    const { cpu } = run((a) => {
      a.movi("cx", 5);
      a.movi("ax", 0);
      a.label("top");
      a.aluI("add", "ax", 3);
      a.loop("top");
    });
    expect(cpu.regs[AX]).toBe(15);
  });

  it("reports an opcode it does not decode rather than skipping it", () => {
    const bus = new Flat();
    bus.memory[0x100] = 0x0f; // `pop cs` on an 8086, and nothing this emits
    const cpu = new Cpu(bus);
    cpu.reset();
    cpu.segs[CS] = 0;
    cpu.ip = 0x100;
    expect(() => cpu.step()).toThrow(CpuError);
  });
});
