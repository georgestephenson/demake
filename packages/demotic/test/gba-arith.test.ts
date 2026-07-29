/**
 * The Game Boy Advance value layer, proven against `fixed.ts` on the hardware.
 *
 * The counterpart of `nes-arith.test.ts`, `sms-arith.test.ts`,
 * `snes-arith.test.ts` and `md-arith.test.ts`, and it exists for the reason those
 * do: the 16.16 arithmetic is where a new backend goes wrong first, and it goes
 * wrong quietly. A multiply that floors the wrong way for negative operands
 * produces a game that plays *almost* right and diverges from the trace a
 * thousand ticks later, by which point the failure names a position rather than
 * an operation.
 *
 * It is also the first thing that runs ARM code the code generator wrote, so it
 * is what would catch an encoder and a decoder agreeing with each other and not
 * with the architecture — `core/test/arm.test.ts` pins the bytes against the
 * manual, `core/test/arm-gnu.test.ts` pins them against the reference assembler,
 * and this pins the behaviour against `fixed.ts`.
 *
 * Three things this machine makes worth testing that the others did not:
 *
 *   - **The multiply is inline and unsigned nowhere.** `smull` and an arithmetic
 *     shift are the whole of it, so the thing to check is that the shift really
 *     does floor — which only shows on a negative product with a fractional part.
 *   - **The clamp is predicated rather than branched**, and both of its bounds are
 *     rotated immediates. A wrong rotation would clamp to a plausible wrong number.
 *   - **An address is one instruction inside the base register's window and two
 *     outside it.** Both paths are exercised deliberately, because a fallback
 *     nothing reaches is a fallback that is wrong when something does.
 */

import { GBA_HEADER_SIZE, packGbaRom } from "@demake/core";
import { Gba, ROM_BASE } from "@demake/gba";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { GbaCtx } from "../src/codegen/gba/ctx.js";
import { emitRngPick } from "../src/codegen/gba/expr.js";
import {
  abs32,
  add32,
  addConst32,
  asr32,
  at,
  branchEqual32,
  branchLess32,
  branchZero32,
  clamp32,
  copy32,
  div32,
  FIXED_MAX,
  imm,
  mul32,
  neg32,
  set32,
  sub32,
  type Val,
} from "../src/codegen/gba/val.js";
import { GBA_MEMORY, planLayout } from "../src/codegen/layout.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { advance, pick } from "../src/rng.js";
import { getProfile } from "../src/profiles.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("gba") });

/** The seed the generator test starts from, and the one its program declares. */
const SEED = 20260726;

/**
 * A program that draws, so the layout allocates the generator's state.
 *
 * Which it does only when something asks — `analysis.usesRandom` — so a test of
 * the generator needs a program that names it, exactly as a game does.
 */
const RANDOM_PROGRAM = compile(
  [
    "start only",
    `seed ${SEED}`,
    "",
    "scene only",
    "",
    "create number counter in only (x 1, y 1, value 0, visible 0)",
    "",
    "when always in only then counter.value as random(0, 10)",
    "",
  ].join("\n"),
  { profile: getProfile("gba") },
);

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/**
 * Where a test's operands live: past the base register's ±4095 window, so every
 * vector goes through the two-instruction addressing path by default.
 */
const A = 0x03006000;
const B = 0x03006004;
const OUT = 0x03006008;

/** The same, inside the window, for the case that costs one instruction. */
const NEAR_A = 0x03000c00;
const NEAR_B = 0x03000c04;

