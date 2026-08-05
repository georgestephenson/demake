/**
 * The tiled-mono fit (`pipeline/fit-mono-tiled.ts`).
 *
 * Every case here is one this console alone can get wrong, because it is the
 * only one whose palette has two levels: a pool chosen from a wider set of
 * display levels, and sixteen four-entry palettes that index it. What the plain
 * mono path proves — a ramp, a dither, a compliant PNG — is proved by
 * `pipeline.test.ts`; what is proved here is that the *choices* are made and
 * spent.
 */

import { describe, expect, it } from "vitest";

import { getConsole } from "../src/consoles/registry.js";
import { encodeRgbaPng } from "../src/image/png/encode.js";
import { inspect } from "../src/inspect/inspect.js";
import { isMonoTiled, portfolioFor } from "../src/pipeline/portfolio.js";
import { prep } from "../src/pipeline/prep.js";

const W = 224;
const H = 144;

/**
 * A source whose tone structure is *local*, which is the only kind a per-cell
 * palette can do anything about.
 *
 * Every 8×8 cell holds a narrow four-tone spread around a base that walks the
 * whole range, so no single quartet serves the picture and each cell has a
 * favourite. A global gradient would be fitted equally well by one ramp, and a
 * source made of three flat bands is answered by two — both would pass a test
 * that only asked whether the picture came out compliant, which is how a fit
 * that computes a per-cell choice and discards it would survive.
 */
