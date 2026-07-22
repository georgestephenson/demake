import { describe, expect, it } from "vitest";

import { cbrt, exp, log, pow } from "../src/math/kernels.js";
import { makePrng } from "../src/math/prng.js";

/**
 * The kernels only have to *agree* across engines (that is the determinism
 * guarantee), but they should also be accurate enough for color work. We check
 * accuracy against the native `Math.*` (allowed in tests) with a tight
 * tolerance across the argument ranges the pipeline uses.
 */
describe("deterministic math kernels", () => {
  it("log matches Math.log across a wide range", () => {
    for (const x of [1e-6, 0.001, 0.5, 1, 1.5, 2, 10, 255, 1000, 1e6]) {
      expect(log(x)).toBeCloseTo(Math.log(x), 10);
    }
  });

  it("exp matches Math.exp", () => {
    for (const x of [-10, -2, -0.5, 0, 0.5, 1, 2, 5, 10]) {
      expect(exp(x)).toBeCloseTo(Math.exp(x), 8);
    }
  });

  it("pow matches Math.pow for gamma-curve arguments", () => {
    for (const base of [0, 0.01, 0.25, 0.5, 0.75, 1]) {
      expect(pow(base, 2.4)).toBeCloseTo(Math.pow(base, 2.4), 10);
      expect(pow(base, 1 / 2.4)).toBeCloseTo(Math.pow(base, 1 / 2.4), 10);
    }
  });

  it("pow handles integer exponents exactly", () => {
    expect(pow(2, 10)).toBe(1024);
    expect(pow(3, 4)).toBe(81);
    expect(pow(5, -2)).toBeCloseTo(0.04, 12);
  });

  it("cbrt matches Math.cbrt including negatives", () => {
    for (const x of [-27, -1, -0.125, 0, 0.125, 1, 8, 27, 1000]) {
      expect(cbrt(x)).toBeCloseTo(Math.cbrt(x), 10);
    }
  });

  it("edge cases stay sane", () => {
    expect(log(0)).toBe(-Infinity);
    expect(Number.isNaN(log(-1))).toBe(true);
    expect(exp(0)).toBe(1);
    expect(cbrt(0)).toBe(0);
  });
});

describe("PCG32 PRNG", () => {
  it("is reproducible: same seed → same stream", () => {
    const a = makePrng(12345);
    const b = makePrng(12345);
    for (let i = 0; i < 100; i += 1) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it("different seeds diverge", () => {
    const a = makePrng(1);
    const b = makePrng(2);
    let same = 0;
    for (let i = 0; i < 100; i += 1) {
      if (a.nextU32() === b.nextU32()) same += 1;
    }
    expect(same).toBeLessThan(5);
  });

  it("next() stays in [0,1)", () => {
    const p = makePrng(7);
    for (let i = 0; i < 1000; i += 1) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nextInt is unbiased-ish and in range", () => {
    const p = makePrng(99);
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 6000; i += 1) {
      const r = p.nextInt(6);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(6);
      counts[r] += 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(800);
      expect(c).toBeLessThan(1200);
    }
  });

  it("stream is stable across versions (snapshot guard)", () => {
    const p = makePrng(0x2a);
    const first = [p.nextU32(), p.nextU32(), p.nextU32()];
    // Regression guard: these bytes must never drift without a deliberate,
    // release-noted change (they feed output-stable conversions).
    expect(first).toMatchInlineSnapshot(`
      [
        3270867926,
        1795671209,
        1924641435,
      ]
    `);
  });
});
