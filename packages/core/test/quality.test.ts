/**
 * Prep quality regression suite (doc 04 §The judge, doc 09 §Stability).
 *
 * Each test pins a failure mode found on the Phase-2 eval battery (realistic
 * pixel art, AA'd portraits, real photographs) — hue swaps from fitting through
 * the CGB panel filter, k-means mean-mush washing out flat art, dither speckle
 * winning the tournament on flat sources, photos misclassified as art. These
 * are behavioral floors, not golden bytes: they must keep passing as the
 * algorithm evolves.
 */

import { describe, expect, it } from "vitest";

import { encodeRgbaPng } from "../src/image/png/encode.js";
import { decodeImage } from "../src/image/decode.js";
import { prep } from "../src/pipeline/prep.js";
import { analyze } from "../src/pipeline/analyze.js";
import { inspect } from "../src/inspect/inspect.js";
import { judge, palettePressure, referenceLab, scoreLab } from "../src/inspect/judge.js";
import { normalize } from "../src/pipeline/normalize.js";
import { detectCompliant } from "../src/codegen/detect.js";
import { getConsole } from "../src/consoles/registry.js";

type Rgb = [number, number, number];

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgb,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const [r, g, b] = paint(x, y);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 255;
    }
  }
  return encodeRgbaPng(width, height, rgba);
}

/** Distinct colors of a decoded PNG. */
function distinctColors(png: Uint8Array): Rgb[] {
  const img = decodeImage(png);
  const seen = new Map<number, Rgb>();
  for (let i = 0; i < img.data.length; i += 4) {
    const key = (img.data[i]! << 16) | (img.data[i + 1]! << 8) | img.data[i + 2]!;
    if (!seen.has(key)) seen.set(key, [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]);
  }
  return [...seen.values()];
}

function nearestDistance(target: Rgb, colors: Rgb[]): number {
  let best = Infinity;
  for (const c of colors) {
    const d = Math.max(
      Math.abs(c[0] - target[0]),
      Math.abs(c[1] - target[1]),
      Math.abs(c[2] - target[2]),
    );
    if (d < best) best = d;
  }
  return best;
}

// Bold flat regions in strongly distinct hues (the flat-badges case): a
// compliant-friendly 160x144 with 9 colors, at most 4 per 8x8 tile.
const FLAT_COLORS: Rgb[] = [
  [16, 16, 24], // outline/bg
  [255, 255, 255],
  [224, 56, 72], // red
  [56, 120, 224], // blue
  [255, 200, 48], // yellow
  [40, 168, 96], // green
  [160, 96, 200], // purple
  [255, 144, 48], // orange
  [120, 120, 128], // gray
];
const flatArt = makeImage(160, 144, (x, y) => {
  const gx = Math.floor(x / 40);
  const gy = Math.floor(y / 48);
  const idx = 1 + ((gy * 4 + gx) % 8);
  const inset = x % 40 >= 4 && x % 40 < 36 && y % 48 >= 6 && y % 48 < 42;
  return inset ? FLAT_COLORS[idx]! : FLAT_COLORS[0]!;
});

// The flat-art prep is shared by several assertions; run it once.
let flatPrep: ReturnType<typeof prep> | undefined;
function prepFlatArt(): ReturnType<typeof prep> {
  flatPrep ??= prep(flatArt, { console: "gbc" });
  return flatPrep;
}

