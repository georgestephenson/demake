/**
 * The TLCS-900/H interpreter, driven by `core`'s own encoder.
 *
 * The arrangement every owned core here uses: the test writes assembly, the
 * encoder under `packages/core/src/asm/` turns it into bytes, and this core runs
 * them. An encoder and a decoder that agreed with each other and not with the
 * hardware would still have to get past `packages/core/test/tlcs900.test.ts`,
 * which pins the same encodings against the published code maps and the
 * manual's own worked examples — so the two files together are a three-way
 * agreement rather than a circle.
 *
 * What is checked here is what a value layer will stand on. The **flags after
 * arithmetic**, because a signed comparison on this processor is `S xor V` and
 * getting it backwards makes a game that plays correctly until something moves
 * left. The **widening multiply and divide**, because they are the reason this
 * console is affordable — one instruction each where an 8-bit backend pays for a
 * bit loop. The **addressing modes**, because the operand comes before the
 * opcode here and a prefix decoded with the wrong role still names *an* address.
 * And the **block copy**, which is one instruction that has to remain
 * interruptible.
 */

import {
  Asm900,
  t9Abs as abs,
  t9At as at,
  t9Indexed as indexed,
  t9Postinc as postinc,
} from "@demake/core";
import { describe, expect, it } from "vitest";

import {
  CpuError,
  FLAG_C,
  FLAG_S,
  FLAG_V,
  FLAG_Z,
  Tlcs900,
  XBC,
  XDE,
  XHL,
  XIX,
  XWA,
  type Bus,
} from "../src/cpu.js";

/** A flat 16 MiB, which is all a CPU test needs of a console. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x1000000);

  read(address: number): number {
    return this.memory[address & 0xffffff] as number;
  }

  write(address: number, value: number): void {
    this.memory[address & 0xffffff] = value & 0xff;
  }
}

const ORIGIN = 0x200040;

/** Assemble, load at the cartridge's first byte, and run until `halt`. */
function run(build: (asm: Asm900) => void, prepare?: (bus: Flat) => void): Tlcs900 {
  const asm = new Asm900(ORIGIN);
  build(asm);
  asm.halt();
  const code = asm.assemble();
  const bus = new Flat();
  bus.memory.set(code, ORIGIN);
  prepare?.(bus);
  const cpu = new Tlcs900(bus);
  cpu.reset(ORIGIN, 0x6c00);
  for (let step = 0; step < 200_000 && !cpu.halted; step += 1) cpu.step();
  expect(cpu.halted).toBe(true);
  return cpu;
}

