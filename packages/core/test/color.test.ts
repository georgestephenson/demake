import { describe, expect, it } from "vitest";

import { channelCode, expandChannel, snapChannel, snapRgb } from "../src/color/lattice.js";
import { deltaESq, linearToOklab, oklabToLinear } from "../src/color/oklab.js";
import { linearToSrgb, linearToSrgb8, srgb8ToLinear, srgbToLinear } from "../src/color/srgb.js";
import { cgbCorrect, dacDecodeShade } from "../src/image/dac.js";

describe("sRGB transfer", () => {
  it("round-trips linear↔sRGB", () => {
    for (const c of [0, 0.02, 0.2, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(c))).toBeCloseTo(c, 9);
    }
  });
  it("8-bit endpoints are exact", () => {
    expect(srgb8ToLinear(0)).toBe(0);
    expect(linearToSrgb8(0)).toBe(0);
    expect(linearToSrgb8(1)).toBe(255);
  });
  it("mid-gray 8-bit round-trips within a code", () => {
    for (let v = 0; v <= 255; v += 17) {
      expect(linearToSrgb8(srgb8ToLinear(v))).toBe(v);
    }
  });
});

describe("Oklab", () => {
  it("round-trips linear→Oklab→linear", () => {
    const samples: Array<[number, number, number]> = [
      [0, 0, 0],
      [1, 1, 1],
      [0.5, 0.2, 0.8],
      [0.9, 0.1, 0.1],
      [0.2, 0.7, 0.3],
    ];
    for (const [r, g, b] of samples) {
      const back = oklabToLinear(linearToOklab(r, g, b));
      expect(back.r).toBeCloseTo(r, 6);
      expect(back.g).toBeCloseTo(g, 6);
      expect(back.b).toBeCloseTo(b, 6);
    }
  });
  it("distance is zero for identical colors and positive otherwise", () => {
    const a = linearToOklab(0.4, 0.5, 0.6);
    const b = linearToOklab(0.4, 0.5, 0.6);
    const c = linearToOklab(0.4, 0.5, 0.9);
    expect(deltaESq(a, b)).toBeCloseTo(0, 12);
    expect(deltaESq(a, c)).toBeGreaterThan(0);
  });
  it("L-weight increases the lightness contribution", () => {
    const a = linearToOklab(0.2, 0.2, 0.2);
    const b = linearToOklab(0.6, 0.6, 0.6);
    expect(deltaESq(a, b, 2)).toBeGreaterThan(deltaESq(a, b, 1));
  });
});

describe("hardware lattice", () => {
  it("snaps 8-bit to RGB555 by bit replication", () => {
    // 5-bit code 31 → 0xff; code 0 → 0.
    expect(snapChannel(255, 5)).toBe(255);
    expect(snapChannel(0, 5)).toBe(0);
    expect(expandChannel(channelCode(255, 5), 5)).toBe(255);
  });
  it("snapping is idempotent", () => {
    for (let v = 0; v <= 255; v += 5) {
      const s = snapChannel(v, 5);
      expect(snapChannel(s, 5)).toBe(s);
    }
  });
  it("snapRgb applies per-channel bit depths (RGB333)", () => {
    const snapped = snapRgb({ r: 200, g: 100, b: 50 }, [3, 3, 3]);
    // Each channel is one of 8 levels expanded to 8-bit.
    for (const v of [snapped.r, snapped.g, snapped.b]) {
      expect(expandChannel(channelCode(v, 3), 3)).toBe(v);
    }
  });
});

describe("DAC models", () => {
  it("CGB correction dims pure white slightly", () => {
    const white = cgbCorrect(31, 31, 31);
    expect(white.r).toBe(240);
    expect(white.g).toBe(240);
    expect(white.b).toBe(240);
    expect(cgbCorrect(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
  });
  it("mono ramp maps shades to configured colors", () => {
    const model = {
      kind: "mono-ramp" as const,
      shades: [
        { r: 155, g: 188, b: 15 },
        { r: 15, g: 56, b: 15 },
      ],
    };
    expect(dacDecodeShade(model, 0)).toEqual({ r: 155, g: 188, b: 15 });
    expect(dacDecodeShade(model, 5)).toEqual({ r: 15, g: 56, b: 15 }); // clamps
  });
});