describe("author-space color fidelity (GBC)", () => {
  it("keeps every dominant flat color on its hue — no LCD-sim washout in the PNG", async () => {
    const result = await prepFlatArt();
    const out = distinctColors(result.png);
    for (const color of FLAT_COLORS) {
      // Raw RGB555 rounding is at most 8 per channel; the CGB panel filter
      // (yellow→orange, blue→teal) would blow far past this.
      expect(nearestDistance(color, out)).toBeLessThanOrEqual(8);
    }
  });

  it("converts flat art with per-tile-friendly colors near-losslessly", async () => {
    const result = await prepFlatArt();
    // Only RGB555 rounding should remain.
    expect(result.stats.meanDeltaE).toBeLessThan(0.008);
    expect(result.tournament.winner.startsWith("art-")).toBe(true);
  });

  it("round-trips an already-compliant image nearly untouched", { timeout: 20000 }, async () => {
    const first = await prepFlatArt();
    const second = await prep(first.png, { console: "gbc" });
    const verdict = judge(first.png, second.png, { profile: "art" });
    expect(verdict.rawMeanDeltaE).toBeLessThan(0.004);
    expect(verdict.metrics.gamut).toBeGreaterThan(0.97);
    // Zero-pressure guardrail: authored-economical art must never pick a
    // graded candidate (doc 04 §The objective).
    expect(second.stats.palettePressure).toBeLessThan(0.05);
    expect(second.tournament.winner).not.toMatch(/expand|punchy/);
  });

  it("--dac-colors opts into the panel-filter simulation instead", { timeout: 20000 }, async () => {
    const raw = await prepFlatArt();
    const dac = await prep(flatArt, { console: "gbc", dacColors: true });
    const rawYellow = nearestDistance([255, 200, 48], distinctColors(raw.png));
    const dacYellow = nearestDistance([255, 200, 48], distinctColors(dac.png));
    // The simulated LCD mutes saturated yellow; raw storage keeps it.
    expect(rawYellow).toBeLessThanOrEqual(8);
    expect(dacYellow).toBeGreaterThan(20);
    // Both encodings are recognized by the oracle and the exact-path detector.
    for (const png of [raw.png, dac.png]) {
      expect(inspect(png, { console: "gbc" }).consoles[0]!.compliant).toBe(true);
      expect(detectCompliant(decodeImage(png), getConsole("gbc"))).not.toBeNull();
    }
  });
});

describe("rare-but-distinct accent colors survive fitting", () => {
  it("keeps a six-pixel highlight the mean would average away", async () => {
    // A portrait-like field: large skin + hair regions, tiny blue eyes and a
    // small red mouth (the doc 04 §Stage 3 scenario).
    const png = makeImage(56, 56, (x, y) => {
      if (y < 16) return [88, 40, 24]; // hair
      if (y >= 22 && y < 25 && ((x >= 18 && x < 21) || (x >= 34 && x < 37))) return [40, 96, 168]; // eyes
      if (y >= 38 && y < 40 && x >= 24 && x < 32) return [176, 48, 56]; // mouth
      return [232, 190, 148]; // skin
    });
    const result = await prep(png, { console: "gbc" });
    const out = distinctColors(result.png);
    expect(nearestDistance([40, 96, 168], out)).toBeLessThanOrEqual(12);
    expect(nearestDistance([176, 48, 56], out)).toBeLessThanOrEqual(12);
  });
});