describe("the TLCS-900/H interpreter", () => {
  it("loads immediates at each width", () => {
    const cpu = run((a) => {
      a.ldn("a", 0x42);
      a.ldn("bc", 0x1234);
      a.ldn("xde", 0x89abcdef);
    });
    expect(cpu.readReg(XWA, 1)).toBe(0x42); // A is the low byte of XWA
    expect(cpu.readReg(XBC, 2)).toBe(0x1234);
    expect(cpu.readReg(XDE, 4)).toBe(0x89abcdef);
  });

  it("puts the halves of a pair where the register file puts them", () => {
    // A is the byte at $E0 and W the byte at $E1, so loading both and reading
    // WA back as a word is what says the two are the right way round.
    const cpu = run((a) => {
      a.ldn("a", 0x34);
      a.ldn("w", 0x12);
    });
    expect(cpu.readReg(XWA, 2)).toBe(0x1234);
  });

  it("moves between registers of every width", () => {
    const cpu = run((a) => {
      a.ldn("xhl", 0x00123456);
      a.ld("xde", "xhl");
      a.ld("bc", "hl");
      a.ld("a", "l");
    });
    expect(cpu.readReg(XDE, 4)).toBe(0x00123456);
    expect(cpu.readReg(XBC, 2)).toBe(0x3456);
    expect(cpu.readReg(XWA, 1)).toBe(0x56);
  });

  describe("the flags", () => {
    it("reports an unsigned comparison in the carry", () => {
      const below = run((a) => {
        a.ldn("wa", 5);
        a.aluImm("cp", "wa", 9);
      });
      expect(below.f & FLAG_C).toBeTruthy();
      const above = run((a) => {
        a.ldn("wa", 9);
        a.aluImm("cp", "wa", 5);
      });
      expect(above.f & FLAG_C).toBeFalsy();
    });

    it("reports a signed comparison as S xor V", () => {
      // -1 against 1: the difference does not overflow, so S alone decides.
      const negative = run((a) => {
        a.ldn("wa", 0xffff);
        a.aluImm("cp", "wa", 1);
      });
      expect((negative.f & FLAG_S) !== 0).not.toBe((negative.f & FLAG_V) !== 0);
      // $8000 against 1 *does* overflow, so S and V disagree with each other and
      // the pair still says "less than" — which is the case a comparison written
      // on S alone gets wrong.
      const overflow = run((a) => {
        a.ldn("wa", 0x8000);
        a.aluImm("cp", "wa", 1);
      });
      expect((overflow.f & FLAG_V) !== 0).toBe(true);
      expect((overflow.f & FLAG_S) !== 0).toBe(false);
      expect((overflow.f & FLAG_S) !== 0).not.toBe((overflow.f & FLAG_V) !== 0);
    });

    it("sets zero on an equal comparison and clears it otherwise", () => {
      expect(
        run((a) => {
          a.ldn("a", 7);
          a.aluImm("cp", "a", 7);
        }).f & FLAG_Z,
      ).toBeTruthy();
      expect(
        run((a) => {
          a.ldn("a", 7);
          a.aluImm("cp", "a", 8);
        }).f & FLAG_Z,
      ).toBeFalsy();
    });

    it("carries out of a 32-bit addition", () => {
      const cpu = run((a) => {
        a.ldn("xwa", 0xffffffff);
        a.aluImm("add", "xwa", 1);
      });
      expect(cpu.readReg(XWA, 4)).toBe(0);
      expect(cpu.f & FLAG_C).toBeTruthy();
      expect(cpu.f & FLAG_Z).toBeTruthy();
    });

    it("leaves the carry alone across an increment", () => {
      // Which is what lets a counter wider than a register be stepped without
      // the carry being saved around it.
      const cpu = run((a) => {
        a.scf();
        a.ldn("a", 1);
        a.inc(1, "a");
      });
      expect(cpu.readReg(XWA, 1)).toBe(2);
      expect(cpu.f & FLAG_C).toBeTruthy();
    });
  });

  describe("arithmetic worth a whole instruction", () => {
    it("widens a multiply into a register twice the size", () => {
      const cpu = run((a) => {
        a.ldn("wa", 0x1234);
        a.ldn("bc", 0x0100);
        a.mul("xwa", "bc");
      });
      expect(cpu.readReg(XWA, 4)).toBe(0x00123400);
    });

    it("multiplies signed operands as signed", () => {
      const cpu = run((a) => {
        a.ldn("wa", 0xffff); // -1
        a.ldn("bc", 3);
        a.muls("xwa", "bc");
      });
      expect(cpu.readReg(XWA, 4)).toBe(0xfffffffd); // -3
    });

    it("leaves a quotient in the low half and a remainder in the high", () => {
      const cpu = run((a) => {
        a.ldn("xwa", 1000);
        a.ldn("bc", 7);
        a.div("xwa", "bc");
      });
      expect(cpu.readReg(XWA, 2)).toBe(142);
      expect(cpu.readReg(XWA + 2, 2)).toBe(1000 - 142 * 7);
    });

    it("sets overflow on a divide by zero rather than trapping", () => {
      const cpu = run((a) => {
        a.ldn("xwa", 1000);
        a.ldn("bc", 0);
        a.div("xwa", "bc");
      });
      expect(cpu.f & FLAG_V).toBeTruthy();
      expect(cpu.readReg(XWA, 4)).toBe(1000);
    });

    it("sign-extends the lower half into the upper", () => {
      const cpu = run((a) => {
        a.ldn("xwa", 0x0000ffff);
        a.exts("xwa");
      });
      expect(cpu.readReg(XWA, 4)).toBe(0xffffffff);
    });

    it("shifts by a constant and by the accumulator", () => {
      const cpu = run((a) => {
        a.ldn("xhl", 0x00001234);
        a.shift("sla", 4, "xhl");
        a.ldn("a", 8);
        a.shiftA("srl", "xhl");
      });
      expect(cpu.readReg(XHL, 4)).toBe(0x00001234 >> 4);
    });

    it("shifts arithmetically to the right, keeping the sign", () => {
      const cpu = run((a) => {
        a.ldn("xhl", 0xfffffff0);
        a.shift("sra", 4, "xhl");
      });
      expect(cpu.readReg(XHL, 4)).toBe(0xffffffff);
    });
  });

  describe("the addressing modes", () => {
    it("reads an absolute address at each width", () => {
      const cpu = run(
        (a) => {
          a.ldm("a", abs(0x4000));
          a.ldm("bc", abs(0x4002));
          a.ldm("xde", abs(0x4004));
        },
        (bus) => {
          bus.memory.set([0x11, 0x00, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77], 0x4000);
        },
      );
      expect(cpu.readReg(XWA, 1)).toBe(0x11);
      expect(cpu.readReg(XBC, 2)).toBe(0x3322);
      expect(cpu.readReg(XDE, 4)).toBe(0x77665544);
    });

    it("stores every byte of a long word, little-endian", () => {
      const bus = new Flat();
      const asm = new Asm900(ORIGIN);
      asm.ldn("xde", 0x77665544);
      asm.stm(abs(0x4100), "xde");
      asm.halt();
      bus.memory.set(asm.assemble(), ORIGIN);
      const cpu = new Tlcs900(bus);
      cpu.reset(ORIGIN, 0x6c00);
      for (let step = 0; step < 100 && !cpu.halted; step += 1) cpu.step();
      expect([...bus.memory.subarray(0x4100, 0x4104)]).toEqual([0x44, 0x55, 0x66, 0x77]);
    });

    it("reads through a base register with and without a displacement", () => {
      const cpu = run(
        (a) => {
          a.ldn("xix", 0x4000);
          a.ldm("a", at("xix"));
          a.ldm("b", at("xix", 3));
          // Past a byte's reach, which takes the longer encoding.
          a.ldm("c", at("xix", 0x200));
        },
        (bus) => {
          bus.memory[0x4000] = 0xaa;
          bus.memory[0x4003] = 0xbb;
          bus.memory[0x4200] = 0xcc;
        },
      );
      expect(cpu.readReg(XWA, 1)).toBe(0xaa);
      expect(cpu.readReg(XBC + 1, 1)).toBe(0xbb); // B is the high byte of BC
      expect(cpu.readReg(XBC, 1)).toBe(0xcc); // C is the low byte
    });

    it("indexes by a signed register", () => {
      const cpu = run(
        (a) => {
          a.ldn("xix", 0x4010);
          a.ldn("a", 0xfe); // -2
          a.ldm("b", indexed("xix", "a"));
        },
        (bus) => {
          bus.memory[0x400e] = 0x5a;
        },
      );
      expect(cpu.readReg(XBC + 1, 1)).toBe(0x5a);
    });

    it("steps a register after using it", () => {
      const cpu = run(
        (a) => {
          a.ldn("xhl", 0x4000);
          a.ldm("a", postinc("xhl"));
          a.ldm("b", postinc("xhl"));
        },
        (bus) => {
          bus.memory.set([0x01, 0x02], 0x4000);
        },
      );
      expect(cpu.readReg(XWA, 1)).toBe(0x01);
      expect(cpu.readReg(XBC + 1, 1)).toBe(0x02);
      expect(cpu.readReg(XHL, 4)).toBe(0x4002);
    });

    it("takes the operand's address rather than its contents", () => {
      const cpu = run((a) => {
        a.ldn("xix", 0x4000);
        a.lda("xhl", at("xix", 0x20));
      });
      expect(cpu.readReg(XHL, 4)).toBe(0x4020);
    });

    it("adds memory to a register and a register to memory", () => {
      // The second half is the one worth checking: `add (mem),R` goes through a
      // *source* prefix even though it writes to memory, because its opcode has
      // no size field. A decoder that treated it as a destination form would
      // read the right address and store the wrong width.
      const bus = new Flat();
      const asm = new Asm900(ORIGIN);
      asm.ldn("wa", 10);
      asm.aluMem("add", "wa", abs(0x4000));
      asm.aluToMem("add", abs(0x4002), "wa");
      asm.halt();
      bus.memory.set(asm.assemble(), ORIGIN);
      bus.memory.set([0x05, 0x00, 0x01, 0x00], 0x4000);
      const cpu = new Tlcs900(bus);
      cpu.reset(ORIGIN, 0x6c00);
      for (let step = 0; step < 100 && !cpu.halted; step += 1) cpu.step();
      expect(cpu.readReg(XWA, 2)).toBe(15);
      expect([...bus.memory.subarray(0x4002, 0x4004)]).toEqual([16, 0]);
    });
  });

  describe("control flow", () => {
    it("branches on a condition, forwards and backwards", () => {
      const cpu = run((a) => {
        a.ldn("bc", 0);
        a.ldn("a", 5);
        a.label("Loop");
        a.inc(1, "bc");
        a.dec(1, "a");
        a.jr("nz", "Loop");
      });
      expect(cpu.readReg(XBC, 2)).toBe(5);
    });

    it("calls and returns", () => {
      const cpu = run((a) => {
        a.ldn("bc", 1);
        a.call("Twice");
        a.call("Twice");
        a.jp("Done");
        a.label("Twice");
        a.alu("add", "bc", "bc");
        a.ret();
        a.label("Done");
      });
      expect(cpu.readReg(XBC, 2)).toBe(4);
    });

    it("returns conditionally", () => {
      const cpu = run((a) => {
        a.ldn("bc", 0);
        a.ldn("a", 0);
        a.call("MaybeReturn");
        a.jp("Done");
        a.label("MaybeReturn");
        a.aluImm("cp", "a", 0);
        a.retc("z");
        a.ldn("bc", 0xdead);
        a.ret();
        a.label("Done");
      });
      expect(cpu.readReg(XBC, 2)).toBe(0);
    });

    it("jumps conditionally through the operand prefix", () => {
      const cpu = run((a) => {
        a.ldn("bc", 1);
        a.ldn("a", 1);
        a.aluImm("cp", "a", 1);
        a.jpc("nz", "Skip");
        a.ldn("bc", 2);
        a.label("Skip");
      });
      expect(cpu.readReg(XBC, 2)).toBe(2);
    });

    it("counts down with one instruction", () => {
      const cpu = run((a) => {
        a.ldn("bc", 0);
        a.ldn("b", 4);
        a.label("Loop");
        a.inc(1, "c");
        a.djnz("b", "Loop");
      });
      expect(cpu.readReg(XBC, 1)).toBe(4);
    });

    it("pushes and pops at each width", () => {
      const cpu = run((a) => {
        a.ldn("xhl", 0x00abcdef);
        a.ldn("bc", 0x1234);
        a.push("xhl");
        a.push("bc");
        a.pop("de");
        a.pop("xix");
      });
      expect(cpu.readReg(XDE, 2)).toBe(0x1234);
      expect(cpu.readReg(XIX, 4)).toBe(0x00abcdef);
    });
  });

  describe("the block operations", () => {
    it("copies a run in one instruction, one element per step", () => {
      const bus = new Flat();
      const asm = new Asm900(ORIGIN);
      asm.ldn("xhl", 0x4000);
      asm.ldn("xde", 0x5000);
      asm.ldn("bc", 4);
      asm.ldir(at("xde"), "b");
      asm.halt();
      bus.memory.set(asm.assemble(), ORIGIN);
      bus.memory.set([1, 2, 3, 4], 0x4000);
      const cpu = new Tlcs900(bus);
      cpu.reset(ORIGIN, 0x6c00);

      // The copy is four steps rather than one, because the hardware makes it
      // interruptible and a cycle count that hid that would be a lie.
      let steps = 0;
      while (!cpu.halted && steps < 100) {
        cpu.step();
        steps += 1;
      }
      expect([...bus.memory.subarray(0x5000, 0x5004)]).toEqual([1, 2, 3, 4]);
      expect(cpu.readReg(XBC, 2)).toBe(0);
      // Three setup loads, four copies and the halt: the copy really is four
      // steps rather than one, which is what "interruptible" means here.
      expect(steps).toBe(8);
    });

    it("copies words when the prefix says so", () => {
      const bus = new Flat();
      const asm = new Asm900(ORIGIN);
      asm.ldn("xhl", 0x4000);
      asm.ldn("xde", 0x5000);
      asm.ldn("bc", 2);
      asm.ldir(at("xde"), "w");
      asm.halt();
      bus.memory.set(asm.assemble(), ORIGIN);
      bus.memory.set([1, 2, 3, 4], 0x4000);
      const cpu = new Tlcs900(bus);
      cpu.reset(ORIGIN, 0x6c00);
      for (let step = 0; step < 100 && !cpu.halted; step += 1) cpu.step();
      expect([...bus.memory.subarray(0x5000, 0x5004)]).toEqual([1, 2, 3, 4]);
    });
  });

  describe("bits", () => {
    it("puts the inverse of a bit in Z, so `nz` means it was set", () => {
      const set = run((a) => {
        a.ldn("a", 0b0010_0000);
        a.bit(5, "a");
      });
      expect(set.f & FLAG_Z).toBeFalsy();
      const clear = run((a) => {
        a.ldn("a", 0);
        a.bit(5, "a");
      });
      expect(clear.f & FLAG_Z).toBeTruthy();
    });

    it("sets, clears and flips a bit in memory", () => {
      const cpu = run(
        (a) => {
          a.setMem(0, abs(0x4000));
          a.resMem(7, abs(0x4000));
          a.chgMem(1, abs(0x4000));
          a.ldm("a", abs(0x4000));
        },
        (bus) => {
          bus.memory[0x4000] = 0b1000_0000;
        },
      );
      expect(cpu.readReg(XWA, 1)).toBe(0b0000_0011);
    });
  });

  it("names an opcode it does not decode rather than skipping it", () => {
    const bus = new Flat();
    // $F7 is `ldx`, which a demade cartridge never emits.
    bus.memory.set([0xf7, 0x00], ORIGIN);
    const cpu = new Tlcs900(bus);
    cpu.reset(ORIGIN, 0x6c00);
    expect(() => cpu.step()).toThrow(CpuError);
  });
});
