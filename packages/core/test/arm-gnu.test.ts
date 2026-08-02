/**
 * The ARM encoder against the reference assembler.
 *
 * `arm.test.ts` pins hand-read encodings, which is what every other encoder in
 * `core` gets and what catches a transcription error. This file is the stronger
 * oracle the ARM toolchain happens to make available: the same instructions are
 * assembled by `arm-none-eabi-as` — the assembler the display-ROM harnesses
 * already build with (doc 10) — and compared word for word.
 *
 * It matters more here than it would for the 8-bit CPUs. Those have an opcode
 * per addressing form, so a wrong byte is a wrong *instruction* and a decoder
 * finds it. ARM has one instruction with five operand shapes packed into
 * twelve bits, and a shift field written into the wrong nibble still decodes as
 * something — just not as the thing that was meant.
 *
 * It self-skips without the toolchain, exactly as `rom.e2e.test.ts` does, so it
 * costs a bare machine nothing. Run `pnpm toolchains` to exercise it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AsmArm,
  armAsr,
  armAt,
  armAtIdx,
  armAtIdxPost,
  armAtIdxSub,
  armAtPost,
  armAtPre,
  armImm,
  armLsl,
  armLsr,
  armReg,
  armRor,
  armRrx,
  armShiftBy,
} from "../src/asm/arm.js";

/** One instruction, spelled twice: for GNU as, and for ours. */
interface Case {
  text: string;
  build: (asm: AsmArm) => void;
}

const CASES: readonly Case[] = [
  // Data processing, every opcode and every operand shape.
  { text: "and r0, r1, r2", build: (a) => void a.and(0, 1, armReg(2)) },
  { text: "ands r0, r1, #255", build: (a) => void a.ands(0, 1, armImm(255)) },
  { text: "eor r5, r6, r7, lsl #3", build: (a) => void a.eor(5, 6, armLsl(7, 3)) },
  { text: "sub r0, r0, #1", build: (a) => void a.sub(0, 0, armImm(1)) },
  { text: "subs r9, r10, r11, asr #12", build: (a) => void a.subs(9, 10, armAsr(11, 12)) },
  { text: "rsb r1, r2, #0", build: (a) => void a.rsb(1, 2, armImm(0)) },
  { text: "add r12, r13, r14, ror #7", build: (a) => void a.add(12, 13, armRor(14, 7)) },
  { text: "adc r0, r1, r2, rrx", build: (a) => void a.adc(0, 1, armRrx(2)) },
  { text: "sbc r3, r4, r5, lsr r6", build: (a) => void a.sbc(3, 4, armShiftBy(5, "lsr", 6)) },
  { text: "rsc r0, r1, #65536", build: (a) => void a.rsc(0, 1, armImm(65536)) },
  { text: "tst r0, #1", build: (a) => void a.tst(0, armImm(1)) },
  { text: "teq r7, r8", build: (a) => void a.teq(7, armReg(8)) },
  { text: "cmp r0, #4096", build: (a) => void a.cmp(0, armImm(4096)) },
  { text: "cmn r1, r2, lsl #31", build: (a) => void a.cmn(1, armLsl(2, 31)) },
  { text: "orr r0, r0, #3221225472", build: (a) => void a.orr(0, 0, armImm(0xc0000000)) },
  { text: "mov r0, r1, lsr #32", build: (a) => void a.mov(0, armLsr(1, 32)) },
  { text: "movs pc, lr", build: (a) => void a.movs(15, armReg(14)) },
  { text: "bic r4, r4, #240", build: (a) => void a.bic(4, 4, armImm(0xf0)) },
  { text: "mvn r0, r1, asr #32", build: (a) => void a.mvn(0, armAsr(1, 32)) },

  // The condition field, on instructions that are not branches.
  { text: "moveq r0, #1", build: (a) => void a.mov(0, armImm(1), "eq") },
  { text: "addne r1, r2, r3", build: (a) => void a.add(1, 2, armReg(3), "ne") },
  { text: "cmphi r0, r1", build: (a) => void a.cmp(0, armReg(1), "hi") },
  { text: "mvnlt r0, #0", build: (a) => void a.mvn(0, armImm(0), "lt") },

  // Multiplies, including the long forms a 16.16 product is made of.
  { text: "mul r0, r1, r2", build: (a) => void a.mul(0, 1, 2) },
  { text: "mla r4, r5, r6, r7", build: (a) => void a.mla(4, 5, 6, 7) },
  { text: "umull r0, r1, r2, r3", build: (a) => void a.umull(0, 1, 2, 3) },
  { text: "umlal r0, r1, r2, r3", build: (a) => void a.umlal(0, 1, 2, 3) },
  { text: "smull r4, r5, r6, r7", build: (a) => void a.smull(4, 5, 6, 7) },
  { text: "smlal r4, r5, r6, r7", build: (a) => void a.smlal(4, 5, 6, 7) },

  // Word and byte transfers, and the direction bit an offset's sign becomes.
  { text: "ldr r0, [r1]", build: (a) => void a.ldr(0, armAt(1)) },
  { text: "ldr r0, [r1, #4095]", build: (a) => void a.ldr(0, armAt(1, 4095)) },
  { text: "ldr r0, [r1, #-2048]", build: (a) => void a.ldr(0, armAt(1, -2048)) },
  { text: "str r2, [r3, #12]!", build: (a) => void a.str(2, armAtPre(3, 12)) },
  { text: "ldr r0, [r1], #-8", build: (a) => void a.ldr(0, armAtPost(1, -8)) },
  { text: "ldrb r0, [r1, r2]", build: (a) => void a.ldrb(0, armAtIdx(1, 2)) },
  { text: "ldr r0, [r1, r2, lsl #2]", build: (a) => void a.ldr(0, armAtIdx(1, 2, "lsl", 2)) },
  { text: "ldr r0, [r1, -r2, asr #4]", build: (a) => void a.ldr(0, armAtIdxSub(1, 2, "asr", 4)) },
  { text: "strb r7, [r8], r9", build: (a) => void a.strb(7, armAtIdxPost(8, 9)) },

  // The halfword and signed forms, whose offset is eight bits in two pieces.
  { text: "ldrh r0, [r1, #4]", build: (a) => void a.ldrh(0, armAt(1, 4)) },
  { text: "strh r2, [r3]", build: (a) => void a.strh(2, armAt(3)) },
  { text: "ldrsb r0, [r1, #255]", build: (a) => void a.ldrsb(0, armAt(1, 255)) },
  { text: "ldrsh r0, [r1, r2]", build: (a) => void a.ldrsh(0, armAtIdx(1, 2)) },
  { text: "ldrh r4, [r5, #-16]", build: (a) => void a.ldrh(4, armAt(5, -16)) },
  { text: "strh r0, [r1, #2]!", build: (a) => void a.strh(0, armAtPre(1, 2)) },

  // Block transfers — all four modes, which is where P and U stop being obvious.
  { text: "stmdb sp!, {r4, lr}", build: (a) => void a.push([4, 14]) },
  { text: "ldmia sp!, {r4, pc}", build: (a) => void a.pop([4, 15]) },
  { text: "stmia r0!, {r1, r2, r3}", build: (a) => void a.stm(0, [1, 2, 3], "ia", true) },
  { text: "ldmdb r7, {r0-r3}", build: (a) => void a.ldm(7, [0, 1, 2, 3], "db", false) },
  { text: "stmib r1, {r0, r5, r10}", build: (a) => void a.stm(1, [0, 5, 10], "ib", false) },
  { text: "ldmda r2!, {r15}", build: (a) => void a.ldm(2, [15], "da", true) },

  // Everything the boot code and the interrupt handler need.
  { text: "bx lr", build: (a) => void a.bx(14) },
  { text: "bx r3", build: (a) => void a.bx(3) },
  { text: "mrs r0, cpsr", build: (a) => void a.mrs(0) },
  { text: "mrs r1, spsr", build: (a) => void a.mrs(1, true) },
  { text: "msr cpsr_c, r0", build: (a) => void a.msr(0, 0b0001) },
  { text: "msr cpsr_fc, r2", build: (a) => void a.msr(2, 0b1001) },
  { text: "msr spsr_f, r3", build: (a) => void a.msr(3, 0b1000, true) },
  { text: "msr cpsr_c, #146", build: (a) => void a.msrImm(146, 0b0001) },
  { text: "swi 131072", build: (a) => void a.swi(0x020000) },
  { text: "mcr p15, 0, r0, c1, c0, 0", build: (a) => void a.mcr(15, 0, 0, 1, 0, 0) },
  { text: "mrc p15, 0, r0, c1, c0, 0", build: (a) => void a.mrc(15, 0, 0, 1, 0, 0) },
  { text: "mcr p15, 0, r1, c9, c1, 0", build: (a) => void a.mcr(15, 0, 1, 9, 1, 0) },
  { text: "nop", build: (a) => void a.nop() },
];

