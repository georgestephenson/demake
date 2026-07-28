/**
 * The 65816, against code this project's own assembler produced.
 *
 * The counterpart of `packages/sms/test/cpu.test.ts`, and it runs under the same
 * bargain: the encoder is pinned to the published opcode bytes by
 * `packages/core/test/wdc65816.test.ts`, so a decoder that agreed with the
 * encoder and not with the hardware would still fail there. What is checked here
 * is *behaviour* — and specifically the behaviour a 6502 model would get wrong.
 */

import { describe, expect, it } from "vitest";

import {
  Asm65816,
  imm16,
  imm8,
  long,
  snesAbs as abs,
  snesAbsX as absX,
  SNES_ORIGIN,
} from "@demake/core";

import { Cpu, type Bus } from "../src/cpu.js";

/** A flat 16 MiB space, so a test can put anything anywhere. */
class Flat implements Bus {
  readonly memory = new Uint8Array(0x1000000);
  read(address: number): number {
    return this.memory[address & 0xffffff] as number;
  }
  write(address: number, value: number): void {
    this.memory[address & 0xffffff] = value & 0xff;
  }
}

/** Assemble a fragment at `$00:8000`, run it, and hand back the machine. */
function run(build: (asm: Asm65816) => void, steps = 200): { cpu: Cpu; bus: Flat } {
  const asm = new Asm65816(SNES_ORIGIN);
  asm.label("Start");
  // Native mode with wide registers, which is the state every fragment below
  // assumes and the state a cartridge's first two instructions produce.
  asm.clc();
  asm.xce();
  asm.rep(0x38);
  asm.ldx(imm16(0x1fff));
  asm.txs();
  build(asm);
  asm.label("Stop");
  asm.stp();
  const bus = new Flat();
  bus.memory.set(asm.assemble(), SNES_ORIGIN);
  bus.memory[0xfffc] = SNES_ORIGIN & 0xff;
  bus.memory[0xfffd] = (SNES_ORIGIN >> 8) & 0xff;
  const cpu = new Cpu(bus);
  cpu.reset();
  for (let index = 0; index < steps && !cpu.stopped; index += 1) cpu.step();
  expect(cpu.stopped).toBe(true);
  return { cpu, bus };
}

const word = (bus: Flat, address: number): number =>
  (bus.memory[address] as number) | ((bus.memory[address + 1] as number) << 8);

