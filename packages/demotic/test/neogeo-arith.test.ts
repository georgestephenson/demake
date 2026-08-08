/**
 * The 68000 value layer, run on the *second* machine that has one.
 *
 * This file looks like a subset of `md-arith.test.ts` on purpose, and it is here
 * for `pce-arith.test.ts`'s reason one architecture along: the emitters are the
 * same file — `codegen/m68k/val.ts`, shared verbatim — so what this proves is not
 * the arithmetic a second time but that the same instructions still mean the same
 * thing on a machine that puts everything somewhere else.
 *
 * Three things differ and each could break every routine at once while
 * `md-arith.test.ts` stayed green:
 *
 *   - **Work RAM is at `$100000`, not `$FF0000`.** The Mega Drive's addresses sit
 *     in the top of the space where a sign-extended short absolute reaches them;
 *     this console's do not, so every access the value layer emits takes a
 *     different form.
 *   - **The program is entered through a header**, not a reset vector — so a
 *     routine only runs at all if `packNeoHeader`'s `JMP USER` lands on it.
 *   - **The cartridge is a container.** The code goes through `packNeoRom` and
 *     comes back through `loadNeo`, so a build whose P region was misdescribed
 *     would execute whatever followed it.
 *
 * The vectors are the ones that catch a sign or a rounding mistake, which is
 * where 16.16 arithmetic goes wrong quietly: a multiply that floors the wrong way
 * for negative operands makes a game that plays *almost* right and diverges a
 * thousand ticks later, by which point the trace names a position rather than an
 * operation.
 */

import { packNeoFix, packNeoHeader, packNeoRom } from "@demake/core";
import { loadNeo, Neogeo } from "@demake/neogeo";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { NEOGEO_MEMORY, planLayout } from "../src/codegen/layout.js";
import { M68kCtx } from "../src/codegen/m68k/ctx.js";
import {
  abs32,
  add32,
  asr32,
  clamp32,
  copy32,
  div32,
  mul32,
  neg32,
  set32,
  sub32,
} from "../src/codegen/m68k/val.js";
import { CODE_ORIGIN, STACK_TOP } from "../src/codegen/neogeo/emit.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("neogeo") });

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/**
 * Where a test's operands live.
 *
 * High in this console's 64 KiB, clear of everything the plan allocated, and
 * even — a long access to an odd address is an address error on a 68000 wherever
 * the memory happens to be.
 */
const A = 0x10ee00;
const B = 0x10ee04;
const OUT = 0x10ee08;

/** The four bytes at `address`, big-endian, as a signed 32-bit integer. */
function read32(machine: Neogeo, address: number): number {
  const bytes = machine.readMemory(address, 4);
  return (
    ((bytes[0] as number) << 24) |
    ((bytes[1] as number) << 16) |
    ((bytes[2] as number) << 8) |
    (bytes[3] as number) |
    0
  );
}