/** Assemble `body` into a cartridge, run it to its spin loop, hand it back. */
function run(body: (ctx: GbaCtx) => void, program = PROGRAM): Gba {
  const analysis = analyze(program);
  const layout = planLayout(program, analysis, GBA_MEMORY);
  const origin = ROM_BASE + GBA_HEADER_SIZE;
  const ctx = new GbaCtx(program, analysis, layout, getProfile("gba"), ROM_BASE);
  const { asm } = ctx;

  asm.b("Start");
  asm.padTo(origin);
  asm.label("Start");
  ctx.loadRamBase();
  body(ctx);
  asm.label("Spin");
  asm.b("Spin");
  asm.ltorg();
  ctx.finish();

  const machine = new Gba(packGbaRom(asm.assemble()));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if ((machine.cpu.r[15] as number) === spin) return machine;
    machine.stepInstruction();
  }
  throw new Error("gba: the program never reached its spin loop");
}

/** The same, for the program that has a generator. */
function runRandom(body: (ctx: GbaCtx) => void): Gba {
  return run(body, RANDOM_PROGRAM);
}

/** The signed 32-bit value at `address`. */
function read32(machine: Gba, address: number): number {
  return machine.read32(address) | 0;
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: GbaCtx, dst: number, src: Val) => void,
  reference: (a: number, b: number) => number,
  vectors: readonly [number, number][],
): void {
  for (const [left, right] of vectors) {
    const machine = run((ctx) => {
      set32(ctx, A, left);
      set32(ctx, B, right);
      emit(ctx, A, at(B));
      copy32(ctx, OUT, at(A));
    });
    expect(`${left} op ${right} = ${read32(machine, OUT)}`).toBe(
      `${left} op ${right} = ${reference(left, right)}`,
    );
  }
}

/** Operand pairs that between them cover both signs and both boundaries. */
const PAIRS: readonly [number, number][] = [
  [0, 0],
  [ONE, ONE],
  [ONE, -ONE],
  [-ONE, ONE],
  [-ONE, -ONE],
  [3 * ONE, 2 * ONE],
  [-3 * ONE, 2 * ONE],
  [3 * ONE, -2 * ONE],
  [-3 * ONE, -2 * ONE],
  [THIRD, 2 * ONE],
  [-THIRD, 3 * ONE],
  [7 * ONE + THIRD, -5 * ONE],
  [FIXED_MAX, ONE],
  [-FIXED_MAX, ONE],
  [FIXED_MAX, 2 * ONE],
  [1, 1],
  [-1, ONE],
  [ONE - 1, ONE + 1],
];

