/**
 * The Neo Geo Pocket Color value layer, proven against `fixed.ts` on the
 * hardware itself.
 *
 * The counterpart of `md-arith.test.ts`, `wsc-arith.test.ts` and the rest, and
 * it exists for the reason those do: the 16.16 arithmetic is where a new backend
 * goes wrong first, and it goes wrong quietly. A multiply that floors the wrong
 * way for negative operands produces a game that plays *almost* right and
 * diverges from the trace a thousand ticks later, by which point the failure
 * names a position rather than an operation.
 *
 * It is also the first thing that runs TLCS-900/H code the code generator wrote,
 * so it is what would catch an encoder and a decoder agreeing with each other
 * and not with Toshiba — `packages/core/test/tlcs900.test.ts` pins the bytes
 * against the published code maps, and this pins the behaviour against
 * `fixed.ts`.
 *
 * Three of the vectors are aimed at answers this machine gives that no
 * predecessor does. The **multiply is three products and no carry propagation**,
 * because the clamp puts both high halves below 2^10 and the middle product
 * therefore cannot overflow — so a fraction near one, where `al·bl` is nearly
 * 2^32, is the case that says the shift and the addition are in the right order.
 * The **divide is a forty-eight iteration loop** rather than the hardware's own
 * `div`, because that instruction is thirty-two by *sixteen* with a sixteen-bit
 * quotient and a `speed / fps` routinely wants more — so a divisor below one
 * cell, which is where the quotient is widest, has to be here. And **both floor
 * adjustments are conditional on a fraction existing**, so every signed case is
 * paired with its exact counterpart.
 *
 * The program is compiled against another console's profile on purpose: this
 * backend has no profile of its own until it can build a cartridge (a profile
 * without a backend is what `registry.test.ts` refuses), and the value layer
 * reads nothing from one — the addresses come from `NGPC_MEMORY` and the
 * arithmetic from the instruction set.
 */

import { NGP_HEADER_SIZE, NGP_ROM_BASE, packNgpRom } from "@demake/core";
import { Ngp } from "@demake/ngp";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/codegen/analyze.js";
import { NGPC_MEMORY, planLayout } from "../src/codegen/layout.js";
import { NgpcCtx } from "../src/codegen/ngpc/ctx.js";
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
} from "../src/codegen/ngpc/val.js";
import { emitExpr, UNBOUND } from "../src/codegen/ngpc/expr.js";
import { compile } from "../src/compile.js";
import { clampFixed, div, mul, ONE } from "../src/fixed.js";
import { getProfile } from "../src/profiles.js";
import { draw } from "../src/rng.js";

/** A program with nothing in it: all these tests need from one is a layout. */
const PROGRAM = compile("start only\n\nscene only\n", { profile: getProfile("md") });

/**
 * A program whose one rule assigns `source`, so a test can emit that expression.
 *
 * Going through a compiled rule rather than hand-building an AST is what makes
 * these tests exercise the path a game takes: constants fold where the compiler
 * folds them, and `random` pulls the generator in the way a rule pulls it —
 * which is also the only way, since a helper reaches the output by being asked
 * for and never by being named.
 */
function programFor(source: string) {
  return compile(
    [
      "start only",
      "",
      "scene only",
      "",
      "create number n in only (value 0, visible 0)",
      "",
      `when always then n.value as ${source}`,
      "",
    ].join("\n"),
    { profile: getProfile("md") },
  );
}

/** The expression that program's rule assigns. */
function expressionOf(program: ReturnType<typeof programFor>) {
  const value = program.rules[0]?.assignments[0]?.value;
  if (!value) throw new Error("the fixture program has no assignment to read");
  return value;
}

/** A third of a cell, as a whole 16.16 value — `ONE / 3` is not one. */
const THIRD = Math.floor(ONE / 3);

/** Where the program is assembled: the first byte after the cartridge header. */
const CODE_ORIGIN = NGP_ROM_BASE + NGP_HEADER_SIZE;

/** Where a test's operands live — the top of work RAM, clear of the plan. */
const A = 0x6b00;
const B = 0x6b04;
const OUT = 0x6b08;

/** The four bytes at `address`, little-endian, as a signed 32-bit integer. */
function read32(machine: Ngp, address: number): number {
  return (
    machine.read(address) |
    (machine.read(address + 1) << 8) |
    (machine.read(address + 2) << 16) |
    (machine.read(address + 3) << 24) |
    0
  );
}

