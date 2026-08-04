/**
 * The WonderSwan value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The counterpart of `nes-arith.test.ts`, `sms-arith.test.ts` and the rest, and
 * it exists for the reason those do: the 16.16 arithmetic is where a new backend
 * goes wrong first, and it goes wrong quietly. A multiply that floors the wrong
 * way for negative operands produces a game that plays *almost* right and
 * diverges from the trace a thousand ticks later, by which point the failure
 * names a position rather than an operation. So the emitters are exercised
 * directly — assemble one operation into a cartridge, run it in `@demake/wsc`,
 * read the four bytes back, and compare against the reference implementation the
 * interpreter itself uses.
 *
 * It is also the first thing that runs V30MZ code the code generator wrote,
 * which makes it the test that would catch an encoder and a decoder agreeing
 * with each other and not with the hardware: `packages/core/test/v30mz-nasm.test.ts`
 * pins the bytes against NASM, and this pins the behaviour against `fixed.ts`.
 *
 * Two of this machine's answers are what the vectors are aimed at, because both
 * are new. The **multiply is four multiplies and no loop**, which is only right
 * if the sign is applied to all forty-eight bits of the product before its
 * middle thirty-two are taken — a third of a cell squared is where truncation
 * and floor come apart. And the **divide has three paths** rather than two: a
 * whole number of cells, a divisor below one, and a bit loop for the fractional
 * divisor of a cell or more that nothing else reaches.
 */

import { packWsRom, WS_CODE_SEGMENT } from "@demake/core";
import { CS, Wsc } from "@demake/wsc";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { planLayout, WSC_MEMORY } from "../src/codegen/layout.js";
import { WscCtx } from "../src/codegen/wsc/ctx.js";
import {
  abs32,
  add32,
  addConst32,
  asr32,
  branchEqual32,
  branchLess32,
  branchUnlessConst32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  FIXED_MAX,
  mul32,
  neg32,
  set32,
  sub32,
} from "../src/codegen/wsc/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/**
 * A program with nothing in it: all these tests need from one is a layout.
 *
 * Compiled for a console that is not this one, because this one has no profile
 * yet and the reason is written down in `profiles.ts` — its 75 Hz tick rate is
 * what the example library's `.test.dmt` scripts turn out not to survive. None
 * of it reaches here: a layout is decided by {@link WSC_MEMORY} and the program's
 * own shape, and the WonderSwan context reads nothing off a profile at all.
 */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("sms") });

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/** Where a test's operands live: RAM above the tile bank, which nothing uses. */
const A = 0x8000;
const B = 0x8004;
const OUT = 0x8008;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Wsc, address: number): number {
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
function run(body: (ctx: WscCtx) => void): Wsc {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, WSC_MEMORY);
  const ctx = new WscCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
  const { asm } = ctx;

  // The processor resets into the far jump at the top of the bank and arrives
  // here, at the bank's first byte, with nothing set up: the segment registers
  // and the stack are the program's own first job.
  asm.cli();
  asm.cld();
  asm.movi("ax", 0);
  asm.movsr("ds", "ax");
  asm.movsr("es", "ax");
  asm.movsr("ss", "ax");
  asm.movi("sp", 0x4000);
  body(ctx);
  asm.label("Spin");
  asm.jmp("Spin");
  ctx.finish();

  const machine = new Wsc(packWsRom(asm.assemble()));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.ip === spin && machine.cpu.segs[CS] === WS_CODE_SEGMENT) return machine;
    machine.stepInstruction();
  }
  throw new Error("wsc: the program never reached its spin loop");
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: WscCtx, dst: number, src: number) => void,
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

