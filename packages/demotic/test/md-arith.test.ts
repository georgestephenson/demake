/**
 * The Mega Drive value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The counterpart of `nes-arith.test.ts` and `sms-arith.test.ts`, and it exists
 * for the reason those do: the 16.16 arithmetic is where a new backend goes
 * wrong first, and it goes wrong quietly. A multiply that floors the wrong way
 * for negative operands produces a game that plays *almost* right and diverges
 * from the trace a thousand ticks later, by which point the failure names a
 * position rather than an operation.
 *
 * It is also the first thing that runs 68000 code the code generator wrote, so
 * it is what would catch an encoder and a decoder agreeing with each other and
 * not with Motorola — `packages/core/test/m68k.test.ts` pins the bytes against
 * the published tables, and this pins the behaviour against `fixed.ts`.
 *
 * The vectors are the other two files' plus the ones this machine's arithmetic
 * makes interesting: the divide has a fast path for a whole-cell divisor built
 * out of two `divu.w` instructions and a general path that is a restoring loop,
 * and the multiply assembles four 16×16 products into a 64-bit one — so both
 * ends of the sign, a carry out of the middle product, and the clamp's exact
 * boundary all have to be here.
 */

import { Asm68k, MD_ROM_SIZE, packMdRom } from "@demake/core";
import { Md } from "@demake/md";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { MD_MEMORY, planLayout } from "../src/codegen/layout.js";
import { M68kCtx } from "../src/codegen/m68k/ctx.js";
import { CODE_ORIGIN, STACK_TOP } from "../src/codegen/md/emit.js";
import {
  abs32,
  add32,
  addConst32,
  asr32,
  branchEqual32,
  branchLess32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  FIXED_MAX,
  mul32,
  neg32,
  set32,
  sub32,
} from "../src/codegen/m68k/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("md") });

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/**
 * Where a test's operands live — clear of everything the plan allocated, and
 * even, because a long access to an odd address is an address error here.
 */
const A = 0xfffe00;
const B = 0xfffe04;
const OUT = 0xfffe08;

/** The four bytes at `address`, big-endian, as a signed 32-bit integer. */
function read32(machine: Md, address: number): number {
  const bytes = machine.readMemory(address, 4);
  return (
    ((bytes[0] as number) << 24) |
    ((bytes[1] as number) << 16) |
    ((bytes[2] as number) << 8) |
    (bytes[3] as number) |
    0
  );
}

/** Assemble `body` into a cartridge, run it to its spin loop, hand it back. */
function run(body: (ctx: M68kCtx) => void): Md {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, MD_MEMORY);
  const ctx = new M68kCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
  const { asm } = ctx;

  asm.label("Start");
  body(ctx);
  asm.label("Spin");
  asm.bra("Spin");
  ctx.finish();

  const code = asm.assemble();
  const machine = new Md(packMdRom(code, asm.addressOf("Start"), STACK_TOP));
  expect(machine.rom.length).toBe(MD_ROM_SIZE);
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("md: the program never reached its spin loop");
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: M68kCtx, dst: number, src: number) => void,
  reference: (a: number, b: number) => number,
  vectors: readonly [number, number][],
): void {
  for (const [left, right] of vectors) {
    const machine = run((ctx) => {
      set32(ctx, A, left);
      set32(ctx, B, right);
      emit(ctx, A, B);
      copy32(ctx, OUT, A);
    });
    expect(`${left} op ${right} = ${read32(machine, OUT)}`).toBe(
      `${left} op ${right} = ${reference(left, right)}`,
    );
  }
}