/** Assemble `body` into a cartridge, run it to its spin loop, hand it back. */
function run(body: (ctx: NgpcCtx) => void, program = PROGRAM): Ngp {
  const analysis = analyze(program);
  const layout = planLayout(program, analysis, NGPC_MEMORY);
  const ctx = new NgpcCtx(program, analysis, layout, getProfile("md"), CODE_ORIGIN);
  const { asm } = ctx;

  asm.label("Start");
  // The stack is the machine's own default; nothing here needs its own.
  body(ctx);
  asm.label("Spin");
  asm.jr("t", "Spin");
  ctx.finish();

  const machine = new Ngp();
  machine.load(packNgpRom(asm.assemble(), { entry: asm.addressOf("Start"), color: true }));
  const spin = asm.addressOf("Spin");
  for (let step = 0; step < 2_000_000; step += 1) {
    if (machine.cpu.pc === spin) return machine;
    machine.step();
  }
  throw new Error("ngpc: the program never reached its spin loop");
}

/** Run one binary operation over a vector of operand pairs. */
function binary(
  emit: (ctx: NgpcCtx, dst: number, src: number) => void,
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

describe("the Neo Geo Pocket Color value layer", () => {
  it("copies and sets whole 32-bit values", () => {
    const machine = run((ctx) => {
      set32(ctx, A, -123456);
      set32(ctx, B, 0);
      copy32(ctx, OUT, A);
    });
    expect(read32(machine, A)).toBe(-123456);
    expect(read32(machine, B)).toBe(0);
    expect(read32(machine, OUT)).toBe(-123456);
  });

  it("adds and subtracts, including across the sign", () => {
    binary(add32, (a, b) => (a + b) | 0, [
      [ONE, ONE],
      [-ONE, ONE],
      [5 * ONE, -7 * ONE],
      [-(5 * ONE), -(7 * ONE)],
      [THIRD, THIRD],
    ]);
    binary(sub32, (a, b) => (a - b) | 0, [
      [ONE, ONE],
      [-ONE, ONE],
      [5 * ONE, -7 * ONE],
      [THIRD, 2 * THIRD],
    ]);
  });

  it("adds a constant", () => {
    for (const [start, delta] of [
      [0, 0],
      [ONE, 1],
      [ONE, -1],
      [-(5 * ONE), 3 * ONE],
      [THIRD, -(2 * THIRD)],
    ] as const) {
      const machine = run((ctx) => {
        set32(ctx, A, start);
        addConst32(ctx, A, delta);
      });
      expect(read32(machine, A)).toBe((start + delta) | 0);
    }
  });

  it("negates, takes an absolute value and halves", () => {
    for (const value of [0, ONE, -ONE, THIRD, -THIRD, 1023 * ONE, -(1023 * ONE)]) {
      expect(
        read32(
          run((ctx) => {
            set32(ctx, A, value);
            neg32(ctx, A);
          }),
          A,
        ),
      ).toBe(-value | 0);
      expect(
        read32(
          run((ctx) => {
            set32(ctx, A, value);
            abs32(ctx, A);
          }),
          A,
        ),
      ).toBe(Math.abs(value) | 0);
      // An arithmetic shift right is floor division by two, so an odd negative
      // value goes *down* rather than toward zero.
      expect(
        read32(
          run((ctx) => {
            set32(ctx, A, value);
            asr32(ctx, A);
          }),
          A,
        ),
      ).toBe(Math.floor(value / 2));
    }
    expect(
      read32(
        run((ctx) => {
          set32(ctx, A, -3);
          asr32(ctx, A);
        }),
        A,
      ),
    ).toBe(-2);
  });

  it("clamps to the range `fixed.ts` enforces", () => {
    for (const value of [
      0,
      FIXED_MAX,
      FIXED_MAX + 1,
      2 * FIXED_MAX,
      -FIXED_MAX,
      -FIXED_MAX - 1,
      -(2 * FIXED_MAX),
      ONE,
    ]) {
      const machine = run((ctx) => {
        set32(ctx, A, value);
        clamp32(ctx, A);
      });
      expect(read32(machine, A)).toBe(clampFixed(value));
    }
  });

  describe("branches", () => {
    /** Run a branch emitter and report whether it was taken. */
    function taken(emit: (ctx: NgpcCtx, target: string) => void): boolean {
      const machine = run((ctx) => {
        set32(ctx, OUT, 0);
        emit(ctx, "Skip");
        set32(ctx, OUT, ONE);
        ctx.asm.label("Skip");
      });
      return read32(machine, OUT) === 0;
    }

    it("tests for zero", () => {
      expect(
        taken((ctx, target) => {
          set32(ctx, A, 0);
          branchZero32(ctx, A, target);
        }),
      ).toBe(true);
      expect(
        taken((ctx, target) => {
          set32(ctx, A, -1);
          branchZero32(ctx, A, target);
        }),
      ).toBe(false);
    });

    it("compares as signed, including at the ends of the range", () => {
      const less = (a: number, b: number): boolean =>
        taken((ctx, target) => {
          set32(ctx, A, a);
          set32(ctx, B, b);
          branchLess32(ctx, A, B, target);
        });
      expect(less(-ONE, ONE)).toBe(true);
      expect(less(ONE, -ONE)).toBe(false);
      expect(less(0, 0)).toBe(false);
      // The pair a comparison written on the sign bit alone gets wrong: the
      // difference overflows, and `lt` is `S xor V` precisely so that it does not
      // matter.
      expect(less(-FIXED_MAX, FIXED_MAX)).toBe(true);
      expect(less(FIXED_MAX, -FIXED_MAX)).toBe(false);
    });

    it("compares for equality", () => {
      const equal = (a: number, b: number): boolean =>
        taken((ctx, target) => {
          set32(ctx, A, a);
          set32(ctx, B, b);
          branchEqual32(ctx, A, B, target);
        });
      expect(equal(THIRD, THIRD)).toBe(true);
      expect(equal(THIRD, THIRD + 1)).toBe(false);
      expect(equal(-ONE, -ONE)).toBe(true);
    });
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
      [THIRD, -THIRD],
      [0, 5 * ONE],
      [5 * ONE, 0],
      [100 * ONE, 10 * ONE],
      // Both fractions near one, so `al × bl` is nearly 2^32 before anything is
      // shifted into it — the case that says the shift and the additions are in
      // the right order.
      [5 * ONE + 65535, 5 * ONE + 65535],
      [-(5 * ONE + 65535), 5 * ONE + 65535],
      // A large operand against a small one, at the far end of the clamp.
      [1023 * ONE, THIRD],
      [-(1023 * ONE), THIRD],
      // Not here, deliberately, and for the reason `md-arith.test.ts` states:
      // both operands at the clamp make `a × b / 65536` equal 2^36, and every
      // backend in the project takes the product's middle thirty-two bits — so
      // all of them agree on zero where `fixed.ts` clamps.
    ]);
  });

  it("divides, and floors toward negative infinity on both signs", () => {
    binary(div32, div, [
      [10 * ONE, 2 * ONE],
      [-10 * ONE, 2 * ONE],
      [10 * ONE, -2 * ONE],
      [-10 * ONE, -2 * ONE],
      [7 * ONE, 60 * ONE],
      [-7 * ONE, 60 * ONE],
      // A divisor below one cell, which is where the quotient is widest — and
      // the reason this console's own `div` instruction is the wrong shape.
      [ONE, THIRD],
      [-ONE, THIRD],
      [ONE, ONE / 2],
      [-(3 * ONE), ONE / 4],
      // Exact and inexact of the same sign, so the floor adjustment is proven to
      // be conditional rather than unconditional.
      [-(4 * ONE), 2 * ONE],
      [-(5 * ONE), 2 * ONE],
      // Division by zero is zero, which is the language's answer and not the
      // hardware's.
      [5 * ONE, 0],
      [-(5 * ONE), 0],
      [0, 5 * ONE],
    ]);
  });

  it("pulls in the divider only when something divides", () => {
    // The reachability rule: a game that never divides ships no divider, because
    // nothing ever asked for one.
    const analysis = analyze(PROGRAM);
    const layout = planLayout(PROGRAM, analysis, NGPC_MEMORY);
    const plain = new NgpcCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
    add32(plain, A, B);
    expect(plain.helperNames()).toEqual([]);

    const dividing = new NgpcCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
    div32(dividing, A, B);
    expect(dividing.helperNames()).toContain("Div32");
  });

  it("emits the same bytes twice for the same program", () => {
    const build = (): Uint8Array => {
      const analysis = analyze(PROGRAM);
      const layout = planLayout(PROGRAM, analysis, NGPC_MEMORY);
      const ctx = new NgpcCtx(PROGRAM, analysis, layout, getProfile("md"), CODE_ORIGIN);
      mul32(ctx, A, B);
      div32(ctx, A, B);
      ctx.finish();
      return ctx.asm.assemble();
    };
    expect([...build()]).toEqual([...build()]);
  });
});

