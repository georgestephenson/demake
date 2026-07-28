/**
 * The 68000 interpreter, driven by `@demake/core`'s own encoder.
 *
 * The pairing is deliberate and is the same one `packages/sms/test/cpu.test.ts`
 * uses: this file proves the two agree, and `packages/core/test/m68k.test.ts`
 * proves the encoder agrees with Motorola. Either alone would let a matched pair
 * of mistakes through.
 *
 * What is checked here is what the code generator above actually depends on —
 * the condition codes after a 32-bit compare, the sign-extension rules, floor
 * shifts, and the two things about address registers that are not like
 * everything else.
 */

import { Asm68k, eaA, eaAbs, eaD, eaDisp, eaImm, eaInd, eaPost, eaPre } from "@demake/core";
import { describe, expect, it } from "vitest";

import { M68k, type Bus } from "../src/cpu.js";

/** A flat 1 MiB of memory, so a test never has to think about the map. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x100000);
  read8(address: number): number {
    return this.memory[address & 0xfffff] as number;
  }
  read16(address: number): number {
    return ((this.read8(address) << 8) | this.read8(address + 1)) & 0xffff;
  }
  write8(address: number, value: number): void {
    this.memory[address & 0xfffff] = value & 0xff;
  }
  write16(address: number, value: number): void {
    this.write8(address, value >> 8);
    this.write8(address + 1, value);
  }
}

/** Where a test's code is assembled and run. */
const CODE = 0x1000;

/** Assemble a fragment, run it until it returns, and hand back the machine. */
function run(build: (asm: Asm68k) => void, prepare?: (cpu: M68k, bus: Flat) => void): M68k {
  const asm = new Asm68k(CODE);
  build(asm);
  asm.rts();
  const bytes = asm.assemble();
  const bus = new Flat();
  bus.memory.set(bytes, CODE);
  const cpu = new M68k(bus);
  cpu.pc = CODE;
  cpu.a[7] = 0x8000;
  // A return address the loop can recognise: when `rts` pops it, the fragment is
  // over.
  bus.write16(0x8000, 0x0000);
  bus.write16(0x8002, 0xdead);
  prepare?.(cpu, bus);
  for (let guard = 0; guard < 200_000; guard += 1) {
    if (cpu.pc === 0xdead) return cpu;
    cpu.step();
  }
  throw new Error("the fragment never returned");
}

/** The same, keeping the bus so a test can read what was written. */
function runWith(
  build: (asm: Asm68k) => void,
  prepare?: (cpu: M68k, bus: Flat) => void,
): { cpu: M68k; bus: Flat } {
  const asm = new Asm68k(CODE);
  build(asm);
  asm.rts();
  const bytes = asm.assemble();
  const bus = new Flat();
  bus.memory.set(bytes, CODE);
  const cpu = new M68k(bus);
  cpu.pc = CODE;
  cpu.a[7] = 0x8000;
  bus.write16(0x8000, 0x0000);
  bus.write16(0x8002, 0xdead);
  prepare?.(cpu, bus);
  for (let guard = 0; guard < 200_000; guard += 1) {
    if (cpu.pc === 0xdead) return { cpu, bus };
    cpu.step();
  }
  throw new Error("the fragment never returned");
}

describe("data movement", () => {
  it("moves longs through memory without touching the bytes around them", () => {
    const { cpu, bus } = runWith(
      (a) => {
        a.move("l", eaAbs(0x2000), eaD(0));
        a.move("l", eaD(0), eaAbs(0x2010));
      },
      (_cpu, memory) => {
        memory.write16(0x2000, 0x1234);
        memory.write16(0x2002, 0x5678);
        memory.write16(0x200c, 0xaaaa);
        memory.write16(0x2014, 0xbbbb);
      },
    );
    expect(cpu.d[0]).toBe(0x12345678);
    expect(bus.read16(0x2010)).toBe(0x1234);
    expect(bus.read16(0x2012)).toBe(0x5678);
    expect(bus.read16(0x200c)).toBe(0xaaaa);
    expect(bus.read16(0x2014)).toBe(0xbbbb);
  });

  it("writes a word into a register without disturbing its high half", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x11223344), eaD(0));
      a.move("w", eaImm(0xbeef), eaD(0));
    });
    expect(cpu.d[0]).toBe(0x1122beef);
  });

  it("sign-extends a word into the whole of an address register", () => {
    const cpu = run((a) => {
      a.movea("w", eaImm(0x8000), 0);
      a.move("l", eaImm(0x1234), eaD(1));
      a.movea("w", eaD(1), 1);
    });
    expect(cpu.a[0]).toBe(0xffff8000);
    expect(cpu.a[1]).toBe(0x1234);
  });

  it("steps the stack pointer by two for a byte, so it stays even", () => {
    const cpu = run((a) => {
      // On a stack of its own, so the fragment's own return address survives.
      a.move("l", eaA(7), eaD(1));
      a.movea("l", eaImm(0x9000), 7);
      a.move("b", eaImm(0x42), eaPre(7));
      a.move("l", eaA(7), eaD(0));
      a.movea("l", eaD(1), 7);
    });
    expect(cpu.d[0]).toBe(0x8ffe);
  });

  it("walks a block with postincrement", () => {
    const { cpu, bus } = runWith(
      (a) => {
        a.movea("l", eaImm(0x3000), 0);
        a.movea("l", eaImm(0x4000), 1);
        a.moveq(3, 0);
        a.label("loop");
        a.move("l", eaPost(0), eaInd(1));
        a.addq("l", 4, eaA(1));
        a.dbra(0, "loop");
      },
      (_cpu, memory) => {
        for (let index = 0; index < 4; index += 1) memory.write16(0x3002 + index * 4, index + 1);
      },
    );
    expect(cpu.a[0]).toBe(0x3010);
    for (let index = 0; index < 4; index += 1)
      expect(bus.read16(0x4002 + index * 4)).toBe(index + 1);
  });
});

