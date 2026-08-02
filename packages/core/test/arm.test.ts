/**
 * The ARM assembler, as an encoder.
 *
 * Tested for the reason the other five are: it decides output bytes, so it is a
 * tested artifact rather than a convenience. Every word below is read off the
 * ARM Architecture Reference Manual's encoding tables (DDI 0100E §A3) and
 * written here as a literal, because an encoder and a decoder that agreed with
 * each other and not with the hardware would still pass a round trip.
 *
 * Three things get more attention than the rest, because they are the three
 * places this architecture is unlike every other CPU in the set:
 *
 *   - **The rotated immediate**, which is a search rather than a field. A value
 *     it cannot express has to become a pooled load, and the assembler is the
 *     only thing that knows which values those are.
 *   - **The literal pool**, which is the whole reason `ltorg` exists and the one
 *     way an ARM program can be wrong in a way that assembles.
 *   - **The `I` bit**, which means "immediate" in a data-processing instruction
 *     and "register" in a load or store.
 */

import { describe, expect, it } from "vitest";

import {
  AsmArm,
  AsmError,
  LR,
  PC,
  R0,
  R1,
  R2,
  R3,
  R4,
  SP,
  armAsr,
  armAt,
  armAtIdx,
  armAtPost,
  armAtPre,
  armImm,
  armLsl,
  armLsr,
  armReg,
  armRrx,
  armShiftBy,
  encodeArmImm,
  fitsArmImm,
  invertCond,
  label,
} from "../src/asm/arm.js";

/** Assemble a body and read it back as instruction words. */
function words(body: (asm: AsmArm) => void, origin = 0): number[] {
  const asm = new AsmArm(origin);
  body(asm);
  const bytes = asm.assemble();
  const out: number[] = [];
  for (let at = 0; at < bytes.length; at += 4) {
    out.push(
      ((bytes[at] as number) |
        ((bytes[at + 1] as number) << 8) |
        ((bytes[at + 2] as number) << 16) |
        ((bytes[at + 3] as number) << 24)) >>>
        0,
    );
  }
  return out;
}

describe("the ARM immediate", () => {
  it("is an 8-bit value rotated right by an even amount", () => {
    expect(encodeArmImm(0)).toBe(0x000);
    expect(encodeArmImm(0xff)).toBe(0x0ff);
    // 0x100 is 1 rotated right by 24, which is rotate field 12.
    expect(encodeArmImm(0x100)).toBe(0xc01);
    // Two rotations express this one; the search takes the smallest, which is
    // also what GNU as emits — so the two agree byte for byte on the same source.
    expect(encodeArmImm(0x4000000)).toBe(0x301);
    // The top bits are reachable because the rotation wraps.
    expect(encodeArmImm(0xff000000)).toBe(0x4ff);
  });

  it("refuses the values that need nine bits of span", () => {
    expect(encodeArmImm(0x101)).toBeUndefined();
    expect(encodeArmImm(0x1ff)).toBeUndefined();
    expect(fitsArmImm(0x12345678)).toBe(false);
    expect(fitsArmImm(1 << 16)).toBe(true);
  });
});