describe("the value layer", () => {
  it("adds and subtracts, clamping nothing that stays in range", () => {
    binary(add32, (a, b) => (a + b) | 0, PAIRS);
    binary(sub32, (a, b) => (a - b) | 0, PAIRS);
  });

  it("adds a constant through the immediate field where the value fits it", () => {
    // A whole number of cells is `n << 16`, which the rotation expresses for
    // every n up to 255 — and 40 cells is what a screen is wide here.
    for (const amount of [0, 1, ONE, 40 * ONE, -ONE, -40 * ONE, THIRD, -THIRD, 0x123456]) {
      const machine = run((ctx) => {
        set32(ctx, A, 5 * ONE);
        addConst32(ctx, A, amount);
        copy32(ctx, OUT, at(A));
      });
      expect(read32(machine, OUT)).toBe((5 * ONE + amount) | 0);
    }
  });

  it("negates, halves and takes an absolute value", () => {
    for (const value of [0, ONE, -ONE, THIRD, -THIRD, 9, -9, FIXED_MAX, -FIXED_MAX]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        neg32(ctx, A);
        copy32(ctx, OUT, at(A));
        set32(ctx, B, value);
        asr32(ctx, B);
        copy32(ctx, OUT + 4, at(B));
        set32(ctx, A, value);
        abs32(ctx, A);
        copy32(ctx, OUT + 8, at(A));
      });
      expect(read32(machine, OUT)).toBe(-value | 0);
      // An arithmetic shift is floor, so −9 halves to −5 rather than to −4.
      expect(read32(machine, OUT + 4)).toBe(value >> 1);
      expect(read32(machine, OUT + 8)).toBe(Math.abs(value) | 0);
    }
  });

  it("clamps to ±1024 cells, at exactly the boundary", () => {
    for (const value of [
      0,
      FIXED_MAX,
      FIXED_MAX + 1,
      FIXED_MAX * 2,
      -FIXED_MAX,
      -FIXED_MAX - 1,
      -FIXED_MAX * 2,
      0x7fffffff,
      -0x80000000,
    ]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
        copy32(ctx, OUT, at(A));
      });
      expect(read32(machine, OUT)).toBe(clampFixed(value | 0));
    }
  });

  it("multiplies the way `fixed.ts` does, flooring toward negative infinity", () => {
    binary(mul32, (a, b) => mul(a, b), PAIRS);
  });

  it("divides the way `fixed.ts` does, and yields zero for a zero divisor", () => {
    binary(div32, (a, b) => div(a, b), PAIRS);
    // Both operands zero and a zero divisor with a non-zero dividend take
    // different paths out of the routine, so both are here.
    binary(div32, (a, b) => div(a, b), [
      [0, 0],
      [5 * ONE, 0],
      [-5 * ONE, 0],
    ]);
  });

  it("divides by a whole number of cells, which is what a speed does every tick", () => {
    // `speed / fps` is the division a moving object performs, so the vectors are
    // the ones a game actually asks for rather than only the awkward ones.
    const vectors: [number, number][] = [];
    for (const speed of [ONE, 2 * ONE, 5 * ONE, 10 * ONE, -7 * ONE, THIRD, 60 * ONE]) {
      for (const divisor of [ONE, 2 * ONE, 60 * ONE, 5 * ONE]) vectors.push([speed, divisor]);
    }
    binary(div32, (a, b) => div(a, b), vectors);
  });

  it("compares signed, both ways round and at the ends of the range", () => {
    for (const [left, right] of PAIRS) {
      const machine = run((ctx) => {
        set32(ctx, A, left);
        set32(ctx, B, right);
        set32(ctx, OUT, 0);
        // The branch is taken *when the condition holds*, so skipping the
        // "yes" store means asking for the negation — the same shape every
        // backend's emitters use.
        branchLess32(ctx, at(A), at(B), "notLess", false);
        set32(ctx, OUT, 1);
        ctx.asm.label("notLess");
        set32(ctx, OUT + 4, 0);
        branchEqual32(ctx, at(A), at(B), "notEqual", false);
        set32(ctx, OUT + 4, 1);
        ctx.asm.label("notEqual");
        set32(ctx, OUT + 8, 0);
        branchZero32(ctx, A, "notZero", false);
        set32(ctx, OUT + 8, 1);
        ctx.asm.label("notZero");
      });
      expect(read32(machine, OUT)).toBe(left < right ? 1 : 0);
      expect(read32(machine, OUT + 4)).toBe(left === right ? 1 : 0);
      expect(read32(machine, OUT + 8)).toBe(left === 0 ? 1 : 0);
    }
  });

  it("compares against an immediate without putting it in memory first", () => {
    // The operand form no other backend has: a constant the instruction carries.
    for (const value of [0, ONE, -ONE, 40 * ONE, THIRD]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        set32(ctx, OUT, 0);
        branchLess32(ctx, at(A), imm(ONE), "notLess", false);
        set32(ctx, OUT, 1);
        ctx.asm.label("notLess");
      });
      expect(read32(machine, OUT)).toBe(value < ONE ? 1 : 0);
    }
  });

  it("draws from the generator the way `rng.ts` defines it", () => {
    // Not a statistical test: the generator is part of the language, so this is
    // the same arithmetic run twice and compared exactly. The modulo is the
    // interesting half — this is the only console in the set with no divide
    // instruction, so the remainder comes from a restoring loop.
    //
    // The state is seeded here rather than left as the RAM found it, because the
    // boot code that would do it is the part of this backend not yet written.
    const seeded = advance(SEED);
    for (const [low, high] of [
      [0, 10],
      [13, 16],
      [-5, 5],
      [0, 1],
      [1, 1],
      [-20, -3],
      [0, 1023],
    ] as const) {
      const machine = runRandom((ctx) => {
        set32(ctx, ctx.layout.rng as number, SEED);
        set32(ctx, ctx.layout.mathA, low * ONE);
        set32(ctx, ctx.layout.mathB, high * ONE);
        ctx.asm.bl(ctx.need("RngPick", emitRngPick));
        copy32(ctx, OUT, at(ctx.layout.mathA));
        // The state the draw left behind, so a run that skipped the advance is
        // distinguishable from one that took it.
        copy32(ctx, OUT + 4, at(ctx.layout.rng as number));
      });
      // `sim.ts` advances unconditionally; every backend skips the advance when
      // the bounds cross, so the reference here is the backends' — see the note
      // on `emitRngPick`.
      const crossed = high <= low;
      const expected = crossed ? low * ONE : (low + pick(seeded, high - low + 1)) * ONE;
      expect(`random(${low}, ${high}) = ${read32(machine, OUT)}`).toBe(
        `random(${low}, ${high}) = ${expected}`,
      );
      expect(read32(machine, OUT + 4) >>> 0).toBe(crossed ? SEED : seeded);
    }
  });

  it("pulls in the divider only when something divides", () => {
    // The reachability rule, on the console where it is newest: a game that never
    // divides ships no divider, because nothing ever asked for one.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, GBA_MEMORY);
    const plain = new GbaCtx(PROGRAM, analysis, layout, getProfile("gba"), ROM_BASE);
    add32(plain, A, at(B));
    mul32(plain, A, at(B));
    // The multiply is inline on this machine, so even *that* pulls in nothing.
    expect(plain.helperNames()).toEqual([]);

    const dividing = new GbaCtx(PROGRAM, analysis, layout, getProfile("gba"), ROM_BASE);
    div32(dividing, A, at(B));
    expect(dividing.helperNames()).toContain("Div32");
  });

  it("assembles the same bytes every time", () => {
    // The determinism the browser-versus-CLI parity contract rests on, at the
    // layer it is cheapest to check.
    const build = (): Uint8Array => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, GBA_MEMORY);
      const ctx = new GbaCtx(PROGRAM, analysis, layout, getProfile("gba"), ROM_BASE);
      mul32(ctx, A, at(B));
      div32(ctx, A, at(B));
      ctx.finish();
      return ctx.asm.assemble();
    };
    expect([...build()]).toEqual([...build()]);
  });

  it("keeps every allocation the emitters read as a word on a word boundary", () => {
    // An unaligned `ldr` *rotates* on this core rather than faulting, so a
    // misaligned allocation is a wrong number rather than a crash — which is
    // worse, and is why the plan asks for four-byte alignment.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, GBA_MEMORY);
    for (const address of [
      layout.mathA,
      layout.mathB,
      layout.mathWork,
      layout.queue,
      layout.plot,
      layout.plotPrev,
      ...layout.temps,
      ...layout.staging,
      ...layout.entities,
    ]) {
      expect(address % 4).toBe(0);
    }
  });

  it("reaches an address inside the base register's window and one outside it", () => {
    // The two addressing paths, on the same arithmetic, in one program — so a
    // fallback that computed the wrong address would disagree with itself.
    const machine = run((ctx) => {
      set32(ctx, NEAR_A, 7 * ONE);
      set32(ctx, NEAR_B, 3 * ONE);
      mul32(ctx, NEAR_A, at(NEAR_B));
      set32(ctx, A, 7 * ONE);
      set32(ctx, B, 3 * ONE);
      mul32(ctx, A, at(B));
      copy32(ctx, OUT, at(NEAR_A));
      copy32(ctx, OUT + 4, at(A));
    });
    expect(read32(machine, OUT)).toBe(mul(7 * ONE, 3 * ONE));
    expect(read32(machine, OUT + 4)).toBe(mul(7 * ONE, 3 * ONE));
  });
});