describe("the WonderSwan value layer", () => {
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
      // truncation: this is the case that fails if the sign is applied to the
      // *shifted* product instead of to the whole of it.
      [ONE + ONE / 2, -(ONE + ONE / 2)],
      [THIRD, THIRD],
      [-THIRD, THIRD],
      [THIRD, -THIRD],
      [0, 5 * ONE],
      [5 * ONE, 0],
      [100 * ONE, 10 * ONE],
      // Both operands at the clamp's edge, which is where the product's bits
      // past forty-eight would show up if any were kept.
      [1000 * ONE, 1000 * ONE],
    ]);
  });

  it("divides, by a whole number of cells, by less than one, and by neither", () => {
    binary(div32, div, [
      // A divisor with no fractional bits: two chained divides.
      [10 * ONE, 2 * ONE],
      [-10 * ONE, 2 * ONE],
      [10 * ONE, -2 * ONE],
      [-10 * ONE, -2 * ONE],
      [7 * ONE, 60 * ONE],
      [-7 * ONE, 60 * ONE],
      [ONE, 1024 * ONE],
      // A divisor below one: three chained divides over the 48-bit dividend.
      [ONE, THIRD],
      [-ONE, THIRD],
      [3 * ONE, THIRD],
      [-(3 * ONE), THIRD],
      [ONE, ONE / 2],
      [-ONE, -(ONE / 2)],
      // A fractional divisor of a cell or more: the bit loop, which nothing in
      // the example library reaches and which therefore only this test covers.
      [ONE, ONE + ONE / 2],
      [-ONE, ONE + ONE / 2],
      [100 * ONE, 3 * ONE + THIRD],
      [-(100 * ONE), 3 * ONE + THIRD],
      [7 * ONE + 12345, -(2 * ONE) - 6789],
      // Division by zero is zero, in the reference and therefore here.
      [5 * ONE, 0],
      [0, 5 * ONE],
    ]);
  });

  it("clamps to the range the interpreter clamps to, boundary included", () => {
    for (const value of [
      FIXED_MAX,
      FIXED_MAX + 1,
      FIXED_MAX - 1,
      -FIXED_MAX,
      -FIXED_MAX - 1,
      -FIXED_MAX + 1,
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
    ];
    for (const [left, right] of cases) {
      const machine = run((ctx) => {
        const { asm } = ctx;
        set32(ctx, A, left);
        set32(ctx, B, right);
        // Four independent answers, one word each, so a single run covers them.
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
        set32(ctx, OUT + 12, 1);
        const notOne = ctx.unique("notOne");
        branchUnlessConst32(ctx, A, ONE, notOne);
        set32(ctx, OUT + 12, 2);
        asm.label(notOne);
      });
      expect(`${left} < ${right} → ${read32(machine, OUT)}`).toBe(
        `${left} < ${right} → ${left < right ? 1 : 0}`,
      );
      expect(read32(machine, OUT + 4)).toBe(left === right ? 1 : 0);
      expect(read32(machine, OUT + 8)).toBe(left === 0 ? 1 : 0);
      expect(read32(machine, OUT + 12)).toBe(left === ONE ? 2 : 1);
    }
  });

  it("takes a long branch when the target is out of a jump's reach", () => {
    // The discipline the whole backend runs under: a conditional branch reaches
    // ±128 bytes here, so anything given a label by a caller inverts and jumps.
    // Nothing else in this file is far enough away to exercise it.
    const machine = run((ctx) => {
      const { asm } = ctx;
      set32(ctx, OUT, 0);
      const skip = ctx.unique("skip");
      branchZero32(ctx, OUT, skip, false); // not taken: OUT is zero
      for (let index = 0; index < 40; index += 1) asm.nop();
      set32(ctx, OUT, 7);
      for (let index = 0; index < 200; index += 1) asm.nop();
      asm.label(skip);
    });
    expect(read32(machine, OUT)).toBe(7);
  });

  it("pulls in the divider only when something divides", () => {
    // The reachability rule, checked on the console where it is newest: a game
    // that never divides ships no divider, because nothing ever asked for one.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, WSC_MEMORY);
    const plain = new WscCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
    add32(plain, A, B);
    expect(plain.helperNames()).toEqual([]);

    const dividing = new WscCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
    div32(dividing, A, B);
    expect(dividing.helperNames()).toContain("Div32");
  });

  it("assembles the same bytes every time", () => {
    // The determinism the browser-versus-CLI parity contract rests on, at the
    // layer it is cheapest to check.
    const build = (): Uint8Array => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, WSC_MEMORY);
      const ctx = new WscCtx(PROGRAM, analysis, layout, getProfile("sms"), 0);
      mul32(ctx, A, B);
      div32(ctx, A, B);
      ctx.finish();
      return ctx.asm.assemble();
    };
    expect([...build()]).toEqual([...build()]);
  });
});