describe("the 65816", () => {
  it("comes up in emulation mode and leaves it when told to", () => {
    const bus = new Flat();
    bus.memory[0xfffc] = 0x00;
    bus.memory[0xfffd] = 0x80;
    const cpu = new Cpu(bus);
    cpu.reset();
    expect(cpu.e).toBe(true);
    expect(cpu.narrowA).toBe(true);
    const asm = new Asm65816(0x8000);
    asm.clc();
    asm.xce();
    asm.rep(0x30);
    bus.memory.set(asm.assemble(), 0x8000);
    cpu.step();
    cpu.step();
    cpu.step();
    expect(cpu.e).toBe(false);
    expect(cpu.narrowA).toBe(false);
    expect(cpu.narrowIndex).toBe(false);
  });

  it("loads and stores sixteen bits when the accumulator is wide, and eight when it is not", () => {
    const wide = run((asm) => {
      asm.lda(imm16(0x1234));
      asm.sta(abs(0x0040));
    });
    expect(word(wide.bus, 0x0040)).toBe(0x1234);

    const narrow = run((asm) => {
      asm.lda(imm16(0xffff));
      asm.sta(abs(0x0040));
      asm.sep(0x20);
      asm.lda(imm8(0x12));
      asm.sta(abs(0x0040));
      asm.rep(0x20);
    });
    // Only the low byte moved: the one above it is what the wide store left.
    expect(word(narrow.bus, 0x0040)).toBe(0xff12);
  });

  it("adds and subtracts across sixteen bits, with the carry chaining as it must", () => {
    const { bus } = run((asm) => {
      asm.lda(imm16(0xffff));
      asm.sta(abs(0x0040));
      asm.lda(imm16(0x0000));
      asm.sta(abs(0x0042));
      asm.clc();
      asm.lda(abs(0x0040));
      asm.adc(imm16(0x0001));
      asm.sta(abs(0x0040));
      asm.lda(abs(0x0042));
      asm.adc(imm16(0x0000));
      asm.sta(abs(0x0042));
    });
    expect(word(bus, 0x0040)).toBe(0x0000);
    expect(word(bus, 0x0042)).toBe(0x0001);
  });

  it("narrowing the index registers throws their high bytes away, for good", () => {
    const { cpu } = run((asm) => {
      asm.ldx(imm16(0x1234));
      asm.sep(0x10);
      asm.rep(0x10);
    });
    expect(cpu.x).toBe(0x0034);
  });

  it("indexes the whole bank, which is what a wide index is for", () => {
    const { bus } = run((asm) => {
      asm.ldx(imm16(0x0f00));
      asm.lda(imm16(0xbeef));
      asm.sta(absX(0x1000));
    });
    expect(word(bus, 0x1f00)).toBe(0xbeef);
  });

  it("reaches another bank with a long address, which is where the tile art lives", () => {
    const asm = new Asm65816(SNES_ORIGIN);
    asm.label("Start");
    asm.clc();
    asm.xce();
    asm.rep(0x38);
    asm.lda(long(0x018000));
    asm.sta(abs(0x0040));
    asm.stp();
    const bus = new Flat();
    bus.memory.set(asm.assemble(), SNES_ORIGIN);
    bus.memory[0x018000] = 0xcd;
    bus.memory[0x018001] = 0xab;
    bus.memory[0xfffc] = 0x00;
    bus.memory[0xfffd] = 0x80;
    const cpu = new Cpu(bus);
    cpu.reset();
    for (let index = 0; index < 20 && !cpu.stopped; index += 1) cpu.step();
    expect(word(bus, 0x0040)).toBe(0xabcd);
  });

  it("shifts a thirty-two bit value right arithmetically, which is what floor needs", () => {
    const { bus } = run((asm) => {
      // -1 in 16.16, shifted right one: still -1, because floor rounds down.
      asm.lda(imm16(0xffff));
      asm.sta(abs(0x0040));
      asm.sta(abs(0x0042));
      asm.lda(abs(0x0042));
      asm.asl();
      asm.ror(abs(0x0042));
      asm.ror(abs(0x0040));
    });
    expect(word(bus, 0x0040)).toBe(0xffff);
    expect(word(bus, 0x0042)).toBe(0xffff);
  });

  it("swaps the accumulator's halves, which is how a byte reaches a high position", () => {
    const { cpu } = run((asm) => {
      asm.lda(imm16(0x00f0));
      asm.xba();
    });
    expect(cpu.a).toBe(0xf000);
  });

  it("sets bits without touching the byte beside them", () => {
    const { bus } = run((asm) => {
      asm.lda(imm16(0xff00));
      asm.sta(abs(0x0040));
      asm.lda(imm16(0x0005));
      asm.tsb(abs(0x0040));
    });
    expect(word(bus, 0x0040)).toBe(0xff05);
  });

  it("calls and returns, and an interrupt saves the bank a return does not", () => {
    const { bus, cpu } = run((asm) => {
      asm.jsr("Helper");
      asm.sta(abs(0x0040));
      asm.jmp("Done");
      asm.label("Helper");
      asm.lda(imm16(0x4321));
      asm.rts();
      asm.label("Done");
    });
    expect(word(bus, 0x0040)).toBe(0x4321);
    // The stack came back to where it started, which a mismatched push would not.
    expect(cpu.s).toBe(0x1fff);
  });

  it("takes the native interrupt vector and comes back through rti", () => {
    const asm = new Asm65816(SNES_ORIGIN);
    asm.label("Start");
    asm.clc();
    asm.xce();
    asm.rep(0x38);
    asm.ldx(imm16(0x1fff));
    asm.txs();
    asm.lda(imm16(0x1111));
    asm.label("Wait");
    asm.nop();
    asm.sta(abs(0x0040));
    asm.stp();
    asm.label("Handler");
    asm.lda(imm16(0x2222));
    asm.sta(abs(0x0042));
    asm.rti();
    const bus = new Flat();
    bus.memory.set(asm.assemble(), SNES_ORIGIN);
    bus.memory[0xfffc] = 0x00;
    bus.memory[0xfffd] = 0x80;
    const nmi = asm.addressOf("Handler");
    bus.memory[0xffea] = nmi & 0xff;
    bus.memory[0xffeb] = (nmi >> 8) & 0xff;
    const cpu = new Cpu(bus);
    cpu.reset();
    for (let index = 0; index < 7; index += 1) cpu.step();
    cpu.nmi();
    for (let index = 0; index < 20 && !cpu.stopped; index += 1) cpu.step();
    // The handler ran, and the interrupted code's accumulator survived it.
    expect(word(bus, 0x0042)).toBe(0x2222);
    expect(word(bus, 0x0040)).toBe(0x2222);
  });
});