function localTones(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      const cx = Math.floor(x / 8);
      const cy = Math.floor(y / 8);
      // A base that sweeps 8–248 over the grid without repeating a row's run.
      const base = 8 + (((cy * 11 + cx * 7) % 30) * 240) / 29;
      // Four tones inside the cell, thirteen levels apart — under the spacing
      // of a pool of eight, so a palette drawn from anywhere else misses them.
      const detail = ((x % 8) + (y % 8)) % 4;
      const v = Math.max(0, Math.min(255, Math.round(base + detail * 13 - 20)));
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

const source = encodeRgbaPng(W, H, localTones());
const spec = getConsole("ws");

describe("the WonderSwan is the tiled-mono console", () => {
  it("is routed to the tiled-mono portfolio, and the mono machines are not", () => {
    expect(isMonoTiled(spec)).toBe(true);
    expect(isMonoTiled(getConsole("dmg"))).toBe(false);
    expect(isMonoTiled(getConsole("gbc"))).toBe(false);
    expect(portfolioFor(spec).every((c) => c.kind === "mono-tiled")).toBe(true);
    expect(portfolioFor(getConsole("dmg")).every((c) => c.kind === "mono")).toBe(true);
  });

  it("declares a pool narrower than the levels the panel can show", () => {
    expect(spec.color.model).toBe("mono");
    expect(spec.color.shades).toBe(8);
    expect(spec.color.levels).toBe(16);
    expect(spec.layout.kind).toBe("tiles");
    expect(spec.layout.kind === "tiles" && spec.layout.bpp).toBe(2);
    expect(spec.layout.kind === "tiles" && spec.layout.subPalettes.count).toBe(16);
    expect(spec.layout.kind === "tiles" && spec.layout.subPalettes.size).toBe(4);
  });
});

describe("prep → ws", () => {
  it("produces a compliant picture the oracle can prove", async () => {
    const result = await prep(source, { console: "ws" });
    const report = inspect(result.png, { console: "ws" });
    expect(report.consoles[0]!.violations).toEqual([]);
    expect(report.consoles[0]!.compliant).toBe(true);
    expect(report.width).toBe(W);
    expect(report.height).toBe(H);
  });

  it("spends the whole machine: sixteen palettes of four over eight levels", async () => {
    const result = await prep(source, { console: "ws" });
    expect(result.image.palettes.length).toBe(16);
    for (const palette of result.image.palettes) expect(palette.colors.length).toBe(4);

    // The pool is spent, and it is a *pool*: eight distinct levels across the
    // palettes, chosen from the panel's sixteen. A fit that came back with
    // fewer would look internally consistent in every number the tournament
    // reports (AGENTS.md §Gotchas), which is why this is asserted rather than
    // left to the compliance check — that one only bounds it from above.
    const used = new Set(result.image.palettes.flatMap((p) => p.colors.map((c) => c.codes[0]!)));
    expect(used.size).toBe(8);
    for (const level of used) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThan(16);
    }
    // And it is a choice: some of the sixteen levels are left out.
    expect(used.size).toBeLessThan(16);
  });

  it("shares entry zero, because colour zero is the backdrop on both layers", async () => {
    const result = await prep(source, { console: "ws" });
    const first = new Set(result.image.palettes.map((p) => p.colors[0]!.codes[0]!));
    expect(first.size).toBe(1);
  });

  it("gives different cells different palettes", async () => {
    const result = await prep(source, { console: "ws" });
    // The bands are far apart in tone, so a fit that handed every cell the same
    // palette would be a fit that had not made the console's own decision.
    expect(new Set(result.image.cellPalette).size).toBeGreaterThan(1);
    for (const index of result.image.cellPalette) {
      expect(index).toBeLessThan(result.image.palettes.length);
    }
  });

  it("beats one ramp, which is the whole reason the path exists", async () => {
    // The claim everything else rests on. A budget of one palette *is* the
    // plain mono answer — one quartet the whole picture shares — so a fit that
    // computed the per-cell choice and discarded it would score the same. Both
    // runs are pinned to one candidate, so the tournament cannot account for
    // the difference.
    const one = await prep(source, {
      console: "ws",
      strategy: "monotile-flat",
      maxSubPalettes: 1,
    });
    const many = await prep(source, { console: "ws", strategy: "monotile-flat" });
    expect(one.image.palettes.length).toBe(1);
    expect(many.image.palettes.length).toBe(16);
    expect(many.stats.meanDeltaE).toBeLessThan(one.stats.meanDeltaE);

    // And the sixteen are sixteen different quartets, not sixteen copies.
    const distinct = new Set(
      many.image.palettes.map((p) => p.colors.map((c) => c.codes[0]).join(",")),
    );
    expect(distinct.size).toBe(16);
  });

  it("is deterministic: identical bytes across runs", async () => {
    const a = await prep(source, { console: "ws" });
    const b = await prep(source, { console: "ws" });
    expect(Array.from(a.png)).toEqual(Array.from(b.png));
    expect(a.tournament.winner).toBe(b.tournament.winner);
  });

  it("runs a tournament over the tiled-mono candidates", async () => {
    const result = await prep(source, { console: "ws" });
    expect(result.tournament.candidates.length).toBe(3);
    for (const candidate of result.tournament.candidates) {
      expect(candidate.strategy.startsWith("monotile-")).toBe(true);
    }
  });

  it("honours a budget of fewer palettes", async () => {
    const result = await prep(source, { console: "ws", maxSubPalettes: 4, effort: "fast" });
    expect(result.image.palettes.length).toBeLessThanOrEqual(4);
    expect(inspect(result.png, { console: "ws" }).consoles[0]!.compliant).toBe(true);
  });

  it("dithers without leaving the pool", async () => {
    const result = await prep(source, { console: "ws", strategy: "monotile-fs" });
    const used = new Set(result.image.palettes.flatMap((p) => p.colors.map((c) => c.codes[0]!)));
    expect(used.size).toBeLessThanOrEqual(8);
    expect(inspect(result.png, { console: "ws" }).consoles[0]!.violations).toEqual([]);
  });
});

describe("the pool is a compliance rule, not an encoding", () => {
  it("refuses a picture showing more levels than the pool holds", () => {
    // Nine greys, one per 16×8 stripe: every cell is uniform, so it passes the
    // per-cell and the cover checks and is caught by the pool rule alone.
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4;
        const level = Math.floor(x / 16) % 9;
        const v = Math.round(255 * (1 - level / 15));
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
    const report = inspect(encodeRgbaPng(W, H, rgba), { console: "ws" });
    const codes = report.consoles[0]!.violations.map((v) => v.code);
    expect(codes).toContain("E_SHADE_POOL");
  });

  it("accepts eight of them", () => {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 4;
        const level = Math.floor(x / 16) % 8;
        const v = Math.round(255 * (1 - level / 15));
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
    const report = inspect(encodeRgbaPng(W, H, rgba), { console: "ws" });
    expect(report.consoles[0]!.violations.map((v) => v.code)).not.toContain("E_SHADE_POOL");
  });
});
