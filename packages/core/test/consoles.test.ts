import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { prep } from "../src/pipeline/prep.js";
import { checkCompliantImage } from "../src/inspect/inspect.js";
import { consoles, getConsole } from "../src/consoles/registry.js";
import type { TileLayout } from "../src/consoles/types.js";

const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function image(
  w: number,
  h: number,
  fn: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const [r, g, b] = fn(x, y);
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return encodeRgbaPng(w, h, d);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CASES: Record<string, Uint8Array> = {
  gradient: image(96, 96, (x, y) => [
    clamp(x * 2.6),
    clamp(y * 2.6),
    clamp(128 + 64 * Math.sin((x + y) / 8)),
  ]),
  flat: image(64, 64, () => [100, 150, 80]),
  noise: (() => {
    const r = lcg(9);
    return image(80, 80, () => [(r() * 255) | 0, (r() * 255) | 0, (r() * 255) | 0]);
  })(),
};

describe("every registered console produces compliant prep output", () => {
  for (const spec of consoles()) {
    for (const [name, png] of Object.entries(CASES)) {
      it(`${spec.id}/${name} is sound-compliant`, async () => {
        const result = await prep(png, { console: spec.id, effort: "fast" });
        expect(checkCompliantImage(result.image, spec)).toEqual([]);
        // Structural invariants from the spec.
        const layout = spec.layout as TileLayout;
        expect(result.image.palettes.length).toBeLessThanOrEqual(layout.subPalettes.count);
        for (const p of result.image.palettes) {
          expect(p.colors.length).toBeLessThanOrEqual(layout.subPalettes.size);
        }
        // Dimensions land on the attribute grid.
        expect(result.image.width % layout.attribute.w).toBe(0);
        expect(result.image.height % layout.attribute.h).toBe(0);
      });
    }
  }
});

describe("console registry", () => {
  it("registers 20 consoles across three tiers with unique ids", () => {
    const all = consoles();
    expect(all.length).toBe(20);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.filter((c) => c.tier === 1).length).toBeGreaterThanOrEqual(8);
  });

  it("resolves aliases", () => {
    expect(getConsole("genesis").id).toBe("md");
    expect(getConsole("superfamicom").id).toBe("snes");
    expect(getConsole("turbografx").id).toBe("pce");
  });
});
