/**
 * The 6502, instruction by instruction.
 *
 * The decode table is a transcription of the instruction reference and the
 * assembler's is another, so these tests are what stop the pair being wrong
 * together: each case is a hand-assembled byte sequence with the result worked
 * out from the reference rather than from either table.
 *
 * The flag arithmetic gets the most attention because it is what the generated
 * code actually leans on. A 16.16 subtract is four `sbc`s chained through carry,
 * and a signed comparison is a `sbc` pair read through the overflow flag — so a
 * carry that is inverted, or an overflow computed from the wrong pair of signs,
 * would not produce a slightly wrong game. It would produce a game whose every
 * position is wrong once anything moves left.
 */

import { describe, expect, it } from "vitest";

import { Cpu, type Bus } from "../src/cpu.js";

/** A flat 64 KiB of RAM, so a test can place code anywhere. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x10000);
  read(address: number): number {
    return this.memory[address & 0xffff] as number;
  }
  write(address: number, value: number): void {
    this.memory[address & 0xffff] = value & 0xff;
  }
}

/** Assemble bytes at `$0200`, point the CPU at them, and run `steps`. */
function run(bytes: readonly number[], steps = 1, before?: (cpu: Cpu, bus: Flat) => void): Cpu {
  const bus = new Flat();
  bus.memory.set(bytes, 0x0200);
  const cpu = new Cpu(bus);
  cpu.pc = 0x0200;
  before?.(cpu, bus);
  for (let index = 0; index < steps; index += 1) cpu.step();
  return cpu;
}

describe("the 6502's arithmetic", () => {
  it("adds through the carry, and reports both carry and overflow", () => {
    // 0x7F + 0x01 = 0x80: no carry out, but the signed result overflowed.
    const cpu = run([0x18, 0xa9, 0x7f, 0x69, 0x01], 3);
    expect(cpu.a).toBe(0x80);
    expect(cpu.carry).toBe(false);
    expect(cpu.overflow).toBe(true);
    expect(cpu.negative).toBe(true);

    // 0xFF + 0x01 = 0x00 with carry, and no signed overflow.
    const wrap = run([0x18, 0xa9, 0xff, 0x69, 0x01], 3);
    expect(wrap.a).toBe(0x00);
    expect(wrap.carry).toBe(true);
    expect(wrap.overflow).toBe(false);
    expect(wrap.zero).toBe(true);
  });

  it("subtracts with the carry meaning 'no borrow'", () => {
    // sec then sbc is a plain subtract; carry stays set when it did not borrow.
    const cpu = run([0x38, 0xa9, 0x05, 0xe9, 0x03], 3);
    expect(cpu.a).toBe(0x02);
    expect(cpu.carry).toBe(true);

    // 0x03 - 0x05 borrows, so carry clears and the result wraps.
    const borrow = run([0x38, 0xa9, 0x03, 0xe9, 0x05], 3);
    expect(borrow.a).toBe(0xfe);
    expect(borrow.carry).toBe(false);
    expect(borrow.negative).toBe(true);
  });

  it("chains a 32-bit subtract through the carry, which is what a rule compiles to", () => {
    // $00010000 - $00000001 = $0000FFFF, one byte at a time out of $10 into $20.
    const bus = new Flat();
    const code = [0x38]; // sec
    for (let byte = 0; byte < 4; byte += 1) {
      code.push(0xa5, 0x10 + byte); // lda $10+n
      code.push(0xe5, 0x20 + byte); // sbc $20+n
      code.push(0x85, 0x30 + byte); // sta $30+n
    }
    bus.memory.set(code, 0x0200);
    bus.memory.set([0x00, 0x00, 0x01, 0x00], 0x10);
    bus.memory.set([0x01, 0x00, 0x00, 0x00], 0x20);
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    for (let index = 0; index < 13; index += 1) cpu.step();
    expect([...bus.memory.subarray(0x30, 0x34)]).toEqual([0xff, 0xff, 0x00, 0x00]);
  });

  it("compares by subtracting without keeping the result", () => {
    const cpu = run([0xa9, 0x10, 0xc9, 0x20], 2);
    expect(cpu.a).toBe(0x10);
    expect(cpu.carry).toBe(false); // 0x10 < 0x20
    expect(cpu.zero).toBe(false);
    const equal = run([0xa9, 0x20, 0xc9, 0x20], 2);
    expect(equal.carry).toBe(true);
    expect(equal.zero).toBe(true);
  });

  it("shifts and rotates through the carry", () => {
    const shifted = run([0x18, 0xa9, 0x81, 0x4a], 3); // lsr a
    expect(shifted.a).toBe(0x40);
    expect(shifted.carry).toBe(true);
    const rotated = run([0x38, 0xa9, 0x80, 0x6a], 3); // ror a with carry set
    expect(rotated.a).toBe(0xc0);
    expect(rotated.carry).toBe(false);
  });

  it("reads bit 7 and bit 6 of memory with bit, leaving A alone", () => {
    const cpu = run([0xa9, 0x00, 0x24, 0x10], 2, (_cpu, bus) => {
      bus.memory[0x10] = 0xc0;
    });
    expect(cpu.a).toBe(0x00);
    expect(cpu.zero).toBe(true);
    expect(cpu.negative).toBe(true);
    expect(cpu.overflow).toBe(true);
  });
});

