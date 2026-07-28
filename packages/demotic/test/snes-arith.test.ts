/**
 * The Super Nintendo value layer, proven against `fixed.ts` on the hardware
 * itself.
 *
 * The counterpart of `nes-arith.test.ts` and `sms-arith.test.ts`, and it is here
 * for the reason those are: the 16.16 arithmetic is where a new backend goes
 * wrong first, and it goes wrong quietly. A multiply that floors the wrong way
 * for negative operands produces a game that plays *almost* right and diverges
 * from the trace a thousand ticks later, by which point the failure names a
 * position rather than an operation. So the emitters are exercised here directly
 * — assemble one operation into a cartridge, run it in `@demake/snes`, read the
 * four bytes back, and compare against the reference implementation the
 * interpreter itself uses.
 *
 * The vectors are chosen for the cases that differ between implementations rather
 * than for coverage: both signs, the exact ±1.0 identity the multiply
 * short-circuits, a fractional operand whose product needs the floor, a division
 * by a whole number of cells (the fast path) and one that does not (the general
 * loop), the clamp's exact boundary, and zero.
 *
 * There is one thing here the other two do not have, and it is the reason this
 * file matters even after their vectors pass: this CPU's accumulator is sixteen
 * bits, so every routine below is a *different program* from the eight-bit one
 * that was proved correct on the other consoles. The answers have to agree; the
 * instructions do not.
 */

import { describe, expect, it } from "vitest";

import { packSnesRom, SNES_ORIGIN, SNES_ROM_SIZE, type Ref } from "@demake/core";
import { Snes } from "@demake/snes";

import { analyze } from "../src/codegen/analyze.js";
import { planLayout, SNES_MEMORY } from "../src/codegen/layout.js";
import { SnesCtx } from "../src/codegen/snes/ctx.js";
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
} from "../src/codegen/snes/val.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("snes") });

/** Where a test's operands live — clear of everything the plan allocated. */
const A = 0x1200;
const B = 0x1204;
const OUT = 0x1208;

/** The four bytes at `address`, as a signed 32-bit integer. */
function read32(machine: Snes, address: number): number {
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
function run(body: (ctx: SnesCtx) => void): Snes {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, SNES_MEMORY);
  const ctx = new SnesCtx(PROGRAM, analysis, layout, getProfile("snes"), SNES_ORIGIN);
  const { asm } = ctx;

  asm.label("Reset");
  // The state every emitter assumes: native mode, sixteen-bit accumulator and
  // index registers, the direct page at zero (`codegen/snes/ctx.ts`).
  asm.sei();
  asm.clc();
  asm.xce();
  asm.rep(0x38);
  asm.ldx({ mode: "imm16", value: 0x03ff });
  asm.txs();
  asm.lda({ mode: "imm16", value: 0 });
  asm.tcd();
  body(ctx);
  asm.label("Spin");
  asm.jmp("Spin");
  asm.label("Nmi");
  asm.rti();
  ctx.finish();

  const image = new Uint8Array(SNES_ROM_SIZE);
  image.set(asm.assemble(), 0);
  const machine = new Snes(
    packSnesRom(image, { reset: asm.addressOf("Reset"), nmi: asm.addressOf("Nmi") }),
  );
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin && machine.cpu.pb === 0) return machine;
    machine.stepInstruction();
  }
  throw new Error("snes: the program never reached its spin loop");
}

/** Run one binary operation over two operands and read the result. */
function binary(op: (ctx: SnesCtx, dst: Ref, src: Ref) => void, a: number, b: number): number {
  const machine = run((ctx) => {
    set32(ctx, A, a);
    set32(ctx, B, b);
    op(ctx, A, B);
  });
  return read32(machine, A);
}

describe("the Super Nintendo 32-bit arithmetic", () => {
  it("adds and subtracts across the sign", () => {
    expect(binary(add32, 3 * ONE, -5 * ONE)).toBe(-2 * ONE);
    expect(binary(sub32, 3 * ONE, 5 * ONE)).toBe(-2 * ONE);
    expect(binary(add32, -1, 1)).toBe(0);
    expect(binary(sub32, 0, 1)).toBe(-1);
    // The carry has to chain between the two halves, which is the one thing a
    // sixteen-bit add can get wrong that an eight-bit one cannot hide.
    expect(binary(add32, 0x0000ffff, 1)).toBe(0x00010000);
    expect(binary(sub32, 0x00010000, 1)).toBe(0x0000ffff);
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
      // A whole-cell divisor takes the word-division path.
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

  it("clamps to the range the interpreter clamps to", () => {
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
      // Once at a work-RAM address, and once in the direct page — which on this
      // CPU is the same routine, because a helper is handed an address in `X`
      // rather than needing a pointer written for it.
      const heap = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
      });
      expect(read32(heap, A), `clamp ${value} in work RAM`).toBe(clampFixed(value));
      const page = run((ctx) => {
        set32(ctx, 0x80, value);
        clamp32(ctx, 0x80);
      });
      expect(read32(page, 0x80), `clamp ${value} in the direct page`).toBe(clampFixed(value));
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
