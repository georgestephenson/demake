/**
 * The Virtual Boy value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The counterpart of `nes-arith.test.ts` and `sms-arith.test.ts`, and it exists
 * for the reason those do: the 16.16 arithmetic is where a new backend goes
 * wrong first, and it goes wrong quietly. A multiply that floors the wrong way
 * for negative operands produces a game that plays *almost* right and diverges
 * from the trace a thousand ticks later, by which point the failure names a
 * position rather than an operation.
 *
 * Until the rest of this backend exists it is also the only thing that runs
 * V810 code the code generator wrote — so it is where a new value-layer emitter
 * is proven, and the file to run when touching `codegen/vb/val.ts`. That is the
 * position `sms-arith.test.ts` held while the Sega backend was half-built.
 *
 * Three of the vectors below are aimed at answers this machine gives that no
 * predecessor does.
 *
 *   - **The multiply has no floor correction**, because an arithmetic shift of
 *     the hardware's own 64-bit product already is one. `THIRD × -THIRD` is
 *     where truncation and floor come apart, and a version that assembled the
 *     product from unsigned halves and forgot to step down would pass everything
 *     else in the file.
 *   - **The divide has two paths**, and which one a program takes depends on
 *     what it divides by: a whole number of cells is a single `divu` and
 *     anything else is a forty-eight-iteration loop. Both are exercised, because
 *     the example library only ever reaches the first.
 *   - **A pooled constant is in the cartridge and a variable is not**, so
 *     `load32` decides an addressing mode from the reference's own type. The
 *     constant vectors are what catch an emitter that treated the two alike.
 */

import { packVbRom, SR_PSW, V810_R0, VB_ROM, VB_WRAM } from "@demake/core";
import { Vb } from "@demake/vb";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { planLayout, VB_MEMORY, VB_RAM_BASE } from "../src/codegen/layout.js";
import { VbCtx } from "../src/codegen/vb/ctx.js";
import { RAM } from "../src/codegen/vb/regs.js";
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
} from "../src/codegen/vb/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("vb") });

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/** Where a test's operands live — clear of everything the plan allocated. */
const A = 0x0500f100;
const B = 0x0500f104;
const OUT = 0x0500f108;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Vb, address: number): number {
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
function run(body: (ctx: VbCtx) => void): Vb {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, VB_MEMORY);
  const ctx = new VbCtx(PROGRAM, analysis, layout, getProfile("vb"), VB_ROM);
  const { asm } = ctx;

  // The whole of this console's boot: clear the reset PSW's `NP` bit, point the
  // stack, and park the work-RAM base every value access is measured from.
  asm.ldsr(V810_R0, SR_PSW);
  asm.movImm32(VB_WRAM + 0xff00, 3);
  asm.movImm32(VB_RAM_BASE, RAM);
  body(ctx);
  asm.label("Spin");
  asm.br("Spin");
  ctx.finish();

  const machine = new Vb(packVbRom(asm.assemble()));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 4_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.step();
  }
  throw new Error("vb: the program never reached its spin loop");
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: VbCtx, dst: number, src: number) => void,
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