describe("judge metrics (art profile)", () => {
  it("punishes dither speckle on regions the source keeps flat", () => {
    const w = 32;
    const h = 32;
    const flat = makeImage(w, h, () => [120, 120, 128]);
    const speckled = makeImage(w, h, (x, y) =>
      (x + y) % 2 === 0 ? [104, 104, 112] : [136, 136, 144],
    );
    const clean = judge(flat, flat, { profile: "art" });
    const noisy = judge(flat, speckled, { profile: "art" });
    expect(noisy.metrics.noise).toBeLessThan(0.5);
    expect(noisy.aggregate).toBeLessThan(clean.aggregate * 0.75);
  });

  it("punishes a hue rotation harder than an equal-size lightness shift", () => {
    const w = 32;
    const h = 32;
    const blue = makeImage(w, h, () => [56, 120, 224]);
    const teal = makeImage(w, h, () => [56, 170, 180]); // rotated hue, similar L
    const darker = makeImage(w, h, () => [50, 106, 200]); // same hue, dimmer
    const hueShifted = judge(blue, teal, { profile: "art" });
    const dimmed = judge(blue, darker, { profile: "art" });
    expect(hueShifted.metrics.hue).toBeLessThan(dimmed.metrics.hue);
    expect(hueShifted.aggregate).toBeLessThan(dimmed.aggregate);
  });

  it("palette recall drops when a dominant region color goes missing", () => {
    const w = 32;
    const h = 32;
    const twoTone = makeImage(w, h, (x) => (x < 16 ? [224, 56, 72] : [56, 120, 224]));
    const kept = judge(twoTone, twoTone, { profile: "art" });
    const swapped = makeImage(w, h, (x) => (x < 16 ? [224, 56, 72] : [72, 88, 96])); // blue gone
    const lost = judge(twoTone, swapped, { profile: "art" });
    expect(lost.metrics.palette).toBeLessThan(kept.metrics.palette * 0.85);
  });

  it("exposes the new metrics through scoreLab's public shape", () => {
    const w = 8;
    const h = 8;
    const png = makeImage(w, h, () => [100, 150, 200]);
    const verdict = judge(png, png, { profile: "art" });
    for (const id of ["meanDeltaE", "p95DeltaE", "structure", "gamut", "hue", "noise", "palette"]) {
      expect(verdict.metrics[id as keyof typeof verdict.metrics]).toBeGreaterThan(0.9);
    }
    expect(typeof scoreLab).toBe("function");
  });
});

describe("perceived equivalence (doc 04 §The objective)", () => {
  it("prefers distinct-but-exaggerated over closer-but-merged region colors", () => {
    // Two mid-gray regions 0.1 L apart. A merges them onto one value (small
    // per-pixel error, regions indistinguishable); B pushes them apart (larger
    // per-pixel error, boundary preserved). The eye — and the judge — must
    // prefer B.
    const w = 32;
    const h = 32;
    const twoTone = makeImage(w, h, (x) => (x < 16 ? [110, 110, 110] : [146, 146, 146]));
    const merged = makeImage(w, h, () => [128, 128, 128]);
    const exaggerated = makeImage(w, h, (x) => (x < 16 ? [78, 78, 78] : [178, 178, 178]));
    const mergedVerdict = judge(twoTone, merged, { profile: "art" });
    const exaggeratedVerdict = judge(twoTone, exaggerated, { profile: "art" });
    // Sanity: the merged output really is the per-pixel-closer one.
    expect(mergedVerdict.rawMeanDeltaE).toBeLessThan(exaggeratedVerdict.rawMeanDeltaE);
    expect(exaggeratedVerdict.metrics.separation).toBeGreaterThan(mergedVerdict.metrics.separation);
    expect(exaggeratedVerdict.aggregate).toBeGreaterThan(mergedVerdict.aggregate);
  });

  it("treats a bounded coherent grade as nearly free", () => {
    // A three-tone ramp, then the same ramp brightened/stretched monotonically
    // with a mild chroma boost — a legal artist grade, not an error.
    const w = 32;
    const h = 33;
    const ramp = makeImage(w, h, (_, y) =>
      y < 11 ? [60, 44, 36] : y < 22 ? [140, 96, 72] : [208, 160, 120],
    );
    const graded = makeImage(w, h, (_, y) =>
      y < 11 ? [44, 30, 24] : y < 22 ? [156, 102, 70] : [240, 186, 136],
    );
    const verdict = judge(ramp, graded, { profile: "art" });
    // The grade-aligned residual must be far smaller than the raw error…
    expect(verdict.metrics.alignedMean).toBeGreaterThan(0.8);
    expect(verdict.metrics.alignedMean).toBeGreaterThan(verdict.metrics.meanDeltaE + 0.1);
    // …and the coherent grade must not be mistaken for damage.
    expect(verdict.metrics.ordering).toBeGreaterThan(0.9);
    expect(verdict.metrics.separation).toBeGreaterThan(0.9);
    expect(verdict.aggregate).toBeGreaterThan(0.6);
  });

  it("does not let grade alignment excuse a full tonal collapse", () => {
    // Collapsing everything to one gray is monotone — isotonic alignment could
    // absorb it. The relational metrics (separation, ordering, structure,
    // contrast) must crater the aggregate anyway.
    const w = 32;
    const h = 32;
    const varied = makeImage(w, h, (x, y) => [
      60 + ((x * 6) % 160),
      50 + ((y * 5) % 170),
      70 + (((x + y) * 4) % 150),
    ]);
    const collapsed = makeImage(w, h, () => [128, 128, 128]);
    const verdict = judge(varied, collapsed, { profile: "art" });
    expect(verdict.aggregate).toBeLessThan(0.35);
  });

  it("palette pressure rises as the console budget falls short", () => {
    // A diverse source: high pressure on DMG (4 shades), lower on GBC (32
    // colors), zero for flat 9-color art anywhere.
    // 64 flat 8×8 blocks, each a distinct color: every color has real coverage.
    const diverse = decodeImage(
      makeImage(64, 64, (x, y) => {
        const block = Math.floor(y / 8) * 8 + Math.floor(x / 8);
        return [40 + ((block * 23) % 200), 40 + ((block * 41) % 200), 40 + ((block * 59) % 200)];
      }),
    );
    const lin = normalize(diverse);
    const lab = referenceLab(lin, 64, 64, "photo");
    const n = 64 * 64;
    const dmg = palettePressure(lab, n, getConsole("dmg"));
    const gbc = palettePressure(lab, n, getConsole("gbc"));
    expect(dmg).toBeGreaterThan(gbc);
    expect(dmg).toBeGreaterThan(0.5);

    const flatLab = referenceLab(normalize(decodeImage(flatArt)), 160, 144, "art");
    expect(palettePressure(flatLab, 160 * 144, getConsole("gbc"))).toBe(0);
  });

  it("graded candidates compete under pressure and are judged, not disqualified", async () => {
    // A tonally-compressed, muted photo-like source on a coarse console: the
    // graded candidates must at least run scored (their whole point is this
    // regime); whichever wins, pressure must be engaged.
    const murky = makeImage(64, 64, (x, y) => [
      90 + ((x * 3) % 60),
      80 + ((y * 2) % 55),
      70 + (((x + y) * 2) % 50),
    ]);
    const result = await prep(murky, { console: "sms" });
    expect(result.stats.palettePressure).toBeGreaterThan(0.2);
    const graded = result.tournament.candidates.filter((c) => /expand|punchy/.test(c.strategy));
    expect(graded.length).toBeGreaterThan(0);
    for (const g of graded) {
      expect(g.disqualified).toBeUndefined();
      expect(g.aggregate).toBeGreaterThan(0);
    }
  });
});