describe("the ARM assembler", () => {
  it("encodes the data-processing forms", () => {
    expect(
      words((asm) => {
        asm.mov(R0, armImm(0));
        asm.mov(R1, armImm(1));
        asm.mvn(R0, armImm(0));
        asm.add(R0, R1, armReg(R2));
        asm.adds(R0, R1, armReg(R2));
        asm.sub(R3, R4, armImm(16));
        asm.rsb(R0, R0, armImm(0));
        asm.cmp(R0, armImm(0));
        asm.cmp(R0, armReg(R1));
        asm.and(R0, R0, armImm(0xff));
        asm.orr(R2, R2, armLsl(R3, 4));
      }),
    ).toEqual([
      0xe3a00000, 0xe3a01001, 0xe3e00000, 0xe0810002, 0xe0910002, 0xe2443010, 0xe2600000,
      0xe3500000, 0xe1500001, 0xe20000ff, 0xe1822203,
    ]);
  });

  it("spells the shifts the way the field does", () => {
    // `lsr #32` and `asr #32` are encoded as zero — there is no shift by nothing
    // in those two, because that is what the bare register means.
    expect(
      words((asm) => {
        asm.mov(R0, armLsr(R1, 32));
        asm.mov(R0, armAsr(R1, 32));
        asm.mov(R0, armAsr(R1, 16));
        asm.mov(R0, armShiftBy(R1, "asr", R2));
        asm.mov(R0, armRrx(R1));
      }),
    ).toEqual([0xe1a00021, 0xe1a00041, 0xe1a00841, 0xe1a00251, 0xe1a00061]);
  });

  it("refuses a shift the field cannot hold", () => {
    const asm = new AsmArm();
    expect(() => asm.mov(R0, armLsr(R1, 0))).toThrow(AsmError);
    expect(() => asm.mov(R0, armLsl(R1, 32))).toThrow(AsmError);
    expect(() => asm.mov(R0, armImm(0x12345678))).toThrow(/not an ARM immediate/);
  });

  it("encodes the multiplies, including the long ones a 16.16 product needs", () => {
    expect(
      words((asm) => {
        asm.mul(R0, R1, R2);
        asm.mla(R0, R1, R2, R3);
        asm.umull(R0, R1, R2, R3);
        asm.smull(R0, R1, R2, R3);
        asm.smlal(R0, R1, R2, R3);
      }),
    ).toEqual([0xe0000291, 0xe0203291, 0xe0810392, 0xe0c10392, 0xe0e10392]);
  });

  it("refuses the multiply operand overlap the core leaves unpredictable", () => {
    const asm = new AsmArm();
    expect(() => asm.mul(R0, R0, R1)).toThrow(AsmError);
    expect(() => asm.smull(R0, R0, R1, R2)).toThrow(AsmError);
  });

  it("encodes loads and stores, with the offset's sign as a direction bit", () => {
    expect(
      words((asm) => {
        asm.ldr(R0, armAt(R1));
        asm.ldr(R0, armAt(R1, 4));
        asm.ldr(R0, armAt(R1, -4));
        asm.str(R0, armAtPre(R1, 8));
        asm.ldr(R0, armAtPost(R1, 4));
        asm.ldrb(R0, armAtIdx(R1, R2));
        asm.strb(R0, armAt(R1, 1));
      }),
    ).toEqual([0xe5910000, 0xe5910004, 0xe5110004, 0xe5a10008, 0xe4910004, 0xe7d10002, 0xe5c10001]);
  });

  it("encodes the halfword forms, which are a different instruction entirely", () => {
    expect(
      words((asm) => {
        asm.ldrh(R0, armAt(R1, 4));
        asm.strh(R2, armAt(R3));
        asm.ldrsb(R0, armAt(R1, 0xff));
        asm.ldrsh(R0, armAtIdx(R1, R2));
      }),
    ).toEqual([0xe1d100b4, 0xe1c320b0, 0xe1d10fdf, 0xe19100f2]);
  });

  it("refuses a halfword offset past the eight bits it has", () => {
    const asm = new AsmArm();
    expect(() => asm.ldrh(R0, armAt(R1, 0x100))).toThrow(/build the address first/);
    // The word form has four more bits, so the same offset is fine there.
    expect(() => asm.ldr(R0, armAt(R1, 0x100))).not.toThrow();
  });

  it("encodes the block transfers a call frame is made of", () => {
    expect(
      words((asm) => {
        asm.push([R4, LR]);
        asm.pop([R4, PC]);
        asm.stm(R0, [R1, R2, R3], "ia", true);
        asm.ldm(SP, [R0], "ia", false);
      }),
    ).toEqual([0xe92d4010, 0xe8bd8010, 0xe8a0000e, 0xe89d0001]);
  });

  it("encodes branches against the pipeline's own view of the program counter", () => {
    // A branch is measured from this instruction plus eight, because that is
    // where the prefetch has already reached.
    expect(
      words((asm) => {
        asm.label("here");
        asm.b("here");
        asm.bl("far");
        asm.bx(LR);
        asm.ret();
        asm.padTo(0x100);
        asm.label("far");
      }),
    ).toEqual([
      0xeafffffe,
      0xeb00003d,
      0xe12fff1e,
      0xe12fff1e,
      ...Array.from({ length: 60 }, () => 0),
    ]);
  });

  it("carries the condition on every instruction, not only the branches", () => {
    expect(
      words((asm) => {
        asm.mov(R0, armImm(1), "eq");
        asm.mov(R0, armImm(0), "ne");
        asm.add(R0, R0, armImm(1), "lt");
        asm.b("skip", "gt");
        asm.label("skip");
      }),
    ).toEqual([0x03a00001, 0x13a00000, 0xb2800001, 0xcaffffff]);
  });

  it("pairs every condition with its inverse in the adjacent slot", () => {
    expect(invertCond("eq")).toBe("ne");
    expect(invertCond("ne")).toBe("eq");
    expect(invertCond("hi")).toBe("ls");
    expect(invertCond("ge")).toBe("lt");
    expect(invertCond("gt")).toBe("le");
    expect(() => invertCond("al")).toThrow(AsmError);
  });

  it("encodes the status-register and coprocessor forms the boot code needs", () => {
    expect(
      words((asm) => {
        asm.mrs(R0);
        asm.msr(R0, 0b0001);
        asm.msrImm(0x92, 0b0001);
        asm.swi(0x020000);
        asm.mcr(15, 0, R0, 1, 0, 0);
        asm.mrc(15, 0, R0, 1, 0, 0);
      }),
    ).toEqual([0xe10f0000, 0xe121f000, 0xe321f092, 0xef020000, 0xee010f10, 0xee110f10]);
  });
});