describe("the Virtual Boy value layer", () => {
  it("adds and subtracts, across the sign", () => {
    const vectors: [number, number][] = [
      [ONE, ONE],
      [-ONE, ONE],
      [3 * ONE + 12345, -(2 * ONE) - 999],
      [0, 0],
      [-1, 1],
      [0x0000ffff, 1],
    ];
    binary(add32, (a, b) => a + b, vectors);
    binary(sub32, (a, b) => a - b, vectors);
  });

  it("adds a literal, including one whose low half is zero", () => {
    for (const [start, delta] of [
      [0, ONE],
      [ONE, -ONE],
      [5 * ONE, 3 * ONE],
      [0x0000ffff, 1],
      [-ONE, -1],
      // A constant whose low half has bit 15 set: the correction `movea`'s sign
      // extension needs, executed rather than asserted about.
      [0, 0x0005f800],
    ] as const) {
      const machine = run((ctx) => {
        set32(ctx, A, start);
        addConst32(ctx, A, delta);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe((start + delta) | 0);
    }
  });

  it("multiplies with a floor the hardware gives for nothing", () => {
    // No sign handling and no correction anywhere in the emitter: the product is
    // 64 bits and its middle thirty-two are the answer. `THIRD × -THIRD` is the
    // vector where truncation and floor differ.
    binary(mul32, mul, [
      [ONE, ONE],
      [ONE, -ONE],
      [-ONE, -ONE],
      [2 * ONE, 3 * ONE],
      [THIRD, THIRD],
      [THIRD, -THIRD],
      [-THIRD, -THIRD],
      [0, 5 * ONE],
      [7 * ONE + 1234, -(3 * ONE) - 4321],
    ]);
  });

  it("divides, on both of its two paths", () => {
    binary(div32, div, [
      // A whole number of cells: one `divu`, which is what pong's opponent and
      // every `n / fps` constant reach.
      [ONE, ONE],
      [5 * ONE, 2 * ONE],
      [-5 * ONE, 2 * ONE],
      [5 * ONE, -(2 * ONE)],
      [-5 * ONE, -(2 * ONE)],
      [7 * ONE + 999, 4 * ONE],
      // ...and a divisor that is not, which is the forty-eight-iteration loop.
      // Nothing in the example library reaches it, so this is the only place it
      // runs at all.
      [ONE, THIRD],
      [-ONE, THIRD],
      [3 * ONE, ONE + 1],
      [ONE, ONE >> 1],
      // Zero by zero is zero, which the language guarantees.
      [5 * ONE, 0],
      [0, 3 * ONE],
    ]);
  });

  it("negates, halves and takes an absolute value", () => {
    for (const value of [ONE, -ONE, 0, THIRD, -THIRD, 5 * ONE + 7]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        neg32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe(-value | 0);

      const halved = run((ctx) => {
        set32(ctx, A, value);
        asr32(ctx, A);
        copy32(ctx, OUT, A);
      });
      // An arithmetic shift is floor, which is what `centerx` is written against.
      expect(read32(halved, OUT)).toBe(value >> 1);

      const magnitude = run((ctx) => {
        set32(ctx, A, value);
        abs32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(magnitude, OUT)).toBe(Math.abs(value));
    }
  });

  it("clamps at the boundary the interpreter clamps at", () => {
    for (const value of [FIXED_MAX, FIXED_MAX + 1, -FIXED_MAX, -FIXED_MAX - 1, 0, ONE]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe(clampFixed(value));
    }
  });

  it("branches on zero, on order and on equality", () => {
    const probe = (
      emit: (ctx: VbCtx, target: string) => void,
      left: number,
      right: number,
    ): number => {
      const machine = run((ctx) => {
        set32(ctx, A, left);
        set32(ctx, B, right);
        set32(ctx, OUT, 0);
        const taken = ctx.unique("taken");
        emit(ctx, taken);
        set32(ctx, OUT, ONE);
        ctx.asm.label(taken);
      });
      // Zero means the branch was taken, so the store was skipped.
      return read32(machine, OUT);
    };

    expect(probe((ctx, t) => branchZero32(ctx, A, t), 0, 0)).toBe(0);
    expect(probe((ctx, t) => branchZero32(ctx, A, t), ONE, 0)).toBe(ONE);
    expect(probe((ctx, t) => branchLess32(ctx, A, B, t), -ONE, ONE)).toBe(0);
    expect(probe((ctx, t) => branchLess32(ctx, A, B, t), ONE, -ONE)).toBe(ONE);
    // Across the sign, which is what makes the signed condition worth having.
    expect(probe((ctx, t) => branchLess32(ctx, A, B, t), -FIXED_MAX, FIXED_MAX)).toBe(0);
    expect(probe((ctx, t) => branchEqual32(ctx, A, B, t), ONE, ONE)).toBe(0);
    expect(probe((ctx, t) => branchEqual32(ctx, A, B, t), ONE, -ONE)).toBe(ONE);
  });

  it("reads a pooled constant out of the cartridge, not out of RAM", () => {
    // The one addressing decision this backend makes, and the one that produces
    // a game which traces perfectly for exactly one tick when it is wrong: a
    // pooled 16.16 literal is in ROM and a variable is not, so `load32` picks
    // its instruction from the reference's own type.
    const machine = run((ctx) => {
      // Put something recognisable where a bad emitter would read instead.
      set32(ctx, A, 0x0badf00d);
      copy32(ctx, OUT, ctx.constant(3 * ONE));
    });
    expect(read32(machine, OUT)).toBe(3 * ONE);
  });

  it("pulls in a divider only when something divides", () => {
    const withoutDivide = (() => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, VB_MEMORY);
      const ctx = new VbCtx(PROGRAM, analysis, layout, getProfile("vb"), VB_ROM);
      mul32(ctx, A, B);
      return ctx.helperNames();
    })();
    // The multiply is six instructions and no routine at all, which is what this
    // console has that no other one in the set does.
    expect(withoutDivide).not.toContain("Div32");

    const withDivide = (() => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, VB_MEMORY);
      const ctx = new VbCtx(PROGRAM, analysis, layout, getProfile("vb"), VB_ROM);
      div32(ctx, A, B);
      return ctx.helperNames();
    })();
    expect(withDivide).toContain("Div32");
  });
});