describe("the Neo Geo Pocket Color expression layer", () => {
  it("draws exactly what the language's generator draws", () => {
    // `rng.ts` is the definition and every backend has to reproduce it bit for
    // bit — a generator that disagreed would make two implementations of the
    // same game incomparable, which is the whole reason it is in the language.
    // Three multiplies and no loop here, and the modulo is one `div`, so this is
    // where either would show.
    const SEED = 1;
    for (const [source, low, high] of [
      ["random(0, 10)", 0, 10 * ONE],
      ["random(3, 3)", 3 * ONE, 3 * ONE],
      // Crossed bounds: the low one is the answer, and the state still moves.
      ["random(5, 2)", 5 * ONE, 2 * ONE],
      ["random(0 - 4, 4)", -4 * ONE, 4 * ONE],
      // Floored to whole cells before anything else happens.
      ["random(1.5, 6.25)", ONE + ONE / 2, 6 * ONE + ONE / 4],
      ["random(0, 1000)", 0, 1000 * ONE],
    ] as const) {
      const program = programFor(source);
      const expr = expressionOf(program);
      const layout = planLayout(program, analyze(program), NGPC_MEMORY);
      const rng = layout.rng as number;
      const machine = run((ctx) => {
        set32(ctx, rng, SEED);
        emitExpr(ctx, expr, UNBOUND, OUT);
        copy32(ctx, OUT + 4, rng);
      }, program);
      const want = draw(SEED, low, high);
      expect(`${source} = ${read32(machine, OUT)}`).toBe(`${source} = ${want.value}`);
      expect(read32(machine, OUT + 4) >>> 0).toBe(want.state);
    }
  });

  it("advances the generator even when the bounds leave nothing to draw", () => {
    // The rule `rng.ts` exists to state: *when* a draw happens is behaviour, so
    // the degenerate case still moves the state.
    const program = programFor("random(2, 2)");
    const expr = expressionOf(program);
    const layout = planLayout(program, analyze(program), NGPC_MEMORY);
    const rng = layout.rng as number;
    const machine = run((ctx) => {
      set32(ctx, rng, 7);
      emitExpr(ctx, expr, UNBOUND, OUT);
      copy32(ctx, OUT + 4, rng);
    }, program);
    expect(read32(machine, OUT + 4) >>> 0).toBe(draw(7, 2 * ONE, 2 * ONE).state);
  });

  it("compiles the builtins the expression layer offers", () => {
    // `abs`, `min`, `max` and `clamp` are the whole of the language's arithmetic
    // vocabulary beyond the operators, and each is a branch this backend picks
    // rather than an instruction the hardware has.
    for (const [source, want] of [
      ["abs(0 - 3)", 3 * ONE],
      ["abs(3)", 3 * ONE],
      ["min(2, 5)", 2 * ONE],
      ["min(5, 2)", 2 * ONE],
      ["min(0 - 5, 2)", -5 * ONE],
      ["max(2, 5)", 5 * ONE],
      ["max(5, 2)", 5 * ONE],
      ["max(0 - 5, 0 - 2)", -2 * ONE],
      ["clamp(7, 0, 5)", 5 * ONE],
      ["clamp(0 - 7, 0 - 5, 5)", -5 * ONE],
      ["clamp(3, 0, 5)", 3 * ONE],
    ] as const) {
      const program = programFor(source);
      const expr = expressionOf(program);
      const machine = run((ctx) => {
        emitExpr(ctx, expr, UNBOUND, OUT);
      }, program);
      expect(`${source} = ${read32(machine, OUT)}`).toBe(`${source} = ${want}`);
    }
  });

  it("builds a comparison's value without ever building its operands' difference", () => {
    // A relational operator used as a *value* rather than as a test: one is
    // `1.0` and zero is zero, which is what makes `when always ... as a < b`
    // usable as a number.
    for (const [source, want] of [
      ["1 < 2", ONE],
      ["2 < 1", 0],
      ["2 = 2", ONE],
      ["2 != 2", 0],
      ["3 >= 3", ONE],
      ["3 > 3", 0],
      ["0 - 5 <= 0 - 5", ONE],
    ] as const) {
      const program = programFor(source);
      const expr = expressionOf(program);
      const machine = run((ctx) => {
        emitExpr(ctx, expr, UNBOUND, OUT);
      }, program);
      expect(`${source} = ${read32(machine, OUT)}`).toBe(`${source} = ${want}`);
    }
  });
});