describe("source analysis profiles", () => {
  it("classifies flat pixel art as art, even after AA-style blur", () => {
    const crisp = decodeImage(flatArt);
    expect(analyze(crisp).profile).toBe("art");

    // Blur horizontally to fake upscaler anti-aliasing: interiors stay exact.
    const blurred = makeImage(160, 144, (x, y) => {
      const img = crisp;
      const idx = (xx: number) => (y * 160 + Math.max(0, Math.min(159, xx))) * 4;
      const c = [0, 1, 2].map((ch) =>
        Math.round(
          (img.data[idx(x - 1) + ch]! + 2 * img.data[idx(x) + ch]! + img.data[idx(x + 1) + ch]!) /
            4,
        ),
      ) as Rgb;
      return c;
    });
    expect(analyze(decodeImage(blurred)).profile).toBe("art");
  });

  it("classifies noisy continuous-tone sources as photo", () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const photo = makeImage(160, 144, (x, y) => {
      const n = (rnd() - 0.5) * 12;
      return [
        Math.max(0, Math.min(255, Math.round(x * 1.2 + n))),
        Math.max(0, Math.min(255, Math.round(y * 1.4 + n))),
        Math.max(0, Math.min(255, Math.round(120 + 60 * Math.sin(x * 0.05) + n))),
      ];
    });
    expect(analyze(decodeImage(photo)).profile).toBe("photo");
  });
});