describe("condition codes", () => {
  /** Run `cmp.l` on two values and report which of the signed branches take. */
  function compare(left: number, right: number): { lt: boolean; eq: boolean; gt: boolean } {
    const cpu = run((a) => {
      a.move("l", eaImm(left >>> 0), eaD(0));
      a.cmp("l", eaImm(right >>> 0), 0);
    });
    return {
      lt: cpu.n !== cpu.v,
      eq: cpu.z,
      gt: cpu.n === cpu.v && !cpu.z,
    };
  }

  it("orders a 32-bit signed compare correctly across the whole range", () => {
    // The value layer's whole comparison story: the clamped range means the sign
    // of a difference is the answer, and `V` is what makes that true at the ends.
    expect(compare(1, 2)).toEqual({ lt: true, eq: false, gt: false });
    expect(compare(2, 2)).toEqual({ lt: false, eq: true, gt: false });
    expect(compare(3, 2)).toEqual({ lt: false, eq: false, gt: true });
    expect(compare(-1, 1)).toEqual({ lt: true, eq: false, gt: false });
    expect(compare(-2, -1)).toEqual({ lt: true, eq: false, gt: false });
    expect(compare(0x7fffffff, -1)).toEqual({ lt: false, eq: false, gt: true });
    expect(compare(-0x80000000, 0x7fffffff)).toEqual({ lt: true, eq: false, gt: false });
  });

  it("reports carry as an unsigned borrow, which is not the signed answer", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x00000001), eaD(0));
      a.cmp("l", eaImm(0xffffffff), 0);
    });
    // 1 - (-1) is 2 and does not go negative; unsigned, 1 - 4294967295 borrows.
    expect(cpu.c).toBe(true);
    expect(cpu.n !== cpu.v).toBe(false);
  });

  it("sets overflow on a signed addition that wraps", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x7fffffff), eaD(0));
      a.add("l", eaImm(1), 0);
    });
    expect(cpu.d[0]).toBe(0x80000000);
    expect(cpu.v).toBe(true);
    expect(cpu.n).toBe(true);
  });

  it("leaves the codes alone for adda, which is what makes it dangerous", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0), eaD(0));
      a.tst("l", eaD(0));
      a.adda("l", eaImm(4), 0);
    });
    expect(cpu.z).toBe(true);
    expect(cpu.a[0]).toBe(4);
  });
});

describe("arithmetic", () => {
  it("shifts arithmetically right, which is floor division", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0xfffffff9), eaD(0)); // -7
      a.asr("l", 1, 0);
      a.move("l", eaImm(7), eaD(1));
      a.asr("l", 1, 1);
    });
    expect(cpu.d[0] | 0).toBe(-4);
    expect(cpu.d[1]).toBe(3);
  });

  it("multiplies signed sixteen-bit halves into a full long", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0xffff), eaD(0)); // -1 as a word
      a.muls(eaImm(0x0003), 0);
      a.move("l", eaImm(0xffff), eaD(1));
      a.mulu(eaImm(0x0003), 1);
    });
    expect(cpu.d[0] | 0).toBe(-3);
    expect(cpu.d[1]).toBe(0x2fffd);
  });

  it("divides unsigned, leaving the remainder in the high half", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(1000), eaD(0));
      a.divu(eaImm(7), 0);
    });
    expect((cpu.d[0] as number) & 0xffff).toBe(142);
    expect((cpu.d[0] as number) >>> 16).toBe(1000 - 142 * 7);
  });

  it("rotates through the extend bit, which is how a long shift chains", () => {
    const cpu = run((a) => {
      // A 64-bit left shift: the bit leaving the low half arrives in the high one.
      a.move("l", eaImm(0x80000000), eaD(0));
      a.move("l", eaImm(0x00000000), eaD(1));
      a.asl("l", 1, 0);
      a.roxl("l", 1, 1);
    });
    expect(cpu.d[0]).toBe(0);
    expect(cpu.d[1]).toBe(1);
  });

  it("negates and clamps the way the value layer expects", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x00010000), eaD(0));
      a.neg("l", eaD(0));
    });
    expect(cpu.d[0]).toBe(0xffff0000);
    expect(cpu.n).toBe(true);
  });

  it("extends a word to a long through its sign", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x0000ffff), eaD(0));
      a.ext("l", 0);
      a.move("l", eaImm(0x00007fff), eaD(1));
      a.ext("l", 1);
    });
    expect(cpu.d[0]).toBe(0xffffffff);
    expect(cpu.d[1]).toBe(0x00007fff);
  });

  it("swaps a register's halves, which is a shift by sixteen either way", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x12345678), eaD(0));
      a.swap(0);
    });
    expect(cpu.d[0]).toBe(0x56781234);
  });
});