/** Assemble the whole battery with GNU as, or report that it is not installed. */
function reference(): Uint32Array | undefined {
  const dir = mkdtempSync(join(tmpdir(), "demake-arm-"));
  const source = `.text\n.arm\n${CASES.map((c) => c.text).join("\n")}\n`;
  writeFileSync(join(dir, "battery.s"), source);
  try {
    execFileSync("arm-none-eabi-as", [
      "-mcpu=arm7tdmi",
      "-o",
      join(dir, "battery.o"),
      join(dir, "battery.s"),
    ]);
    execFileSync("arm-none-eabi-objcopy", [
      "-O",
      "binary",
      join(dir, "battery.o"),
      join(dir, "battery.bin"),
    ]);
  } catch {
    return undefined;
  }
  const bytes = readFileSync(join(dir, "battery.bin"));
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
}

const REFERENCE = reference();

describe.skipIf(REFERENCE === undefined)("the ARM encoder against arm-none-eabi-as", () => {
  it("assembles the same bytes, instruction for instruction", () => {
    const expected = REFERENCE as Uint32Array;
    expect(expected.length).toBe(CASES.length);
    const mismatches: string[] = [];
    CASES.forEach((entry, index) => {
      const asm = new AsmArm();
      entry.build(asm);
      const bytes = asm.assemble();
      const ours = (((bytes[0] as number) |
        ((bytes[1] as number) << 8) |
        ((bytes[2] as number) << 16) |
        ((bytes[3] as number) << 24)) >>>
        0) as number;
      const theirs = expected[index] as number;
      if (bytes.length !== 4 || ours !== theirs) {
        mismatches.push(
          `${entry.text}: gnu ${theirs.toString(16).padStart(8, "0")}, ours ${ours
            .toString(16)
            .padStart(8, "0")}`,
        );
      }
    });
    expect(mismatches).toEqual([]);
  });
});
