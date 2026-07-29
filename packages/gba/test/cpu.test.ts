/**
 * The ARM7TDMI and the console around it.
 *
 * Driven by `@demake/core`'s own ARM assembler, which is the arrangement every
 * other core in this project uses and the reason it is worth stating: an encoder
 * and a decoder that agreed with each other and not with the hardware would
 * still fail, because `core/test/arm-gnu.test.ts` pins the encoder against
 * `arm-none-eabi-as` and this pins the decoder against the encoder. Neither test
 * alone would catch a shared misreading of the manual.
 *
 * What gets the most attention is what the eight-bit cores had no counterpart
 * for: the literal pool a 32-bit constant needs, the 64-bit product a 16.16
 * multiply is made of, and the interrupt path — which on this console runs
 * through a BIOS dispatcher, in a mode with its own stack, and returns by
 * restoring a saved status register rather than by branching.
 */

import {
  AsmArm,
  GBA_HEADER_SIZE,
  armAsr,
  armAt,
  armImm,
  armLsl,
  armReg,
  packGbaRom,
} from "@demake/core";
import { describe, expect, it } from "vitest";

import { Gba, ROM_BASE } from "../src/index.js";

/** Assemble a body into a cartridge that halts on a branch to itself. */
function cartridge(body: (asm: AsmArm) => void): Uint8Array {
  const asm = new AsmArm(ROM_BASE);
  asm.b("start");
  asm.padTo(ROM_BASE + GBA_HEADER_SIZE);
  asm.label("start");
  body(asm);
  asm.label("stop");
  asm.b("stop");
  asm.ltorg();
  return packGbaRom(asm.assemble());
}

/** Boot a cartridge and run until it reaches its own tail, or a step budget. */
function run(body: (asm: AsmArm) => void, steps = 2000): Gba {
  const gba = new Gba(cartridge(body));
  for (let step = 0; step < steps; step += 1) gba.stepInstruction();
  return gba;
}

/** The word at an internal-work-RAM address. */
function word(gba: Gba, address: number): number {
  return gba.read32(address) >>> 0;
}

const SCRATCH = 0x03000000;