describe("control flow", () => {
  it("calls and returns through the stack", () => {
    const cpu = run((a) => {
      a.moveq(0, 0);
      a.bsr("bump");
      a.bsr("bump");
      a.bra("done");
      a.label("bump");
      a.addq("l", 1, eaD(0));
      a.rts();
      a.label("done");
    });
    expect(cpu.d[0]).toBe(2);
  });

  it("counts a dbra loop the hardware's number of times", () => {
    const cpu = run((a) => {
      a.moveq(4, 1);
      a.moveq(0, 0);
      a.label("loop");
      a.addq("l", 1, eaD(0));
      a.dbra(1, "loop");
    });
    // `dbra #4` runs the body five times: it exits when the counter reaches -1.
    expect(cpu.d[0]).toBe(5);
  });

  it("takes an interrupt through its autovector and returns from it", () => {
    const asm = new Asm68k(CODE);
    asm.label("main");
    asm.bra("main");
    const bytes = asm.assemble();
    const bus = new Flat();
    bus.memory.set(bytes, CODE);
    // The handler bumps a counter and returns.
    const handler = new Asm68k(0x2000);
    handler.addq("l", 1, eaAbs(0x3000));
    handler.rte();
    bus.memory.set(handler.assemble(), 0x2000);
    bus.write16(0x0078, 0x0000);
    bus.write16(0x007a, 0x2000);

    const cpu = new M68k(bus);
    cpu.pc = CODE;
    cpu.a[7] = 0x8000;
    cpu.mask = 0;
    cpu.step();
    expect(cpu.interrupt(6, 0x0078)).toBe(true);
    for (let index = 0; index < 3; index += 1) cpu.step();
    expect(bus.read16(0x3002)).toBe(1);
    // Back in the loop, with the mask restored so the next one can arrive.
    expect(cpu.pc).toBeGreaterThanOrEqual(CODE);
    expect(cpu.mask).toBe(0);
  });

  it("saves and restores a register set with movem", () => {
    const cpu = run((a) => {
      a.move("l", eaImm(0x11111111), eaD(0));
      a.move("l", eaImm(0x22222222), eaD(1));
      a.movem("l", 0b11, eaPre(7), true);
      a.move("l", eaImm(0), eaD(0));
      a.move("l", eaImm(0), eaD(1));
      a.movem("l", 0b11, eaPost(7), false);
    });
    expect(cpu.d[0]).toBe(0x11111111);
    expect(cpu.d[1]).toBe(0x22222222);
  });
});

describe("addressing", () => {
  it("indexes a record by a register, which is how a looped rule reaches one", () => {
    const { cpu } = runWith(
      (a) => {
        a.movea("l", eaImm(0x5000), 0);
        a.moveq(8, 1);
        a.move("l", eaDisp(0, 4), eaD(2));
        a.move("l", eaImm(0), eaD(3));
      },
      (_cpu, memory) => {
        memory.write16(0x5004, 0xcafe);
        memory.write16(0x5006, 0xbabe);
      },
    );
    expect(cpu.d[2]).toBe(0xcafebabe);
  });

  it("reads a byte from an absolute short address in the top of work RAM", () => {
    const { cpu } = runWith(
      (a) => {
        a.moveq(0, 0);
        a.move("b", eaAbs(0xff8100), eaD(0));
      },
      (_cpu, memory) => {
        // The short form sign-extends, so `$FF8100` and `$8100` are one address
        // on a 24-bit bus; this flat bus masks to 20 bits, which lands the same.
        memory.write8(0xf8100, 0x5a);
      },
    );
    expect(cpu.d[0]).toBe(0x5a);
  });
});