describe("the Mega Drive value layer", () => {
  it("adds and subtracts, across the sign", () => {
    const vectors: [number, number][] = [
      [ONE, ONE],
      [-ONE, ONE],
      [3 * ONE + 12345, -(2 * ONE) - 999],
      [0, 0],
      [-1, 1],
      [0x0000ffff, 1],
    ];
    binary(add32, (a, b) => clampFixed(a + b), vectors);
    binary(sub32, (a, b) => clampFixed(a - b), vectors);
  });

  it("adds a literal in whichever of the three forms it fits", () => {
    // One to eight is `addq`, minus one to minus eight is `subq`, and anything
    // else is `addi`; all three have to mean the same thing.
    for (const [start, delta] of [
      [0, ONE],
      [ONE, -ONE],
      [5 * ONE, 3 * ONE],
      [0x0000ffff, 1],
      [-ONE, -1],
      [ONE, 8],
      [ONE, -8],
      [ONE, 9],
    ] as const) {
      const machine = run((ctx) => {
        set32(ctx, A, start);
        addConst32(ctx, A, delta);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe((start + delta) | 0);
    }
  });

  it("negates and takes an absolute value", () => {
    for (const value of [ONE, -ONE, 0, 12345, -12345]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        neg32(ctx, A);
        copy32(ctx, OUT, A);
        set32(ctx, B, value);
        abs32(ctx, B);
        copy32(ctx, OUT + 4, B);
      });
      expect(read32(machine, OUT)).toBe(-value | 0);
      expect(read32(machine, OUT + 4)).toBe(Math.abs(value) | 0);
    }
  });

  it("shifts right arithmetically, which is floor division by two", () => {
    for (const value of [ONE, -ONE, 3, -3, 0, -1, 7 * ONE + 5]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        asr32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe(Math.floor(value / 2));
    }
  });

  it("multiplies, and floors toward negative infinity on both signs", () => {
    binary(mul32, mul, [
      [ONE, ONE],
      [-ONE, ONE],
      [ONE, -ONE],
      [-ONE, -ONE],
      [2 * ONE, 3 * ONE],
      [-2 * ONE, 3 * ONE],
      // A fractional operand whose product needs the floor rather than a
      // truncation: 1.5 × -1.5 is -2.25, which floors to -3 quarters, not -2.
      [ONE + ONE / 2, -(ONE + ONE / 2)],
      [THIRD, THIRD],
      [-THIRD, THIRD],
      [0, 5 * ONE],
      [5 * ONE, 0],
      [100 * ONE, 10 * ONE],
      // A carry out of the low half of the 64-bit product, which is the one
      // place this multiply's four partial products have to talk to each other:
      // both fractions near one, so `al × bl` is nearly 2^32 before the middle
      // product is shifted into it.
      [5 * ONE + 65535, 5 * ONE + 65535],
      [-(5 * ONE + 65535), 5 * ONE + 65535],
      // A large operand against a small one, at the far end of the clamp.
      [1023 * ONE, THIRD],
      [-(1023 * ONE), THIRD],
      // Not here, deliberately: both operands at the clamp. `a × b / 65536` is
      // then 2^36, and every backend in the project takes the product's middle
      // thirty-two bits — so all four agree on zero where `fixed.ts` clamps.
      // Asserting one of them alone would read as a Mega Drive bug.
    ]);
  });

  it("divides, by a whole number of cells and by anything else", () => {
    binary(div32, div, [
      // The fast path: a divisor with no fractional bits, which is two `divu.w`
      // instructions rather than a loop, and is what every `speed / fps` takes.
      [10 * ONE, 2 * ONE],
      [-10 * ONE, 2 * ONE],
      [10 * ONE, -2 * ONE],
      [-10 * ONE, -2 * ONE],
      [7 * ONE, 60 * ONE],
      [-7 * ONE, 60 * ONE],
      [FIXED_MAX, 60 * ONE],
      // The general loop: a fractional divisor.
      [ONE, ONE + ONE / 2],
      [-ONE, ONE + ONE / 2],
      [3 * ONE, THIRD],
      [-(3 * ONE), THIRD],
      [FIXED_MAX, THIRD],
      [1, THIRD],
      // Division by zero is zero, in the reference and therefore here.
      [5 * ONE, 0],
      [0, 5 * ONE],
    ]);
  });

  it("clamps to the range the interpreter clamps to, boundary included", () => {
    for (const value of [
      FIXED_MAX,
      FIXED_MAX + 1,
      -FIXED_MAX,
      -FIXED_MAX - 1,
      0,
      ONE,
      -ONE,
      0x7fffffff | 0,
      -0x7fffffff | 0,
    ]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(`clamp(${value}) = ${read32(machine, OUT)}`).toBe(
        `clamp(${value}) = ${clampFixed(value)}`,
      );
    }
  });

  it("branches on order, equality and zero", () => {
    const cases: [number, number][] = [
      [ONE, 2 * ONE],
      [2 * ONE, ONE],
      [ONE, ONE],
      [-ONE, ONE],
      [ONE, -ONE],
      [-2 * ONE, -ONE],
      [0, 0],
      [0, -1],
      // The ends of the range, where a comparison built on the sign of a
      // difference rather than on the overflow flag would answer backwards.
      [0x7fffffff | 0, -1],
      [-0x80000000, 0x7fffffff | 0],
    ];
    for (const [left, right] of cases) {
      const machine = run((ctx) => {
        const { asm } = ctx;
        set32(ctx, A, left);
        set32(ctx, B, right);
        // Three independent answers, one bit each, so a single run covers them.
        set32(ctx, OUT, 0);
        const notLess = ctx.unique("notLess");
        branchLess32(ctx, A, B, notLess, false);
        set32(ctx, OUT, 1);
        asm.label(notLess);
        set32(ctx, OUT + 4, 0);
        const notEqual = ctx.unique("notEq");
        branchEqual32(ctx, A, B, notEqual, false);
        set32(ctx, OUT + 4, 1);
        asm.label(notEqual);
        set32(ctx, OUT + 8, 0);
        const notZero = ctx.unique("notZero");
        branchZero32(ctx, A, notZero, false);
        set32(ctx, OUT + 8, 1);
        asm.label(notZero);
      });
      expect(`${left} < ${right} → ${read32(machine, OUT)}`).toBe(
        `${left} < ${right} → ${left < right ? 1 : 0}`,
      );
      expect(read32(machine, OUT + 4)).toBe(left === right ? 1 : 0);
      expect(read32(machine, OUT + 8)).toBe(left === 0 ? 1 : 0);
    }
  });

  it("pulls in the divider only when something divides", () => {
    // The reachability rule, checked on the console where it is newest: a game
    // that never divides ships no divider, because nothing ever asked for one.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, MD_MEMORY);
    const plain = new M68kCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
    add32(plain, A, B);
    expect(plain.helperNames()).toEqual([]);

    const dividing = new M68kCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
    div32(dividing, A, B);
    expect(dividing.helperNames()).toContain("Div32");
  });

  it("assembles the same bytes every time", () => {
    // The determinism the browser-versus-CLI parity contract rests on, at the
    // layer it is cheapest to check.
    const build = (): Uint8Array => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, MD_MEMORY);
      const ctx = new M68kCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
      mul32(ctx, A, B);
      div32(ctx, A, B);
      ctx.finish();
      return ctx.asm.assemble();
    };
    expect([...build()]).toEqual([...build()]);
  });

  it("keeps every allocation the emitters read as a word on an even address", () => {
    // The one thing about this machine that no other backend has to think about:
    // a word or long access to an odd address is an address error, so the shared
    // allocator pads before anything wider than a byte.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, MD_MEMORY);
    for (const address of [
      layout.tick,
      layout.scratch,
      layout.mathA,
      layout.mathB,
      layout.mathWork,
      layout.words,
      layout.queue,
      layout.plot,
      layout.plotPrev,
      ...layout.temps,
      ...layout.staging,
      ...layout.entities,
    ]) {
      expect(address % 2).toBe(0);
    }
  });

  it("is a cartridge the hardware can boot", () => {
    const asm = new Asm68k(CODE_ORIGIN);
    asm.label("Start");
    asm.bra("Start");
    const rom = packMdRom(asm.assemble(), CODE_ORIGIN, STACK_TOP, { title: "PONG" });
    // The 68000 reads its stack pointer and its entry point out of the first
    // eight bytes, before anything on the cartridge has run.
    expect(read32Bytes(rom, 0)).toBe(STACK_TOP);
    expect(read32Bytes(rom, 4)).toBe(CODE_ORIGIN);
    expect(String.fromCharCode(...rom.subarray(0x100, 0x110))).toBe("SEGA MEGA DRIVE ");
    expect(String.fromCharCode(...rom.subarray(0x120, 0x124))).toBe("PONG");
    // The checksum covers everything from `$0200` on, and is written into the
    // header it does not cover.
    let sum = 0;
    for (let at = 0x200; at + 1 < rom.length; at += 2) {
      sum = (sum + ((rom[at] as number) << 8) + (rom[at + 1] as number)) & 0xffff;
    }
    expect(((rom[0x18e] as number) << 8) | (rom[0x18f] as number)).toBe(sum);
  });
});

/** A big-endian long out of a raw image. */
function read32Bytes(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] as number) << 24) |
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number)) >>>
    0
  );
}