describe("the processor", () => {
  it("runs from the cartridge and writes to internal work RAM", () => {
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      asm.movImm32(1, 0x12345678);
      asm.str(1, armAt(0));
    }, 40);
    expect(word(gba, SCRATCH)).toBe(0x12345678);
  });

  it("loads a constant the immediate field cannot express, through the pool", () => {
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      // Three values: one a plain immediate, one the complement of an
      // immediate, one that has to be pooled.
      asm.movImm32(1, 0x100);
      asm.movImm32(2, 0xffffff00);
      asm.movImm32(3, 0xdeadbeef);
      asm.str(1, armAt(0, 0));
      asm.str(2, armAt(0, 4));
      asm.str(3, armAt(0, 8));
    }, 40);
    expect(word(gba, SCRATCH)).toBe(0x100);
    expect(word(gba, SCRATCH + 4)).toBe(0xffffff00);
    expect(word(gba, SCRATCH + 8)).toBe(0xdeadbeef);
  });

  it("sets the flags a signed comparison needs, both ways round", () => {
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      asm.movImm32(1, 5);
      asm.mvn(2, armImm(9)); // −10
      asm.cmp(1, armReg(2));
      asm.mov(3, armImm(0));
      asm.mov(3, armImm(1), "gt"); // 5 > −10
      asm.str(3, armAt(0, 0));
      asm.cmp(2, armReg(1));
      asm.mov(3, armImm(0));
      asm.mov(3, armImm(1), "lt"); // −10 < 5
      asm.str(3, armAt(0, 4));
    }, 60);
    expect(word(gba, SCRATCH)).toBe(1);
    expect(word(gba, SCRATCH + 4)).toBe(1);
  });

  it("takes the middle words of a 64-bit product, which is a 16.16 multiply", () => {
    // 2.5 × −3.25 = −8.125, in 16.16.
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      asm.movImm32(1, 2.5 * 65536);
      asm.movImm32(2, (-3.25 * 65536) >>> 0);
      asm.smull(3, 4, 1, 2);
      asm.mov(3, { k: "shift", r: 3, by: "lsr", n: 16 });
      asm.orr(3, 3, armLsl(4, 16));
      asm.str(3, armAt(0));
    }, 60);
    expect(word(gba, SCRATCH) | 0).toBe(-8.125 * 65536);
  });

  it("sets the overflow flag on a comparison, which is not a logical operation", () => {
    // `cmp` and `cmn` are arithmetic and set V like the `sub` and `add` they
    // are; `tst` and `teq` are logical and leave it. Classifying the four
    // together produces flags that are right until a comparison overflows —
    // which is what comparing against the end of the 16.16 range does, so the
    // symptom was a value clamped to the wrong end of it.
    const gba = run((asm) => {
      asm.movImm32(0, 0x03000000);
      asm.movImm32(1, 0x80000000); // the most negative integer
      asm.cmp(1, armImm(0x04000000));
      asm.mov(2, armImm(0));
      asm.mov(2, armImm(1), "gt"); // must be false: the subtraction overflows
      asm.str(2, armAt(0, 0));
      asm.mov(2, armImm(0));
      asm.mov(2, armImm(1), "lt"); // and this must be true
      asm.str(2, armAt(0, 4));
    }, 60);
    expect(word(gba, SCRATCH)).toBe(0);
    expect(word(gba, SCRATCH + 4)).toBe(1);
  });

  it("shifts arithmetically, keeping a negative fixed-point value negative", () => {
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      asm.movImm32(1, (-9 >>> 0) as number);
      asm.mov(2, armAsr(1, 1));
      asm.str(2, armAt(0));
    }, 40);
    expect(word(gba, SCRATCH) | 0).toBe(-5);
  });

  it("calls and returns through the link register", () => {
    const gba = run((asm) => {
      asm.movImm32(4, SCRATCH);
      asm.mov(5, armImm(0));
      asm.bl("bump");
      asm.bl("bump");
      asm.bl("bump");
      asm.str(5, armAt(4));
      asm.b("done");
      asm.label("bump");
      asm.add(5, 5, armImm(7));
      asm.ret();
      asm.label("done");
    }, 60);
    expect(word(gba, SCRATCH)).toBe(21);
  });

  it("pushes and pops a frame, restoring what the callee used", () => {
    const gba = run((asm) => {
      asm.movImm32(4, SCRATCH);
      asm.movImm32(5, 0xaaaa);
      asm.movImm32(6, 0xbbbb);
      asm.bl("clobber");
      asm.str(5, armAt(4, 0));
      asm.str(6, armAt(4, 4));
      asm.b("done");
      asm.label("clobber");
      asm.push([5, 6, 14]);
      asm.mov(5, armImm(0));
      asm.mov(6, armImm(0));
      asm.pop([5, 6, 15]);
      asm.label("done");
    }, 60);
    expect(word(gba, SCRATCH)).toBe(0xaaaa);
    expect(word(gba, SCRATCH + 4)).toBe(0xbbbb);
  });

  it("reads and writes halfwords and bytes at their own widths", () => {
    const gba = run((asm) => {
      asm.movImm32(0, SCRATCH);
      asm.movImm32(1, 0x1234);
      asm.strh(1, armAt(0, 0));
      asm.movImm32(1, 0x56);
      asm.strb(1, armAt(0, 2));
      asm.ldrh(2, armAt(0, 0));
      asm.str(2, armAt(0, 4));
      asm.movImm32(1, 0xff80);
      asm.strh(1, armAt(0, 8));
      asm.ldrsh(3, armAt(0, 8));
      asm.str(3, armAt(0, 12));
    }, 60);
    expect(word(gba, SCRATCH) & 0xffffff).toBe(0x561234);
    expect(word(gba, SCRATCH + 4)).toBe(0x1234);
    expect(word(gba, SCRATCH + 12) | 0).toBe(-128);
  });
});

