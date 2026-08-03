/**
 * The PC Engine value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The counterpart of `nes-arith.test.ts`, and it looks like a duplicate of it on
 * purpose: the *emitters* are the same file (`codegen/mos/val.ts`), because a
 * HuC6280 is a 6502 with a memory mapper on it — so what this proves is not the
 * arithmetic a second time but that the same instructions still mean the same
 * thing on the second machine that runs them.
 *
 * Two things about this console can break that, and neither would show up as a
 * wrong sum on the first. **Zero page is at `$2000`**, so an operand the plan put
 * in the cheap page is `zp $7E` to the instruction and `$207E` to an indexed
 * access — and a backend that got the two the same way round on one machine and
 * not the other would produce a game that plays *almost* right and diverges a
 * thousand ticks later. And **the mapper decides what an address means at all**,
 * so a program whose `tam`s were wrong would read its own code as data.
 *
 * The vectors are the NES's, deliberately: the cases that differ between
 * implementations rather than the ones that cover lines.
 */

import { describe, expect, it } from "vitest";

import { PCE_BANK_SIZE, packHuCard, Asm6280, imm, type Ref } from "@demake/core";
import { Pce } from "@demake/pce";

import { analyze } from "../src/codegen/analyze.js";
import { PCE_MEMORY, planLayout } from "../src/codegen/layout.js";
import {
  add32,
  asr32,
  branchLess32,
  clamp32,
  copy32,
  div32,
  mul32,
  neg32,
  set32,
  sub32,
} from "../src/codegen/mos/val.js";
import { PceCtx } from "../src/codegen/pce/ctx.js";
import { CODE_ORIGIN, BOOT_ORIGIN } from "../src/codegen/pce/emit.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("pce") });

/** Where a test's operands live — clear of everything the plan allocated. */
const A = 0x3000;
const B = 0x3004;
const OUT = 0x3008;

/** And one in the cheap page, which on this CPU is `$2000` and not `$0000`. */
const FAST = 0x2080;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Pce, address: number): number {
  const bytes = machine.readMemory(address, 4);
  return (
    (bytes[0] as number) |
    ((bytes[1] as number) << 8) |
    ((bytes[2] as number) << 16) |
    ((bytes[3] as number) << 24) |
    0
  );
}

/** Assemble `body` into a cartridge, run it to its spin loop, hand it back. */
function run(body: (ctx: PceCtx) => void): Pce {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, PCE_MEMORY);
  const ctx = new PceCtx(PROGRAM, analysis, layout, getProfile("pce"), CODE_ORIGIN);
  const { asm } = ctx;

  asm.label("Body");
  body(ctx);
  asm.label("Spin");
  asm.bra("Spin");
  ctx.finish();
  if (asm.pc > BOOT_ORIGIN) throw new Error("pce-arith: the test program is too big");

  // The boot stub, which on this console is not optional: until the `tam`s run
  // there is no work RAM, no stack and nothing at `$4000` at all.
  asm.padTo(BOOT_ORIGIN, 0xff);
  asm.label("Reset");
  asm.sei();
  asm.csh();
  asm.cld();
  asm.lda(imm(0xff));
  asm.tam(Asm6280.mprBit(0));
  asm.lda(imm(0xf8));
  asm.tam(Asm6280.mprBit(1));
  asm.ldx(imm(0xff));
  asm.txs();
  for (let page = 2; page <= 6; page += 1) {
    asm.lda(imm(page - 1));
    asm.tam(Asm6280.mprBit(page));
  }
  asm.jmp("Body");
  const code = asm.assemble();

  // The window rearranged into banks: reset maps bank 0 at `$E000`, so the top
  // 8 KiB of the image is bank 0 and everything below it follows.
  const split = BOOT_ORIGIN - CODE_ORIGIN;
  const banks = new Uint8Array(0x10000 - CODE_ORIGIN);
  banks.set(code.subarray(split), 0);
  banks.set(code.subarray(0, split), PCE_BANK_SIZE);
  const machine = new Pce(packHuCard(banks, { vectors: { reset: asm.addressOf("Reset") } }));

  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("pce: the program never reached its spin loop");
}

/** Run one binary operation over two operands and read the result. */
function binary(op: (ctx: PceCtx, dst: Ref, src: Ref) => void, a: number, b: number): number {
  const machine = run((ctx) => {
    set32(ctx, A, a);
    set32(ctx, B, b);
    op(ctx, A, B);
  });
  return read32(machine, A);
}

