/**
 * The NES value layer, proven against `fixed.ts` on the hardware itself.
 *
 * The 16.16 arithmetic is where a second backend goes wrong first, and it goes
 * wrong quietly: a multiply that floors the wrong way for negative operands
 * produces a game that plays *almost* right and diverges from the trace a
 * thousand ticks later, by which point the failure names a position rather than
 * an operation. So the emitters are exercised here directly — assemble one
 * operation into a cartridge, run it in `@demake/nes`, read the four bytes back,
 * and compare against the reference implementation the interpreter itself uses.
 *
 * The vectors are chosen for the cases that differ between implementations rather
 * than for coverage: both signs, the exact ±1.0 identity the multiply
 * short-circuits, a fractional operand whose product needs the floor, a division
 * by a whole number of cells (the fast path) and one that does not (the general
 * loop), the clamp's exact boundary, and zero.
 */

import { describe, expect, it } from "vitest";

import { NES_CHR_SIZE, NES_PRG_ORIGIN, NES_PRG_SIZE, packInesRom, type Ref } from "@demake/core";
import { Nes } from "@demake/nes";

import { analyze } from "../src/codegen/analyze.js";
import { NES_MEMORY, planLayout } from "../src/codegen/layout.js";
import { NesCtx } from "../src/codegen/nes/ctx.js";
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
} from "../src/codegen/nes/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("nes") });

/** Where a test's operands live — clear of everything the plan allocated. */
const A = 0x0500;
const B = 0x0504;
const OUT = 0x0508;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Nes, address: number): number {
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
function run(body: (ctx: NesCtx) => void): Nes {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, NES_MEMORY);
  const ctx = new NesCtx(PROGRAM, analysis, layout, getProfile("nes"), NES_PRG_ORIGIN);
  const { asm } = ctx;

  asm.label("Reset");
  body(ctx);
  asm.label("Spin");
  asm.jmp("Spin");
  ctx.finish();

  const prg = new Uint8Array(NES_PRG_SIZE);
  prg.set(asm.assemble(), 0);
  const reset = asm.addressOf("Reset");
  prg[NES_PRG_SIZE - 4] = reset & 0xff;
  prg[NES_PRG_SIZE - 3] = (reset >> 8) & 0xff;

  const machine = new Nes(packInesRom(prg, new Uint8Array(NES_CHR_SIZE)));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 500_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("nes: the program never reached its spin loop");
}

/** Run one binary operation over two operands and read the result. */
function binary(op: (ctx: NesCtx, dst: Ref, src: Ref) => void, a: number, b: number): number {
  const machine = run((ctx) => {
    set32(ctx, A, a);
    set32(ctx, B, b);
    op(ctx, A, B);
  });
  return read32(machine, A);
}

describe("the NES 32-bit arithmetic", () => {
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
    // An arithmetic shift is floor, so an odd negative value rounds down.
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
      // A whole-cell divisor takes the byte-division path.
      [7 * ONE, 2 * ONE],
      [-7 * ONE, 2 * ONE],
      [7 * ONE, -2 * ONE],
      [-7 * ONE, -2 * ONE],
      [5 * ONE, 60 * ONE],
      // A fractional divisor takes the general loop.
      [7 * ONE, ONE + 32768],
      [-7 * ONE, ONE + 32768],
      [ONE, 3 * ONE + 1],
      [0, 3 * ONE],
      // And a zero divisor gives zero, not a crash.
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
      // Once at a work-RAM address, which goes through the pointer form...
      const heap = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
      });
      expect(read32(heap, A), `clamp ${value} in work RAM`).toBe(clampFixed(value));
      // ...and once in page zero, which goes through the indexed one.
      const zero = run((ctx) => {
        set32(ctx, 0x80, value);
        clamp32(ctx, 0x80);
      });
      expect(read32(zero, 0x80), `clamp ${value} in page zero`).toBe(clampFixed(value));
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
});