describe("the console", () => {
  it("reports the pad active low, and only the buttons the language names", () => {
    // A halfword transfer reaches ±255 from its base, so the pad's register
    // gets a base of its own rather than an offset from the I/O page — which is
    // the same accommodation every emitter on this console has to make.
    const gba = run((asm) => {
      asm.movImm32(0, 0x04000130);
      asm.movImm32(1, 0x03000000);
      asm.label("loop");
      asm.ldrh(2, armAt(0));
      asm.str(2, armAt(1));
      asm.b("loop");
    }, 20);
    expect(word(gba, SCRATCH) & 0x3ff).toBe(0x3ff);
    gba.setButtons(["a", "start"]);
    for (let step = 0; step < 20; step += 1) gba.stepInstruction();
    expect(word(gba, SCRATCH) & 0x3ff).toBe(0x3ff & ~0x9);
  });

  it("copies through DMA the moment the channel is enabled", () => {
    const gba = run((asm) => {
      asm.movImm32(0, 0x04000000);
      asm.movImm32(1, SCRATCH);
      // Four words of a recognisable pattern, then a DMA of them into VRAM.
      asm.movImm32(2, 0x11112222);
      asm.str(2, armAt(1, 0));
      asm.movImm32(2, 0x33334444);
      asm.str(2, armAt(1, 4));
      asm.str(1, armAt(0, 0xd4)); // DMA3 source
      asm.movImm32(2, 0x06000000);
      asm.str(2, armAt(0, 0xd8)); // DMA3 destination
      asm.movImm32(2, 0x84000002); // enable, 32-bit, immediate, two words
      asm.str(2, armAt(0, 0xdc));
    }, 80);
    expect(gba.read32(0x06000000) >>> 0).toBe(0x11112222);
    expect(gba.read32(0x06000004) >>> 0).toBe(0x33334444);
  });

  it("takes an interrupt through the dispatcher and comes back where it left", () => {
    const gba = new Gba(
      cartridge((asm) => {
        asm.movImm32(0, 0x04000000);
        asm.movImm32(1, SCRATCH);
        asm.mov(2, armImm(0));
        asm.str(2, armAt(1));
        // The handler's address goes where the dispatcher reads it from.
        asm.movImm32(2, 0x03007ffc);
        asm.movImm32(3, { label: "handler", addend: 0 });
        asm.str(3, armAt(2));
        asm.movImm32(8, 0x04000200); // the interrupt registers, past ±255
        asm.mov(3, armImm(1));
        asm.strh(3, armAt(8, 0x00)); // IE = vertical blank
        asm.strh(3, armAt(8, 0x08)); // IME
        asm.mov(3, armImm(0x08)); // DISPSTAT: raise on vertical blank
        asm.strh(3, armAt(0, 0x04));
        asm.movImm32(7, 0xc0ffee); // a register the handler must not disturb
        asm.label("idle");
        // Halt rather than spin, which is what a game\'s main loop does and why
        // a conformance run is affordable at all.
        asm.mov(4, armImm(0));
        asm.strb(4, armAt(0, 0x301));
        asm.b("idle");
        asm.ltorg();

        asm.label("handler");
        asm.movImm32(5, 0x04000202);
        asm.mov(6, armImm(1));
        asm.strh(6, armAt(5)); // acknowledge
        asm.movImm32(5, SCRATCH);
        asm.ldr(6, armAt(5));
        asm.add(6, 6, armImm(1));
        asm.str(6, armAt(5));
        asm.ret();
        asm.ltorg();
      }),
    );
    for (let frame = 0; frame < 3; frame += 1) gba.runFrame();
    expect(word(gba, SCRATCH)).toBe(3);
    // The interrupted program\'s own registers survived, which is what the
    // dispatcher\'s banked stack is for.
    expect(gba.cpu.r[7] >>> 0).toBe(0xc0ffee);
  });

  it("counts a timer at its prescaler and raises when it wraps", () => {
    const gba = new Gba(
      cartridge((asm) => {
        asm.movImm32(0, 0x04000000);
        asm.movImm32(1, SCRATCH);
        asm.mov(2, armImm(0));
        asm.str(2, armAt(1));
        asm.movImm32(2, { label: "handler", addend: 0 });
        asm.movImm32(3, 0x03007ffc);
        asm.str(2, armAt(3));
        asm.movImm32(8, 0x04000200);
        asm.movImm32(2, 0x08); // IE = timer 0
        asm.strh(2, armAt(8, 0x00));
        asm.mov(2, armImm(1));
        asm.strh(2, armAt(8, 0x08)); // IME
        // Timer 0 at the system clock, reloading every 1024 cycles.
        asm.movImm32(9, 0x04000100);
        asm.movImm32(2, 0x10000 - 1024);
        asm.strh(2, armAt(9, 0x00));
        asm.movImm32(2, 0xc0); // enable + interrupt, prescaler 1
        asm.strh(2, armAt(9, 0x02));
        asm.label("idle");
        asm.mov(4, armImm(0));
        asm.strb(4, armAt(0, 0x301));
        asm.b("idle");
        asm.ltorg();

        asm.label("handler");
        asm.movImm32(5, 0x04000202);
        asm.movImm32(6, 0x08);
        asm.strh(6, armAt(5));
        asm.movImm32(5, SCRATCH);
        asm.ldr(6, armAt(5));
        asm.add(6, 6, armImm(1));
        asm.str(6, armAt(5));
        asm.ret();
        asm.ltorg();
      }),
    );
    gba.runFrame();
    // 280,896 cycles a frame at 1024 cycles a tick is 274 interrupts, less the
    // few hundred the setup spends before the timer starts.
    expect(word(gba, SCRATCH)).toBeGreaterThan(260);
    expect(word(gba, SCRATCH)).toBeLessThanOrEqual(274);
  });
});