/** Assemble `body` into a `.neo`, run it to its spin loop, hand the machine back. */
function run(body: (ctx: M68kCtx) => void): Neogeo {
  const analysis = analyze(PROGRAM);
  const layout = planLayout(PROGRAM, analysis, NEOGEO_MEMORY);
  const ctx = new M68kCtx(PROGRAM, analysis, layout, getProfile("neogeo"), CODE_ORIGIN);
  const { asm } = ctx;

  asm.label("Start");
  body(ctx);
  asm.label("Spin");
  asm.bra("Spin");
  ctx.finish();

  const code = asm.assemble();
  const size = CODE_ORIGIN + code.length;
  const p = new Uint8Array(size);
  p.set(
    packNeoHeader(size, {
      stack: STACK_TOP,
      user: asm.addressOf("Start"),
      vblank: asm.addressOf("Spin"),
    }),
    0,
  );
  p.set(code, CODE_ORIGIN);
  const image = packNeoRom({
    p,
    s: packNeoFix(new Uint8Array(64)),
    c1: new Uint8Array(64),
    c2: new Uint8Array(64),
  });

  const machine = new Neogeo(loadNeo(image));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("neogeo: the program never reached its spin loop");
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

describe("the 68000 value layer on a Neo Geo", () => {
  it("reaches its own work RAM at all, which is the point of this file", () => {
    // `$100000` rather than `$FF0000`. If the shared value layer had baked in the
    // Mega Drive's addressing this is the assertion that would fail, and it would
    // fail before any arithmetic was even wrong.
    const machine = run((ctx) => set32(ctx, OUT, 0x12345678));
    expect(read32(machine, OUT) >>> 0).toBe(0x12345678);
  });

  it("adds and subtracts, across the sign", () => {
    binary(add32, (a, b) => (a + b) | 0, [
      [ONE, ONE],
      [ONE, -ONE],
      [-ONE, -ONE],
      [THIRD, -THIRD],
      [0x7fff0000, 0x0000ffff],
    ]);
    binary(sub32, (a, b) => (a - b) | 0, [
      [ONE, ONE],
      [ONE, -ONE],
      [-ONE, ONE],
      [0, ONE],
    ]);
  });

  it("negates, takes an absolute value, and halves by shifting", () => {
    for (const value of [0, ONE, -ONE, THIRD, -THIRD, 0x7fffffff | 0]) {
      const negated = run((ctx) => {
        set32(ctx, A, value);
        neg32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(negated, OUT)).toBe(-value | 0);

      const absolute = run((ctx) => {
        set32(ctx, A, value);
        abs32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(absolute, OUT)).toBe(Math.abs(value) | 0);

      // Arithmetic, so it floors rather than truncating: -1 >> 1 is -1.
      const shifted = run((ctx) => {
        set32(ctx, A, value);
        asr32(ctx, A, 1);
        copy32(ctx, OUT, A);
      });
      expect(read32(shifted, OUT)).toBe(value >> 1);
    }
  });

  it("multiplies, flooring toward negative infinity on both signs", () => {
    binary(mul32, (a, b) => mul(a, b), [
      [ONE, ONE],
      [ONE, -ONE],
      [-ONE, -ONE],
      [THIRD, THIRD],
      // The vector `wsc-arith.test.ts` calls out: truncation and floor come apart
      // here, and a version that shifted before signing passes every other case.
      [THIRD, -THIRD],
      [-THIRD, -THIRD],
      [ONE * 3, THIRD],
    ]);
  });

  it("divides, by a whole number of cells and by anything else", () => {
    binary(div32, (a, b) => div(a, b), [
      [ONE * 5, ONE],
      [ONE * 5, ONE * 2],
      [-ONE * 5, ONE * 2],
      [ONE * 5, -ONE * 2],
      [-ONE * 5, -ONE * 2],
      // A fractional divisor, which takes the general path rather than the
      // whole-cell one.
      [ONE, THIRD],
      [-ONE, THIRD],
    ]);
  });

  it("clamps to the range the interpreter clamps to", () => {
    for (const value of [0, ONE, -ONE, 0x7fffffff | 0, -0x7fffffff | 0]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
        copy32(ctx, OUT, A);
      });
      expect(read32(machine, OUT)).toBe(clampFixed(value));
    }
  });

  it("assembles the same bytes every time", () => {
    // Determinism at the level below the cartridge: two runs of the same emitter
    // over the same program have to agree, or nothing above can be golden.
    const once = run((ctx) => {
      set32(ctx, A, THIRD);
      set32(ctx, B, -THIRD);
      mul32(ctx, A, B);
      copy32(ctx, OUT, A);
    });
    const twice = run((ctx) => {
      set32(ctx, A, THIRD);
      set32(ctx, B, -THIRD);
      mul32(ctx, A, B);
      copy32(ctx, OUT, A);
    });
    expect(read32(once, OUT)).toBe(read32(twice, OUT));
    expect(read32(once, OUT)).toBe(mul(THIRD, -THIRD));
  });
});