describe("the PC Engine 32-bit arithmetic", () => {
  it("adds and subtracts across the sign", () => {
    expect(binary(add32, 3 * ONE, -5 * ONE)).toBe(-2 * ONE);
    expect(binary(sub32, 3 * ONE, 5 * ONE)).toBe(-2 * ONE);
    expect(binary(add32, -1, 1)).toBe(0);
    expect(binary(sub32, 0, 1)).toBe(-1);
  });

  it("negates, and halves toward negative infinity", () => {
    const negated = run((ctx) => {
      set32(ctx, A, 5 * ONE + 1);
      neg32(ctx, A);
    });
    expect(read32(negated, A)).toBe(-(5 * ONE + 1));
    const halved = run((ctx) => {
      set32(ctx, A, -3);
      asr32(ctx, A);
    });
    expect(read32(halved, A)).toBe(-2);
  });

  it("copies four bytes and not a fifth", () => {
    const machine = run((ctx) => {
      set32(ctx, B, 0x12345678);
      set32(ctx, OUT, 0x7f7f7f7f);
      copy32(ctx, A, B);
    });
    expect(read32(machine, A)).toBe(0x12345678);
    expect(read32(machine, OUT)).toBe(0x7f7f7f7f);
  });

  it("multiplies exactly as the interpreter does", () => {
    const vectors: readonly (readonly [number, number])[] = [
      [3 * ONE, 2 * ONE],
      [ONE, 7 * ONE],
      [7 * ONE, ONE],
      [-ONE, 5 * ONE],
      [5 * ONE, -ONE],
      [-3 * ONE, -4 * ONE],
      [ONE + 32768, 3 * ONE],
      [-(ONE + 1), 3 * ONE],
      [0, 5 * ONE],
      [123456, -7891],
    ];
    for (const [a, b] of vectors) {
      expect(binary(mul32, a, b), `${a} * ${b}`).toBe(mul(a, b));
    }
  });

  it("divides exactly as the interpreter does, on both paths", () => {
    const vectors: readonly (readonly [number, number])[] = [
      [7 * ONE, 2 * ONE],
      [-7 * ONE, 2 * ONE],
      [7 * ONE, -2 * ONE],
      [-7 * ONE, -2 * ONE],
      [5 * ONE, 60 * ONE],
      [7 * ONE, ONE + 32768],
      [-7 * ONE, ONE + 32768],
      [ONE, 3 * ONE + 1],
      [0, 3 * ONE],
      [5 * ONE, 0],
    ];
    for (const [a, b] of vectors) {
      expect(binary(div32, a, b), `${a} / ${b}`).toBe(div(a, b));
    }
  });

  it("clamps to the range the interpreter clamps to, from either page", () => {
    const vectors = [
      0,
      ONE,
      -ONE,
      1024 * ONE,
      -1024 * ONE,
      1024 * ONE + 1,
      -(1024 * ONE) - 1,
      2000 * ONE,
      -2000 * ONE,
    ];
    for (const value of vectors) {
      const heap = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
      });
      expect(read32(heap, A), `clamp ${value} in work RAM`).toBe(clampFixed(value));
      // And once in the cheap page, which is the address this console gets wrong
      // if the two windows in `mos/zp.ts` were ever confused for each other.
      const zero = run((ctx) => {
        set32(ctx, FAST, value);
        clamp32(ctx, FAST);
      });
      expect(read32(zero, FAST), `clamp ${value} in the cheap page`).toBe(clampFixed(value));
    }
  });

  it("branches on a signed comparison the way collision needs it to", () => {
    const less = (a: number, b: number): number => {
      const machine = run((ctx) => {
        set32(ctx, A, a);
        set32(ctx, B, b);
        set32(ctx, OUT, 0);
        const no = ctx.unique("notLess");
        branchLess32(ctx, A, B, no, false);
        set32(ctx, OUT, 1);
        ctx.asm.label(no);
      });
      return read32(machine, OUT);
    };
    const cases: readonly (readonly [number, number])[] = [
      [1, 2],
      [2, 1],
      [0, 0],
      [-1, 1],
      [1, -1],
      [-2, -1],
      [-1024 * ONE, 1024 * ONE],
      [1024 * ONE, -1024 * ONE],
    ];
    for (const [a, b] of cases) {
      expect(less(a, b), `${a} < ${b}`).toBe(a < b ? 1 : 0);
    }
  });

  it("reaches the cheap page and work RAM as the same memory", () => {
    // The one property this console has that the NES does not: `$2080` is both
    // `zp $80` to an unindexed instruction and an ordinary absolute address to an
    // indexed one, and a build that disagreed with itself about which would put a
    // game's contact bits in the video chip's register page.
    const machine = run((ctx) => {
      set32(ctx, FAST, 0x0badf00d | 0);
      copy32(ctx, A, FAST);
    });
    expect(read32(machine, A)).toBe(0x0badf00d);
    expect(machine.ram[0x80]).toBe(0x0d);
  });
});
