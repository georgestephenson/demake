/**
 * The Sega value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The counterpart of `nes-arith.test.ts`, and it exists for the reason that one
 * does: the 16.16 arithmetic is where a new backend goes wrong first, and it goes
 * wrong quietly. A multiply that floors the wrong way for negative operands
 * produces a game that plays *almost* right and diverges from the trace a
 * thousand ticks later, by which point the failure names a position rather than
 * an operation. So the emitters are exercised here directly — assemble one
 * operation into a cartridge, run it in `@demake/sms`, read the four bytes back,
 * and compare against the reference implementation the interpreter itself uses.
 *
 * It is also the first thing that runs Z80 code the code generator wrote, which
 * makes it the test that would catch an encoder and a decoder agreeing with each
 * other and not with the hardware — the assembler's own suite pins the bytes
 * against the published opcode table, and this pins the behaviour against
 * `fixed.ts`.
 *
 * The vectors are chosen for the cases that differ between implementations
 * rather than for coverage: both signs, the exact ±1.0 identity the multiply
 * short-circuits, a fractional operand whose product needs the floor, a division
 * by a whole number of cells (the fast path) and one that does not (the general
 * loop), the clamp's exact boundary, and zero.
 */

import { SMS_ROM_SIZE, packSegaRom } from "@demake/core";
import { Sms } from "@demake/sms";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { planLayout, SMS_MEMORY } from "../src/codegen/layout.js";
import { SmsCtx } from "../src/codegen/sms/ctx.js";
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
} from "../src/codegen/sms/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("sms") });

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/** Where a test's operands live — clear of everything the plan allocated. */
const A = 0xdc00;
const B = 0xdc04;
const OUT = 0xdc08;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Sms, address: number): number {
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
function run(body: (ctx: SmsCtx) => void): Sms {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, SMS_MEMORY);
  const ctx = new SmsCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
  const { asm } = ctx;

  // The Z80 resets to $0000, so the first instruction is the first byte of the
  // cartridge — there is no vector to fill in and no entry point to jump from.
  asm.di();
  asm.ld16("sp", 0xdff0);
  body(ctx);
  asm.label("Spin");
  asm.jp("Spin");
  ctx.finish();

  const image = new Uint8Array(SMS_ROM_SIZE);
  const code = asm.assemble();
  if (code.length > 0x7ff0) throw new Error("sms: the test program ran into the header");
  image.set(code, 0);

  const machine = new Sms(packSegaRom(image));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("sms: the program never reached its spin loop");
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: SmsCtx, dst: number, src: number) => void,
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

describe("the Sega value layer", () => {
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

  it("adds a literal, including one whose low half is zero", () => {
    for (const [start, delta] of [
      [0, ONE],
      [ONE, -ONE],
      [5 * ONE, 3 * ONE],
      [0x0000ffff, 1],
      [-ONE, -1],
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
    ]);
  });

  it("divides, by a whole number of cells and by anything else", () => {
    binary(div32, div, [
      // The fast path: a divisor with no fractional bits.
      [10 * ONE, 2 * ONE],
      [-10 * ONE, 2 * ONE],
      [10 * ONE, -2 * ONE],
      [-10 * ONE, -2 * ONE],
      [7 * ONE, 60 * ONE],
      [-7 * ONE, 60 * ONE],
      // The general loop: a fractional divisor.
      [ONE, ONE + ONE / 2],
      [-ONE, ONE + ONE / 2],
      [3 * ONE, THIRD],
      [-(3 * ONE), THIRD],
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
      expect(`clamp(${value})`).toBe(`clamp(${value})`);
      expect(read32(machine, OUT)).toBe(clampFixed(value));
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
    const layout = planLayout(PROGRAM, analysis, SMS_MEMORY);
    const plain = new SmsCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
    add32(plain, A, B);
    expect(plain.helperNames()).toEqual([]);

    const dividing = new SmsCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
    div32(dividing, A, B);
    expect(dividing.helperNames()).toContain("Div32");
  });

  it("assembles the same bytes every time", () => {
    // The determinism the browser-versus-CLI parity contract rests on, at the
    // layer it is cheapest to check.
    const build = (): Uint8Array => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, SMS_MEMORY);
      const ctx = new SmsCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
      mul32(ctx, A, B);
      div32(ctx, A, B);
      ctx.finish();
      return ctx.asm.assemble();
    };
    expect([...build()]).toEqual([...build()]);
  });
});