describe("the 6502's addressing", () => {
  it("indexes absolutely and indirectly", () => {
    const cpu = run([0xa0, 0x02, 0xb9, 0x00, 0x03], 2, (_cpu, bus) => {
      bus.memory[0x0302] = 0x5a;
    });
    expect(cpu.a).toBe(0x5a);

    const pointer = run([0xa0, 0x01, 0xb1, 0x10], 2, (_cpu, bus) => {
      bus.memory[0x10] = 0x00;
      bus.memory[0x11] = 0x04;
      bus.memory[0x0401] = 0x99;
    });
    expect(pointer.a).toBe(0x99);
  });

  it("wraps a zero-page index inside page zero", () => {
    const cpu = run([0xa2, 0x02, 0xb5, 0xff], 2, (_cpu, bus) => {
      bus.memory[0x0001] = 0x77; // $FF + 2 wraps to $01, not $0101
      bus.memory[0x0101] = 0x11;
    });
    expect(cpu.a).toBe(0x77);
  });

  it("charges a cycle for an indexed read that crosses a page, and not for a store", () => {
    const bus = new Flat();
    bus.memory.set([0xbd, 0xff, 0x02], 0x0200); // lda $02FF,x
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    cpu.x = 1;
    expect(cpu.step()).toBe(5); // 4 + 1 for the crossing

    const store = new Flat();
    store.memory.set([0x9d, 0xff, 0x02], 0x0200); // sta $02FF,x
    const other = new Cpu(store);
    other.pc = 0x0200;
    other.x = 1;
    expect(other.step()).toBe(5); // always 5, crossing or not
  });

  it("reproduces the indirect jump's page-boundary bug", () => {
    const bus = new Flat();
    bus.memory.set([0x6c, 0xff, 0x03], 0x0200); // jmp ($03FF)
    bus.memory[0x03ff] = 0x34;
    bus.memory[0x0300] = 0x12; // the high byte comes from here, not $0400
    bus.memory[0x0400] = 0xff;
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    cpu.step();
    expect(cpu.pc).toBe(0x1234);
  });
});

describe("the 6502's control flow", () => {
  it("branches relatively, and pays for the crossing", () => {
    const bus = new Flat();
    bus.memory.set([0xd0, 0x02, 0xea, 0xea, 0xa9, 0x01], 0x0200);
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    cpu.zero = false;
    expect(cpu.step()).toBe(3); // taken, same page
    expect(cpu.pc).toBe(0x0204);
  });

  it("calls and returns through the stack", () => {
    const bus = new Flat();
    bus.memory.set([0x20, 0x00, 0x03], 0x0200); // jsr $0300
    bus.memory.set([0xa9, 0x42, 0x60], 0x0300); // lda #$42 : rts
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    cpu.step();
    expect(cpu.pc).toBe(0x0300);
    cpu.step();
    cpu.step();
    expect(cpu.pc).toBe(0x0203);
    expect(cpu.a).toBe(0x42);
  });

  it("takes the NMI vector once per edge, saving the status byte", () => {
    const bus = new Flat();
    bus.memory.set([0xea, 0xea], 0x0200);
    bus.memory[0xfffa] = 0x00;
    bus.memory[0xfffb] = 0x05;
    bus.memory[0x0500] = 0xea; // the handler, such as it is
    const cpu = new Cpu(bus);
    cpu.pc = 0x0200;
    cpu.carry = true;
    cpu.nmi();
    expect(cpu.step()).toBe(7);
    expect(cpu.pc).toBe(0x0500);
    expect(cpu.interrupt).toBe(true);
    // The pushed status has the carry in it and the break flag clear.
    expect(bus.memory[0x0100 + cpu.sp + 1]! & 0x11).toBe(0x01);
    // And it does not fire again without a second edge.
    cpu.step();
    expect(cpu.pc).toBe(0x0501);
  });

  it("refuses an opcode it has no instruction for", () => {
    expect(() => run([0x02])).toThrow(/illegal opcode/);
  });
});