describe("the literal pool", () => {
  it("loads a constant the immediate field cannot express", () => {
    const out = words((asm) => {
      asm.ldrConst(R0, 0x12345678);
      asm.ret();
      asm.ltorg();
    });
    // `ldr r0, [pc, #0]` — the pool word sits at this instruction plus eight,
    // which is the instruction after the `bx lr`.
    expect(out).toEqual([0xe59f0000, 0xe12fff1e, 0x12345678]);
  });

  it("shares one word between identical constants", () => {
    const out = words((asm) => {
      asm.ldrConst(R0, 0x11223344);
      asm.ldrConst(R1, 0x11223344);
      asm.ldrConst(R2, 0x55667788);
      asm.ret();
      asm.ltorg();
    });
    expect(out).toEqual([
      0xe59f0008, // r0 ← [pc + 8]  → the word at 16
      0xe59f1004, // r1 ← [pc + 4]  → the same word at 16
      0xe59f2004, // r2 ← [pc + 4]  → the word at 20
      0xe12fff1e,
      0x11223344,
      0x55667788,
    ]);
  });

  it("pools a label's address, which is not known until the fixup sweep", () => {
    const out = words((asm) => {
      asm.ldrConst(R0, label("Table"));
      asm.ret();
      asm.ltorg();
      asm.label("Table");
      asm.dw(0xdeadbeef);
    }, 0x08000000);
    expect(out).toEqual([0xe59f0000, 0xe12fff1e, 0x0800000c, 0xdeadbeef]);
  });

  it("takes the cheap form when the immediate field can express the value", () => {
    const out = words((asm) => {
      asm.movImm32(R0, 0x100);
      asm.movImm32(R1, 0xffffffff);
      asm.movImm32(R2, 0x12345678);
      asm.ret();
      asm.ltorg();
    });
    expect(out).toEqual([
      0xe3a00c01, // mov  r0, #0x100
      0xe3e01000, // mvn  r1, #0
      0xe59f2000, // ldr  r2, [pc, #0]
      0xe12fff1e,
      0x12345678,
    ]);
  });

  it("refuses a load that cannot reach the pool it was given", () => {
    const asm = new AsmArm();
    asm.ldrConst(R0, 0x12345678);
    asm.ds(0x1004);
    expect(() => asm.ltorg()).toThrow(/call ltorg\(\) more often/);
  });

  it("flushes what is left when the program ends", () => {
    // The last routine in a program has nowhere to put its pool but the end, so
    // `assemble` places it — and the range check still applies, which is what
    // makes the convenience safe.
    const out = words((asm) => {
      asm.ldrConst(R0, 0xcafef00d);
      asm.ret();
    });
    expect(out).toEqual([0xe59f0000, 0xe12fff1e, 0xcafef00d]);
  });
});

describe("labels and data", () => {
  it("resolves a forward reference and reports one that never arrives", () => {
    const asm = new AsmArm(0x08000000);
    asm.b("Later");
    asm.label("Later");
    // The label is the *next* instruction, which is eight bytes behind the
    // program counter the branch is measured from: a displacement of −1 word.
    expect([...asm.assemble()]).toEqual([0xff, 0xff, 0xff, 0xea]);

    const broken = new AsmArm();
    broken.b("Nowhere");
    expect(() => broken.assemble()).toThrow(/undefined label/);
  });

  it("writes data little-endian, and keeps instructions word-aligned", () => {
    const asm = new AsmArm();
    asm.db(1, 2, 3);
    asm.align();
    asm.dh(0x1234);
    asm.dw(0x89abcdef);
    expect([...asm.assemble()]).toEqual([1, 2, 3, 0, 0x34, 0x12, 0xef, 0xcd, 0xab, 0x89]);
  });

  it("refuses an instruction at an odd address rather than emitting one", () => {
    const asm = new AsmArm();
    asm.db(1);
    expect(() => asm.nop()).toThrow(/not word-aligned/);
  });
});
