import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { prep } from "../src/pipeline/prep.js";
import { checkCompliantImage } from "../src/inspect/inspect.js";
import { consoles, findConsole, getConsole } from "../src/consoles/registry.js";
import { consoleLabel, consoleNames } from "../src/consoles/names.js";
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
        // Dimensions land on the attribute grid.
        expect(result.image.width % result.image.grid.attributeW).toBe(0);
        expect(result.image.height % result.image.grid.attributeH).toBe(0);
        if (spec.layout.kind === "tiles") {
          // Structural invariants from a tiled spec.
          const layout = spec.layout as TileLayout;
          expect(result.image.palettes.length).toBeLessThanOrEqual(layout.subPalettes.count);
          for (const p of result.image.palettes) {
            expect(p.colors.length).toBeLessThanOrEqual(layout.subPalettes.size);
          }
        } else {
          // TMS Graphics II: at most two colors per 8×1 row cell.
          for (const p of result.image.palettes) expect(p.colors.length).toBeLessThanOrEqual(2);
        }
      });
    }
  }
});

describe("console registry", () => {
  it("registers 21 consoles across three tiers with unique ids", () => {
    const all = consoles();
    expect(all.length).toBe(21);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    expect(all.filter((c) => c.tier === 1).length).toBeGreaterThanOrEqual(8);
  });

  it("resolves aliases", () => {
    expect(getConsole("genesis").id).toBe("md");
    expect(getConsole("superfamicom").id).toBe("snes");
    expect(getConsole("turbografx").id).toBe("pce");
  });
});

describe("console names", () => {
  it("labels a console sold under one name with just that name", () => {
    expect(consoleNames(getConsole("dmg"))).toEqual(["Game Boy"]);
    expect(consoleLabel(getConsole("gba"))).toBe("Game Boy Advance");
  });

  it("labels a console sold under two with both, British first", () => {
    expect(consoleLabel(getConsole("md"))).toBe("Sega Mega Drive / Sega Genesis");
    expect(consoleLabel(getConsole("pce"))).toBe("PC Engine / TurboGrafx-16");
    expect(consoleLabel(getConsole("nes"))).toBe("Nintendo Entertainment System / Family Computer");
  });

  it("never repeats a name a second region kept", () => {
    // The deduplication is the spec's — a region that kept the name before it
    // simply is not listed — so a repeat is a spec bug rather than something a
    // display helper should quietly swallow.
    for (const spec of consoles()) {
      const names = consoleNames(spec);
      expect([spec.id, new Set(names).size]).toEqual([spec.id, names.length]);
    }
  });

  it("puts the console's own name first", () => {
    for (const spec of consoles()) {
      expect([spec.id, consoleNames(spec)[0]]).toEqual([spec.id, spec.name]);
      expect([spec.id, consoleLabel(spec).startsWith(spec.name)]).toEqual([spec.id, true]);
    }
  });

  it("lets a regional name be typed at the CLI", () => {
    // A name offered in a picker that the parser then rejects is worse than not
    // offering it, so every regional name resolves through the alias table —
    // lowercased and hyphenated, which is the form `findConsole` takes.
    for (const spec of consoles()) {
      for (const name of spec.otherNames ?? []) {
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        expect([spec.id, name, findConsole(key)?.id]).toEqual([spec.id, name, spec.id]);
      }
    }
  });
});
